# UTE (HCMUTE) document collector

Collects every document HCMUTE publishes on its official websites — theses and
dissertations, forms (biểu mẫu), regulations and decisions, curricula, plans
and notices, textbooks and slides — into one folder, ready to be uploaded to
the UTE workspace.

```bash
pip install -r requirements.txt            # httpx only
python main.py                             # every university site + linked Drive files → ~/Documents/workspace/ute_docs
python main.py --sources web drive thuvienso   # + the digital library (needs its consent, see Rules)
python main.py --report                    # what is stored, by kind and by site
python main.py --refresh                   # read pages again to find new files
python main.py --sources web drive --hosts sdh.hcmute.edu.vn aao.hcmute.edu.vn
python main.py --sources thuvienso -c do-an-khoa-luan-tot-nghiep
python main.py --list-categories           # thuvienso category tree
```

Without installing anything: `uv run --with httpx python main.py`.

## Sources

| Source | What | How |
| --- | --- | --- |
| `web` | Every `*.hcmute.edu.vn` site (~50 units: faculties, offices, centres, graduate school, party office…) | Starts from the homepage and `/gioi-thieu/so-do-to-chuc`, which link every unit; any new `*.hcmute.edu.vn` host found in a link is crawled too. Per host: robots.txt, its sitemaps plus `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, and on WordPress sites the public media listing `/wp-json/wp/v2/media`. |
| `drive` | Google Drive / Docs files and folders linked from those pages | Files via `drive.usercontent.google.com/download`; Docs/Sheets/Slides exported as DOCX/XLSX/PPTX; folders listed through `drive.google.com/embeddedfolderview`. Stored next to the site that links them. |
| `thuvienso` | `thuvienso.hcmute.edu.vn`, the digital library (~14 000 theses, textbooks, slides) | Nuxt payload: category menu → `?page=N` listings → `/tai-lieu/<slug>-<id>.html` → public `cdn.dlib.vn` file. |

What the sites look like (checked against the live sites):

* **New platform** (Next.js: `hcmute.edu.vn`, `fit`, `fpi`, `sao`, `ktx`, …):
  attachments live under `www.hcmute.edu.vn/hcmute-website-bucket/uploads/<unit>/document/…`
  and appear only in the RSC payload, not in `<a href>`; the crawler reads every URL
  in the page source. Category lists paginate through `/api/` (disallowed by
  robots.txt), so articles come from links and from the sitemap, which names the
  wrong host (`dev.hcmutertic.com`) — its paths are rewritten onto the sitemap's host.
* **Old ASP.NET sites** (`aao`, `sdh`, `fme`, `feee`, `fce`, `hd`, …): files under
  `/Resources/Docs/SubDomain/<unit>/…`. Articles are linked as `/?ArticleId=<id>` and
  `/ArticleId/<id>/<slug>`; both are one page. Old pages still link files on
  `hcmute.edu.vn/Resources/Docs/SubDomain/<unit>/…`, which 404 since the main site
  moved; those links are rewritten to `<unit>.hcmute.edu.vn`, which still serves them.
* **WordPress** (`dangbo`): the media listing names every upload.
* Their servers reset HTTP/2 streams, so the crawler speaks HTTP/1.1.
* `lib.hcmute.edu.vn` is the library portal (no files of its own); the Libol OPAC
  (`library.hcmute.edu.vn/Libol50`) has bibliographic records only.

## Output

```text
~/Documents/workspace/ute_docs/
  web/<host>/<url path>/<file>         files on university sites
  web/<host>/_drive/<folder>/<file>    Drive / Docs files linked from <host>
  thuvienso/<category>/<title>-<id>.<ext>
  manifest.jsonl                       one line per stored file
  state.sqlite                         crawl state (resume, duplicates, errors)
```

Each manifest line: `url`, `path` (relative to the output folder), `sha256`, `bytes`,
`mime`, `kind`, `title` (link text or library title), `source_page`, `host`.
`kind` is a best guess from the file name, link text, page title and URL:
`luan_an`, `luan_van`, `khoa_luan_do_an`, `bieu_mau`, `quy_che_van_ban`,
`chuong_trinh_dao_tao`, `giao_trinh_bai_giang`, `de_thi`, `nghien_cuu`,
`ke_hoach_thong_bao`, `khac`.

## Speed

* asyncio + httpx. Every host has its own queue and `--per-host` workers (4; CDNs and
  Google ×3); all hosts run in parallel under `--concurrency` requests in flight (48).
* A host answering 429/5xx is paused (Retry-After honoured, otherwise 5 s × attempt)
  without slowing the others; 4 attempts per request.
* Re-running resumes: finished pages and files are never fetched again. `--refresh`
  re-reads pages, sitemaps and listings only, so new files are found while stored
  ones are kept.
* The same file under several URLs (same SHA-256) is stored once.

## Rules

* robots.txt of every university host is honoured for pages, sitemaps and listings;
  disallowed paths (`/api/`, `/admin/`, `/manage/`…) are never requested. A document
  linked from a page is fetched like a reader clicking the link.
* No login, no forms, no CAPTCHA, no proxies.
* Pages are limited to university hosts. Documents hosted elsewhere that university
  pages link (ministry decrees…) are skipped unless `--external-files`.
* thuvienso is **opt-in** (`--sources web drive thuvienso`). Its `robots.txt` serves
  `User-agent: * / Disallow: /` under the comment *"allow normal web crawlers and
  search engines"* — a contradictory template, but the rule itself disallows
  everything, so bulk downloading the library needs its consent (ask the university
  library, Thư viện). When enabled, only documents it marks
  `resource_allowdownload == 1` are taken; the others are counted as read-only and
  skipped. `--force` overrides that — only with the library's written permission.

## Options

| Flag | Meaning |
| --- | --- |
| `--out DIR` | output folder (default `~/Documents/workspace/ute_docs`) |
| `--sources web drive thuvienso` | what to collect (default: all) |
| `--hosts HOST...` | crawl only these university hosts |
| `--seeds URL...` | start pages (default: homepage + organisation chart) |
| `--concurrency N` | requests in flight overall (48) |
| `--per-host N` | parallel requests per site (4) |
| `--delay SECONDS` | minimum interval between requests to one site (0) |
| `--max-pages-per-host N` | page cap per site (30000, 0 = none) |
| `--max-depth N` | link depth from a site's root (0 = none) |
| `--max-file-mb N` | skip larger files (500, 0 = none) |
| `--external-files` | also store documents hosted outside `hcmute.edu.vn` |
| `--refresh` | re-read pages, sitemaps and listings |
| `--dry-run` | list files instead of downloading (nothing saved) |
| `--report` | summary of the stored files, jobs and most common errors |
| `--quiet` | progress lines only |
| `-c, --categories PATH...` | thuvienso categories (`do-an-khoa-luan-tot-nghiep`, `/ky-nang/ky-nang-so/`) |
| `--list-categories` | thuvienso category tree with counts |
| `--max-pages N` / `--max-docs N` | thuvienso listing pages per category / documents |
| `--force` | thuvienso: include read-only documents (permission required) |

## UTE workspace setup files

| File | Import it in | What it creates |
| --- | --- | --- |
| `hcmute_domains_topics.csv` | Knowledge Studio → Topics → Import | The domain → topic taxonomy CLASSIFYING assigns while processing |
| `hcmute_folders.json` | Knowledge Studio → Collections → *the collection* → Contents → Import folders | 109 folders: each faculty/institute with Bài giảng & slide · Giáo trình & tài liệu tham khảo · Đề cương học phần · Đề thi & đáp án · Đồ án, khóa luận & luận văn · Văn bản & thông báo của đơn vị; the university's offices; learner guides |

Folders decide who reads a document (one parent each); topics say what it is
about (several per document, applied automatically). Restrict *Đề thi & đáp án*
folders to the faculty's lecturers after importing. Re-importing the file
creates only the folders that are missing.
