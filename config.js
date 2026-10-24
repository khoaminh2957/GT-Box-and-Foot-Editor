// Optional cloud settings.  Leave a value empty to keep the local mode (browser storage, every frame editable, video chosen from disk).
// The Supabase anon key is a PUBLIC key by design: what it may do is decided by the row-level-security policies and the functions in
// supabase/migrations/*_gt_blocks.sql, not by keeping the key secret.
window.GT_CONFIG = {
  supabaseUrl: "",       // e.g. "https://xxxxxxxxxxxx.supabase.co"
  supabaseAnonKey: "",   // Project Settings -> API -> anon public key
  // Google Drive videos: a file id or a share link, shared as "Anyone with the link".
  driveVideos: { IMG_0114: "", IMG_0115: "" }
};
