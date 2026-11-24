"""Split the crawled UTE files into ingestion batches that grow in size.

Reads the crawler's ``state.sqlite`` (read-only) and lays the unique files under
``web/`` out as numbered batch folders. Each batch mirrors the HCM-UTE
collection tree (``seed_fixtures/hcmute/collections.json``), so a batch's
relative path is the collection a document belongs in:

    batches/
      001-wave1-10/
        manifest.jsonl                    one line per file: source URL, sha256, collection, ...
        Khoa Xây dựng/Đề thi & đáp án/<file>
        Văn bản & quy định của Trường/Đào tạo/<file>
      002-wave1-25/
      ...
      excluded.jsonl                      files no batch takes (format or size the API refuses)
      held.jsonl                          files kept back for review (likely personal data)

Files are hard links into the crawl output: a batch costs no disk space, and
deleting a batch folder never touches the crawl. Batches never mix waves:

    wave 1  university pages, file kind known
    wave 2  Google Drive files with a known kind, and university files of kind ``khac``
    wave 3  Google Drive files of kind ``khac`` (the noisiest group)

Within a wave, files are interleaved across format, unit and kind, so every batch
is a small cross-section of its wave; the first batch of a wave covers every format
present. Rerunning is incremental: files already in a batch stay where they are,
and files the crawler added since go into new batches.

Usage (from backend/script/ute_crawler):
    ../../.venv/bin/python batches.py             # write new batches
    ../../.venv/bin/python batches.py --dry-run   # only print the plan
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import shutil
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

DEFAULT_ROOT = Path.home() / "Documents" / "workspace" / "ute_docs"
DEFAULT_SIZES = (10, 25, 50, 100, 200, 400, 800)
#: An Ingestion Run selects at most 1000 items (``selector.items``).
DEFAULT_MAX_SIZE = 1000
#: BOMESH_DOCUMENT_MAX_UPLOAD_BYTES default; larger files are refused on upload.
DEFAULT_MAX_BYTES = 100 * 1024 * 1024
#: Formats an ingestion run reads. RAR/7z archives are stored as UNSUPPORTED.
SUPPORTED_EXTS = {
    ".pdf",
    ".doc",
    ".docx",
    ".docm",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".zip",
}

SCHOOL = "Văn bản & quy định của Trường"
#: Faculty and institute sites -> their collection.
FACULTIES = {
    "fme": "Khoa Cơ khí Chế tạo máy",
    "feee": "Khoa Điện – Điện tử",
    "feet": "Khoa Giao thông và Năng lượng",  # former Khoa Cơ khí Động lực (subdomain fae)
    "fit": "Khoa Công nghệ Thông tin",
    "fce": "Khoa Xây dựng",
    "civiltech": "Khoa Xây dựng",
    "fcft": "Khoa Công nghệ Hóa học và Thực phẩm",
    "fgam": "Khoa In và Truyền thông",
    "ffl": "Khoa Ngoại ngữ",
    "ite": "Viện Sư phạm Kỹ thuật",
}
#: Office and school-wide sites -> folder under "Văn bản & quy định của Trường" ("" = its root).
OFFICES = {
    "aao": "Đào tạo",
    "sdh": "Đào tạo",
    "nmo": "Đào tạo",
    "daotaotuxa": "Đào tạo",
    "fie": "Đào tạo",
    "lms": "Đào tạo",
    "binhphuoc": "Tuyển sinh",
    "alumni": "Công tác sinh viên",
    "stiao": "Khoa học & Công nghệ",
    "aspt2022": "Khoa học & Công nghệ",
    "oia": "Hợp tác quốc tế & đối ngoại",
    "qao": "Đảm bảo chất lượng & kiểm định",
    "tcns": "Tổ chức, nhân sự & hành chính",
    "dangbo": "Tổ chức, nhân sự & hành chính",
    "hd": "Tổ chức, nhân sự & hành chính",
    "pr": "Tổ chức, nhân sự & hành chính",
    "emo": "Tài chính & cơ sở vật chất",
    "lib": "Hạ tầng số, thông tin & thư viện",
    "trungtamtinhoc": "Hạ tầng số, thông tin & thư viện",
    "www": "",
}
#: Crawler kind -> faculty folder. ``khac`` stays at the faculty root.
FACULTY_FOLDERS = {
    "de_thi": "Đề thi & đáp án",
    "chuong_trinh_dao_tao": "Đề cương học phần",
    "giao_trinh_bai_giang": "Giáo trình & tài liệu tham khảo",
    "khoa_luan_do_an": "Đồ án, khóa luận & luận văn",
    "luan_van": "Đồ án, khóa luận & luận văn",
    "luan_an": "Đồ án, khóa luận & luận văn",
    "bieu_mau": "Văn bản & thông báo của đơn vị",
    "quy_che_van_ban": "Văn bản & thông báo của đơn vị",
    "ke_hoach_thong_bao": "Văn bản & thông báo của đơn vị",
    "nghien_cuu": "Văn bản & thông báo của đơn vị",
}
SLIDE_EXTS = {".ppt", ".pptx"}
#: School-level overrides by kind or keyword, before the site's own folder.
SCHOOL_BY_KIND = {
    "chuong_trinh_dao_tao": "Đào tạo",
    "nghien_cuu": "Khoa học & Công nghệ",
}
SCHOOL_BY_WORD = (("Tuyển sinh", re.compile(r"(?:^|-)tuyen-sinh(?:-|$)")),)

#: Held back for review: uploads to Google Forms and names that point at one person.
HOLD_RULES = (
    ("form upload (File responses)", re.compile(r"(?:^|-)file-responses(?:-|$)")),
    (
        "personal document",
        re.compile(
            r"(?:^|-)(?:van-bang|cccd|cmnd|can-cuoc|ly-lich|llkh|so-yeu-ly-lich"
            r"|giay-khai-sinh|hoc-ba|ho-so-ung-tuyen|screenshot|anh-chup-man-hinh)(?:-|$)"
        ),
    ),
)
#: Course outlines lecturers submitted through a form are not personal data.
HOLD_EXCEPT = re.compile(r"(?:^|-)(?:de-cuong|dcct)(?:-|$)")
#: A student number in a file name (21142340, 24TX825031); dates are told apart below.
STUDENT_ID = re.compile(r"(?<![0-9a-z])(?:1[5-9]|2[0-6])(?:tx)?\d{6}(?![0-9])")
#: Upload IDs some sites prefix to file names; their digits are not student numbers.
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


@dataclass(frozen=True)
class Planned:
    """One file of a batch, as written to its ``manifest.jsonl``."""

    sha256: str
    url: str
    source_page: str | None
    title: str | None
    kind: str
    site: str
    bytes: int
    wave: int
    collection: str  # "Unit" or "Unit/Folder", relative to the shared collection
    file: str  # path inside the batch folder
    crawl_path: str  # path under the crawl root


@dataclass(frozen=True)
class Source:
    sha256: str
    url: str
    path: Path
    bytes: int
    kind: str
    title: str | None
    source_page: str | None
    site: str
    drive: bool
    relative: str  # path under web/

    @property
    def ext(self) -> str:
        return self.path.suffix.lower()


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = (
        "".join(c for c in text if not unicodedata.combining(c))
        .replace("đ", "d")
        .replace("Đ", "D")
    )
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()


def is_date(digits: str) -> bool:
    """Eight digits read as a date (yyyymmdd, ddmmyyyy, yyyyddmm) or a school year (20252026)."""
    if 1990 <= int(digits[:4]) <= 2030 and int(digits[4:]) == int(digits[:4]) + 1:
        return True
    orders = ((0, 4, 6), (4, 2, 0), (0, 6, 4))  # start of year, month, day
    for year, month, day in orders:
        try:
            if 1990 <= int(digits[year : year + 4]) <= 2030:
                date(
                    int(digits[year : year + 4]),
                    int(digits[month : month + 2]),
                    int(digits[day : day + 2]),
                )
                return True
        except ValueError:
            continue
    return False


def load_sources(root: Path) -> list[Source]:
    web = root / "web"
    db = sqlite3.connect(f"file:{root / 'state.sqlite'}?mode=ro", uri=True)
    rows = db.execute(
        "select sha256, url, path, bytes, kind, title, source_page from files"
        " where duplicate_of is null order by fetched_at, url"
    ).fetchall()
    db.close()
    sources = []
    for sha256, url, path, size, kind, title, source_page in rows:
        full = Path(path) if Path(path).is_absolute() else root / path
        try:
            relative = full.relative_to(web)
        except ValueError:
            continue  # only the web/ tree is planned
        site = relative.parts[0].removesuffix(".hcmute.edu.vn")
        drive = "_drive" in relative.parts or "google" in urlhost(url)
        sources.append(
            Source(
                sha256,
                url,
                full,
                size,
                kind or "khac",
                title,
                source_page,
                site,
                drive,
                str(relative),
            )
        )
    return sources


def urlhost(url: str) -> str:
    return url.split("/", 3)[2] if "://" in url else ""


def exclusion(source: Source, max_bytes: int) -> str | None:
    if source.ext not in SUPPORTED_EXTS:
        return f"unsupported format ({source.ext or 'none'})"
    if source.bytes > max_bytes:
        return f"over the upload limit ({source.bytes / 1048576:.0f} MiB)"
    if not source.path.is_file():
        return "missing on disk"
    return None


def hold(source: Source) -> str | None:
    text = slugify(f"{source.relative} {source.title or ''}")
    if HOLD_EXCEPT.search(text):
        return None
    for reason, pattern in HOLD_RULES:
        if pattern.search(text):
            return reason
    name = slugify(UUID.sub("", source.path.stem))
    for match in STUDENT_ID.finditer(name):
        number = match.group()
        if "tx" in number or not is_date(number):
            return "student number in file name"
    return None


def wave(source: Source) -> int:
    if not source.drive:
        return 1 if source.kind != "khac" else 2
    return 2 if source.kind != "khac" else 3


def collection(source: Source) -> str:
    if source.site in FACULTIES:
        unit = FACULTIES[source.site]
        folder = FACULTY_FOLDERS.get(source.kind, "")
        if source.kind == "giao_trinh_bai_giang" and source.ext in SLIDE_EXTS:
            folder = "Bài giảng & slide"
        return f"{unit}/{folder}" if folder else unit
    text = slugify(f"{source.path.name} {source.title or ''}")
    folder = next(
        (name for name, pattern in SCHOOL_BY_WORD if pattern.search(text)), None
    )
    folder = folder or SCHOOL_BY_KIND.get(source.kind) or OFFICES.get(source.site, "")
    return f"{SCHOOL}/{folder}" if folder else SCHOOL


def interleave(sources: list[Source]) -> list[Source]:
    """Spread format, then unit and kind, evenly over the order; rare formats come first."""
    by_ext: dict[str, list[Source]] = defaultdict(list)
    for source in sources:
        by_ext[source.ext].append(source)
    lanes = []
    for group in by_ext.values():
        by_unit: dict[str, list[Source]] = defaultdict(list)
        for source in sorted(group, key=lambda s: (s.kind, s.url)):
            by_unit[collection(source)].append(source)
        mixed = [
            s for row in itertools.zip_longest(*by_unit.values()) for s in row if s
        ]
        lanes.append(mixed)
    lanes.sort(key=len)
    head = [lane[0] for lane in lanes]  # one of every format leads the wave
    rest = [
        (index / len(lane), source)
        for lane in lanes
        for index, source in enumerate(lane[1:], 1)
    ]
    return head + [source for _, source in sorted(rest, key=lambda pair: pair[0])]


def existing_batches(out: Path) -> tuple[set[str], int]:
    assigned: set[str] = set()
    count = 0
    for manifest in sorted(out.glob("[0-9][0-9][0-9]-*/manifest.jsonl")):
        count += 1
        with manifest.open(encoding="utf-8") as lines:
            assigned.update(
                json.loads(line)["sha256"] for line in lines if line.strip()
            )
    return assigned, count


def batch_name(source: Source, used: set[str], folder: str) -> str:
    """The file's own name, or with its hash when the folder has it already.

    macOS file names ignore case and Unicode normalization, so names are compared that way.
    """
    name = source.path.name
    key = unicodedata.normalize("NFC", f"{folder}/{name}").casefold()
    if key in used:
        name = f"{source.path.stem} ({source.sha256[:8]}){source.path.suffix}"
        key = unicodedata.normalize("NFC", f"{folder}/{name}").casefold()
    used.add(key)
    return name


def plan(args: argparse.Namespace) -> None:
    root: Path = args.root
    out: Path = args.out
    sources = load_sources(root)
    assigned, done = existing_batches(out)
    excluded, held, waves = [], [], defaultdict(list)
    for source in sources:
        if source.sha256 in assigned:
            continue
        if reason := exclusion(source, args.max_bytes):
            excluded.append((source, reason))
        elif reason := hold(source):
            held.append((source, reason))
        else:
            waves[wave(source)].append(source)

    sizes = [*args.sizes]
    batches: list[tuple[int, list[Source]]] = []
    for number in sorted(waves):
        queue = interleave(waves[number])
        while queue:
            index = done + len(batches)
            size = sizes[index] if index < len(sizes) else args.max_size
            batches.append((number, queue[:size]))
            queue = queue[size:]

    print(
        f"crawl: {len(sources)} unique files under {root / 'web'}; already in batches: {len(assigned)}"
    )
    for number, group in sorted(waves.items()):
        print(
            f"wave {number}: {len(group):>6} files  {sum(s.bytes for s in group) / 2**30:6.2f} GiB"
        )
    for label, items in (("excluded", excluded), ("held for review", held)):
        reasons = Counter(re.sub(r" \(\d+ MiB\)", "", reason) for _, reason in items)
        print(
            f"{label}: {len(items)}  "
            + ", ".join(f"{r}: {n}" for r, n in reasons.most_common())
        )
    print(f"new batches: {len(batches)}")
    for offset, (number, group) in enumerate(batches):
        exts = Counter(s.ext.lstrip(".") for s in group)
        print(
            f"  {done + offset + 1:03d}-wave{number}-{len(group):<5} {sum(s.bytes for s in group) / 2**20:8.1f} MiB  "
            + " ".join(f"{e}:{n}" for e, n in exts.most_common())
        )
    if args.dry_run:
        return

    out.mkdir(parents=True, exist_ok=True)
    for offset, (number, group) in enumerate(batches):
        final = out / f"{done + offset + 1:03d}-wave{number}-{len(group)}"
        # Built under a hidden name and renamed at the end, so an interrupted run leaves
        # no half batch that a rerun would count.
        folder = out / f".{final.name}.partial"
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir()
        used: set[str] = set()
        records = []
        for source in group:
            target = collection(source)
            name = batch_name(source, used, target)
            destination = folder / target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.link(source.path, destination)
            records.append(
                Planned(
                    sha256=source.sha256,
                    url=source.url,
                    source_page=source.source_page,
                    title=source.title,
                    kind=source.kind,
                    site=source.site,
                    bytes=source.bytes,
                    wave=number,
                    collection=target,
                    file=f"{target}/{name}",
                    crawl_path=str(source.path.relative_to(root)),
                )
            )
        with (folder / "manifest.jsonl").open("w", encoding="utf-8") as manifest:
            manifest.writelines(
                json.dumps(asdict(r), ensure_ascii=False) + "\n" for r in records
            )
        folder.rename(final)
    for filename, items in (("excluded.jsonl", excluded), ("held.jsonl", held)):
        with (out / filename).open("w", encoding="utf-8") as lines:
            for source, reason in items:
                record = {
                    "reason": reason,
                    "sha256": source.sha256,
                    "url": source.url,
                    "site": source.site,
                }
                record |= {
                    "kind": source.kind,
                    "bytes": source.bytes,
                    "crawl_path": str(source.path.relative_to(root)),
                }
                lines.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"wrote {len(batches)} batches to {out}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="crawl output (holds state.sqlite and web/)",
    )
    parser.add_argument(
        "--out", type=Path, help="batch folder (default: <root>/batches)"
    )
    parser.add_argument(
        "--sizes",
        type=lambda text: tuple(int(n) for n in text.split(",")),
        default=DEFAULT_SIZES,
        help="sizes of the first batches, comma separated (default: 10,25,50,100,200,400,800)",
    )
    parser.add_argument(
        "--max-size",
        type=int,
        default=DEFAULT_MAX_SIZE,
        help="size of every later batch",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help="largest file a batch takes",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the plan, write nothing"
    )
    args = parser.parse_args()
    args.out = args.out or args.root / "batches"
    if not (args.root / "state.sqlite").is_file():
        sys.exit(f"no state.sqlite under {args.root}")
    plan(args)


if __name__ == "__main__":
    main()
