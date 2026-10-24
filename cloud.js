/**
 * Supabase (versioned GT snapshots) and Google Drive (video source) glue.
 * Everything is optional: with an empty config.js the editor behaves exactly like upstream.
 * Depends on: config.js, supabase-js (window.supabase), fflate (window.fflate), decompressGzip() from app.js.
 */
const GT_CFG = window.GT_CONFIG || {};
let _sb = null;
let _lastCloudSig = {};   // vid -> signature of the last payload uploaded (skip identical re-uploads)

function cloudEnabled() {
  return !!(GT_CFG.supabaseUrl && GT_CFG.supabaseAnonKey && window.supabase);
}

function sb() {
  if (!_sb) _sb = window.supabase.createClient(GT_CFG.supabaseUrl, GT_CFG.supabaseAnonKey, { auth: { persistSession: false } });
  return _sb;
}

async function gzipBytes(text) {
  const raw = new TextEncoder().encode(text);
  if (window.CompressionStream) {
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (window.fflate && window.fflate.gzipSync) return window.fflate.gzipSync(raw);
  throw new Error("GZIP compression not supported in this browser.");
}

function cheapSig(text) {   // length + 32-bit FNV-1a: only to avoid uploading the same state twice
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length}:${h}`;
}

function gtAuthor() {
  let a = "";
  try { a = localStorage.getItem("gt_author") || ""; } catch (e) { /* storage blocked */ }
  if (!a) {
    a = (window.prompt("Tên của bạn (ghi kèm mỗi bản lưu trên Supabase):", "") || "").trim().slice(0, 80);
    try { if (a) localStorage.setItem("gt_author", a); } catch (e) { /* storage blocked */ }
  }
  return a;
}

// Upload one snapshot (append-only: a row in gt_snapshots + a gzip JSON object in the bucket).
async function cloudSaveSnapshot(vid, payload, editedBoxes) {
  const body = JSON.stringify(payload);   // {vid, maxFrames, roster, frames}: the same object that goes to localStorage, minus savedAt
  const sig = cheapSig(body);
  if (_lastCloudSig[vid] === sig) return "unchanged";
  const bytes = await gzipBytes(body);
  const path = `${vid}/${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz`;
  const up = await sb().storage.from(GT_CFG.bucket || "gt-snapshots").upload(path, bytes, { contentType: "application/gzip", upsert: false });
  if (up.error) throw up.error;
  const ins = await sb().from("gt_snapshots").insert({ video: vid, author: gtAuthor(), edited_boxes: editedBoxes, object_path: path, bytes: bytes.length });
  if (ins.error) throw ins.error;
  _lastCloudSig[vid] = sig;
  return "saved";
}

// Newest snapshot of a video -> { meta, payload } or null.
async function cloudLoadLatest(vid) {
  const q = await sb().from("gt_snapshots").select("object_path,saved_at,author,edited_boxes").eq("video", vid).order("saved_at", { ascending: false }).limit(1);
  if (q.error) throw q.error;
  if (!q.data.length) return null;
  const dl = await sb().storage.from(GT_CFG.bucket || "gt-snapshots").download(q.data[0].object_path);
  if (dl.error) throw dl.error;
  const payload = JSON.parse(await decompressGzip(await dl.data.arrayBuffer()));
  _lastCloudSig[vid] = cheapSig(JSON.stringify({ vid: payload.vid, maxFrames: payload.maxFrames, roster: payload.roster, frames: payload.frames }));
  return { meta: q.data[0], payload };
}

/**
 * Which saved state does the editor open?  local = parsed localStorage payload (has .savedAt) or null,
 * cloud = { meta, payload } from cloudLoadLatest() or null.  Return "cloud", "local" or "base" (the csv.gz shipped in the repo).
 */
function chooseSource(local, cloud) {
  // TODO(human): decide the policy when BOTH exist (e.g. two people editing, or an offline edit newer than the cloud copy).
  // Safe default for now: the cloud copy wins, then the browser copy, then the shipped base.
  if (cloud && cloud.payload && cloud.payload.frames) return "cloud";
  if (local && local.frames) return "local";
  return "base";
}

// Google Drive: a file id or a share link -> a direct media URL (UNVERIFIED for large files: see README, "Drive video").
function driveVideoUrl(idOrLink) {
  if (!idOrLink) return "";
  const m = String(idOrLink).match(/\/d\/([\w-]{10,})|[?&]id=([\w-]{10,})/);
  const id = m ? (m[1] || m[2]) : String(idOrLink).trim();
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}
