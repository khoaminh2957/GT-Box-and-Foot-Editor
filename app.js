/**
 * 🏀 ABC2027 3x3 Basketball Ground-Truth Box & Foot Editor (Web / Vercel Edition)
 * Pure Client-Side Application: Zero server latency, instant 60fps canvas seeking,
 * hardware-accelerated local video loading, and in-browser BTC export.
 */

// Official BTC 4-Point Homography Matrix (720p: 1280x720 -> Court: 1505x1105 cm)
const H_IMG2COURT = [
  [3.86833481736599, 4.0210322443672855, -5829.427872343548],
  [2.9798861427158427, -24.201507726651634, 5855.758151558235],
  [0.00030566688359773373, -0.009504842405414103, 1.0]
];

const FPS = 29.97002997002997;

const ROSTERS = {
  "IMG_0114": ["A#6", "A#9", "A#10", "B#6", "B#9", "B#11"],
  "IMG_0115": ["A#4", "A#10", "A#12", "B#1", "B#3", "B#5"]
};

const TOTAL_FRAMES = {
  "IMG_0114": 11536,
  "IMG_0115": 11823
};

const TEAM_COLORS = {
  "A": "#ffd700", // Team A: Gold
  "B": "#00c3ff"  // Team B: Cyan
};

function imgToCourt(u, v) {
  const w = H_IMG2COURT[2][0] * u + H_IMG2COURT[2][1] * v + H_IMG2COURT[2][2];
  const cx = (H_IMG2COURT[0][0] * u + H_IMG2COURT[0][1] * v + H_IMG2COURT[0][2]) / w;
  const cy = (H_IMG2COURT[1][0] * u + H_IMG2COURT[1][1] * v + H_IMG2COURT[1][2]) / w;
  return [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100];
}

// App State
let curVid = "IMG_0114";
let curFrame = 1;
let maxFrames = 11536;
let roster = ROSTERS["IMG_0114"];
let selectedIdent = roster[0];
let groundTruth = {}; // groundTruth[frame][ident] = [x1, y1, x2, y2, cx, cy, obs, ed]
let bookmarks = [];
let playing = false;
let playInterval = null;
let drawNewBoxMode = false;
let hasVideo = false;

const canvas = document.getElementById("videoCanvas");
const ctx = canvas.getContext("2d");
const video = document.getElementById("videoElement");
let dragState = null;

// Status & UI Elements
const statusEl = document.getElementById("saveStatus");
const scrubber = document.getElementById("scrubber");
const frameInput = document.getElementById("frameInput");
const maxFrameLbl = document.getElementById("maxFrameLbl");
const dropzoneStatus = document.getElementById("dropzoneStatus");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");

function setStatus(msg, isSuccess = true) {
  statusEl.textContent = msg;
  statusEl.style.color = isSuccess ? "#34d399" : "#fbbf24";
}

// Decompress GZIP Stream or ArrayBuffer
async function decompressGzip(arrayBuffer) {
  if (window.DecompressionStream) {
    const ds = new DecompressionStream("gzip");
    const blob = new Blob([arrayBuffer]);
    const stream = blob.stream().pipeThrough(ds);
    const response = new Response(stream);
    return await response.text();
  }
  if (window.fflate && window.fflate.gunzipSync) {
    const decompressed = window.fflate.gunzipSync(new Uint8Array(arrayBuffer));
    return new TextDecoder().decode(decompressed);
  }
  throw new Error("GZIP decompression not supported in this browser.");
}

// Load Ground Truth CSV (.csv.gz)
async function loadGroundTruth(vid) {
  loadingOverlay.style.display = "flex";
  loadingText.textContent = `Đang tải Ground Truth cho ${vid}...`;

  // Saved state: Supabase snapshot and/or browser copy (cloud.js decides which one wins), else the shipped base
  const localKey = `gt_v4_${vid}`;
  let local = null;
  try { local = JSON.parse(localStorage.getItem(localKey) || "null"); } catch (e) { console.warn("Failed to parse cached GT:", e); }
  let cloud = null;
  if (cloudEnabled()) {
    loadingText.textContent = `Đang tải bản lưu trên Supabase (${vid})...`;
    try { cloud = await cloudLoadLatest(vid); } catch (e) { console.warn("Supabase load failed:", e); }
  }
  const pick = chooseSource(local, cloud);
  const saved = pick === "cloud" ? cloud.payload : (pick === "local" ? local : null);
  if (saved && saved.frames && saved.maxFrames) {
    groundTruth = saved.frames;
    maxFrames = saved.maxFrames;
    roster = ROSTERS[vid] || saved.roster;
    selectedIdent = roster[0];
    calculateBookmarks();
    initUI();
    loadingOverlay.style.display = "none";
    setStatus(pick === "cloud" ? `Đã nạp bản lưu Supabase (${vid}, ${cloud.meta.author || "?"}, ${cloud.meta.saved_at.slice(0, 16).replace("T", " ")})` : `Đã nạp bản lưu từ trình duyệt (${vid})`);
    return;
  }

  try {
    const url = `output_ground_truth/${vid}_gt_boxes.csv.gz`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} when fetching ${url}`);
    const buffer = await res.arrayBuffer();
    const csvText = await decompressGzip(buffer);

    parseCSV(csvText, vid);
    calculateBookmarks();
    initUI();
    loadingOverlay.style.display = "none";
    setStatus(`Đã tải sẵn sàng ${vid} (${maxFrames.toLocaleString()} frames)`);
  } catch (err) {
    console.error("Error loading GT data:", err);
    loadingText.textContent = `Lỗi: ${err.message}.`;
    setTimeout(() => { loadingOverlay.style.display = "none"; }, 3000);
  }
}

function parseCSV(csvText, vid) {
  groundTruth = {};
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return;

  const header = lines[0].split(",");
  const idxFrame = header.indexOf("frame");
  const idxTeam = header.indexOf("team");
  const idxJersey = header.indexOf("jersey");
  const idxX1 = header.indexOf("x1");
  const idxY1 = header.indexOf("y1");
  const idxX2 = header.indexOf("x2");
  const idxY2 = header.indexOf("y2");
  const idxCx = header.indexOf("court_x");
  const idxCy = header.indexOf("court_y");
  const idxObs = header.indexOf("observed");
  const idxEd = header.indexOf("edited");

  let maxF = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const p = line.split(",");
    const f = parseInt(p[idxFrame], 10);
    if (f > maxF) maxF = f;
    const team = p[idxTeam];
    const jersey = p[idxJersey];
    const ident = `${team}#${jersey}`;
    const x1 = parseFloat(p[idxX1]);
    const y1 = parseFloat(p[idxY1]);
    const x2 = parseFloat(p[idxX2]);
    const y2 = parseFloat(p[idxY2]);
    const cx = idxCx >= 0 ? parseFloat(p[idxCx]) : imgToCourt(0.5 * (x1 + x2), y2)[0];
    const cy = idxCy >= 0 ? parseFloat(p[idxCy]) : imgToCourt(0.5 * (x1 + x2), y2)[1];
    const obs = p[idxObs] === "True" || p[idxObs] === "true";
    const ed = idxEd >= 0 ? (p[idxEd] === "True" || p[idxEd] === "true") : false;

    if (!groundTruth[f]) groundTruth[f] = {};
    groundTruth[f][ident] = [x1, y1, x2, y2, cx, cy, obs, ed];
  }

  maxFrames = maxF || TOTAL_FRAMES[vid] || 11536;
  roster = ROSTERS[vid] || Object.keys(groundTruth[1] || {});
  selectedIdent = roster[0];
}

function calculateBookmarks() {
  bookmarks = [];
  let prevF = -999;
  for (let f = 1; f <= maxFrames; f++) {
    const fd = groundTruth[f];
    if (!fd) continue;
    let hasInterp = false;
    for (const ident of roster) {
      if (fd[ident] && !fd[ident][6]) { // not observed
        hasInterp = true;
        break;
      }
    }
    if (hasInterp && f - prevF > 8) {
      bookmarks.push(f);
      prevF = f;
    }
  }
}

function initUI() {
  scrubber.max = maxFrames;
  frameInput.max = maxFrames;
  maxFrameLbl.textContent = `/ ${maxFrames.toLocaleString()}`;

  const pWrap = document.getElementById("playerBtns");
  const swA = document.getElementById("swapA");
  const swB = document.getElementById("swapB");
  pWrap.innerHTML = "";
  swA.innerHTML = "";
  swB.innerHTML = "";

  roster.forEach((id, idx) => {
    const team = id.split("#")[0];
    const btn = document.createElement("button");
    btn.className = "p-btn" + (id === selectedIdent ? " active" : "");
    btn.style.background = team === "A" ? "#422006" : "#083344";
    btn.style.color = TEAM_COLORS[team];
    btn.innerHTML = `<span>[${idx + 1}] ${id}</span><span id="tag_${id}"></span>`;
    btn.onclick = () => selectPlayer(id);
    btn.id = `pbtn_${id}`;
    pWrap.appendChild(btn);

    swA.add(new Option(id, id));
    swB.add(new Option(id, id));
  });

  if (roster.length > 1) swB.selectedIndex = 1;
  goToFrame(1);
}

function selectPlayer(id) {
  selectedIdent = id;
  roster.forEach(r => {
    const el = document.getElementById(`pbtn_${r}`);
    if (el) el.className = "p-btn" + (r === id ? " active" : "");
  });
  renderCanvas();
  updateSidebarInfo();
}

function changeVideo() {
  if (playing) togglePlay();
  curVid = document.getElementById("vidSelect").value;
  hasVideo = false;
  dropzoneStatus.textContent = `Chưa chọn video ${curVid}.MP4`;
  document.getElementById("dropzoneCard").className = "video-dropzone";
  video.removeAttribute("src");
  loadGroundTruth(curVid);
  attachDriveVideo(curVid);
}

// Frame Navigation
function goToFrame(f) {
  f = Math.max(1, Math.min(maxFrames, f));
  curFrame = f;
  frameInput.value = f;
  scrubber.value = f;

  if (hasVideo && video.readyState >= 1) {
    const targetTime = (f - 1) / FPS;
    if (Math.abs(video.currentTime - targetTime) > 0.01) {
      video.currentTime = targetTime;
    }
  }

  renderCanvas();
  updateSidebarInfo();
}

function stepFrame(delta) {
  goToFrame(curFrame + delta);
}

function togglePlay() {
  playing = !playing;
  const btn = document.getElementById("playBtn");
  if (playing) {
    btn.textContent = "⏸ Tạm Dừng (Space)";
    const delay = parseInt(document.getElementById("speedSelect").value, 10);
    playInterval = setInterval(() => {
      if (curFrame >= maxFrames) {
        togglePlay();
        return;
      }
      goToFrame(curFrame + 1);
    }, delay);
  } else {
    btn.textContent = "▶ Phát (Space)";
    if (playInterval) clearInterval(playInterval);
  }
}

function jumpBookmark(dir) {
  if (!bookmarks.length) return;
  if (dir > 0) {
    const next = bookmarks.find(b => b > curFrame) || bookmarks[0];
    goToFrame(next);
  } else {
    const prev = [...bookmarks].reverse().find(b => b < curFrame) || bookmarks[bookmarks.length - 1];
    goToFrame(prev);
  }
}

// 2D Court Minimap (Matches Python GT Editor Standalone)
function drawMinimapTopLeft() {
  const mx = 14, my = 14, mw = 236, mh = 174, pad = 12;
  ctx.save();
  ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
  ctx.fillRect(mx, my, mw, mh);
  ctx.strokeStyle = "#475569";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mx, my, mw, mh);

  const cw = mw - 2 * pad;
  const ch = mh - 2 * pad;
  const c2u = (cx) => mx + pad + ((1505.0 - cx) / 1505.0) * cw;
  const c2v = (cy) => my + pad + (cy / 1105.0) * ch;

  // Blue court background
  ctx.fillStyle = "#1e3a8a";
  ctx.fillRect(mx + pad, my + pad, cw, ch);
  ctx.fillStyle = "rgba(148, 163, 184, 0.35)";
  const kx1 = c2u(1002.5), kx2 = c2u(502.5), ky1 = c2v(0), ky2 = c2v(580);
  ctx.fillRect(kx1, ky1, kx2 - kx1, ky2 - ky1);
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.strokeRect(mx + pad, my + pad, cw, ch);
  ctx.strokeRect(kx1, ky1, kx2 - kx1, ky2 - ky1);

  // Hoop at (752.5, 95)
  ctx.beginPath();
  ctx.arc(c2u(752.5), c2v(95.0), 3.5, 0, Math.PI * 2);
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Player Dots
  const frameData = groundTruth[curFrame];
  if (frameData) {
    roster.forEach(id => {
      const r = frameData[id];
      if (!r) return;
      const team = id.split("#")[0];
      const col = TEAM_COLORS[team];
      const px = Math.max(mx + 4, Math.min(mx + mw - 4, c2u(r[4])));
      const py = Math.max(my + 4, Math.min(my + mh - 4, c2v(r[5])));

      ctx.beginPath();
      ctx.arc(px, py, id === selectedIdent ? 6.5 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = id === selectedIdent ? 2 : 1;
      ctx.strokeStyle = id === selectedIdent ? "#ffffff" : "#000000";
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = "bold 10px sans-serif";
      ctx.fillText(id.split("#")[1], px + 6, py + 3);
    });
  }

  ctx.fillStyle = "#94a3b8";
  ctx.font = "bold 9.5px sans-serif";
  ctx.fillText("2D COURT MAP (Rổ ở trên)", mx + 8, my + mh - 4);
  ctx.restore();
}

function getHandles(x1, y1, x2, y2) {
  const xm = 0.5 * (x1 + x2), ym = 0.5 * (y1 + y2);
  return [
    { name: "tl", x: x1, y: y1 },
    { name: "tm", x: xm, y: y1 },
    { name: "tr", x: x2, y: y1 },
    { name: "ml", x: x1, y: ym },
    { name: "mr", x: x2, y: ym },
    { name: "bl", x: x1, y: y2 },
    { name: "bm", x: xm, y: y2 }, // Green Foot Midpoint Handle
    { name: "br", x: x2, y: y2 },
  ];
}

// Render Canvas
function renderCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Draw video background (or dark court grid placeholder if video not loaded)
  if (hasVideo && video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, 1280, 720);
  } else {
    drawCourtPlaceholder();
  }

  // 2. Draw Ground Truth Bounding Boxes
  const frameData = groundTruth[curFrame];
  if (frameData) {
    roster.forEach(id => {
      const r = frameData[id];
      if (!r) return;
      const [x1, y1, x2, y2, cx, cy, obs, edited] = r;
      const isSel = (id === selectedIdent);
      const team = id.split("#")[0];
      const col = TEAM_COLORS[team];

      ctx.save();
      ctx.strokeStyle = isSel ? "#ffffff" : col;
      ctx.lineWidth = isSel ? 2.5 : 1.8;
      if (!obs && !edited) ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);

      // Label Pill
      const lbl = `${id}${edited ? " ★" : (!obs ? " (interp)" : "")}`;
      ctx.font = "bold 12px sans-serif";
      const tw = ctx.measureText(lbl).width;
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.fillRect(x1, Math.max(0, y1 - 18), tw + 8, 18);
      ctx.fillStyle = col;
      ctx.fillText(lbl, x1 + 4, Math.max(13, y1 - 5));

      // Foot Midpoint Dot
      const uFoot = 0.5 * (x1 + x2);
      const vFoot = y2;
      ctx.beginPath();
      ctx.arc(uFoot, vFoot, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = "#000000";
      ctx.stroke();

      // Resize Handles for Selected Box
      if (isSel) {
        getHandles(x1, y1, x2, y2).forEach(h => {
          ctx.fillStyle = h.name === "bm" ? "#22c55e" : "#ffffff";
          ctx.strokeStyle = "#000000";
          ctx.lineWidth = 1.2;
          ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
          ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
        });
      }
      ctx.restore();

      const tagEl = document.getElementById(`tag_${id}`);
      if (tagEl) tagEl.textContent = edited ? "★" : (!obs ? "○" : "●");
    });
  }

  // 3. Draw 2D Minimap
  drawMinimapTopLeft();
}

function drawCourtPlaceholder() {
  ctx.fillStyle = "#090d16";
  ctx.fillRect(0, 0, 1280, 720);

  // Subtle grid
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x < 1280; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 720); ctx.stroke();
  }
  for (let y = 0; y < 720; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1280, y); ctx.stroke();
  }

  // Perspective 4-Point Boundary Lines (Official BTC Markers)
  ctx.strokeStyle = "rgba(56, 189, 248, 0.25)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(1113, 379); // RKU0
  ctx.lineTo(955, 531);  // RKU1
  ctx.lineTo(141, 374);  // RKU11
  ctx.lineTo(512, 305);  // RKU10
  ctx.closePath();
  ctx.stroke();

  // Watermark Notice
  ctx.fillStyle = "rgba(148, 163, 184, 0.45)";
  ctx.font = "600 14px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`Kéo thả video ${curVid}.MP4 vào đây để xem video trực tiếp`, 640, 680);
  ctx.textAlign = "left";
}

function updateSidebarInfo() {
  const frameData = groundTruth[curFrame];
  if (!frameData) return;
  const r = frameData[selectedIdent];
  if (!r) return;
  const [x1, y1, x2, y2, cx, cy, obs, edited] = r;
  const uFoot = (0.5 * (x1 + x2)).toFixed(1);
  const vFoot = y2.toFixed(1);

  document.getElementById("boxInfo").innerHTML = `
    <div>Cầu thủ   : <b style="color:#38bdf8">${selectedIdent}</b> (${edited ? "Đã sửa ★" : (obs ? "YOLO26m Obs" : "Nội suy")})</div>
    <div>Box 720p  : [${x1.toFixed(1)}, ${y1.toFixed(1)}, ${x2.toFixed(1)}, ${y2.toFixed(1)}]</div>
    <div>Đáy giữa  : <b>(${uFoot}, ${vFoot}) px</b></div>
    <div>Tọa độ sân: <b style="color:#34d399">(${cx.toFixed(1)}, ${cy.toFixed(1)}) cm</b></div>
  `;
}

// Mouse Canvas Interaction
function getMousePos(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY
  };
}

canvas.addEventListener("mousedown", (evt) => {
  const pos = getMousePos(evt);
  const frameData = groundTruth[curFrame];
  if (!frameData) return;

  if (drawNewBoxMode) {
    dragState = { mode: "draw", startX: pos.x, startY: pos.y, origBox: [pos.x, pos.y, pos.x + 20, pos.y + 50] };
    return;
  }

  const selR = frameData[selectedIdent];
  if (selR) {
    const handles = getHandles(selR[0], selR[1], selR[2], selR[3]);
    for (const h of handles) {
      if (Math.hypot(pos.x - h.x, pos.y - h.y) <= 8) {
        dragState = { mode: "resize", handle: h.name, startX: pos.x, startY: pos.y, origBox: [...selR.slice(0, 4)] };
        return;
      }
    }
  }

  const checkOrder = [selectedIdent, ...roster.filter(i => i !== selectedIdent)];
  for (const id of checkOrder) {
    const r = frameData[id];
    if (!r) continue;
    if (pos.x >= r[0] && pos.x <= r[2] && pos.y >= r[1] && pos.y <= r[3]) {
      if (id !== selectedIdent) selectPlayer(id);
      dragState = { mode: "move", startX: pos.x, startY: pos.y, origBox: [...r.slice(0, 4)] };
      return;
    }
  }
});

canvas.addEventListener("mousemove", (evt) => {
  if (!dragState) return;
  const pos = getMousePos(evt);
  const dx = pos.x - dragState.startX;
  const dy = pos.y - dragState.startY;
  let [x1, y1, x2, y2] = dragState.origBox;

  if (dragState.mode === "move") {
    x1 += dx; x2 += dx; y1 += dy; y2 += dy;
  } else if (dragState.mode === "draw") {
    x1 = Math.min(dragState.startX, pos.x);
    y1 = Math.min(dragState.startY, pos.y);
    x2 = Math.max(dragState.startX + 8, pos.x);
    y2 = Math.max(dragState.startY + 16, pos.y);
  } else if (dragState.mode === "resize") {
    const h = dragState.handle;
    if (h.includes("l")) x1 += dx;
    if (h.includes("r")) x2 += dx;
    if (h.includes("t")) y1 += dy;
    if (h.includes("b")) y2 += dy;
  }

  if (x2 < x1 + 6) x2 = x1 + 6;
  if (y2 < y1 + 12) y2 = y1 + 12;

  updateBox(curVid, curFrame, selectedIdent, x1, y1, x2, y2);
  renderCanvas();
  updateSidebarInfo();
});

window.addEventListener("mouseup", () => {
  if (!dragState) return;
  const mode = dragState.mode;
  dragState = null;
  if (mode === "draw") toggleDrawMode(false);
  setStatus(`Đã sửa ${selectedIdent} @ frame=${curFrame} (Nhấn Ctrl+S để lưu)`);
});

// Editing & Interpolation Core Math
function updateBox(vid, f, ident, x1, y1, x2, y2) {
  if (!groundTruth[f]) groundTruth[f] = {};
  if (x2 < x1 + 4) x2 = x1 + 4;
  if (y2 < y1 + 8) y2 = y1 + 8;
  const uFoot = 0.5 * (x1 + x2);
  const vFoot = y2;
  const [cx, cy] = imgToCourt(uFoot, vFoot);
  const prevObs = groundTruth[f][ident] ? groundTruth[f][ident][6] : true;
  groundTruth[f][ident] = [
    Math.round(x1 * 100) / 100,
    Math.round(y1 * 100) / 100,
    Math.round(x2 * 100) / 100,
    Math.round(y2 * 100) / 100,
    cx,
    cy,
    prevObs,
    true // edited = true
  ];
}

function toggleDrawMode(forceVal) {
  drawNewBoxMode = (forceVal !== undefined) ? forceVal : !drawNewBoxMode;
  const btn = document.getElementById("drawModeBtn");
  btn.textContent = `✏️ Chế độ Vẽ Lại Box (W): ${drawNewBoxMode ? "BẬT" : "TẮT"}`;
  btn.className = drawNewBoxMode ? "primary" : "";
}

function copyPrevFrame() {
  if (curFrame <= 1) return;
  const prevData = groundTruth[curFrame - 1];
  if (!prevData || !prevData[selectedIdent]) return;
  const pb = prevData[selectedIdent];
  updateBox(curVid, curFrame, selectedIdent, pb[0], pb[1], pb[2], pb[3]);
  goToFrame(Math.min(maxFrames, curFrame + 1));
  setStatus(`Đã sao chép box ${selectedIdent} từ f=${curFrame - 1}`);
}

function setRangeStart() { document.getElementById("fStart").value = curFrame; }
function setRangeEnd() { document.getElementById("fEnd").value = curFrame; }

function interpolateRange() {
  let f1 = parseInt(document.getElementById("fStart").value, 10);
  let f2 = parseInt(document.getElementById("fEnd").value, 10);
  if (f1 > f2) [f1, f2] = [f2, f1];
  if (!groundTruth[f1] || !groundTruth[f2]) return;

  const b1 = groundTruth[f1][selectedIdent].slice(0, 4);
  const b2 = groundTruth[f2][selectedIdent].slice(0, 4);
  const span = Math.max(1, f2 - f1);

  for (let f = f1; f <= f2; f++) {
    const alpha = (f - f1) / span;
    const x1 = (1.0 - alpha) * b1[0] + alpha * b2[0];
    const y1 = (1.0 - alpha) * b1[1] + alpha * b2[1];
    const x2 = (1.0 - alpha) * b1[2] + alpha * b2[2];
    const y2 = (1.0 - alpha) * b1[3] + alpha * b2[3];
    updateBox(curVid, f, selectedIdent, x1, y1, x2, y2);
  }
  goToFrame(curFrame);
  setStatus(`Đã nội suy tuyến tính ${selectedIdent} [${f1}..${f2}]`);
}

function interpolateFromAnchor() {
  let f1 = parseInt(document.getElementById("fStart").value, 10);
  let f2 = parseInt(document.getElementById("fEnd").value, 10);
  const anchor = curFrame;
  if (f1 > f2) [f1, f2] = [f2, f1];
  const boundedAnchor = Math.max(f1, Math.min(f2, anchor));

  const bAnchor = groundTruth[boundedAnchor][selectedIdent].slice(0, 4);

  // Left segment: f1 -> anchor
  if (boundedAnchor > f1) {
    const b1 = groundTruth[f1][selectedIdent].slice(0, 4);
    const span = Math.max(1, boundedAnchor - f1);
    for (let f = f1; f <= boundedAnchor; f++) {
      const alpha = (f - f1) / span;
      const x1 = (1.0 - alpha) * b1[0] + alpha * bAnchor[0];
      const y1 = (1.0 - alpha) * b1[1] + alpha * bAnchor[1];
      const x2 = (1.0 - alpha) * b1[2] + alpha * bAnchor[2];
      const y2 = (1.0 - alpha) * b1[3] + alpha * bAnchor[3];
      updateBox(curVid, f, selectedIdent, x1, y1, x2, y2);
    }
  }

  // Right segment: anchor -> f2
  if (f2 > boundedAnchor) {
    const b2 = groundTruth[f2][selectedIdent].slice(0, 4);
    const span = Math.max(1, f2 - boundedAnchor);
    for (let f = boundedAnchor; f <= f2; f++) {
      const alpha = (f - boundedAnchor) / span;
      const x1 = (1.0 - alpha) * bAnchor[0] + alpha * b2[0];
      const y1 = (1.0 - alpha) * bAnchor[1] + alpha * b2[1];
      const x2 = (1.0 - alpha) * bAnchor[2] + alpha * b2[2];
      const y2 = (1.0 - alpha) * bAnchor[3] + alpha * b2[3];
      updateBox(curVid, f, selectedIdent, x1, y1, x2, y2);
    }
  }

  goToFrame(curFrame);
  setStatus(`Đã nội suy anchor ${selectedIdent} @ f=${boundedAnchor} [${f1}..${f2}]`);
}

function swapRange() {
  let f1 = parseInt(document.getElementById("fStart").value, 10);
  let f2 = parseInt(document.getElementById("fEnd").value, 10);
  if (f1 > f2) [f1, f2] = [f2, f1];
  const id1 = document.getElementById("swapA").value;
  const id2 = document.getElementById("swapB").value;
  if (id1 === id2) return;

  for (let f = f1; f <= f2; f++) {
    if (!groundTruth[f]) continue;
    const r1 = [...groundTruth[f][id1]];
    const r2 = [...groundTruth[f][id2]];
    r1[7] = true;
    r2[7] = true;
    groundTruth[f][id1] = r2;
    groundTruth[f][id2] = r1;
  }
  goToFrame(curFrame);
  setStatus(`Đã hoán đổi ${id1} ⇄ ${id2} [${f1}..${f2}]`);
}

// Save & Export
function saveGT() {
  let editedCount = 0;
  for (let f = 1; f <= maxFrames; f++) {
    const fd = groundTruth[f];
    if (!fd) continue;
    for (const id of roster) {
      if (fd[id] && fd[id][7]) editedCount++;
    }
  }

  const payload = {
    vid: curVid,
    maxFrames,
    roster,
    frames: groundTruth
  };
  try {
    localStorage.setItem(`gt_v4_${curVid}`, JSON.stringify({ ...payload, savedAt: new Date().toISOString() }));
    setStatus(`Đã lưu trình duyệt (${editedCount} box đã sửa)`);
  } catch (e) {
    setStatus("Bộ nhớ localStorage đầy! Hãy xuất file .txt để sao lưu.", false);
  }
  if (cloudEnabled()) {
    const vid = curVid;
    cloudSaveSnapshot(vid, payload, editedCount)
      .then((r) => setStatus(r === "saved" ? `Đã lưu Supabase (${vid}, ${editedCount} box đã sửa)` : `Supabase đã có đúng bản này (${vid})`))
      .catch((err) => { console.error("Supabase save failed:", err); setStatus(`Lưu Supabase thất bại: ${err.message || err}. Bản trình duyệt vẫn còn.`, false); });
  }
}

function resetGT() {
  if (confirm(`Bạn có chắc muốn xóa bản sửa đổi và tải lại dữ liệu gốc của ${curVid}?`)) {
    localStorage.removeItem(`gt_v4_${curVid}`);
    loadGroundTruth(curVid);
  }
}

// Download Official BTC 5-column .txt Format
function downloadBTCTxt() {
  let lines = [];
  for (let f = 1; f <= maxFrames; f++) {
    const fd = groundTruth[f];
    if (!fd) continue;
    for (const ident of roster) {
      const [team, jer] = ident.split("#");
      const r = fd[ident];
      if (!r) continue;
      // 5 columns: frame, court_x, court_y, team, jersey
      lines.push(`${f},${r[4].toFixed(2)},${r[5].toFixed(2)},${team},${jer}`);
    }
  }

  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${curVid}.txt`;
  a.click();
  setStatus(`Đã tải xuống ${curVid}.txt chuẩn BTC!`);
}

// Download Full 11-column .csv Format
function downloadFullCSV() {
  let rows = ["frame,team,jersey,x1,y1,x2,y2,court_x,court_y,observed,edited"];
  for (let f = 1; f <= maxFrames; f++) {
    const fd = groundTruth[f];
    if (!fd) continue;
    for (const ident of roster) {
      const [team, jer] = ident.split("#");
      const r = fd[ident];
      if (!r) continue;
      rows.push(`${f},${team},${jer},${r[0]},${r[1]},${r[2]},${r[3]},${r[4]},${r[5]},${r[6]},${r[7]}`);
    }
  }

  const blob = new Blob([rows.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${curVid}_gt_boxes.csv`;
  a.click();
  setStatus(`Đã tải xuống ${curVid}_gt_boxes.csv!`);
}

// Video File Picker & Drag-and-Drop
const videoFileInput = document.getElementById("videoFileInput");

function attachVideoUrl(url, label, onFail) {
  video.src = url;
  video.load();
  video.onloadeddata = () => {
    hasVideo = true;
    dropzoneStatus.textContent = `Đã kết nối: ${label}`;
    document.getElementById("dropzoneCard").className = "video-dropzone loaded";
    goToFrame(curFrame);
    setStatus(`Đã kết nối video: ${label}`);
  };
  video.onerror = () => { if (onFail) onFail(); };
}

function handleVideoFile(file) {
  if (!file) return;
  attachVideoUrl(URL.createObjectURL(file), file.name);
}

// Video from Google Drive when config.js names one for this video; the file picker above always remains as the fallback.
function attachDriveVideo(vid) {
  const link = (window.GT_CONFIG && window.GT_CONFIG.driveVideos || {})[vid];
  if (!link) return;
  dropzoneStatus.textContent = `Đang mở ${vid} từ Google Drive...`;
  attachVideoUrl(driveVideoUrl(link), `${vid} (Google Drive)`, () => {
    hasVideo = false;
    video.removeAttribute("src");
    dropzoneStatus.textContent = `Không phát được ${vid} từ Drive. Hãy chọn file từ máy (.MP4)`;
    setStatus(`Video Drive lỗi (${vid}); chọn file từ máy.`, false);
  });
}

videoFileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleVideoFile(e.target.files[0]);
});

// Canvas Drag & Drop Video
const dropCard = document.getElementById("dropzoneCard");
["dragenter", "dragover"].forEach(name => {
  window.addEventListener(name, (e) => {
    e.preventDefault();
    dropCard.style.borderColor = "#38bdf8";
  });
});
["dragleave", "drop"].forEach(name => {
  window.addEventListener(name, (e) => {
    e.preventDefault();
    dropCard.style.borderColor = "";
  });
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) {
    const file = e.dataTransfer.files[0];
    if (file.type.startsWith("video/") || file.name.endsWith(".mp4") || file.name.endsWith(".MP4")) {
      handleVideoFile(file);
    }
  }
});

// Keyboard Shortcuts
window.addEventListener("keydown", (evt) => {
  if (evt.target.tagName === "INPUT" || evt.target.tagName === "SELECT") return;

  if (evt.ctrlKey && (evt.key === "s" || evt.key === "S")) {
    evt.preventDefault();
    saveGT();
    return;
  }
  if (evt.key === " ") { evt.preventDefault(); togglePlay(); }
  else if (evt.key === "ArrowLeft" || evt.key === "a" || evt.key === "A") stepFrame(evt.shiftKey ? -10 : -1);
  else if (evt.key === "ArrowRight" || evt.key === "d" || evt.key === "D") stepFrame(evt.shiftKey ? 10 : 1);
  else if (evt.key === "q" || evt.key === "Q") stepFrame(-10);
  else if (evt.key === "e" || evt.key === "E") stepFrame(10);
  else if (evt.key === "w" || evt.key === "W") toggleDrawMode();
  else if (evt.key === "c" || evt.key === "C") copyPrevFrame();
  else if (evt.key === "i" || evt.key === "I") setRangeStart();
  else if (evt.key === "o" || evt.key === "O") setRangeEnd();
  else if (evt.key === "k" || evt.key === "K") interpolateRange();
  else if (evt.key === "j" || evt.key === "J") interpolateFromAnchor();
  else if (evt.key === "n" || evt.key === "N") jumpBookmark(1);
  else if (evt.key === "p" || evt.key === "P") jumpBookmark(-1);
  else if (evt.key >= "1" && evt.key <= "6") {
    const idx = parseInt(evt.key, 10) - 1;
    if (roster[idx]) selectPlayer(roster[idx]);
  }
});

// Video Seek Sync
video.addEventListener("seeked", () => {
  renderCanvas();
});

// Initialize on Load
loadGroundTruth(curVid);
attachDriveVideo(curVid);
