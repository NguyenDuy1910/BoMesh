# UTE (HCMUTE) library downloader

Simple `requests`-based crawler that walks the HCMUTE digital library and saves
the documents the library itself marks as downloadable.

```bash
pip install -r requirements.txt
python main.py                          # all categories, all pages
python main.py --list-categories        # show the category tree and exit
python main.py -c do-an-khoa-luan-tot-nghiep --max-pages 2 --max-docs 20
python main.py -c slide-bai-giang --dry-run
```

Files land in `downloads/` next to `main.py` as
`<slugified-title>-<document-id>.<ext>`.

## What the sites actually are

| URL | Verdict |
| --- | --- |
| `thuvienso.hcmute.edu.vn` | **The real repository** (dlib.vn platform). Full-text PDFs, ~14 000 documents across 38 leaf categories. This is what the crawler uses. |
| `lib.hcmute.edu.vn` | Library portal: news, guides, service pages. No documents. |
| `lib.hcmute.edu.vn/tra-cuu-opac` | HTTP 404. The OPAC is not hosted there. |
| `library.hcmute.edu.vn/Libol50/search/libfram.asp` | Libol catalogue (frameset of `libmenu.asp` / `frmBook.asp` …). Bibliographic records only — authors, call numbers, availability — with no file or attachment endpoint, and its WAF blocks browser automation (`Web Page Blocked!`). Nothing to download. |

## How the crawler talks to thuvienso

1. **Categories** come from the homepage menu in the Nuxt payload: each node has
   `name`, `link` and `count`. Only leaf nodes are crawled, because parent
   counts are the exact sum of their children (`luan-van` 14352 =
   2772 + 10023 + 1557), so parents would double-count.
2. **Pagination** is the plain query parameter `?page=N` (18 documents per
   page). The listing payload exposes `current_page`, `per_page`,
   `resources[]` and `next_page_url`; `next_page_url` is `null` on the last
   page and that is the stop signal.
3. **Document pages** are `/tai-lieu/<slug>-<id>.html`. Their payload holds
   `resource_title`, `resource_id`, `resource_format` and `pdf_file_path`
   (a public `cdn.dlib.vn` URL). Careful: a detail page also embeds ~10
   "related document" objects with the same fields, so the crawler matches the
   object whose `resource_id` equals the id in the requested URL.
4. **Files** are plain anonymous GETs from `cdn.dlib.vn` — no cookies, no
   tokens, no referer check, `Content-Type: application/pdf`, ranged requests
   supported.

The whole site is server-rendered (Nuxt SSR), so no browser automation is
needed: HTTP + JSON payload decoding is enough. `BeautifulSoup` is used only to
read the one `<script id="__NUXT_DATA__">` tag, with a regex fallback, so the
script still runs with `requests` alone.

## Access rules

* Only documents with `resource_allowdownload == 1` are downloaded. Items
  flagged `0` are read-only on the library's terms; they are counted and
  skipped. `--force` overrides this — use it only with explicit written
  permission from the library.
* No login, no CAPTCHA solving, no user-agent spoofing beyond a normal browser
  string, no proxy rotation.
* One request at a time, `--delay` seconds apart (default 1.0 s), with
  exponential backoff on `429/5xx` and `Retry-After` support.
* Note: `thuvienso.hcmute.edu.vn/robots.txt` currently serves
  `User-agent: * / Disallow: /` under the comment *"allow normal web crawlers
  and search engines"* — a contradictory template. Treat it as a signal that
  bulk crawling needs the library's consent. Only run this at scale if you have
  it.

## Options

| Flag | Meaning |
| --- | --- |
| `-c, --categories PATH...` | category path or slug (`do-an-khoa-luan-tot-nghiep`, `/ky-nang/ky-nang-so/`) |
| `--max-pages N` | listing pages per category (0 = all) |
| `--max-docs N` | stop after examining N documents |
| `--delay SECONDS` | pause between requests (default 1.0) |
| `--out DIR` | download folder (default `downloads/` next to `main.py`) |
| `--dry-run` | show what would be downloaded |
| `--list-categories` | print the category tree with document counts |
| `--force` | include items the library marks read-only |

## Behaviour

* Skips files whose `<title>-<id>` already exists (safe to re-run / resume).
* Downloads to `<name>.part` and renames on success, so an interrupted run
  never leaves a half file behind.
* Rejects responses that are not a document (HTML error page, zero bytes).
* Prints one line per document plus a summary (downloaded / skipped / failed).
* Uses only `requests` + optional `beautifulsoup4`; no Playwright, no database.

## UTE workspace setup files

| File | Import it in | What it creates |
| --- | --- | --- |
| `hcmute_domains_topics.csv` | Knowledge Studio → Topics → Import | The domain → topic taxonomy CLASSIFYING assigns while processing |
| `hcmute_folders.json` | Knowledge Studio → Collections → *the collection* → Contents → Import folders | 109 folders: each faculty/institute with Bài giảng & slide · Giáo trình & tài liệu tham khảo · Đề cương học phần · Đề thi & đáp án · Đồ án, khóa luận & luận văn · Văn bản & thông báo của đơn vị; the university's offices; learner guides |

Folders decide who reads a document (one parent each); topics say what it is
about (several per document, applied automatically). Restrict *Đề thi & đáp án*
folders to the faculty's lecturers after importing. Re-importing the file
creates only the folders that are missing.
