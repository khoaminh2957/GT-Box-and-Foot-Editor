/**
 * Supabase glue (block queue).
 * Everything is optional: with an empty config.js the editor runs locally and every frame stays editable.
 * Depends on: config.js and supabase-js (window.supabase).
 * Server contract: supabase/migrations/*_gt_blocks.sql.  Error codes: GT000 not signed in, GT001 claim lost, GT002 bad argument, GT003 bad labels.
 */
const GT_CFG = window.GT_CONFIG || {};
let _sb = null;

function cloudEnabled() {
  return !!(GT_CFG.supabaseUrl && GT_CFG.supabaseAnonKey && window.supabase);
}

function sb() {
  if (!_sb) _sb = window.supabase.createClient(GT_CFG.supabaseUrl, GT_CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  return _sb;
}

function cloudError(e) {
  const err = new Error(e.message || String(e));
  err.code = e.code || "";
  return err;
}

// Anonymous sign-in: one stable identity per browser (kept in localStorage), so a reload resumes the same claim.
async function cloudSignIn() {
  const s = await sb().auth.getSession();
  if (s.data && s.data.session) return s.data.session.user.id;
  const r = await sb().auth.signInAnonymously();
  if (r.error) throw cloudError(r.error);
  return r.data.user.id;
}

async function rpc(fn, args) {
  const r = await sb().rpc(fn, args);
  if (r.error) throw cloudError(r.error);
  return r.data;
}

// -> the claimed block row (also when the caller already held one) or null when no block is free.
async function cloudClaim(video, prefer, name) {
  const row = await rpc("gt_claim_block", { p_video: video, p_prefer: prefer || 0, p_name: name });
  return row && row.block !== null && row.block !== undefined ? row : null;
}

async function cloudSaveDraft(video, block, labels) {
  await rpc("gt_save_draft", { p_video: video, p_block: block, p_labels: labels });
}

async function cloudComplete(video, block, labels) {
  return rpc("gt_complete_block", { p_video: video, p_block: block, p_labels: labels });
}

async function cloudRelease(video, block) {
  await rpc("gt_release_block", { p_video: video, p_block: block });
}

// Light status list for the timeline (no labels).
async function cloudProgress(video) {
  const r = await sb().from("gt_block_status").select("block,first_frame,last_frame,status,claimed_by,claimed_name,done_name,done_at").eq("video", video).order("block", { ascending: true }).limit(1000);
  if (r.error) throw cloudError(r.error);
  return r.data;
}

// Labels of one block (a draft or the final ones) -> {frames: {...}} or null.
async function cloudBlockLabels(video, block) {
  const r = await sb().from("gt_blocks").select("labels").eq("video", video).eq("block", block).maybeSingle();
  if (r.error) throw cloudError(r.error);
  return r.data ? r.data.labels : null;
}
