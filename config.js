// Optional cloud settings.  Leave a value empty to keep the upstream behaviour (localStorage + "choose video from disk").
// The Supabase anon key is a PUBLIC key by design: what it may do is decided by the row-level-security policies in
// supabase/migrations/0001_gt_snapshots.sql, not by keeping the key secret.
window.GT_CONFIG = {
  supabaseUrl: "",       // e.g. "https://xxxxxxxxxxxx.supabase.co"
  supabaseAnonKey: "",   // Project Settings -> API -> anon public key
  bucket: "gt-snapshots",
  // Google Drive videos: a file id or a share link, shared as "Anyone with the link".
  driveVideos: { IMG_0114: "", IMG_0115: "" }
};
