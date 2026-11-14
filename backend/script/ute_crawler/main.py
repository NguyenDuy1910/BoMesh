#!/usr/bin/env python3
"""
Download academic documents from the HCMUTE (UTE) digital library.

Target
------
https://thuvienso.hcmute.edu.vn  — the university's full-text repository
(powered by dlib.vn). Everything below was verified against the live site.

How the site works (reverse engineered)
---------------------------------------
1. Category pages are server-side rendered (Nuxt) and paginated with the
   plain query parameter `?page=N` (18 documents per page). The embedded
   Nuxt payload carries `current_page` / `per_page` / `next_page_url`;
   `next_page_url` becomes null on the last page, which is the stop signal.
2. Each document lives at `/tai-lieu/<slug>-<id>.html`. Its payload exposes:
       resource_title          title
       pdf_file_path           public CDN URL of the file
       resource_allowdownload  1 = the library allows downloading
       resource_format         pdf / ppt / doc ...
3. Files are served from https://cdn.dlib.vn/... as plain public GETs
   (no cookies, no tokens, no referer check).

Access rules honoured by this script
------------------------------------
* Only documents with `resource_allowdownload == 1` are downloaded. Items
  flagged 0 are read-only on the library's own terms and are skipped and
  counted, even though their CDN URL is technically reachable.
* No login, no CAPTCHA, no header/UA spoofing beyond a normal browser UA.
* One request at a time with a configurable delay (`--delay`, default 1 s)
  and exponential backoff on 429/5xx.

Not a document source (checked, nothing to download)
----------------------------------------------------
* https://lib.hcmute.edu.vn/                  → library portal / news pages.
* https://lib.hcmute.edu.vn/tra-cuu-opac      → HTTP 404; the OPAC actually
  lives at library.hcmute.edu.vn/Libol50.
* https://library.hcmute.edu.vn/Libol50/...   → Libol catalogue: bibliographic
  records only (no file endpoints) and its WAF blocks non-browser clients.

Usage
-----
    python main.py                          # every category, all pages
    python main.py --list-categories
    python main.py -c do-an-khoa-luan-tot-nghiep --max-pages 2 --max-docs 5
    python main.py -c giao-trinh-spkt --dry-run
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Set
from urllib.parse import urljoin, urlparse

import requests

try:  # BeautifulSoup is only used to read one <script> tag; regex fallback below
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover - keeps the script runnable with requests only
    BeautifulSoup = None

BASE_URL = "https://thuvienso.hcmute.edu.vn"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
)
DEFAULT_OUT = Path(__file__).resolve().parent / "downloads"
DOC_LINK_RE = re.compile(r'href="(/tai-lieu/[^"]+\.html)"')
# devalue sentinels used by the Nuxt payload
NEGATIVE = {-1: None, -2: None, -3: float("nan"), -4: float("inf"),
            -5: float("-inf"), -6: -0.0}


# --------------------------------------------------------------------------- #
# Nuxt payload (devalue) decoding
# --------------------------------------------------------------------------- #
def decode_nuxt(html: str) -> Any:
    """Decode the `__NUXT_DATA__` script of a Nuxt page into plain Python.

    The payload is a devalue-encoded array: strings/numbers sit at their own
    index, objects and lists are stored as references (integers) to indices.
    """
    soup = BeautifulSoup(html, "html.parser") if BeautifulSoup else None
    tag = soup.find("script", id="__NUXT_DATA__") if soup else None
    raw_payload = tag.string if tag is not None else None
    if not raw_payload:
        match = re.search(r'id="__NUXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
        raw_payload = match.group(1) if match else None
    if not raw_payload:
        return None

    arr = json.loads(raw_payload)
    memo: Dict[int, Any] = {}

    def deref(ref: Any) -> Any:
        if isinstance(ref, bool) or not isinstance(ref, int):
            return ref
        if ref < 0:
            return NEGATIVE.get(ref)
        if ref >= len(arr):
            return None
        if ref in memo:
            return memo[ref]

        raw = arr[ref]
        memo[ref] = None  # cycle guard
        if isinstance(raw, dict):
            value: Any = {key: deref(target) for key, target in raw.items()}
        elif isinstance(raw, list):
            value = [deref(item) for item in raw]
        else:
            value = raw
        memo[ref] = value
        return value

    return deref(1)


def find_all(node: Any, key: str) -> Iterator[Dict[str, Any]]:
    """Yield every dict inside `node` that contains `key`."""
    stack: List[Any] = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if key in current:
                yield current
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def payload_object(html: str, key: str) -> Optional[Dict[str, Any]]:
    payload = decode_nuxt(html)
    if payload is None:
        return None
    for found in find_all(payload, key):
        return found
    return None


def doc_id_from_link(link: str) -> str:
    """`/tai-lieu/<slug>-<hexid>.html` -> `<hexid>`."""
    stem = Path(urlparse(link).path).stem
    return stem.rsplit("-", 1)[-1] if "-" in stem else stem


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Client:
    """Single-connection, rate-limited HTTP client."""

    def __init__(self, delay: float = 1.0, timeout: int = 60) -> None:
        self.delay = delay
        self.timeout = timeout
        self._last = 0.0
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "vi,en;q=0.8",
        })

    def _throttle(self) -> None:
        wait = self.delay - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def get(self, url: str, *, stream: bool = False, retries: int = 3) -> requests.Response:
        last_error: Optional[Exception] = None
        for attempt in range(1, retries + 1):
            self._throttle()
            try:
                response = self.session.get(url, timeout=self.timeout, stream=stream)
            except requests.RequestException as exc:  # network error / timeout
                last_error = exc
            else:
                if response.status_code in (429, 500, 502, 503, 504):
                    backoff = int(response.headers.get("Retry-After") or 0) or 5 * attempt
                    response.close()
                    last_error = RuntimeError(f"HTTP {response.status_code}")
                    print(f"    ! {response.status_code} on {url} - waiting {backoff}s",
                          file=sys.stderr)
                    time.sleep(backoff)
                    continue
                if response.status_code >= 400:
                    response.close()
                    raise RuntimeError(f"HTTP {response.status_code} for {url}")
                return response
            time.sleep(2 ** attempt)
        raise RuntimeError(f"giving up on {url}: {last_error}")

    def text(self, url: str) -> str:
        return self.get(url).text

    def close(self) -> None:
        self.session.close()


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #
def discover_categories(client: Client) -> List[Dict[str, Any]]:
    """Read the category tree from the homepage menu and keep the leaf nodes.

    Each menu node carries `link`, `name` and `count`. Parent categories
    aggregate their children (the counts add up exactly), so only leaves are
    crawled and nothing is listed twice.
    """
    html = client.text(BASE_URL + "/")
    categories: List[Dict[str, Any]] = []
    seen: Set[str] = set()

    for node in find_all(decode_nuxt(html), "link"):
        link, name = node.get("link"), node.get("name")
        if not isinstance(link, str) or not link.startswith("/"):
            continue
        if link.startswith(("/tin-tuc", "/tai-lieu")) or "count" not in node:
            continue
        if node.get("children"):  # parent category: its children carry the docs
            continue
        if link in seen:
            continue
        seen.add(link)
        categories.append({
            "name": name,
            "path": link,
            "count": node.get("count") or 0,
        })
    return categories


def category_url(path: str, page: int) -> str:
    base = BASE_URL + path
    return base if page <= 1 else f"{base}{'&' if '?' in base else '?'}page={page}"


def list_page(client: Client, path: str, page: int) -> tuple[List[Dict[str, Any]], bool]:
    """Return (documents, has_next_page) for one category page.

    The listing state lives in one payload object that holds `resources`,
    `current_page`, `per_page` and `next_page_url` (null on the last page).
    """
    html = client.text(category_url(path, page))

    meta = payload_object(html, "next_page_url")
    has_next = bool(meta and meta.get("next_page_url"))

    items = (meta or {}).get("resources")
    if isinstance(items, list) and items:
        cleaned = [i for i in items if isinstance(i, dict) and i.get("link")]
        if cleaned:
            return cleaned, has_next

    # fallback: scrape the rendered cards
    links = list(dict.fromkeys(DOC_LINK_RE.findall(html)))
    return [{"link": link, "resource_title": "", "resource_id": ""} for link in links], has_next


def document_detail(client: Client, link: str) -> Optional[Dict[str, Any]]:
    """Fetch a document page and return *that* document's metadata object.

    A detail page payload also embeds ~10 "related document" objects that carry
    the same fields, so the object is matched on the document id taken from the
    requested URL.
    """
    try:
        html = client.text(urljoin(BASE_URL, link))
    except RuntimeError as exc:
        print(f"    ! detail failed {link}: {exc}", file=sys.stderr)
        return None

    payload = decode_nuxt(html)
    if payload is None:
        return None

    wanted_id = doc_id_from_link(link)
    candidates = list(find_all(payload, "pdf_file_path"))
    for candidate in candidates:
        if str(candidate.get("resource_id") or "") == wanted_id:
            candidate.setdefault("link", link)
            return candidate
    for candidate in candidates:  # last resort: match on the link itself
        if str(candidate.get("link") or "").rstrip("/") == link.rstrip("/"):
            candidate.setdefault("link", link)
            return candidate
    return None


# --------------------------------------------------------------------------- #
# Files
# --------------------------------------------------------------------------- #
def slugify(text: str, limit: int = 90) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("đ", "d").replace("Đ", "D")
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return (text[:limit].rstrip("-")) or "document"


def file_extension(url: str, resource_format: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix and len(suffix) <= 6:
        return suffix
    fmt = (resource_format or "").strip().lower()
    return f".{fmt}" if fmt.isalnum() else ".bin"


def build_index(folder: Path) -> Dict[str, Path]:
    """Map `<slug>-<id>` prefixes to already downloaded files."""
    index: Dict[str, Path] = {}
    if not folder.is_dir():
        return index
    for file in folder.iterdir():
        if file.is_file():
            index[file.stem] = file
    return index


def already_downloaded(index: Dict[str, Path], stem: str) -> bool:
    return stem in index


def download_file(client: Client, url: str, dest: Path) -> int:
    """Stream `url` into `dest` atomically. Returns bytes written."""
    part = dest.with_name(dest.name + ".part")
    response = client.get(url, stream=True)
    content_type = response.headers.get("Content-Type", "")
    size = 0
    try:
        with open(part, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1 << 16):
                if chunk:
                    handle.write(chunk)
                    size += len(chunk)
    finally:
        response.close()

    with open(part, "rb") as handle:
        head = handle.read(5)
    if size == 0 or (b"html" in content_type.encode() and not head.startswith(b"%PDF")):
        part.unlink(missing_ok=True)
        raise RuntimeError(f"not a document ({content_type or 'unknown'}, {size} bytes)")

    part.replace(dest)
    return size


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


# --------------------------------------------------------------------------- #
# Crawl
# --------------------------------------------------------------------------- #
def crawl(args: argparse.Namespace) -> int:
    client = Client(delay=args.delay)
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    index = build_index(out)

    stats = {"documents": 0, "downloaded": 0, "bytes": 0,
             "existing": 0, "not_downloadable": 0, "no_file": 0, "failed": 0}
    seen: Set[str] = set()

    try:
        categories = discover_categories(client)
        if args.list_categories:
            for category in categories:
                print(f"{category['count']:>7}  {category['path']:<48} {category['name']}")
            return 0

        selected = select_categories(categories, args.categories)
        if not selected:
            print("No matching categories.", file=sys.stderr)
            return 1

        print(f"Categories : {len(selected)}")
        print(f"Output dir : {out}")
        print(f"Delay      : {args.delay}s between requests\n")

        stop = False
        for category in selected:
            if stop:
                break
            print(f"== {category['name']} ({category['path']}) ~{category['count']} docs")
            page = 1
            while True:
                if args.max_pages and page > args.max_pages:
                    print("   ... page limit reached")
                    break
                try:
                    items, has_next = list_page(client, category["path"], page)
                except RuntimeError as exc:
                    print(f"   ! listing failed on page {page}: {exc}", file=sys.stderr)
                    break
                if not items:
                    break
                print(f"   page {page}: {len(items)} documents")

                for item in items:
                    if args.max_docs and stats["documents"] >= args.max_docs:
                        stop = True
                        break
                    stats["documents"] += 1
                    handle_item(client, item, out, index, seen, stats, args)

                if stop or not has_next:
                    break
                page += 1
    finally:
        client.close()

    print("\n=== summary ===")
    print(f"documents examined    : {stats['documents']}")
    print(f"downloaded            : {stats['downloaded']} ({human_size(stats['bytes'])})")
    print(f"already on disk       : {stats['existing']}")
    print(f"skipped (not permitted to download) : {stats['not_downloadable']}")
    print(f"skipped (no file)     : {stats['no_file']}")
    print(f"failed                : {stats['failed']}")
    print(f"saved under           : {out}")
    return 0 if stats["failed"] == 0 else 2


def handle_item(client: Client, item: Dict[str, Any], out: Path,
                index: Dict[str, Path], seen: Set[str], stats: Dict[str, int],
                args: argparse.Namespace) -> None:
    link = item.get("link") or ""
    title = (item.get("resource_title") or "").strip()
    doc_id = str(item.get("resource_id") or "") or doc_id_from_link(link)

    if doc_id in seen:  # the same document can appear in several categories
        stats["existing"] += 1
        return
    seen.add(doc_id)

    # Cheap skip: the target filename only depends on title + id.
    if title and doc_id:
        stem = f"{slugify(title)}-{doc_id}"
        if already_downloaded(index, stem):
            stats["existing"] += 1
            print(f"   = exists  {title[:70]}")
            return

    detail = document_detail(client, link)
    if detail is None:
        stats["failed"] += 1
        print(f"   ! no metadata for {link}", file=sys.stderr)
        return

    title = (detail.get("resource_title") or title or "document").strip()
    doc_id = str(detail.get("resource_id") or doc_id or "unknown")
    file_url = (detail.get("pdf_file_path") or "").strip()

    if not file_url:
        stats["no_file"] += 1
        print(f"   - no file  {title[:70]}")
        return

    allowed = detail.get("resource_allowdownload")
    if not args.force and allowed != 1:
        stats["not_downloadable"] += 1
        print(f"   - read-only {title[:66]} (allowdownload={allowed})")
        return

    stem = f"{slugify(title)}-{doc_id}"
    dest = out / (stem + file_extension(file_url, detail.get("resource_format", "")))
    if dest.exists() and dest.stat().st_size > 0:
        index[stem] = dest
        stats["existing"] += 1
        print(f"   = exists  {title[:70]}")
        return

    if args.dry_run:
        print(f"   > would download {title[:60]} <- {file_url}")
        return

    try:
        size = download_file(client, file_url, dest)
    except (RuntimeError, OSError) as exc:
        stats["failed"] += 1
        print(f"   ! download failed {title[:60]}: {exc}", file=sys.stderr)
        return

    index[stem] = dest
    stats["downloaded"] += 1
    stats["bytes"] += size
    print(f"   + {human_size(size):>8}  {dest.name}")
    return


def select_categories(categories: List[Dict[str, Any]],
                      wanted: Optional[List[str]]) -> List[Dict[str, Any]]:
    if not wanted:
        return categories
    selected = []
    for category in categories:
        path = category["path"].strip("/")
        for token in wanted:
            token = token.strip("/")
            if path == token or path.endswith("/" + token) or category["name"].lower() == token.lower():
                selected.append(category)
                break
    return selected


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download documents from the HCMUTE digital library "
                    "(only items the library marks as downloadable).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python main.py --list-categories\n"
               "  python main.py -c do-an-khoa-luan-tot-nghiep --max-pages 2\n"
               "  python main.py -c slide-bai-giang --max-docs 5\n",
    )
    parser.add_argument("-c", "--categories", nargs="+", action="extend", metavar="PATH",
                        help="category paths or slugs (default: all)")
    parser.add_argument("--max-pages", type=int, default=0,
                        help="max listing pages per category (0 = all)")
    parser.add_argument("--max-docs", type=int, default=0,
                        help="stop after examining N documents (0 = no limit)")
    parser.add_argument("--delay", type=float, default=1.0,
                        help="seconds between HTTP requests (default: 1.0)")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help=f"download folder (default: {DEFAULT_OUT})")
    parser.add_argument("--dry-run", action="store_true",
                        help="show what would be downloaded")
    parser.add_argument("--list-categories", action="store_true",
                        help="print the category tree and exit")
    parser.add_argument("--force", action="store_true",
                        help="also fetch items the library marks read-only "
                             "(use only with explicit permission)")
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    try:
        return crawl(args)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
