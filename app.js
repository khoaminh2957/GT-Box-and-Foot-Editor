/**
 * GT Editor: boxes and foot points of the six players of a 3x3 game, labelled in 50-frame blocks.
 * Local mode (no Supabase in config.js): every frame is editable and the state lives in this browser.
 * Cloud mode: a person claims a block (cloud.js, supabase/migrations/*_gt_blocks.sql), edits only its frames, and "Xong khối" locks it for good.
 * Pure logic (homography, block arithmetic, payloads) is in logic.js; this file is the DOM, the canvas and the workflow.
 */

const FPS = 29.97002997002997;
const ROSTERS = {
  IMG_0114: ["A#6", "A#9", "A#10", "B#6", "B#9", "B#11"],
  IMG_0115: ["A#4", "A#10", "A#12", "B#1", "B#3", "B#5"]
};
const TOTAL_FRAMES = { IMG_0114: 11536, IMG_0115: 11823 };

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const TEAM_COLORS = { A: cssVar("--team-a"), B: cssVar("--team-b") };
const STATUS_COLORS = { done: cssVar("--st-done"), mine: cssVar("--st-mine"), others: cssVar("--st-others"), open: cssVar("--st-open") };

// ---- state ------------------------------------------------------------------------------------------------------------------
let curVid = "IMG_0114";
let curFrame = 1;
let maxFrames = TOTAL_FRAMES.IMG_0114;
let roster = ROSTERS.IMG_0114;
let selectedIdent = roster[0];
let groundTruth = {};      // groundTruth[frame][ident] = [x1, y1, x2, y2, court_x, court_y, observed, edited]
let baseGT = {};           // the shipped labels, untouched, for "Về dữ liệu gốc"
let bookmarks = [];
let playing = false;
let playInterval = null;
let drawNewBoxMode = false;
let hasVideo = false;
let videoStart = 0;       // presentation time of the video's first frame, measured when a file is attached
let dragState = null;
let loadSeq = 0;

const cloudOn = cloudEnabled();
let myUid = null;
let myBlock = null;        // the block row this browser has claimed, or null
let progress = [];         // rows of gt_block_status for the current video
let dirty = false;         // edits not yet saved as a draft (cloud) / to the browser (local)
let lastRenew = 0;
let busy = false;
const finalLoaded = new Set();   // "video:block" of finished blocks whose labels were copied into groundTruth

// ---- DOM --------------------------------------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $("videoCanvas");
const ctx = canvas.getContext("2d");
const video = $("videoElement");
const timeline = $("timeline");
const statusEl = $("saveStatus");

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function decompressGzip(arrayBuffer) {
  if (window.DecompressionStream) {
    const stream = new Blob([arrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  if (window.fflate && window.fflate.gunzipSync) return new TextDecoder().decode(window.fflate.gunzipSync(new Uint8Array(arrayBuffer)));
  throw new Error("Trình duyệt không hỗ trợ giải nén GZIP.");
}

const canEdit = (f) => canEditFrame(cloudOn, myBlock, f);

// ---- loading ----------------------------------------------------------------------------------------------------------------
function parseCSV(csvText, vid) {
  const gt = {};
  const lines = csvText.split(/\r?\n/);
  const header = lines[0].split(",");
  const col = (name) => header.indexOf(name);
  const [iF, iT, iJ, iX1, iY1, iX2, iY2, iCx, iCy, iObs, iEd] = ["frame", "team", "jersey", "x1", "y1", "x2", "y2", "court_x", "court_y", "observed", "edited"].map(col);
  let maxF = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(",");
    const f = parseInt(p[iF], 10);
    if (f > maxF) maxF = f;
    const x1 = parseFloat(p[iX1]), y1 = parseFloat(p[iY1]), x2 = parseFloat(p[iX2]), y2 = parseFloat(p[iY2]);
    const foot = imgToCourt(0.5 * (x1 + x2), y2);
    const cx = iCx >= 0 ? parseFloat(p[iCx]) : foot[0];
    const cy = iCy >= 0 ? parseFloat(p[iCy]) : foot[1];
    const isTrue = (s) => s === "True" || s === "true";
    (gt[f] = gt[f] || {})[`${p[iT]}#${p[iJ]}`] = [x1, y1, x2, y2, cx, cy, isTrue(p[iObs]), iEd >= 0 ? isTrue(p[iEd]) : false];
  }
  return { gt, frames: maxF || TOTAL_FRAMES[vid] };
}

const cloneGT = (gt) => Object.fromEntries(Object.entries(gt).map(([f, d]) => [f, Object.fromEntries(Object.entries(d).map(([id, e]) => [id, e.slice()]))]));

async function openVideo(vid) {
  const seq = ++loadSeq;
  $("loadingOverlay").style.display = "flex";
  $("loadingText").textContent = `Đang tải nhãn gốc của ${vid}…`;
  myBlock = null; progress = []; dirty = false; finalLoaded.clear();
  try {
    const res = await fetch(`output_ground_truth/${vid}_gt_boxes.csv.gz`);
    if (!res.ok) throw new Error(`HTTP ${res.status} khi tải nhãn gốc`);
    const { gt, frames } = parseCSV(await decompressGzip(await res.arrayBuffer()), vid);
    if (seq !== loadSeq) return;
    baseGT = gt; groundTruth = cloneGT(gt); maxFrames = frames; roster = ROSTERS[vid]; selectedIdent = roster[0];
    if (!cloudOn) restoreLocal(vid);
    calculateBookmarks();
    initUI();
    $("loadingOverlay").style.display = "none";
    setStatus(cloudOn ? `Đã tải ${vid}. Đang kết nối Supabase…` : `Đã tải ${vid} (${maxFrames.toLocaleString("vi-VN")} frame).`);
  } catch (err) {
    console.error(err);
    $("loadingText").textContent = `Lỗi: ${err.message}`;
    return;
  }
  if (cloudOn) await syncCloud(vid, seq);
}

function restoreLocal(vid) {
  try {
    const saved = JSON.parse(localStorage.getItem(`gt_v4_${vid}`) || "null");
    if (saved && saved.frames && saved.maxFrames) { groundTruth = saved.frames; maxFrames = saved.maxFrames; setStatus(`Đã nạp bản lưu trong trình duyệt (${vid}).`); }
  } catch (e) { console.warn("Bản lưu trong trình duyệt hỏng:", e); }
}

function calculateBookmarks() {
  bookmarks = [];
  let prevF = -999;
  for (let f = 1; f <= maxFrames; f++) {
    const fd = groundTruth[f];
    if (!fd) continue;
    const hasInterp = roster.some((id) => fd[id] && !fd[id][6]);
    if (hasInterp && f - prevF > 8) { bookmarks.push(f); prevF = f; }
  }
}

// ---- cloud workflow ---------------------------------------------------------------------------------------------------------
async function syncCloud(vid, seq) {
  try {
    if (!myUid) myUid = await cloudSignIn();
    $("connState").textContent = "Đã kết nối Supabase"; $("connState").className = "conn ok";
    await refreshProgress();
    const mine = progress.find((r) => r.status === "claimed" && r.claimed_by === myUid);
    if (seq !== loadSeq) return;
    if (mine) {                                   // resume after a reload: same anonymous identity, same block
      $("annotatorName").value = $("annotatorName").value || mine.claimed_name || "";
      await claimNext(mine.block);
    } else setStatus(`Đã kết nối. Bấm "Nhận khối" để bắt đầu.`);
  } catch (e) { cloudProblem(e); }
  updateBlockUI();
}

async function refreshProgress() {
  if (!cloudOn || !myUid) return;
  try {
    progress = await cloudProgress(curVid);
    $("connState").textContent = "Đã kết nối Supabase"; $("connState").className = "conn ok";
  } catch (e) { $("connState").textContent = "Mất kết nối"; $("connState").className = "conn bad"; return; }
  updateBlockUI(); drawTimeline(); updateNotice();
}

function cloudProblem(e) {
  (e.code === "GT001" ? console.warn : console.error)(e);          // losing a claim is an expected outcome, not a script error
  if (e.code === "GT001") {
    if (myBlock) for (let f = myBlock.first_frame; f <= myBlock.last_frame; f++) groundTruth[f] = cloneGT({ [f]: baseGT[f] })[f];   // drop edits that can no longer be saved
    myBlock = null; dirty = false;
    setStatus("Khối này không còn thuộc về bạn (quá 15 phút không lưu hoặc đã có người khác nhận). Thay đổi chưa lưu bị mất.", "error");
    refreshProgress();
  } else if (e.code === "GT003") setStatus(`Máy chủ từ chối nhãn: ${e.message}`, "error");
  else { $("connState").textContent = "Mất kết nối"; $("connState").className = "conn bad"; setStatus(`Lỗi Supabase: ${e.message}. Bản đang sửa vẫn còn trên trang này.`, "error"); }
  updateBlockUI(); updateNotice();
}

async function claimNext(preferBlock) {
  const name = $("annotatorName").value.trim();
  if (!name) { setStatus("Nhập tên trước khi nhận khối.", "warn"); $("annotatorName").focus(); return; }
  try { localStorage.setItem("gt_annotator", name); } catch (e) { /* storage blocked */ }
  if (busy) return;
  busy = true; updateBlockUI();
  try {
    const row = await cloudClaim(curVid, preferBlock || 0, name);
    if (!row) { myBlock = null; setStatus("Không còn khối trống ở video này.", "warn"); await refreshProgress(); return; }
    const draft = await cloudBlockLabels(curVid, row.block);       // the block becomes editable only once its draft is in place, else an early edit would be overwritten by it
    if (draft) overlayFrames(groundTruth, draft);
    myBlock = row; dirty = false; lastRenew = Date.now();
    calculateBookmarks();
    updateBlockUI();
    goToFrame(row.first_frame);
    setStatus(`Bạn đang gán khối ${row.block + 1} (frame ${row.first_frame}–${row.last_frame}).`);
    busy = false; updateBlockUI();                 // refreshing the progress bar is not part of the claim: a save pressed meanwhile must not be dropped
    await refreshProgress();
  } catch (e) { cloudProblem(e); } finally { busy = false; updateBlockUI(); }
}

async function saveDraft(manual) {
  if (!cloudOn) return saveLocal();
  if (!myBlock) { if (manual) setStatus("Chưa nhận khối nên không có gì để lưu.", "warn"); return; }
  if (!dirty && !manual) return;
  if (busy) { if (manual) setStatus("Đang nhận hoặc khoá khối, thử lưu lại sau giây lát.", "warn"); return; }
  busy = true;
  try {
    await cloudSaveDraft(curVid, myBlock.block, buildBlockPayload(groundTruth, roster, myBlock.first_frame, myBlock.last_frame));
    dirty = false; lastRenew = Date.now();
    setStatus(`Đã lưu bản nháp khối ${myBlock.block + 1} lúc ${new Date().toLocaleTimeString("vi-VN")}.`);
  } catch (e) { cloudProblem(e); } finally { busy = false; updateBlockUI(); }
}

async function completeBlock() {
  if (!cloudOn || !myBlock || busy) return;
  const { block, first_frame: first, last_frame: last } = myBlock;
  const problems = validateBlockFrames(groundTruth, roster, first, last);
  if (problems.length) { setStatus(`Chưa kết thúc được: ${problems[0]}${problems.length > 1 ? ` (và ${problems.length - 1} lỗi khác)` : ""}`, "error"); return; }
  if (!confirm(`Khoá khối ${block + 1} (frame ${first}–${last})?\nSau khi xong sẽ không ai sửa được khối này nữa.`)) return;
  busy = true; updateBlockUI();
  try {
    await cloudComplete(curVid, block, buildBlockPayload(groundTruth, roster, first, last));
    myBlock = null; dirty = false; finalLoaded.add(`${curVid}:${block}`);
    setStatus(`Đã khoá khối ${block + 1}. Đang nhận khối kế tiếp…`);
    await refreshProgress();
    busy = false;
    await claimNext(block + 1);
  } catch (e) { cloudProblem(e); } finally { busy = false; updateBlockUI(); }
}

async function releaseBlock() {
  if (!cloudOn || !myBlock || busy) return;
  if (!confirm(`Trả lại khối ${myBlock.block + 1}? Bản nháp hiện tại được giữ cho người nhận sau.`)) return;
  try {
    if (dirty) await saveDraft(true);
    busy = true;
    await cloudRelease(curVid, myBlock.block);
    setStatus(`Đã trả lại khối ${myBlock.block + 1}.`);
    myBlock = null; dirty = false;
    busy = false;
    await refreshProgress();
  } catch (e) { cloudProblem(e); } finally { busy = false; updateBlockUI(); updateNotice(); renderCanvas(); }
}

// A finished block is shown with its final labels; fetched the first time someone looks at it.
async function ensureFinalLabels(frame) {
  if (!cloudOn) return;
  const row = progress.find((r) => frame >= r.first_frame && frame <= r.last_frame);
  if (!row || row.status !== "done" || (myBlock && myBlock.block === row.block)) return;
  const key = `${curVid}:${row.block}`;
  if (finalLoaded.has(key)) return;
  finalLoaded.add(key);
  try {
    const labels = await cloudBlockLabels(curVid, row.block);
    if (labels) { overlayFrames(groundTruth, labels); if (curFrame >= row.first_frame && curFrame <= row.last_frame) { renderCanvas(); updatePlayerTable(); updateBoxInfo(); } }
  } catch (e) { finalLoaded.delete(key); console.warn("Không tải được nhãn của khối đã xong:", e); }
}

function tickCloud() {
  if (!cloudOn || !myBlock || busy) return;
  if (dirty) saveDraft(false);
  else if (Date.now() - lastRenew > 4 * 60 * 1000) {            // nothing to save: renew the 15-minute lease by claiming again (returns the same block)
    cloudClaim(curVid, 0, $("annotatorName").value.trim() || "Ẩn danh").then(() => { lastRenew = Date.now(); }).catch(cloudProblem);
  }
}

// ---- block panel, notices, timeline -------------------------------------------------------------------------------------------
function blockRow(frame) { return progress.find((r) => frame >= r.first_frame && frame <= r.last_frame); }

function updateBlockUI() {
  $("blockLocal").hidden = cloudOn; $("blockCloud").hidden = !cloudOn;
  if (!cloudOn) { $("topBlock").textContent = ""; return; }
  const n = progress.length ? countStatuses(progress) : null;
  const dl = $("blockState");
  const rows = myBlock
    ? [["Khối", `${myBlock.block + 1} / ${progress.length || "?"}`], ["Frame", `${myBlock.first_frame}–${myBlock.last_frame}`], ["Bản nháp", dirty ? "có thay đổi chưa lưu" : "đã lưu"]]
    : [["Khối", "chưa nhận"]];
  dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("claimBtn").hidden = !!myBlock; $("doneBtn").hidden = !myBlock; $("releaseBtn").hidden = !myBlock;
  for (const id of ["claimBtn", "doneBtn", "releaseBtn"]) $(id).disabled = busy;
  $("progressText").textContent = n ? `${n.done} / ${progress.length} khối đã xong · ${n.claimed} đang làm · ${n.open} còn trống` : "";
  $("topBlock").innerHTML = myBlock ? `Khối <b>${myBlock.block + 1}</b> · frame ${myBlock.first_frame}–${myBlock.last_frame}` : "Chưa nhận khối";
}

function updateNotice() {
  const el = $("viewNotice");
  let msg = "";
  if (cloudOn && !canEdit(curFrame)) {
    const r = blockRow(curFrame);
    if (!myBlock) msg = "Chưa nhận khối: chỉ xem.";
    else if (r && r.status === "done") msg = `Khối ${r.block + 1} đã xong${r.done_name ? ` (${r.done_name})` : ""}. Chỉ xem.`;
    else if (r && r.status === "claimed") msg = `Khối ${r.block + 1} đang do ${r.claimed_name || "người khác"} làm. Chỉ xem.`;
    else msg = r ? `Khối ${r.block + 1} chưa ai nhận. Chỉ xem.` : "Ngoài khối của bạn. Chỉ xem.";
  }
  el.hidden = !msg; el.textContent = msg;
}

function timelineCells() {
  if (progress.length) return progress;
  return Array.from({ length: Math.ceil(maxFrames / BLOCK_SIZE) }, (_, b) => ({ block: b, status: "open", first_frame: blockRange(b, maxFrames).first, last_frame: blockRange(b, maxFrames).last }));
}

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const W = timeline.clientWidth, H = 22;
  if (!W) return;
  timeline.width = Math.round(W * dpr); timeline.height = Math.round(H * dpr);
  const t = timeline.getContext("2d");
  t.setTransform(dpr, 0, 0, dpr, 0, 0);
  t.clearRect(0, 0, W, H);
  const cells = timelineCells(), cw = W / cells.length;
  cells.forEach((r, i) => {
    const mine = myBlock && r.block === myBlock.block;
    t.fillStyle = mine ? STATUS_COLORS.mine : (r.status === "done" ? STATUS_COLORS.done : (r.status === "claimed" ? STATUS_COLORS.others : STATUS_COLORS.open));
    t.fillRect(i * cw, 3, Math.max(1, cw - 1), H - 6);
  });
  const x = ((curFrame - 0.5) / maxFrames) * W;
  t.fillStyle = cssVar("--ink"); t.fillRect(Math.round(x) - 1, 0, 2, H);
}

timeline.addEventListener("click", (evt) => {
  const rect = timeline.getBoundingClientRect(), cells = timelineCells();
  const i = Math.min(cells.length - 1, Math.max(0, Math.floor(((evt.clientX - rect.left) / rect.width) * cells.length)));
  goToFrame(cells[i].first_frame);
});
timeline.addEventListener("mousemove", (evt) => {
  const rect = timeline.getBoundingClientRect(), cells = timelineCells();
  const r = cells[Math.min(cells.length - 1, Math.max(0, Math.floor(((evt.clientX - rect.left) / rect.width) * cells.length)))];
  const who = r.status === "done" ? ` · xong bởi ${r.done_name || "?"}` : (r.status === "claimed" ? ` · ${r.claimed_name || "?"} đang làm` : "");
  timeline.title = `Khối ${r.block + 1} · frame ${r.first_frame}–${r.last_frame}${who}`;
});
window.addEventListener("resize", drawTimeline);

// ---- UI construction --------------------------------------------------------------------------------------------------------
function initUI() {
  $("scrubber").max = maxFrames; $("frameInput").max = maxFrames;
  $("maxFrameLbl").textContent = `/ ${maxFrames.toLocaleString("vi-VN")}`;
  const tbody = $("playerTable").querySelector("tbody");
  tbody.innerHTML = "";
  for (const sel of [$("swapA"), $("swapB")]) sel.innerHTML = "";
  roster.forEach((id, idx) => {
    const tr = document.createElement("tr");
    tr.id = `row_${id}`;
    tr.innerHTML = `<td class="mono">${idx + 1}</td><td><i class="sw team-${id[0].toLowerCase()}"></i>${id}</td><td class="st"></td><td class="num co"></td>`;
    tr.addEventListener("click", () => selectPlayer(id));
    tbody.appendChild(tr);
    $("swapA").add(new Option(id, id)); $("swapB").add(new Option(id, id));
  });
  if (roster.length > 1) $("swapB").selectedIndex = 1;
  $("fStart").value = 1; $("fEnd").value = Math.min(10, maxFrames);
  $("legend").hidden = !cloudOn;
  updateBlockUI();
  goToFrame(1);
}

function selectPlayer(id) {
  selectedIdent = id;
  renderCanvas(); updatePlayerTable(); updateBoxInfo();
}

function updatePlayerTable() {
  const fd = groundTruth[curFrame] || {};
  for (const id of roster) {
    const tr = $(`row_${id}`);
    if (!tr) continue;
    tr.className = id === selectedIdent ? "sel" : "";
    const e = fd[id];
    tr.querySelector(".st").textContent = !e ? "thiếu" : (e[7] ? "đã sửa" : (e[6] ? "quan sát" : "nội suy"));
    tr.querySelector(".co").textContent = e ? `${e[4].toFixed(0)}, ${e[5].toFixed(0)}` : "";
  }
}

function updateBoxInfo() {
  const e = (groundTruth[curFrame] || {})[selectedIdent];
  const dl = $("boxInfo");
  if (!e) { dl.innerHTML = "<dt>Cầu thủ</dt><dd>không có dữ liệu</dd>"; return; }
  const [x1, y1, x2, y2, cx, cy, obs, edited] = e;
  const rows = [["Cầu thủ", selectedIdent], ["Nguồn", edited ? "đã sửa tay" : (obs ? "quan sát" : "nội suy")], ["Box (px)", `${x1.toFixed(1)}, ${y1.toFixed(1)}, ${x2.toFixed(1)}, ${y2.toFixed(1)}`],
                ["Điểm chân (px)", `${(0.5 * (x1 + x2)).toFixed(1)}, ${y2.toFixed(1)}`], ["Sân (cm)", `${cx.toFixed(1)}, ${cy.toFixed(1)}`]];
  dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

// ---- navigation -------------------------------------------------------------------------------------------------------------
function changeVideo() {
  if (playing) togglePlay();
  curVid = $("vidSelect").value;
  hasVideo = false; video.removeAttribute("src");
  $("videoBanner").className = "banner"; $("dropzoneStatus").textContent = `Chưa có video ${curVid}.`;
  openVideo(curVid);
  restoreVideo(curVid);
}

function goToFrame(f) {
  f = Math.max(1, Math.min(maxFrames, f));
  curFrame = f;
  $("frameInput").value = f; $("scrubber").value = f;
  if (hasVideo && video.readyState >= 1) {
    const t = frameTime(f, videoStart, FPS);
    if (Math.abs(video.currentTime - t) > 0.004) video.currentTime = t;
  }
  renderCanvas(); updatePlayerTable(); updateBoxInfo(); updateNotice(); drawTimeline();
  ensureFinalLabels(f);
}

const stepFrame = (d) => goToFrame(curFrame + d);

function togglePlay() {
  playing = !playing;
  $("playBtn").textContent = playing ? "Dừng" : "Phát";
  if (playing) {
    playInterval = setInterval(() => { if (curFrame >= maxFrames) togglePlay(); else goToFrame(curFrame + 1); }, parseInt($("speedSelect").value, 10));
  } else if (playInterval) clearInterval(playInterval);
}

function jumpBookmark(dir) {
  if (!bookmarks.length) return;
  if (dir > 0) goToFrame(bookmarks.find((b) => b > curFrame) || bookmarks[0]);
  else goToFrame([...bookmarks].reverse().find((b) => b < curFrame) || bookmarks[bookmarks.length - 1]);
}

// ---- canvas -----------------------------------------------------------------------------------------------------------------
function drawMinimap() {
  const mx = 12, my = 12, mw = 220, mh = 168, pad = 10, cw = mw - 2 * pad, ch = mh - 2 * pad;
  const c2u = (cx) => mx + pad + ((1505.0 - cx) / 1505.0) * cw;
  const c2v = (cy) => my + pad + (cy / 1105.0) * ch;
  ctx.save();
  ctx.fillStyle = "rgba(245, 246, 247, 0.93)"; ctx.fillRect(mx, my, mw, mh);
  ctx.strokeStyle = cssVar("--line-strong"); ctx.lineWidth = 1; ctx.strokeRect(mx + 0.5, my + 0.5, mw - 1, mh - 1);
  ctx.fillStyle = "#d9dfe3"; ctx.fillRect(mx + pad, my + pad, cw, ch);
  const kx1 = c2u(1002.5), kx2 = c2u(502.5), ky1 = c2v(0), ky2 = c2v(580);
  ctx.fillStyle = "#c8d0d6"; ctx.fillRect(kx1, ky1, kx2 - kx1, ky2 - ky1);
  ctx.strokeStyle = "#7d8993"; ctx.strokeRect(mx + pad + 0.5, my + pad + 0.5, cw, ch); ctx.strokeRect(kx1 + 0.5, ky1 + 0.5, kx2 - kx1, ky2 - ky1);
  ctx.beginPath(); ctx.arc(c2u(752.5), c2v(95.0), 3.5, 0, Math.PI * 2); ctx.stroke();
  const fd = groundTruth[curFrame];
  if (fd) {
    for (const id of roster) {
      const r = fd[id];
      if (!r) continue;
      const sel = id === selectedIdent;
      const px = Math.max(mx + 4, Math.min(mx + mw - 4, c2u(r[4]))), py = Math.max(my + 4, Math.min(my + mh - 4, c2v(r[5])));
      ctx.beginPath(); ctx.arc(px, py, sel ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = TEAM_COLORS[id[0]]; ctx.fill();
      ctx.lineWidth = sel ? 2 : 1; ctx.strokeStyle = sel ? "#1b2126" : "#f5f6f7"; ctx.stroke();
      ctx.fillStyle = "#1b2126"; ctx.font = "11px system-ui, sans-serif"; ctx.fillText(id.split("#")[1], px + 7, py + 4);
    }
  }
  ctx.fillStyle = "#4f5b64"; ctx.font = "11px system-ui, sans-serif"; ctx.fillText("Sân 2D, rổ ở trên", mx + 6, my + mh - 4);
  ctx.restore();
}

function getHandles(x1, y1, x2, y2) {
  const xm = 0.5 * (x1 + x2), ym = 0.5 * (y1 + y2);
  return [{ name: "tl", x: x1, y: y1 }, { name: "tm", x: xm, y: y1 }, { name: "tr", x: x2, y: y1 }, { name: "ml", x: x1, y: ym },
          { name: "mr", x: x2, y: ym }, { name: "bl", x: x1, y: y2 }, { name: "bm", x: xm, y: y2 }, { name: "br", x: x2, y: y2 }];
}

function drawCourtPlaceholder() {
  ctx.fillStyle = cssVar("--stage"); ctx.fillRect(0, 0, 1280, 720);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.07)"; ctx.lineWidth = 1;
  for (let x = 0; x < 1280; x += 40) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, 720); ctx.stroke(); }
  for (let y = 0; y < 720; y += 40) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(1280, y + 0.5); ctx.stroke(); }
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)"; ctx.lineWidth = 1.5;   // the four court markers of the organizers (RKU0, RKU1, RKU11, RKU10)
  ctx.beginPath(); ctx.moveTo(1113, 379); ctx.lineTo(955, 531); ctx.lineTo(141, 374); ctx.lineTo(512, 305); ctx.closePath(); ctx.stroke();
}

function renderCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (hasVideo && video.readyState >= 2) ctx.drawImage(video, 0, 0, 1280, 720); else drawCourtPlaceholder();
  const fd = groundTruth[curFrame];
  const editable = canEdit(curFrame);
  if (fd) {
    for (const id of roster) {
      const r = fd[id];
      if (!r) continue;
      const [x1, y1, x2, y2, , , obs, edited] = r;
      const sel = id === selectedIdent, col = TEAM_COLORS[id[0]];
      ctx.save();
      ctx.strokeStyle = sel ? "#f5f6f7" : col; ctx.lineWidth = sel ? 2.5 : 1.8;
      if (!obs && !edited) ctx.setLineDash([5, 3]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1); ctx.setLineDash([]);
      const lbl = `${id}${edited ? " · sửa" : (!obs ? " · nội suy" : "")}`;
      ctx.font = "12px system-ui, sans-serif";
      const tw = ctx.measureText(lbl).width;
      ctx.fillStyle = "rgba(27, 33, 38, 0.82)"; ctx.fillRect(x1, Math.max(0, y1 - 18), tw + 8, 18);
      ctx.fillStyle = "#f5f6f7"; ctx.fillText(lbl, x1 + 4, Math.max(13, y1 - 5));
      ctx.beginPath(); ctx.arc(0.5 * (x1 + x2), y2, 4.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#1b2126"; ctx.stroke();
      if (sel && editable) {
        for (const h of getHandles(x1, y1, x2, y2)) {
          ctx.fillStyle = h.name === "bm" ? "#3f8f62" : "#f5f6f7"; ctx.strokeStyle = "#1b2126"; ctx.lineWidth = 1;
          ctx.fillRect(h.x - 4, h.y - 4, 8, 8); ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
        }
      }
      ctx.restore();
    }
  }
  drawMinimap();
}

// ---- mouse ------------------------------------------------------------------------------------------------------------------
function getMousePos(evt) {
  const rect = canvas.getBoundingClientRect();
  return { x: (evt.clientX - rect.left) * (canvas.width / rect.width), y: (evt.clientY - rect.top) * (canvas.height / rect.height) };
}

canvas.addEventListener("mousedown", (evt) => {
  const pos = getMousePos(evt), fd = groundTruth[curFrame];
  if (!fd) return;
  const editable = canEdit(curFrame);
  if (drawNewBoxMode && editable) { dragState = { mode: "draw", startX: pos.x, startY: pos.y, origBox: [pos.x, pos.y, pos.x + 20, pos.y + 50] }; return; }
  const sel = fd[selectedIdent];
  if (sel && editable) {
    for (const h of getHandles(sel[0], sel[1], sel[2], sel[3])) {
      if (Math.hypot(pos.x - h.x, pos.y - h.y) <= 8) { dragState = { mode: "resize", handle: h.name, startX: pos.x, startY: pos.y, origBox: sel.slice(0, 4) }; return; }
    }
  }
  for (const id of [selectedIdent, ...roster.filter((i) => i !== selectedIdent)]) {
    const r = fd[id];
    if (r && pos.x >= r[0] && pos.x <= r[2] && pos.y >= r[1] && pos.y <= r[3]) {
      if (id !== selectedIdent) selectPlayer(id);
      if (editable) dragState = { mode: "move", startX: pos.x, startY: pos.y, origBox: r.slice(0, 4) };
      else setStatus("Frame này không thuộc khối của bạn nên chỉ xem được.", "warn");
      return;
    }
  }
});

canvas.addEventListener("mousemove", (evt) => {
  const pos = getMousePos(evt);
  const [cx, cy] = imgToCourt(pos.x, pos.y);
  $("cursorInfo").textContent = `px ${pos.x.toFixed(0)}, ${pos.y.toFixed(0)} · sân ${cx.toFixed(0)}, ${cy.toFixed(0)} cm`;
  if (!dragState) return;
  const dx = pos.x - dragState.startX, dy = pos.y - dragState.startY;
  let [x1, y1, x2, y2] = dragState.origBox;
  if (dragState.mode === "move") { x1 += dx; x2 += dx; y1 += dy; y2 += dy; }
  else if (dragState.mode === "draw") { x1 = Math.min(dragState.startX, pos.x); y1 = Math.min(dragState.startY, pos.y); x2 = Math.max(dragState.startX + 8, pos.x); y2 = Math.max(dragState.startY + 16, pos.y); }
  else {
    const h = dragState.handle;
    if (h.includes("l")) x1 += dx;
    if (h.includes("r")) x2 += dx;
    if (h.includes("t")) y1 += dy;
    if (h.includes("b")) y2 += dy;
  }
  if (x2 < x1 + 6) x2 = x1 + 6;
  if (y2 < y1 + 12) y2 = y1 + 12;
  updateBox(curFrame, selectedIdent, x1, y1, x2, y2);
  renderCanvas(); updatePlayerTable(); updateBoxInfo();
});

window.addEventListener("mouseup", () => {
  if (!dragState) return;
  const mode = dragState.mode;
  dragState = null;
  if (mode === "draw") toggleDrawMode(false);
  setStatus(`Đã sửa ${selectedIdent} ở frame ${curFrame}. ${cloudOn ? "Tự lưu bản nháp sau vài giây." : "Ctrl+S để lưu vào trình duyệt."}`);
});

canvas.addEventListener("mouseleave", () => { $("cursorInfo").textContent = ""; });

// ---- editing ----------------------------------------------------------------------------------------------------------------
// The court position is derived from the ROUNDED corners so that what is stored is self-consistent (scripts/gt_export.py checks it).
function updateBox(f, ident, x1, y1, x2, y2) {
  if (!canEdit(f)) return false;
  if (!groundTruth[f]) groundTruth[f] = {};
  if (x2 < x1 + 4) x2 = x1 + 4;
  if (y2 < y1 + 8) y2 = y1 + 8;
  const r = (v) => Math.round(v * 100) / 100;
  const [rx1, ry1, rx2, ry2] = [r(x1), r(y1), r(x2), r(y2)];
  const [cx, cy] = imgToCourt(0.5 * (rx1 + rx2), ry2);
  const prevObs = groundTruth[f][ident] ? groundTruth[f][ident][6] : true;
  groundTruth[f][ident] = [rx1, ry1, rx2, ry2, cx, cy, prevObs, true];
  dirty = true;
  return true;
}

function toggleDrawMode(force) {
  drawNewBoxMode = force !== undefined ? force : !drawNewBoxMode;
  $("drawModeBtn").classList.toggle("on", drawNewBoxMode);
  $("drawModeBtn").textContent = drawNewBoxMode ? "Vẽ lại box: đang bật (W)" : "Vẽ lại box (W)";
}

function copyPrevFrame() {
  if (curFrame <= 1 || !canEdit(curFrame)) { setStatus("Không sửa được frame này.", "warn"); return; }
  const prev = (groundTruth[curFrame - 1] || {})[selectedIdent];
  if (!prev) return;
  updateBox(curFrame, selectedIdent, prev[0], prev[1], prev[2], prev[3]);
  setStatus(`Đã chép box ${selectedIdent} từ frame ${curFrame - 1}.`);
  goToFrame(Math.min(maxFrames, curFrame + 1));
}

const rangeInputs = () => { let a = parseInt($("fStart").value, 10), b = parseInt($("fEnd").value, 10); return a > b ? [b, a] : [a, b]; };
function setRangeStart() { $("fStart").value = curFrame; }
function setRangeEnd() { $("fEnd").value = curFrame; }

function rangeAllowed(f1, f2) {
  if (!Number.isFinite(f1) || !Number.isFinite(f2)) { setStatus("Nhập frame đầu và frame cuối.", "warn"); return false; }
  if (!rangeInsideBlock(cloudOn, myBlock, f1, f2)) { setStatus("Đoạn này vượt ra ngoài khối của bạn nên không thực hiện.", "warn"); return false; }
  return true;
}

function lerpBoxes(f1, b1, f2, b2) {
  const span = Math.max(1, f2 - f1);
  for (let f = f1; f <= f2; f++) {
    const a = (f - f1) / span;
    updateBox(f, selectedIdent, ...b1.map((v, i) => (1 - a) * v + a * b2[i]));
  }
}

function interpolateRange() {
  const [f1, f2] = rangeInputs();
  if (!rangeAllowed(f1, f2)) return;
  const e1 = (groundTruth[f1] || {})[selectedIdent], e2 = (groundTruth[f2] || {})[selectedIdent];
  if (!e1 || !e2) return;
  lerpBoxes(f1, e1.slice(0, 4), f2, e2.slice(0, 4));
  goToFrame(curFrame); setStatus(`Đã nội suy tuyến tính ${selectedIdent} từ frame ${f1} đến ${f2}.`);
}

function interpolateFromAnchor() {
  const [f1, f2] = rangeInputs();
  if (!rangeAllowed(f1, f2)) return;
  const anchor = Math.max(f1, Math.min(f2, curFrame));
  const get = (f) => ((groundTruth[f] || {})[selectedIdent] || []).slice(0, 4);
  const [b1, bA, b2] = [get(f1), get(anchor), get(f2)];
  if (!b1.length || !bA.length || !b2.length) return;
  if (anchor > f1) lerpBoxes(f1, b1, anchor, bA);
  if (f2 > anchor) lerpBoxes(anchor, bA, f2, b2);
  goToFrame(curFrame); setStatus(`Đã nội suy ${selectedIdent} qua frame ${anchor}, đoạn ${f1}–${f2}.`);
}

function swapRange() {
  const [f1, f2] = rangeInputs();
  const id1 = $("swapA").value, id2 = $("swapB").value;
  if (id1 === id2 || !rangeAllowed(f1, f2)) return;
  for (let f = f1; f <= f2; f++) {
    const fd = groundTruth[f];
    if (!fd || !fd[id1] || !fd[id2]) continue;
    const r1 = fd[id1].slice(), r2 = fd[id2].slice();
    r1[7] = true; r2[7] = true;
    fd[id1] = r2; fd[id2] = r1;
  }
  dirty = true;
  goToFrame(curFrame); setStatus(`Đã đổi nhãn ${id1} với ${id2} từ frame ${f1} đến ${f2}.`);
}

// ---- local save and files ---------------------------------------------------------------------------------------------------
function saveLocal() {
  try {
    localStorage.setItem(`gt_v4_${curVid}`, JSON.stringify({ vid: curVid, maxFrames, roster, frames: groundTruth, savedAt: new Date().toISOString() }));
    dirty = false; setStatus(`Đã lưu vào trình duyệt lúc ${new Date().toLocaleTimeString("vi-VN")}.`);
  } catch (e) { setStatus("Bộ nhớ trình duyệt đầy. Hãy tải file .txt để sao lưu.", "error"); }
}

function resetGT() {
  if (!cloudOn) {
    if (!confirm(`Bỏ mọi chỉnh sửa và tải lại dữ liệu gốc của ${curVid}?`)) return;
    try { localStorage.removeItem(`gt_v4_${curVid}`); } catch (e) { /* storage blocked */ }
    openVideo(curVid);
    return;
  }
  if (!myBlock) { setStatus("Chỉ đưa được khối của chính bạn về dữ liệu gốc.", "warn"); return; }
  if (!confirm(`Đưa khối ${myBlock.block + 1} về dữ liệu gốc? Chỉnh sửa chưa khoá của khối này sẽ mất.`)) return;
  for (let f = myBlock.first_frame; f <= myBlock.last_frame; f++) groundTruth[f] = Object.fromEntries(Object.entries(baseGT[f]).map(([id, e]) => [id, e.slice()]));
  dirty = true; goToFrame(curFrame); setStatus(`Khối ${myBlock.block + 1} đã về dữ liệu gốc (chưa lưu).`);
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadBTCTxt() {
  const lines = [];
  for (let f = 1; f <= maxFrames; f++) {
    const fd = groundTruth[f];
    if (!fd) continue;
    for (const id of roster) if (fd[id]) lines.push(`${f},${fd[id][4].toFixed(2)},${fd[id][5].toFixed(2)},${id.split("#")[0]},${id.split("#")[1]}`);
  }
  download(`${curVid}.txt`, lines.join("\n") + "\n", "text/plain;charset=utf-8");
  setStatus(`Đã tải ${curVid}.txt từ dữ liệu đang hiển thị trên trang này.`);
}

function downloadFullCSV() {
  const rows = ["frame,team,jersey,x1,y1,x2,y2,court_x,court_y,observed,edited"];
  for (let f = 1; f <= maxFrames; f++) {
    const fd = groundTruth[f];
    if (!fd) continue;
    for (const id of roster) {
      const r = fd[id];
      if (r) rows.push(`${f},${id.split("#")[0]},${id.split("#")[1]},${r[0]},${r[1]},${r[2]},${r[3]},${r[4]},${r[5]},${r[6] ? "True" : "False"},${r[7] ? "True" : "False"}`);
    }
  }
  download(`${curVid}_gt_boxes.csv`, rows.join("\n") + "\n", "text/csv;charset=utf-8");
  setStatus(`Đã tải ${curVid}_gt_boxes.csv.`);
}

// ---- video: always a file from this computer; the chosen file is remembered (File System Access API: Chrome, Edge) -------------------------
// Playing it straight from Google Drive does not work from another site: Drive answers 403 / HTML to browser media requests (Sec-Fetch-Site: cross-site), see README.
let pendingHandle = null;

const handleDB = () => new Promise((res, rej) => {
  const r = indexedDB.open("gt-editor", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("handles");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});

async function rememberHandle(vid, handle) {
  try {
    const db = await handleDB();
    await new Promise((res, rej) => { const tx = db.transaction("handles", "readwrite"); tx.objectStore("handles").put(handle, vid); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch (e) { console.warn("Không nhớ được file video:", e); }
}

async function recallHandle(vid) {
  try {
    const db = await handleDB();
    return await new Promise((res, rej) => { const rq = db.transaction("handles").objectStore("handles").get(vid); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => rej(rq.error); });
  } catch (e) { return null; }
}

// Presentation time of the first frame, read from the frame callback of a seek to 0; null when the browser cannot tell.
function measureVideoStart() {
  return new Promise((res) => {
    if (!("requestVideoFrameCallback" in video)) { res(null); return; }
    const timer = setTimeout(() => res(null), 3000);
    video.requestVideoFrameCallback((now, meta) => { clearTimeout(timer); res(meta.mediaTime); });
    video.currentTime = 0;
  });
}

function attachVideoUrl(url, label) {
  video.src = url; video.load();
  videoStart = 0;
  video.onloadeddata = async () => {
    video.onloadeddata = null;
    const start = await measureVideoStart();
    videoStart = start === null ? 0 : start;
    hasVideo = true; $("dropzoneStatus").textContent = `Đang dùng: ${label}`; $("videoBanner").className = "banner ok";
    goToFrame(curFrame);
    const problems = [];
    if (start === null) problems.push("Không đo được thời điểm bắt đầu của video: khung hình có thể lệch 1 đến 2 frame so với nhãn.");
    if (!label.toUpperCase().includes(curVid)) problems.push(`Tên file "${label}" không chứa ${curVid}: kiểm tra đã chọn đúng video chưa.`);
    const len = videoLengthProblem(video.duration, TOTAL_FRAMES[curVid], FPS);
    if (len) problems.push(len);
    if (problems.length) setStatus(problems.join(" "), "warn"); else setStatus(`Đã kết nối video ${label} (frame đầu bắt đầu ở ${videoStart.toFixed(3)} s).`);
  };
  video.onerror = () => setStatus("Trình duyệt không phát được file này (cần MP4 H.264).", "error");
}

function handleVideoFile(file) { if (file) attachVideoUrl(URL.createObjectURL(file), file.name); }

async function pickVideo() {
  if (!window.showOpenFilePicker) { $("videoFileInput").click(); return; }
  try {
    const [h] = await window.showOpenFilePicker({ types: [{ description: "Video MP4", accept: { "video/mp4": [".mp4", ".MP4"] } }], multiple: false });
    await rememberHandle(curVid, h);
    handleVideoFile(await h.getFile());
  } catch (e) { if (e.name !== "AbortError") { console.warn(e); $("videoFileInput").click(); } }
}

async function openRemembered() {
  const h = pendingHandle;
  if (!h) return;
  $("reopenVideoBtn").hidden = true;
  try { handleVideoFile(await h.getFile()); }
  catch (e) { setStatus(`Không mở lại được ${h.name}: hãy chọn lại file.`, "warn"); }
}

// Reopen the file chosen last time for this video: straight away when the browser still allows it, else after one click.
async function restoreVideo(vid) {
  $("reopenVideoBtn").hidden = true; pendingHandle = null;
  const h = await recallHandle(vid);
  if (!h || vid !== curVid) return;
  pendingHandle = h;
  let perm = "prompt";
  try { perm = await h.queryPermission({ mode: "read" }); } catch (e) { /* not supported */ }
  if (perm === "granted") await openRemembered();
  else { $("reopenVideoBtn").textContent = `Mở lại ${h.name}`; $("reopenVideoBtn").hidden = false; }
}

$("pickVideoBtn").addEventListener("click", pickVideo);
$("reopenVideoBtn").addEventListener("click", async () => {
  try { if ((await pendingHandle.requestPermission({ mode: "read" })) === "granted") await openRemembered(); } catch (e) { console.warn(e); }
});
$("videoFileInput").addEventListener("change", (e) => { if (e.target.files.length) handleVideoFile(e.target.files[0]); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  const handleRequest = item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;   // has to be requested during the event
  const f = e.dataTransfer.files[0];
  if (!f || !(f.type.startsWith("video/") || /\.mp4$/i.test(f.name))) return;
  handleVideoFile(f);
  try { const h = handleRequest && await handleRequest; if (h && h.kind === "file") await rememberHandle(curVid, h); } catch (err) { /* dropped from somewhere that gives no handle */ }
});
video.addEventListener("seeked", renderCanvas);

// ---- wiring -----------------------------------------------------------------------------------------------------------------
$("vidSelect").addEventListener("change", changeVideo);
document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => stepFrame(parseInt(b.dataset.step, 10))));
$("playBtn").addEventListener("click", togglePlay);
$("frameInput").addEventListener("change", (e) => goToFrame(parseInt(e.target.value, 10)));
$("scrubber").addEventListener("input", (e) => goToFrame(parseInt(e.target.value, 10)));
$("prevMarkBtn").addEventListener("click", () => jumpBookmark(-1));
$("nextMarkBtn").addEventListener("click", () => jumpBookmark(1));
$("drawModeBtn").addEventListener("click", () => toggleDrawMode());
$("copyPrevBtn").addEventListener("click", copyPrevFrame);
$("setStartBtn").addEventListener("click", setRangeStart);
$("setEndBtn").addEventListener("click", setRangeEnd);
$("interpBtn").addEventListener("click", interpolateRange);
$("anchorBtn").addEventListener("click", interpolateFromAnchor);
$("swapBtn").addEventListener("click", swapRange);
$("saveBtn").addEventListener("click", () => saveDraft(true));
$("txtBtn").addEventListener("click", downloadBTCTxt);
$("csvBtn").addEventListener("click", downloadFullCSV);
$("resetBtn").addEventListener("click", resetGT);
$("claimBtn").addEventListener("click", () => claimNext(blockOfFrame(curFrame)));
$("doneBtn").addEventListener("click", completeBlock);
$("releaseBtn").addEventListener("click", releaseBlock);

window.addEventListener("keydown", (evt) => {
  if (evt.target.tagName === "INPUT" || evt.target.tagName === "SELECT") { if (!(evt.key === "Enter" && (evt.ctrlKey || evt.metaKey))) return; }
  const k = evt.key.toLowerCase();
  if (evt.ctrlKey || evt.metaKey) {
    if (k === "s") { evt.preventDefault(); saveDraft(true); }
    else if (evt.key === "Enter") { evt.preventDefault(); completeBlock(); }
    return;
  }
  if (evt.key === " ") { evt.preventDefault(); togglePlay(); }
  else if (evt.key === "ArrowLeft" || k === "a") stepFrame(evt.shiftKey ? -10 : -1);
  else if (evt.key === "ArrowRight" || k === "d") stepFrame(evt.shiftKey ? 10 : 1);
  else if (k === "q") stepFrame(-10);
  else if (k === "e") stepFrame(10);
  else if (k === "w") toggleDrawMode();
  else if (k === "c") copyPrevFrame();
  else if (k === "i") setRangeStart();
  else if (k === "o") setRangeEnd();
  else if (k === "k") interpolateRange();
  else if (k === "j") interpolateFromAnchor();
  else if (k === "n") jumpBookmark(1);
  else if (k === "p") jumpBookmark(-1);
  else if (evt.key >= "1" && evt.key <= "6" && roster[parseInt(evt.key, 10) - 1]) selectPlayer(roster[parseInt(evt.key, 10) - 1]);
});

window.addEventListener("beforeunload", (evt) => { if (cloudOn && myBlock && dirty) { evt.preventDefault(); evt.returnValue = ""; } });
if (cloudOn) {
  setInterval(tickCloud, 45 * 1000);
  setInterval(refreshProgress, 20 * 1000);
  try { $("annotatorName").value = localStorage.getItem("gt_annotator") || ""; } catch (e) { /* storage blocked */ }
  $("connState").textContent = "Đang kết nối…";
}

// ---- start ------------------------------------------------------------------------------------------------------------------
openVideo(curVid);
restoreVideo(curVid);
