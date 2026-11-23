#!/usr/bin/env python3
"""
Collect every document HCMUTE (Trường Đại học Sư phạm Kỹ thuật TP.HCM) publishes
on its official websites: theses and dissertations, forms, regulations,
decisions, curricula, textbooks, reports...

Sources (`--sources`, default: web drive; thuvienso is opt-in, see Rules)
-----------------------------------------
web        Every *.hcmute.edu.vn website, crawled concurrently. Hosts are
           discovered from links (the homepage and /gioi-thieu/so-do-to-chuc
           link every faculty, office and centre), so new units are picked up
           automatically. Per host it also reads robots.txt sitemaps, the usual
           sitemap paths and, on WordPress sites, the public media listing
           (/wp-json/wp/v2/media), which names every uploaded file.
           Documents are found in links and inside page payloads: the new
           Next.js platform (hcmute.edu.vn, fit, fpi, sao, ...) keeps its
           attachments under www.hcmute.edu.vn/hcmute-website-bucket/... in the
           RSC payload, not in <a href>. Its sitemap names a wrong host
           (dev.hcmutertic.com); paths are rewritten onto the sitemap's host.
           Old ASP.NET sites (aao, sdh, fme, feee, ...) keep files under
           /Resources/Docs/SubDomain/<unit>/... and link articles twice
           (/?ArticleId=<id> and /ArticleId/<id>/<slug>); both are one page here.
drive      Google Drive / Docs files and folders linked from those pages (the
           graduate school and several faculties publish forms and thesis lists
           there). Docs, Sheets and Slides are exported as DOCX / XLSX / PPTX;
           folders are listed through drive.google.com/embeddedfolderview.
thuvienso  thuvienso.hcmute.edu.vn, the digital library (dlib.vn, Nuxt SSR):
           theses, dissertations, textbooks, slides. Category menu -> ?page=N
           listings -> /tai-lieu/<slug>-<id>.html -> public cdn.dlib.vn file.
           A detail page also embeds ~10 related documents, so the document is
           matched on the id in its URL.

Rules
-----
* robots.txt of every university host is honoured for pages, sitemaps and
  listings. A file linked from a page is fetched like a reader clicking it.
* thuvienso is not crawled unless named in `--sources`: its robots.txt serves
  `Disallow: /` (under a comment saying normal crawlers are allowed), so bulk
  downloading it needs the library's consent. When enabled, only documents it
  marks `resource_allowdownload == 1` are taken; `--force` also takes read-only
  ones (only with the library's permission).
* No login, no forms, no CAPTCHA. Disallowed paths (/api/, /admin/, ...) are
  never requested.

Speed
-----
asyncio + httpx: every host has its own queue and `--per-host` workers, all
hosts run in parallel under `--concurrency` requests in flight. A host that
answers 429/5xx is paused (Retry-After honoured) without slowing the others.

Output (`--out`, default ~/Documents/workspace/ute_docs)
--------------------------------------------------------
    web/<host>/<url path>/<file>        files found on university sites
    web/<host>/_drive/<folder>/<file>   Drive / Docs files linked from <host>
    thuvienso/<category>/<title>-<id>.<ext>
    manifest.jsonl                      one line per stored file: url, path,
                                        sha256, bytes, kind, title, source page
    state.sqlite                        crawl state: re-running resumes; files
                                        already fetched are never fetched again

Identical files (same SHA-256) found under several URLs are stored once; the
other URLs are recorded in state.sqlite with `duplicate_of`.

Usage
-----
    uv run --with httpx python main.py                    # every university site + linked Drive files
    python main.py --sources web drive thuvienso          # + the digital library (needs its consent)
    python main.py --hosts sdh.hcmute.edu.vn aao.hcmute.edu.vn
    python main.py --sources thuvienso -c do-an-khoa-luan-tot-nghiep
    python main.py --list-categories
    python main.py --refresh                              # re-read pages for new files
    python main.py --report                               # summary of what is stored
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import html
import json
import re
import sqlite3
import sys
import time
import unicodedata
from collections import Counter
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import (
    parse_qsl,
    quote,
    unquote,
    urlencode,
    urljoin,
    urlsplit,
    urlunsplit,
)
from urllib.robotparser import RobotFileParser

try:
    import httpx
except ImportError:  # pragma: no cover
    sys.exit("httpx is required: pip install -r requirements.txt  (or: uv run --with httpx python main.py)")

UNIVERSITY_DOMAIN = "hcmute.edu.vn"
LIBRARY_HOST = "thuvienso.hcmute.edu.vn"
LIBRARY_URL = f"https://{LIBRARY_HOST}"
DEFAULT_OUT = Path("~/Documents/workspace/ute_docs").expanduser()
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
)
# Pages that link every unit site; anything else is found from links.
SEED_URLS = (
    "https://hcmute.edu.vn/",
    "https://hcmute.edu.vn/gioi-thieu/so-do-to-chuc",
)
DOC_EXTS = {
    ".pdf", ".doc", ".docx", ".docm", ".dot", ".dotx", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx",
    ".pps", ".ppsx", ".odt", ".ods", ".odp", ".rtf", ".zip", ".rar", ".7z", ".epub",
}
# Never pages, never documents.
SKIP_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tif", ".tiff", ".avif",
    ".css", ".js", ".mjs", ".map", ".json", ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp4", ".mp3", ".webm", ".avi", ".mov", ".wmv", ".flv", ".m4a", ".wav", ".ogg", ".swf",
    ".exe", ".msi", ".dmg", ".apk", ".iso", ".bin", ".txt", ".xml", ".rss", ".atom",
}
SKIP_PATH = re.compile(
    r"(?i)(^|/)(_next|wp-admin|wp-login\.php|wp-includes|admin|manage|login|logout|dang-nhap|dang-xuat|"
    r"signin|signout|auth|portal|cgi-bin|feed|xmlrpc\.php|print|share)(/|$)"
)
SKIP_QUERY = re.compile(r"(?i)(^|&)(replytocom|share|print|format|action|returnurl|redirect_to|lang)=")
DROP_PARAMS = re.compile(r"(?i)^(utm_\w+|fbclid|gclid|zarsrc|_gl|ref|usp|sp)$")
GUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
OLD_CMS_PATH = re.compile(rf"(?i)^/(ArticleId|TopicId|CategoryId)/({GUID})(/.*)?$")
GOOGLE_HOSTS = {"drive.google.com", "docs.google.com", "drive.usercontent.google.com"}
FAST_HOSTS = GOOGLE_HOSTS | {"cdn.dlib.vn"}  # CDNs take more parallel downloads
PAGE_LIMIT = 25 << 20
RETRIES = 4

DOC_MIME = {
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.oasis.opendocument.text": ".odt",
    "application/vnd.oasis.opendocument.spreadsheet": ".ods",
    "application/vnd.oasis.opendocument.presentation": ".odp",
    "application/rtf": ".rtf",
    "application/zip": ".zip",
    "application/x-zip-compressed": ".zip",
    "application/x-rar-compressed": ".rar",
    "application/vnd.rar": ".rar",
    "application/x-7z-compressed": ".7z",
}
# What a document is, from its URL, link text and page title (slugified). First match wins.
KIND_RULES = tuple((kind, re.compile(rf"(?:^|-)(?:{words})(?:-|$)")) for kind, words in (
    ("luan_an", r"luan-an|tien-si|dissertation"),
    ("luan_van", r"luan-van|thac-si"),
    ("khoa_luan_do_an", r"khoa-luan|do-an|tieu-luan|bao-cao-tot-nghiep|thesis"),
    ("bieu_mau", r"bieu-mau|mau-don|don-xin|don-de-nghi|giay-de-nghi|mau-so|mau|phieu|to-khai|ban-cam-ket|forms?"),
    ("quy_che_van_ban", r"quy-che|quy-dinh|quyet-dinh|qd|thong-tu|nghi-dinh|cong-van|huong-dan|chinh-sach|luat"),
    ("chuong_trinh_dao_tao", r"chuong-trinh-dao-tao|ctdt|de-cuong|chuan-dau-ra|khung-chuong-trinh|ban-mo-ta"),
    ("giao_trinh_bai_giang", r"giao-trinh|bai-giang|slide|hoc-lieu|tai-lieu-hoc-tap"),
    ("de_thi", r"de-thi|dap-an|ngan-hang-cau-hoi|de-kiem-tra"),
    ("nghien_cuu", r"nghien-cuu|bai-bao|tap-chi|ky-yeu|hoi-thao|de-tai|journal"),
    ("ke_hoach_thong_bao", r"ke-hoach|thong-bao|tb|lich|danh-sach|ket-qua"),
))


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def slugify(text: str, limit: int = 90) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.replace("đ", "d").replace("Đ", "D")
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return text[:limit].rstrip("-") or "document"


def classify_kind(*texts: str) -> str:
    """Kind from the first text that says something; pass the most specific (file name) first."""
    for text in texts:
        slug = slugify(unquote(text or ""), 400)
        for kind, pattern in KIND_RULES:
            if pattern.search(slug):
                return kind
    return "khac"


def safe_segment(text: str, limit: int = 120) -> str:
    text = unicodedata.normalize("NFC", unquote(text or "")).strip()
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", text).strip(" .")
    if len(text) > limit:
        stem, dot, ext = text.rpartition(".")
        text = (stem[: limit - len(ext) - 1] + "." + ext) if dot and len(ext) <= 6 else text[:limit]
    return text or "_"


def is_university(host: str) -> bool:
    return host == UNIVERSITY_DOMAIN or host.endswith("." + UNIVERSITY_DOMAIN)


def url_ext(url: str) -> str:
    return Path(unquote(urlsplit(url).path)).suffix.lower()


def short_hash(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:8]


def human_size(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def filename_from_disposition(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"filename\*\s*=\s*[^']*'[^']*'([^;]+)", value, re.IGNORECASE)
    if match:
        return unquote(match.group(1).strip().strip('"'))
    match = re.search(r'filename\s*=\s*"?([^";]+)"?', value, re.IGNORECASE)
    if match:
        name = match.group(1).strip()
        try:  # servers often send UTF-8 bytes as latin-1
            name = name.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
        return name
    return None


def mime_of(response: httpx.Response) -> str:
    return response.headers.get("content-type", "").split(";")[0].strip().lower()


def looks_like_document(response: httpx.Response, url: str) -> bool:
    mime = mime_of(response)
    if mime in DOC_MIME or mime.startswith(("application/vnd.openxmlformats", "application/vnd.ms-")):
        return True
    disposition = filename_from_disposition(response.headers.get("content-disposition"))
    if disposition and Path(disposition).suffix.lower() in DOC_EXTS:
        return True
    return mime in ("application/octet-stream", "binary/octet-stream") and url_ext(url) in DOC_EXTS


# --------------------------------------------------------------------------- #
# URLs
# --------------------------------------------------------------------------- #
ATTR_RE = re.compile(r"""(?:href|src|data-src|data-href|data-url|data-file|action)\s*=\s*["']([^"'<>]+)["']""", re.IGNORECASE)
ABS_RE = re.compile(r"""https?://[^\s"'<>\\)\]}|^`]+""", re.IGNORECASE)
QUOTED_PATH_RE = re.compile(r"""["'](/[A-Za-z0-9_%~][^"'<>\s\\]{0,300})["']""")
ANCHOR_RE = re.compile(r"<a\b[^>]*?href\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", re.IGNORECASE | re.DOTALL)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")


def unescape_payload(text: str) -> str:
    """Undo JSON/JS escaping so URLs inside RSC, Nuxt and inline scripts become plain."""
    for escaped, plain in (("\\/", "/"), ("\\u002F", "/"), ("\\u002f", "/"), ("\\u0026", "&"),
                           ("\\u003d", "="), ("\\u003D", "="), ("\\u0025", "%")):
        text = text.replace(escaped, plain)
    return html.unescape(text)


def extract_urls(text: str) -> set[str]:
    plain = unescape_payload(text)
    found = set(ATTR_RE.findall(plain)) | set(ABS_RE.findall(plain)) | set(QUOTED_PATH_RE.findall(plain))
    return {u.strip().rstrip(".,;:") for u in found if u and not u.startswith(("#", "mailto:", "tel:", "javascript:", "data:"))}


def anchor_texts(text: str, base: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for href, inner in ANCHOR_RE.findall(text):
        label = re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", inner))).strip()
        if label:
            result.setdefault(urljoin(base, html.unescape(href.strip())), label[:300])
    return result


def unwrap_viewer(url: str) -> str:
    """Google/Office viewer links carry the real file in a query parameter."""
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query))
    if parts.hostname in ("docs.google.com", "drive.google.com") and parts.path.rstrip("/").endswith(("/viewer", "/gview")):
        return query.get("url") or url
    if parts.hostname == "view.officeapps.live.com":
        return query.get("src") or url
    return url


OLD_UNIT_FILE = re.compile(r"(?i)^/Resources/Docs/SubDomain/([a-z0-9-]+)/")


def normalize(url: str, http_only: set[str]) -> str | None:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    host = parts.hostname.lower().rstrip(".")
    unit = OLD_UNIT_FILE.match(unquote(parts.path or ""))
    if unit and host in (UNIVERSITY_DOMAIN, "www." + UNIVERSITY_DOMAIN):
        # The main site moved to a new platform; old unit pages still link their files on it,
        # where they now 404. The unit's own host still serves them.
        host = f"{unit.group(1).lower()}.{UNIVERSITY_DOMAIN}"
    scheme = parts.scheme
    if is_university(host):
        scheme = "http" if host in http_only else "https"
    netloc = host if parts.port in (None, 80, 443) else f"{host}:{parts.port}"
    path = quote(unquote(parts.path or "/"), safe="/%:@!$&'()*+,;=-._~")
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not DROP_PARAMS.match(k)]
    if is_university(host):
        if re.fullmatch(r"(?i)/default\.aspx", path):
            path = "/"
        old = OLD_CMS_PATH.match(path)
        if old:  # /ArticleId/<id>/<slug> and /?ArticleId=<id> are one article
            path, query = "/", [(old.group(1), old.group(2).lower())] + query
    query = [(k, v.lower() if re.fullmatch(GUID, v) else v) for k, v in query]
    query.sort()
    return urlunsplit((scheme, netloc, path, urlencode(query, quote_via=quote), ""))


# --------------------------------------------------------------------------- #
# Nuxt payload (thuvienso)
# --------------------------------------------------------------------------- #
NUXT_RE = re.compile(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', re.DOTALL)
NEGATIVE = {-1: None, -2: None, -3: float("nan"), -4: float("inf"), -5: float("-inf"), -6: -0.0}


def decode_nuxt(page: str) -> Any:
    """Decode the devalue-encoded `__NUXT_DATA__` array into plain Python."""
    match = NUXT_RE.search(page)
    if not match:
        return None
    arr = json.loads(match.group(1))
    memo: dict[int, Any] = {}

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


def find_all(node: Any, key: str) -> Iterator[dict[str, Any]]:
    stack: list[Any] = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if key in current:
                yield current
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def library_doc_id(link: str) -> str:
    stem = Path(urlsplit(link).path).stem
    return stem.rsplit("-", 1)[-1] if "-" in stem else stem


# --------------------------------------------------------------------------- #
# State
# --------------------------------------------------------------------------- #
@dataclass
class Job:
    kind: str  # host | page | sitemap | wp_media | file | drive_folder | tv_home | tv_list | tv_detail
    url: str
    key: str
    data: dict[str, Any] = field(default_factory=dict)


class Skip(Exception):
    """The job ends without a result for a known reason (robots, 404, not a document...)."""


class Store:
    """SQLite crawl state: every job ever queued, and every stored file."""

    RECRAWLED = ("host", "page", "sitemap", "wp_media", "drive_folder", "tv_home", "tv_list")

    def __init__(self, path: str) -> None:
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                key TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL, data TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending', error TEXT, updated REAL);
            CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
            CREATE TABLE IF NOT EXISTS files (
                url TEXT PRIMARY KEY, path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
                mime TEXT, kind TEXT, title TEXT, source_page TEXT, host TEXT, duplicate_of TEXT,
                fetched_at REAL);
            CREATE INDEX IF NOT EXISTS files_sha ON files(sha256);
        """)
        self.keys: set[str] = {key for (key,) in self.db.execute("SELECT key FROM jobs")}
        self.shas: dict[str, str] = dict(self.db.execute(
            "SELECT sha256, path FROM files WHERE duplicate_of IS NULL"))
        self.paths: dict[str, str] = {path: url for url, path in self.db.execute(
            "SELECT url, path FROM files WHERE duplicate_of IS NULL")}
        self._dirty = 0

    def add(self, job: Job) -> bool:
        if job.key in self.keys:
            return False
        self.keys.add(job.key)
        self.db.execute("INSERT OR IGNORE INTO jobs(key, kind, url, data, updated) VALUES (?,?,?,?,?)",
                        (job.key, job.kind, job.url, json.dumps(job.data, ensure_ascii=False), time.time()))
        self._tick()
        return True

    def unfinished(self) -> list[Job]:
        rows = self.db.execute("SELECT kind, url, key, data FROM jobs WHERE state IN ('pending','running')")
        return [Job(kind, url, key, json.loads(data)) for kind, url, key, data in rows]

    def reopen_listings(self) -> int:
        marks = ",".join("?" * len(self.RECRAWLED))
        cursor = self.db.execute(
            f"UPDATE jobs SET state='pending', error=NULL WHERE kind IN ({marks}) AND state != 'pending'",
            self.RECRAWLED)
        self.db.commit()
        return cursor.rowcount

    def finish(self, key: str, state: str, error: str | None = None) -> None:
        self.db.execute("UPDATE jobs SET state=?, error=?, updated=? WHERE key=?", (state, error, time.time(), key))
        self._tick()

    def record_file(self, row: dict[str, Any]) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO files(url, path, sha256, bytes, mime, kind, title, source_page, host, duplicate_of, fetched_at)"
            " VALUES (:url,:path,:sha256,:bytes,:mime,:kind,:title,:source_page,:host,:duplicate_of,:fetched_at)", row)
        if not row["duplicate_of"]:
            self.shas[row["sha256"]] = row["path"]
            self.paths[row["path"]] = row["url"]
        self._tick()

    def _tick(self) -> None:
        self._dirty += 1
        if self._dirty >= 200:
            self.commit()

    def commit(self) -> None:
        self.db.commit()
        self._dirty = 0

    def close(self) -> None:
        self.commit()
        self.db.close()


# --------------------------------------------------------------------------- #
# Crawler
# --------------------------------------------------------------------------- #
class Crawler:
    def __init__(self, args: argparse.Namespace, store: Store, out: Path) -> None:
        self.args = args
        self.store = store
        self.out = out
        self.sources = set(args.sources)
        self.only_hosts = {h.lower() for h in (args.hosts or [])}
        self.client = httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT, "Accept-Language": "vi,en;q=0.8"},
            follow_redirects=True, http2=False,  # the IIS unit sites reset HTTP/2 streams (HTTP_1_1_REQUIRED)
            timeout=httpx.Timeout(90, connect=20),
            limits=httpx.Limits(max_connections=args.concurrency * 2, max_keepalive_connections=args.concurrency),
        )
        self.slots = asyncio.Semaphore(args.concurrency)
        self.queues: dict[str, asyncio.Queue] = {}
        self.tasks: list[asyncio.Task] = []
        self.robots: dict[str, RobotFileParser] = {}
        self.robots_locks: dict[str, asyncio.Lock] = {}
        self.next_slot: dict[str, float] = {}
        self.paused_until: dict[str, float] = {}
        self.http_only: set[str] = set()
        self.known_hosts: set[str] = set()
        self.wp_hosts: set[str] = set()
        self.host_pages: Counter = Counter()
        self.stats: Counter = Counter()
        self.outstanding = 0
        self.done = asyncio.Event()
        self.started = time.monotonic()
        self.library_docs = 0
        # Kept open for the whole run (appended per file); closed in run().
        self.manifest = None if args.dry_run else open(out / "manifest.jsonl", "a", encoding="utf-8")  # noqa: SIM115
        self.claimed: set[str] = set()  # destinations being written by running downloads

    # ----------------------------------------------------------------- queue
    def submit(self, job: Job, *, persist: bool = True) -> None:
        if persist and not self.store.add(job):
            return
        host = urlsplit(job.url).hostname or ""
        queue = self.queues.get(host)
        if queue is None:
            queue = self.queues[host] = asyncio.Queue()
            workers = self.args.per_host * (3 if host in FAST_HOSTS else 1)
            self.tasks.extend(asyncio.create_task(self.worker(host, queue)) for _ in range(workers))
        self.outstanding += 1
        self.done.clear()
        queue.put_nowait(job)

    async def worker(self, host: str, queue: asyncio.Queue) -> None:
        while True:
            job: Job = await queue.get()
            try:
                await self.handle(job)
                self.store.finish(job.key, "done")
            except Skip as reason:
                self.stats["skipped"] += 1
                self.store.finish(job.key, "skipped", str(reason)[:300])
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001  one bad job never stops the crawl
                self.stats[f"failed_{job.kind}"] += 1
                self.store.finish(job.key, "failed", f"{type(exc).__name__}: {exc}"[:300])
                if not self.args.quiet:
                    print(f"  ! {job.kind} {job.url}: {type(exc).__name__}: {exc}"[:240], file=sys.stderr)
            finally:
                self.outstanding -= 1
                if self.outstanding == 0:
                    self.done.set()

    async def handle(self, job: Job) -> None:
        handler = {
            "host": self.handle_host, "page": self.handle_page, "sitemap": self.handle_sitemap,
            "wp_media": self.handle_wp_media, "file": self.handle_file, "drive_folder": self.handle_drive_folder,
            "tv_home": self.handle_library_home, "tv_list": self.handle_library_list,
            "tv_detail": self.handle_library_detail,
        }[job.kind]
        await handler(job)

    # ------------------------------------------------------------------ http
    async def _wait_turn(self, host: str) -> None:
        now = time.monotonic()
        start = max(now, self.next_slot.get(host, 0.0), self.paused_until.get(host, 0.0))
        self.next_slot[host] = start + self.args.delay
        if start > now:
            await asyncio.sleep(start - now)

    @asynccontextmanager
    async def fetch(self, url: str) -> AsyncIterator[httpx.Response]:
        """Streaming GET with retries; holds one `--concurrency` slot until the body is consumed."""
        host = urlsplit(url).hostname or ""
        last: BaseException | None = None
        response: httpx.Response | None = None
        for attempt in range(1, RETRIES + 1):
            await self._wait_turn(host)
            await self.slots.acquire()
            try:
                response = await self.client.send(self.client.build_request("GET", url), stream=True)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                self.slots.release()
                last = exc
                if is_university(host) and url.startswith("https://") and "CERTIFICATE" in str(exc).upper():
                    self.http_only.add(host)  # broken certificate: the unit site also answers on http
                    url = "http://" + url[len("https://"):]
                    continue
                await asyncio.sleep(min(30, 2 ** attempt))
                continue
            status = response.status_code
            if status in (429, 500, 502, 503, 504):
                await response.aclose()
                self.slots.release()
                retry_after = response.headers.get("retry-after", "").strip()
                wait = max(float(retry_after) if retry_after.isdigit() else 0.0, 5.0 * attempt)
                self.paused_until[host] = time.monotonic() + wait
                self.stats["throttled"] += 1
                last = RuntimeError(f"HTTP {status}")
                response = None
                continue
            if status >= 400:
                await response.aclose()
                self.slots.release()
                raise Skip(f"HTTP {status}")
            break
        if response is None:
            raise RuntimeError(f"gave up after {RETRIES} attempts: {last}")
        try:
            yield response
        finally:
            await response.aclose()
            self.slots.release()

    async def read_text(self, response: httpx.Response, limit: int = PAGE_LIMIT) -> str:
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes(1 << 16):
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                break
        body = b"".join(chunks)
        if body[:2] == b"\x1f\x8b":
            body = gzip.decompress(body)
        return body.decode(response.encoding or "utf-8", errors="replace")

    async def get_text(self, url: str) -> tuple[str, str]:
        async with self.fetch(url) as response:
            return str(response.url), await self.read_text(response)

    # ---------------------------------------------------------------- robots
    async def robots_for(self, host: str) -> RobotFileParser:
        parser = self.robots.get(host)
        if parser is not None:
            return parser
        async with self.robots_locks.setdefault(host, asyncio.Lock()):
            if host in self.robots:
                return self.robots[host]
            parser = RobotFileParser()
            lines: list[str] = []
            scheme = "http" if host in self.http_only else "https"
            try:
                response = await self.client.get(f"{scheme}://{host}/robots.txt", timeout=20)
                text = response.text
                if response.status_code in (401, 403):
                    lines = ["User-agent: *", "Disallow: /"]
                elif response.status_code == 200 and "<html" not in text[:500].lower():
                    lines = text.splitlines()
            except httpx.HTTPError:
                pass  # unreachable robots.txt: nothing is disallowed
            parser.parse(lines)
            self.robots[host] = parser
            return parser

    async def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        return (await self.robots_for(parts.hostname or "")).can_fetch(USER_AGENT, url)

    # ------------------------------------------------------------- discovery
    def add_host(self, host: str) -> None:
        if host in self.known_hosts or host == LIBRARY_HOST or "web" not in self.sources:
            return
        self.known_hosts.add(host)
        if self.only_hosts and host not in self.only_hosts:
            return
        scheme = "http" if host in self.http_only else "https"
        self.submit(Job("host", f"{scheme}://{host}/robots.txt", f"host:{host}", {"host": host}))

    def submit_page(self, url: str, depth: int, referrer: str) -> None:
        host = urlsplit(url).hostname or ""
        self.add_host(host)
        if self.only_hosts and host not in self.only_hosts:
            return
        if self.args.max_depth and depth > self.args.max_depth:
            return
        self.submit(Job("page", url, url, {"depth": depth, "ref": referrer}))

    def submit_file(self, url: str, referrer: str, label: str, page_title: str, extra: dict[str, Any] | None = None) -> None:
        data = {"ref": referrer, "label": label, "page_title": page_title}
        data.update(extra or {})
        self.submit(Job("file", url, url, data))

    def submit_google(self, url: str, referrer: str, label: str, page_title: str, subdir: str = "") -> None:
        if "drive" not in self.sources:
            return
        parts = urlsplit(url)
        host, path = parts.hostname or "", parts.path
        query = dict(parse_qsl(parts.query))
        ref_host = urlsplit(referrer).hostname or "google"
        base = {"drive": True, "ref_host": ref_host, "subdir": subdir}
        doc = re.match(r"/(document|spreadsheets|presentation)/d/([\w-]{10,})", path)
        if host == "docs.google.com" and doc:
            kind, doc_id = doc.groups()
            export = {
                "document": (f"https://docs.google.com/document/d/{doc_id}/export?format=docx", ".docx"),
                "spreadsheets": (f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=xlsx", ".xlsx"),
                "presentation": (f"https://docs.google.com/presentation/d/{doc_id}/export/pptx", ".pptx"),
            }[kind]
            self.submit(Job("file", export[0], f"gdoc:{doc_id}",
                            {"ref": referrer, "label": label, "page_title": page_title, "ext": export[1], **base}))
            return
        folder = re.search(r"/folders/([\w-]{10,})", path)
        if folder:
            folder_id = folder.group(1)
            self.submit(Job("drive_folder", f"https://drive.google.com/embeddedfolderview?id={folder_id}",
                            f"gfolder:{folder_id}", {"ref": referrer, "page_title": page_title, **base}))
            return
        file_match = re.search(r"/file/d/([\w-]{10,})", path)
        file_id = file_match.group(1) if file_match else query.get("id")
        if file_id and re.fullmatch(r"[\w-]{10,}", file_id):
            self.submit(Job("file", f"https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t",
                            f"gfile:{file_id}", {"ref": referrer, "label": label, "page_title": page_title, **base}))

    def route(self, raw: str, base: str, depth: int, labels: dict[str, str], page_title: str) -> None:
        url = unwrap_viewer(urljoin(base, raw))
        url = normalize(url, self.http_only) if url else None
        if not url:
            return
        parts = urlsplit(url)
        host = parts.hostname or ""
        label = labels.get(raw) or labels.get(urljoin(base, raw), "")
        if host in GOOGLE_HOSTS:
            self.submit_google(url, base, label, page_title)
            return
        if host == LIBRARY_HOST:
            return  # the library is its own source
        ext = url_ext(url)
        if ext in DOC_EXTS:
            if is_university(host) or self.args.external_files:
                self.submit_file(url, base, label, page_title)
            return
        if not is_university(host) or "web" not in self.sources:
            return
        if ext in SKIP_EXTS or SKIP_PATH.search(parts.path) or SKIP_QUERY.search(parts.query):
            return
        if len(parts.query) > 200 or parts.path.count("/") > 12:
            return  # calendars and filter combinations: crawler traps
        self.submit_page(url, depth + 1, base)

    def discover(self, base: str, text: str, depth: int) -> None:
        title_match = TITLE_RE.search(text)
        page_title = re.sub(r"\s+", " ", html.unescape(title_match.group(1))).strip()[:300] if title_match else ""
        labels = anchor_texts(text, base)
        for raw in extract_urls(text):
            self.route(raw, base, depth, labels, page_title)
        host = urlsplit(base).hostname or ""
        if ("wp-content" in text or "wp-json" in text) and host not in self.wp_hosts and is_university(host):
            self.wp_hosts.add(host)
            self.submit(Job("wp_media", self.wp_media_url(base, 1), f"wp:{host}:1", {"page": 1}))

    @staticmethod
    def wp_media_url(base: str, page: int) -> str:
        parts = urlsplit(base)
        return f"{parts.scheme}://{parts.netloc}/wp-json/wp/v2/media?per_page=100&page={page}&_fields=source_url,title,mime_type,link"

    # -------------------------------------------------------------- handlers
    async def handle_host(self, job: Job) -> None:
        host = job.data["host"]
        scheme = "http" if host in self.http_only else "https"
        root = f"{scheme}://{host}/"
        self.submit_page(root, 0, root)
        parser = await self.robots_for(host)
        sitemaps = list(parser.site_maps() or []) + [f"{root}sitemap.xml", f"{root}sitemap_index.xml", f"{root}wp-sitemap.xml"]
        for sitemap in sitemaps:
            normalized = normalize(sitemap, self.http_only)
            if not normalized:
                continue
            if not is_university(urlsplit(normalized).hostname or ""):  # misconfigured: same path on this host
                parts = urlsplit(normalized)
                normalized = urlunsplit((scheme, host, parts.path, parts.query, ""))
            self.submit(Job("sitemap", normalized, f"sitemap:{normalized}", {"host": host}))

    async def handle_page(self, job: Job) -> None:
        host = urlsplit(job.url).hostname or ""
        if not await self.allowed(job.url):
            raise Skip("robots.txt")
        if self.args.max_pages_per_host and self.host_pages[host] >= self.args.max_pages_per_host:
            raise Skip("page limit for host")
        self.host_pages[host] += 1
        async with self.fetch(job.url) as response:
            final = str(response.url)
            if looks_like_document(response, final):
                await self.store_response(response, job.url, {**job.data, "page_title": ""})
                return
            mime = mime_of(response)
            if mime and "html" not in mime and "xml" not in mime:
                raise Skip(f"not a page: {mime}")
            text = await self.read_text(response)
        final_host = urlsplit(final).hostname or ""
        if not is_university(final_host):
            raise Skip(f"redirected off the university: {final_host}")
        self.stats["pages"] += 1
        self.discover(final, text, int(job.data.get("depth", 0)))

    async def handle_sitemap(self, job: Job) -> None:
        if not await self.allowed(job.url):
            raise Skip("robots.txt")
        host = job.data["host"]
        _, text = await self.get_text(job.url)
        if "<urlset" not in text and "<sitemapindex" not in text:
            raise Skip("not a sitemap")
        scheme = urlsplit(job.url).scheme
        locs = [html.unescape(loc.strip()) for loc in re.findall(r"<loc>\s*(.*?)\s*</loc>", text, re.DOTALL)]
        index = "<sitemapindex" in text
        for loc in locs:
            parts = urlsplit(loc)
            if not is_university(parts.hostname or ""):  # e.g. dev.hcmutertic.com in the new platform's sitemap
                loc = urlunsplit((scheme, host, parts.path or "/", parts.query, ""))
            if index:
                normalized = normalize(loc, self.http_only)
                if normalized:
                    self.submit(Job("sitemap", normalized, f"sitemap:{normalized}", {"host": host}))
            else:
                self.route(loc, job.url, 0, {}, "")
        self.stats["sitemaps"] += 1

    async def handle_wp_media(self, job: Job) -> None:
        if not await self.allowed(job.url):
            raise Skip("robots.txt")
        async with self.fetch(job.url) as response:
            if "json" not in mime_of(response):
                raise Skip("no WordPress media listing")
            items = json.loads(await self.read_text(response))
            total_pages = int(response.headers.get("x-wp-totalpages", "0") or 0)
        page = int(job.data["page"])
        host = urlsplit(job.url).hostname or ""
        for item in items if isinstance(items, list) else []:
            mime = str(item.get("mime_type") or "")
            source = item.get("source_url")
            if not source or mime.startswith(("image/", "video/", "audio/")):
                continue
            title = html.unescape(str((item.get("title") or {}).get("rendered") or ""))
            normalized = normalize(urljoin(job.url, source), self.http_only)
            if normalized:
                self.submit_file(normalized, str(item.get("link") or job.url), title, "")
        if isinstance(items, list) and len(items) == 100 and (not total_pages or page < total_pages):
            self.submit(Job("wp_media", self.wp_media_url(job.url, page + 1), f"wp:{host}:{page + 1}", {"page": page + 1}))

    async def handle_drive_folder(self, job: Job) -> None:
        _, text = await self.get_text(job.url)
        title_match = TITLE_RE.search(text)
        folder = safe_segment(html.unescape(title_match.group(1)).strip()) if title_match else job.key.split(":", 1)[1]
        subdir = "/".join(s for s in (job.data.get("subdir", ""), folder) if s)
        labels = anchor_texts(text, job.url)
        for href, label in labels.items():
            if "drive.google.com" in href or "docs.google.com" in href:
                self.submit_google(href, job.data["ref"], label, job.data.get("page_title", ""), subdir)

    async def handle_file(self, job: Job) -> None:
        if self.args.dry_run:
            print(f"  > {job.url}  ({job.data.get('label') or job.data.get('title') or ''})"[:200])
            raise Skip("dry run")
        async with self.fetch(job.url) as response:
            await self.store_response(response, job.url, job.data)

    # ------------------------------------------------------------- storage
    def destination(self, url: str, final: str, response: httpx.Response, data: dict[str, Any]) -> Path:
        if data.get("dest"):
            return self.out / data["dest"]
        name = filename_from_disposition(response.headers.get("content-disposition")) or ""
        path = unquote(urlsplit(final).path)
        if Path(name).suffix.lower() not in DOC_EXTS:
            from_url = Path(path).name
            if Path(from_url).suffix.lower() in DOC_EXTS:
                name = from_url
            else:  # handler URL (Download.aspx?id=...) or a name without extension
                ext = data.get("ext") or DOC_MIME.get(mime_of(response)) or ".bin"
                stem = Path(name).stem if name else (data.get("label") or data.get("title") or Path(path).stem or "document")
                name = f"{safe_segment(stem, 100)}{ext}"
        name = safe_segment(name)
        if data.get("drive"):
            folder = self.out / "web" / safe_segment(data.get("ref_host", "google")) / "_drive"
            for part in filter(None, str(data.get("subdir", "")).split("/")):
                folder /= safe_segment(part)
            return folder / name
        parts = urlsplit(url)
        folder = self.out / "web" / safe_segment(parts.hostname or "unknown")
        segments = [s for s in unquote(parts.path).split("/") if s]
        if segments and Path(segments[-1]).suffix.lower() in DOC_EXTS:
            segments = segments[:-1]
        for segment in segments[:10]:
            folder /= safe_segment(segment, 80)
        if parts.query:  # handler URLs (Download.aspx?id=...) share one path
            name = f"{Path(name).stem}-{short_hash(url)}{Path(name).suffix}"
        return folder / name

    async def store_response(self, response: httpx.Response, url: str, data: dict[str, Any]) -> None:
        final = str(response.url)
        mime = mime_of(response)
        if mime == "text/html":
            raise Skip("HTML instead of a document")
        if mime.startswith(("image/", "video/", "audio/", "text/")):
            raise Skip(f"not a document: {mime}")  # Drive links often point at photos and videos
        named = filename_from_disposition(response.headers.get("content-disposition"))
        if named and Path(named).suffix.lower() not in DOC_EXTS and mime not in DOC_MIME:
            raise Skip(f"not a document: {Path(named).suffix or mime}")
        limit = self.args.max_file_mb << 20
        length = int(response.headers.get("content-length", "0") or 0)
        if limit and length > limit:
            raise Skip(f"too large ({human_size(length)})")
        dest = self.destination(url, final, response, data)
        known = self.store.paths.get(str(dest))
        if (known and known != url) or str(dest) in self.claimed:  # another URL owns or is writing this name
            dest = dest.with_name(f"{dest.stem}-{short_hash(url)}{dest.suffix}")
        self.claimed.add(str(dest))
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        digest = hashlib.sha256()
        size = 0
        head = b""
        try:
            with open(part, "wb") as handle:  # noqa: ASYNC230  chunk writes are short; the network is the bottleneck
                async for chunk in response.aiter_bytes(1 << 17):
                    if not head:
                        head = chunk[:64]
                    handle.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                    if limit and size > limit:
                        raise Skip(f"too large (> {self.args.max_file_mb} MB)")
        except BaseException:
            part.unlink(missing_ok=True)
            raise
        lowered = head.lstrip().lower()
        if size == 0 or lowered.startswith((b"<!doctype html", b"<html")):
            part.unlink(missing_ok=True)
            raise Skip("empty or HTML instead of a document")
        sha = digest.hexdigest()
        duplicate_of = self.store.shas.get(sha)
        if duplicate_of and duplicate_of != str(dest):
            part.unlink(missing_ok=True)
            self.stats["duplicates"] += 1
        else:
            duplicate_of = None
            part.replace(dest)
            self.stats["files"] += 1
            self.stats["bytes"] += size
        title = data.get("title") or data.get("label") or dest.stem
        row = {
            "url": url, "path": duplicate_of or str(dest), "sha256": sha, "bytes": size, "mime": mime_of(response),
            "kind": data.get("kind") or classify_kind(dest.name, data.get("label", ""), data.get("page_title", ""), url),
            "title": title, "source_page": data.get("ref"), "host": urlsplit(url).hostname,
            "duplicate_of": duplicate_of, "fetched_at": time.time(),
        }
        self.store.record_file(row)
        if duplicate_of:
            return
        if self.manifest:
            self.manifest.write(json.dumps({**row, "path": str(dest.relative_to(self.out))}, ensure_ascii=False) + "\n")
        if not self.args.quiet:
            print(f"  + {human_size(size):>9}  {row['kind']:<22} {dest.relative_to(self.out)}"[:220])

    # ------------------------------------------------------------- library
    async def handle_library_home(self, job: Job) -> None:
        _, text = await self.get_text(job.url)
        categories: list[dict[str, Any]] = []
        seen: set[str] = set()
        for node in find_all(decode_nuxt(text), "link"):
            link, name = node.get("link"), node.get("name")
            if not isinstance(link, str) or not link.startswith("/") or link.startswith(("/tin-tuc", "/tai-lieu")):
                continue
            if "count" not in node or node.get("children") or link in seen:
                continue  # parents only aggregate their children
            seen.add(link)
            categories.append({"name": name, "path": link, "count": node.get("count") or 0})
        if self.args.list_categories:
            for category in categories:
                print(f"{category['count']:>7}  {category['path']:<48} {category['name']}")
            return
        wanted = [t.strip("/").lower() for t in (self.args.categories or [])]
        for category in categories:
            path = category["path"].strip("/")
            if wanted and not any(path == t or path.endswith("/" + t) or str(category["name"]).lower() == t for t in wanted):
                continue
            self.submit(Job("tv_list", self.library_page_url(category["path"], 1), f"tv:list:{category['path']}:1",
                            {"path": category["path"], "name": category["name"], "page": 1}))

    @staticmethod
    def library_page_url(path: str, page: int) -> str:
        base = LIBRARY_URL + path
        return base if page <= 1 else f"{base}{'&' if '?' in base else '?'}page={page}"

    async def handle_library_list(self, job: Job) -> None:
        _, text = await self.get_text(job.url)
        payload = decode_nuxt(text)
        meta = next(find_all(payload, "next_page_url"), None) if payload is not None else None
        items = (meta or {}).get("resources")
        documents = [i for i in items if isinstance(i, dict) and i.get("link")] if isinstance(items, list) else []
        if not documents:
            documents = [{"link": link} for link in dict.fromkeys(re.findall(r'href="(/tai-lieu/[^"]+\.html)"', text))]
        for document in documents:
            link = document["link"]
            doc_id = str(document.get("resource_id") or "") or library_doc_id(link)
            self.submit(Job("tv_detail", urljoin(LIBRARY_URL, link), f"tv:doc:{doc_id}",
                            {"link": link, "category": job.data["name"], "category_path": job.data["path"]}))
        page = int(job.data["page"])
        if meta and meta.get("next_page_url") and (not self.args.max_pages or page < self.args.max_pages):
            path = job.data["path"]
            self.submit(Job("tv_list", self.library_page_url(path, page + 1), f"tv:list:{path}:{page + 1}",
                            {**job.data, "page": page + 1}))
        self.stats["library_pages"] += 1

    async def handle_library_detail(self, job: Job) -> None:
        if self.args.max_docs and self.library_docs >= self.args.max_docs:
            raise Skip("--max-docs reached")
        self.library_docs += 1
        _, text = await self.get_text(job.url)
        payload = decode_nuxt(text)
        wanted = library_doc_id(job.data["link"])
        candidates = list(find_all(payload, "pdf_file_path")) if payload is not None else []
        detail = next((c for c in candidates if str(c.get("resource_id") or "") == wanted), None)
        if detail is None:
            detail = next((c for c in candidates if str(c.get("link") or "").rstrip("/") == job.data["link"].rstrip("/")), None)
        if detail is None:
            raise RuntimeError("no metadata for this document")
        file_url = str(detail.get("pdf_file_path") or "").strip()
        if not file_url:
            self.stats["library_no_file"] += 1
            raise Skip("no file")
        if not self.args.force and detail.get("resource_allowdownload") != 1:
            self.stats["library_read_only"] += 1
            raise Skip("library marks it read-only")
        title = str(detail.get("resource_title") or "document").strip()
        doc_id = str(detail.get("resource_id") or wanted)
        ext = url_ext(file_url)
        if not ext or len(ext) > 6:
            fmt = str(detail.get("resource_format") or "").strip().lower()
            ext = f".{fmt}" if fmt.isalnum() else ".pdf"
        dest = f"thuvienso/{slugify(job.data['category_path'], 60)}/{slugify(title)}-{doc_id}{ext}"
        self.submit(Job("file", file_url, file_url, {
            "ref": job.url, "title": title, "dest": dest,
            "kind": classify_kind(job.data["category_path"].strip("/").split("/")[-1], job.data["category"], title,
                                  job.data["category_path"]),
        }))

    # ---------------------------------------------------------------- run
    async def progress(self) -> None:
        while True:
            await asyncio.sleep(self.args.progress)
            elapsed = time.monotonic() - self.started
            queued = sum(q.qsize() for q in self.queues.values())
            print(f"[{elapsed / 60:5.1f} min] hosts {len(self.queues):>3} | pages {self.stats['pages']:>6} | "
                  f"files {self.stats['files']:>6} ({human_size(self.stats['bytes'])}, "
                  f"{human_size(self.stats['bytes'] / max(elapsed, 1))}/s) | dup {self.stats['duplicates']} | "
                  f"queued {queued} | in flight {self.args.concurrency - self.slots._value}", flush=True)

    @staticmethod
    def source_of(job: Job) -> str:
        if job.kind.startswith("tv_") or job.data.get("dest", "").startswith("thuvienso/"):
            return "thuvienso"
        if job.data.get("drive") or job.kind == "drive_folder":
            return "drive"
        return "web"

    async def run(self) -> None:
        resumed = [job for job in self.store.unfinished() if self.source_of(job) in self.sources]
        for job in resumed:
            if job.kind == "host":
                self.known_hosts.add(job.data["host"])
            self.submit(job, persist=False)
        for key in self.store.keys:  # hosts already crawled in earlier runs
            if key.startswith("host:"):
                self.known_hosts.add(key[5:])
            elif key.startswith("wp:"):
                self.wp_hosts.add(key.split(":")[1])
        if resumed:
            print(f"Resuming {len(resumed)} unfinished jobs")
        if self.args.list_categories:
            self.submit(Job("tv_home", LIBRARY_URL + "/", "tv:home"), persist=False)
        else:
            if "web" in self.sources:
                for seed in self.args.seeds or SEED_URLS:
                    normalized = normalize(seed, self.http_only)
                    if normalized:
                        self.submit_page(normalized, 0, normalized)
                for host in self.only_hosts:
                    self.add_host(host)
            if "thuvienso" in self.sources:
                self.submit(Job("tv_home", LIBRARY_URL + "/", "tv:home"))
        if self.outstanding == 0:
            return
        reporter = asyncio.create_task(self.progress())
        try:
            await self.done.wait()
        finally:
            reporter.cancel()
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(*self.tasks, reporter, return_exceptions=True)
            await self.client.aclose()
            if self.manifest:
                self.manifest.close()


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def report(store: Store, out: Path) -> None:
    db = store.db
    print("=== files stored ===")
    rows = db.execute("SELECT kind, COUNT(*), SUM(bytes) FROM files WHERE duplicate_of IS NULL GROUP BY kind ORDER BY 2 DESC")
    total_files = total_bytes = 0
    for kind, count, size in rows:
        total_files += count
        total_bytes += size or 0
        print(f"  {kind:<24} {count:>7}  {human_size(size or 0):>10}")
    duplicates = db.execute("SELECT COUNT(*) FROM files WHERE duplicate_of IS NOT NULL").fetchone()[0]
    print(f"  {'total':<24} {total_files:>7}  {human_size(total_bytes):>10}   (+{duplicates} duplicate URLs)")
    print("=== by site (top 25) ===")
    for host, count, size in db.execute(
            "SELECT host, COUNT(*), SUM(bytes) FROM files WHERE duplicate_of IS NULL GROUP BY host ORDER BY 2 DESC LIMIT 25"):
        print(f"  {host or '?':<40} {count:>7}  {human_size(size or 0):>10}")
    print("=== jobs ===")
    for kind, state, count in db.execute("SELECT kind, state, COUNT(*) FROM jobs GROUP BY kind, state ORDER BY kind, state"):
        print(f"  {kind:<14} {state:<9} {count:>8}")
    print("=== most common reasons (skipped / failed) ===")
    for error, count in db.execute(
            "SELECT error, COUNT(*) FROM jobs WHERE state IN ('skipped','failed') GROUP BY error ORDER BY 2 DESC LIMIT 12"):
        print(f"  {count:>7}  {(error or '')[:110]}")
    print(f"saved under {out}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect every public HCMUTE document: all *.hcmute.edu.vn sites, the Drive files they "
                    "link, and the digital library (thuvienso).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python main.py\n"
               "  python main.py --sources web drive --hosts sdh.hcmute.edu.vn\n"
               "  python main.py --sources thuvienso -c do-an-khoa-luan-tot-nghiep\n"
               "  python main.py --refresh\n"
               "  python main.py --report\n",
    )
    parser.add_argument("--out", default=str(DEFAULT_OUT), help=f"output folder (default: {DEFAULT_OUT})")
    parser.add_argument("--sources", nargs="+", choices=("web", "drive", "thuvienso"),
                        default=["web", "drive"], help="what to collect (default: web drive)")
    parser.add_argument("--hosts", nargs="+", metavar="HOST", help="crawl only these university hosts")
    parser.add_argument("--seeds", nargs="+", metavar="URL", help="start pages (default: homepage + organisation chart)")
    parser.add_argument("--concurrency", type=int, default=48, help="requests in flight overall (default: 48)")
    parser.add_argument("--per-host", type=int, default=4, help="parallel requests per site (default: 4; CDNs x3)")
    parser.add_argument("--delay", type=float, default=0.0, help="minimum seconds between requests to one site")
    parser.add_argument("--max-pages-per-host", type=int, default=30000, help="page cap per site (0 = none)")
    parser.add_argument("--max-depth", type=int, default=0, help="link depth from a site's root (0 = none)")
    parser.add_argument("--max-file-mb", type=int, default=500, help="skip files larger than this (0 = none)")
    parser.add_argument("--external-files", action="store_true",
                        help="also download documents hosted outside hcmute.edu.vn that university pages link")
    parser.add_argument("--refresh", action="store_true",
                        help="read pages, sitemaps and listings again to find new files (stored files are kept)")
    parser.add_argument("--dry-run", action="store_true", help="list files instead of downloading (state not saved)")
    parser.add_argument("--report", action="store_true", help="summarize what is stored and exit")
    parser.add_argument("--quiet", action="store_true", help="no per-file lines, progress only")
    parser.add_argument("--progress", type=float, default=15.0, help="seconds between progress lines")
    library = parser.add_argument_group("thuvienso (digital library)")
    library.add_argument("-c", "--categories", nargs="+", action="extend", metavar="PATH",
                         help="category paths or slugs (default: all)")
    library.add_argument("--list-categories", action="store_true", help="print the category tree and exit")
    library.add_argument("--max-pages", type=int, default=0, help="listing pages per category (0 = all)")
    library.add_argument("--max-docs", type=int, default=0, help="stop after N documents (0 = no limit)")
    library.add_argument("--force", action="store_true",
                         help="also fetch documents the library marks read-only (only with its permission)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    store = Store(":memory:" if args.dry_run or args.list_categories else str(out / "state.sqlite"))
    if args.report:
        report(store, out)
        return 0
    if args.refresh:
        print(f"Re-reading {store.reopen_listings()} pages, sitemaps and listings")
    crawler = Crawler(args, store, out)
    print(f"Output      : {out}")
    print(f"Sources     : {', '.join(args.sources)}{'  (hosts: ' + ', '.join(args.hosts) + ')' if args.hosts else ''}")
    print(f"Concurrency : {args.concurrency} overall, {args.per_host} per site\n")
    try:
        asyncio.run(crawler.run())
    except KeyboardInterrupt:
        print("\ninterrupted - run again to resume", file=sys.stderr)
        return 130
    finally:
        store.close()
    if args.list_categories:
        return 0
    elapsed = time.monotonic() - crawler.started
    stats = crawler.stats
    print(f"\n=== this run ({elapsed / 60:.1f} min) ===")
    print(f"pages read   : {stats['pages']}   sitemaps: {stats['sitemaps']}   library pages: {stats['library_pages']}")
    print(f"files stored : {stats['files']} ({human_size(stats['bytes'])})   duplicates skipped: {stats['duplicates']}")
    print(f"library      : read-only {stats['library_read_only']}, no file {stats['library_no_file']}")
    failed = sum(v for k, v in stats.items() if k.startswith("failed_"))
    print(f"failed jobs  : {failed}   throttled responses: {stats['throttled']}")
    if not args.dry_run:
        print(f"details      : python main.py --report --out {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
