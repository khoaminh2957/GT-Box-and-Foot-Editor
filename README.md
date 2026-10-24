# GT-Box-and-Foot-Editor

Editor for the boxes and foot points of the six players of a 3x3 game (IMG_0114, IMG_0115), made for several people working at once.
The user guide of the original single-user tool is `HUONG_DAN_SU_DUNG.md`.

## How the work is divided

Each video is cut into **blocks of 50 frames** (231 and 237 blocks). A person **claims** a block, corrects it, and presses **Xong khối** (Ctrl+Enter):

- only the frames of the claimed block can be edited; every other frame is view-only (interpolation, swap and copy refuse to cross the block border);
- a finished block is **locked for good**, for everyone including its author; the editor then claims the next free block and jumps to it;
- a draft is saved every 45 s and with Ctrl+S; a claim that is not renewed for 15 minutes is taken over by the next person, and the old holder's next save is refused;
- "Trả lại" hands a block back and keeps its draft for the next person.

Without Supabase in `config.js` the editor runs in **local mode**: every frame is editable and the state stays in this browser.

## Output

`scripts/gt_export.py` merges all finished blocks into the BTC files and validates them (all frames 1..N, six players per frame, boxes not inverted, court positions finite,
edited rows consistent with the homography to 0.1 cm):

| file | content |
|---|---|
| `IMG_0114.txt`, `IMG_0115.txt` | `frame,court_x,court_y,team,jersey`, one row per player per frame |
| `IMG_0114_gt_boxes.csv.gz`, ... | boxes (720p) with `observed` and `edited` flags |
| `manifest_<video>.json` | blocks taken from the database, who finished how many, sha256 of both files |

A video is exported under its final name only when **every** block is done; `--partial` writes `_DRAFT` files for the rest. Output is byte-for-byte reproducible.
The workflow `Export labels` runs every 30 minutes (and by hand), attaches the files to the run and uploads them to Google Drive.

## Setup

1. **Supabase project.** Authentication, Sign In / Providers: enable **Anonymous sign-ins** (each browser gets an identity so claims belong to someone).
   Apply `supabase/migrations/20261025000000_gt_blocks.sql` (SQL editor, or `supabase db push`). Put the Project URL and the *anon* key in `config.js` (the anon key is public by design:
   clients can only read; all writes go through the checked functions in the migration).
2. **GitHub secrets** (repository, Settings, Secrets and variables, Actions). Every workflow step that needs a missing secret is skipped with a notice instead of failing.

   | secret | used by | where to get it |
   |---|---|---|
   | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID` | `Deploy` (applies migrations) | Supabase account tokens; project database password; project reference |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `Export labels` (Drive upload) | `scripts/drive_oauth_setup.py` (instructions at the top of the file) |

   Drive uses an OAuth refresh token and not a service account: a service account has no storage quota in a personal My Drive.
   Publish the OAuth consent screen ("In production"), otherwise Google expires the token after 7 days. The files go to a Drive folder named `GT Editor output`, created by the script.
3. **Video.** Each person downloads `IMG_0114.MP4` / `IMG_0115.MP4` once from the organizers' folder, picks the file in the editor ("Chọn file .MP4") and the editor remembers it
   (File System Access API: Chrome and Edge; Firefox and Safari ask again each visit). The editor warns when the file name does not contain the video id or the video does not have the
   expected 11,536 / 11,823 frames.

   *Frame alignment.* The first frame of these MP4s is not presented at 0 s (IMG_0114: 0.041 s, IMG_0115: 0.034 s, read from the browser's frame callback), so seeking to `(f - 1) / fps` showed the
   frame two places too early: in Chrome 156 the displayed frame matched decoded frame `f - 3` at all 14 tested positions of IMG_0114. The editor now measures the start time of each file and seeks to the middle of
   the frame's interval; afterwards the displayed frame is decoded frame `f - 1` at 14 of 14 positions (IMG_0114) and 8 of 8 (IMG_0115), compared with sequentially decoded OpenCV frames on the pixels that move.
   Only headless Chrome was tested; if a browser cannot report the start time the editor says so (the frames may then be one or two off).

   *Why not stream it from Google Drive:* a direct Drive link plays with `curl` (HTTP 206, byte ranges work) but not from a page on another site. Replaying a browser's media request with `curl`
   gives HTTP 403 or an HTML page as soon as `Sec-Fetch-Site: cross-site` (which a browser always sends) is present, and Chrome 156 reports `ERR_BLOCKED_BY_ORB` for the `<video>`.
   Tested without a Google login; why Drive does this was not investigated. Supabase Storage would play, but its free plan allows 50 MB per file and the videos are 150 and 154 MB.

Not verified against the real services: the Supabase project and the Google Drive upload (both are tested against local stand-ins).

## CI/CD (`.github/workflows`)

| workflow | when | what |
|---|---|---|
| `CI` | every push to main and every pull request | syntax check, unit tests, design lint; Python tests (export, Drive upload); SQL tests on Postgres 16 (claim, lease, lock, 40 simultaneous claims); browser workflow tests in Chrome with a mock backend |
| `Deploy` | migrations change; after each production deployment | `supabase db push`; smoke test of the live site (Vercel's Git integration does the deployment itself) |
| `Export labels` | every 30 minutes, by hand | merge, validate, upload |

Tests locally: `python -m pytest -q tests`, `node --test tests/js/*.test.cjs`, `python scripts/design_lint.py`;
SQL: `docker run -d -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine`, then in `tests/sql`: `npm ci && PG_URL=postgres://postgres:pw@localhost:55432/postgres npm test`;
browser: in `tests/e2e`: `npm ci && npm test` (needs Chrome).

## Design

A working tool, so the interface is flat panels split by 1px rules, one accent colour, system fonts, monospace only for numbers that are data. `scripts/design_lint.py` fails CI on the visual tells that
mark a page as machine-generated (gradients, glass blur, glow and shadows, purple or neon-cyan accents, emoji as icons, thick one-sided accent borders, Inter/Roboto stacks, large rounded corners,
pulse and bounce animation, marketing copy), following [this catalogue](https://www.impeccable.style/slop) and [this one](https://cdn.jsdelivr.net/npm/pixelslop@0.3.8/dist/skill/resources/ai-slop-patterns.md).
Passing the lint does not make a design good; it only means none of those known tells is present.

## Known data issues (observed in the shipped labels, cause not investigated)

- `court_x/court_y` of unedited rows in IMG_0114 differ from the homography of the stored box foot by up to 9.55 cm (IMG_0115: up to 0.07 cm); the exporter keeps the stored values and only checks edited rows.
- 363 rows (IMG_0114) and 204 rows (IMG_0115) lie 100 to 294 cm outside the court. The exporter reports them as a warning and rejects anything beyond 500 cm.
