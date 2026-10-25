// Static server for the repo root + an in-memory stand-in for the Supabase backend (the rules of supabase/migrations/*_gt_blocks.sql, which
// tests/sql/blocks.test.mjs checks against a real Postgres).  The page talks to it through mock-supabase.js, so two browser contexts = two people.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const LEASE_MS = 15 * 60 * 1000;
const TOTAL = { IMG_0114: 11536, IMG_0115: 11823 };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".gz": "application/octet-stream", ".txt": "text/plain" };

export function newBackend(now = () => Date.now()) {
  const blocks = {};
  for (const [video, total] of Object.entries(TOTAL)) {
    blocks[video] = Array.from({ length: Math.ceil(total / 50) }, (_, b) => ({ video, block: b, first_frame: b * 50 + 1, last_frame: Math.min(total, (b + 1) * 50), status: "open",
      claimed_by: null, claimed_name: null, claimed_at: null, done_by: null, done_name: null, done_at: null, labels: null }));
  }
  const err = (code, message) => ({ data: null, error: { code, message } });
  const ok = (data) => ({ data, error: null });
  const eff = (b) => (b.status === "claimed" && now() - b.claimed_at > LEASE_MS ? "open" : b.status);
  const owned = (b, uid) => b && b.status === "claimed" && b.claimed_by === uid;
  const validFrames = (b, labels) => labels && labels.frames && Object.keys(labels.frames).length === b.last_frame - b.first_frame + 1
    && Array.from({ length: b.last_frame - b.first_frame + 1 }, (_, i) => labels.frames[String(b.first_frame + i)]).every((f) => f && typeof f === "object" && Object.keys(f).length === 6);

  const rpc = {
    gt_claim_block(uid, { p_video, p_prefer, p_name }) {
      if (!uid) return err("GT000", "not signed in");
      const nm = (p_name || "").trim();
      if (nm.length < 1 || nm.length > 40) return err("GT002", "name must be 1 to 40 characters");
      const list = blocks[p_video]; if (!list) return err("GT002", "unknown video");
      let b = list.find((x) => owned(x, uid));
      if (!b) {
        const free = list.filter((x) => eff(x) === "open").sort((x, y) => (x.block < (p_prefer || 0)) - (y.block < (p_prefer || 0)) || x.block - y.block);
        b = free[0];
        if (!b) return ok({ video: null, block: null });
        b.status = "claimed"; b.claimed_by = uid;
      }
      b.claimed_name = nm; b.claimed_at = now();
      return ok(structuredClone(b));
    },
    gt_save_draft(uid, { p_video, p_block, p_labels }) {
      if (!uid) return err("GT000", "not signed in");
      if (!p_labels || typeof p_labels.frames !== "object") return err("GT003", "labels must be {frames: ...}");
      const b = blocks[p_video]?.[p_block];
      if (!owned(b, uid)) return err("GT001", "this block is not claimed by you");
      b.labels = p_labels; b.claimed_at = now(); return ok(null);
    },
    gt_complete_block(uid, { p_video, p_block, p_labels }) {
      if (!uid) return err("GT000", "not signed in");
      const b = blocks[p_video]?.[p_block];
      if (!owned(b, uid)) return err("GT001", "this block is not claimed by you");
      if (!validFrames(b, p_labels)) return err("GT003", `labels must hold exactly frames ${b.first_frame} to ${b.last_frame} with six players each`);
      Object.assign(b, { status: "done", done_by: uid, done_name: b.claimed_name, done_at: now(), labels: p_labels, claimed_by: null, claimed_at: null });
      return ok(structuredClone(b));
    },
    gt_release_block(uid, { p_video, p_block }) {
      if (!uid) return err("GT000", "not signed in");
      const b = blocks[p_video]?.[p_block];
      if (!owned(b, uid)) return err("GT001", "this block is not claimed by you");
      Object.assign(b, { status: "open", claimed_by: null, claimed_name: null, claimed_at: null }); return ok(null);
    },
  };

  function query({ table, filters, single }) {
    const rows = (blocks[filters.video] || []).filter((b) => filters.block === undefined || b.block === filters.block);
    if (table === "gt_block_status") return ok(rows.map((b) => ({ block: b.block, first_frame: b.first_frame, last_frame: b.last_frame, status: eff(b), claimed_by: b.claimed_by, claimed_name: b.claimed_name, done_name: b.done_name, done_at: b.done_at })));
    if (table === "gt_blocks") return ok(single ? (rows[0] ? { labels: rows[0].labels } : null) : rows.map((b) => ({ labels: b.labels })));
    return err("42P01", `no table ${table}`);
  }
  return { blocks, rpc, query, expire: (video, block) => { blocks[video][block].claimed_at = now() - LEASE_MS - 1000; } };
}

export async function startServer(root) {
  const backend = newBackend();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/__mock/")) {
      let body = ""; for await (const c of req) body += c;
      if (Number(process.env.MOCK_LATENCY_MS)) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_LATENCY_MS)));      // slow-network stand-in: the browser tests must not depend on timing
      const json = body ? JSON.parse(body) : {};
      const uid = req.headers["x-uid"] || null;
      let out;
      if (url.pathname === "/__mock/rpc") out = backend.rpc[json.fn] ? backend.rpc[json.fn](uid, json.args) : { data: null, error: { code: "42883", message: `no function ${json.fn}` } };
      else if (url.pathname === "/__mock/query") out = backend.query(json);
      else out = { data: null, error: { code: "404", message: "unknown mock endpoint" } };
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out)); return;
    }
    try {
      const file = path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
      if (!file.startsWith(root)) throw new Error("outside root");
      const buf = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(buf);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, backend, close: () => new Promise((r) => server.close(r)) };
}
