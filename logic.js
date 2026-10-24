/**
 * Pure logic shared by the editor and its tests: homography, block arithmetic and the label payload of a block.
 * No DOM access here; the Node tests load this file with require().
 */

// Official BTC 4-point homography (720p image -> court 1505 x 1105 cm). The same matrix is in scripts/gt_export.py.
const H_IMG2COURT = [
  [3.86833481736599, 4.0210322443672855, -5829.427872343548],
  [2.9798861427158427, -24.201507726651634, 5855.758151558235],
  [0.00030566688359773373, -0.009504842405414103, 1.0]
];

function imgToCourt(u, v) {
  const w = H_IMG2COURT[2][0] * u + H_IMG2COURT[2][1] * v + H_IMG2COURT[2][2];
  const cx = (H_IMG2COURT[0][0] * u + H_IMG2COURT[0][1] * v + H_IMG2COURT[0][2]) / w;
  const cy = (H_IMG2COURT[1][0] * u + H_IMG2COURT[1][1] * v + H_IMG2COURT[1][2]) / w;
  return [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100];
}

// Blocks: 50 consecutive frames, numbered from 0, frames numbered from 1. Must match supabase/migrations/*_gt_blocks.sql.
const BLOCK_SIZE = 50;

function blockOfFrame(frame) {
  return Math.floor((frame - 1) / BLOCK_SIZE);
}

function blockRange(block, totalFrames) {
  return { first: block * BLOCK_SIZE + 1, last: Math.min(totalFrames, (block + 1) * BLOCK_SIZE) };
}

// mine = the block row this browser has claimed (first_frame / last_frame) or null; cloud = whether Supabase is in use.
// Without the cloud every frame is editable (local mode); with it only the frames of the claimed block are.
function canEditFrame(cloud, mine, frame) {
  if (!cloud) return true;
  return !!mine && frame >= mine.first_frame && frame <= mine.last_frame;
}

function rangeInsideBlock(cloud, mine, f1, f2) {
  if (!cloud) return true;
  return !!mine && Math.min(f1, f2) >= mine.first_frame && Math.max(f1, f2) <= mine.last_frame;
}

// groundTruth[frame][ident] = [x1, y1, x2, y2, court_x, court_y, observed, edited]
function buildBlockPayload(groundTruth, roster, first, last) {
  const frames = {};
  for (let f = first; f <= last; f++) {
    const fd = groundTruth[f];
    if (!fd) throw new Error(`frame ${f} has no labels`);
    frames[String(f)] = {};
    for (const id of roster) {
      if (!fd[id]) throw new Error(`frame ${f}: ${id} has no box`);
      frames[String(f)][id] = fd[id].slice(0, 8);
    }
  }
  return { frames };
}

// Problems that should stop "Xong khối". Mirrors the checks of scripts/gt_export.py (tolerance 0.1 cm: see EDITED_TOL there).
function validateBlockFrames(groundTruth, roster, first, last) {
  const problems = [];
  for (let f = first; f <= last && problems.length < 20; f++) {
    const fd = groundTruth[f];
    for (const id of roster) {
      const e = fd && fd[id];
      if (!e) { problems.push(`frame ${f}: thiếu ${id}`); continue; }
      const [x1, y1, x2, y2, cx, cy, , edited] = e;
      if (![x1, y1, x2, y2, cx, cy].every(Number.isFinite)) problems.push(`frame ${f} ${id}: giá trị không hợp lệ`);
      else if (x2 <= x1 || y2 <= y1) problems.push(`frame ${f} ${id}: box rỗng hoặc ngược`);
      else if (edited === true) {
        const [ex, ey] = imgToCourt(0.5 * (x1 + x2), y2);
        if (Math.abs(ex - cx) > 0.1 || Math.abs(ey - cy) > 0.1) problems.push(`frame ${f} ${id}: tọa độ sân không khớp điểm chân`);
      }
    }
  }
  return problems;
}

// Copy the frames of a payload ({"frames": {"101": {"A#6": [...]}}}) into groundTruth.
function overlayFrames(groundTruth, payload) {
  const frames = (payload && payload.frames) || {};
  for (const key of Object.keys(frames)) {
    const f = parseInt(key, 10);
    groundTruth[f] = {};
    for (const id of Object.keys(frames[key])) groundTruth[f][id] = frames[key][id].slice(0, 8);
  }
}

// Time (seconds) at which a video whose first frame is presented at `start` shows label frame f (frame 1 = first decoded frame): the middle of that frame's display interval.
// The first frame of IMG_0114 is presented at 0.041 s, not 0; seeking to (f - 1) / fps showed the frame two places too early in Chrome (see README).
function frameTime(f, start, fps) {
  return start + (f - 0.5) / fps;
}

// Does the chosen video have the number of frames the labels were made for?  -> a message, or "" when it fits.
function videoLengthProblem(durationSeconds, expectedFrames, fps, tolerance = 2) {
  const n = Math.round(durationSeconds * fps);
  return Math.abs(n - expectedFrames) > tolerance ? `Video có khoảng ${n} frame nhưng nhãn cần ${expectedFrames}: kiểm tra đã chọn đúng file chưa.` : "";
}

function countStatuses(rows) {
  const n = { open: 0, claimed: 0, done: 0 };
  for (const r of rows) n[r.status] = (n[r.status] || 0) + 1;
  return n;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { H_IMG2COURT, imgToCourt, BLOCK_SIZE, blockOfFrame, blockRange, canEditFrame, rangeInsideBlock, buildBlockPayload, validateBlockFrames, overlayFrames, frameTime, videoLengthProblem, countStatuses };
}
