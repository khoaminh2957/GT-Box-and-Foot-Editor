# GT-Box-and-Foot-Editor

In-browser editor for 3x3 basketball ground-truth boxes and foot points (user guide: `HUONG_DAN_SU_DUNG.md`).

## Cloud setup (optional: Supabase snapshots + Google Drive video)

Without any setup the editor works as before: state in `localStorage`, video chosen from disk.

1. **Supabase.** Create a project, run `supabase/migrations/0001_gt_snapshots.sql` in the SQL editor, then put the project URL and the *anon* key in `config.js`.
   Every **Ctrl+S** then also uploads an append-only snapshot (gzip JSON in the `gt-snapshots` bucket + one row in `gt_snapshots`). The anon key can read and insert only, never update or delete.
2. **Drive video.** Upload `IMG_0114.MP4` / `IMG_0115.MP4`, share them as *Anyone with the link*, and put the file ids or links in `config.js` (`driveVideos`).
   *Unverified:* Drive may refuse range requests or throttle large files, which would make frame-accurate seeking unreliable. If the video does not play the editor says so and the file picker keeps working.
3. Anyone with the page URL can save snapshots. Which saved state opens first (cloud vs browser copy) is decided in `chooseSource()` in `cloud.js`.
