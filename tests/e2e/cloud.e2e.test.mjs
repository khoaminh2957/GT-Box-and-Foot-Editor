// The labelling workflow in a real Chrome against the mock backend (mock-server.mjs): claim, edit only inside the block, validate, lock, hand over to the next block,
// see other people's finished blocks, lose a lapsed claim, release.  Screenshots go to tests/e2e/out/ (not committed).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./mock-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "out");
const MOCK = readFileSync(path.join(HERE, "mock-supabase.js"), "utf8");
let server, browser;
const people = {};

async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  await page.route("**/supabase-js@*/**", (r) => r.fulfill({ contentType: "text/javascript", body: MOCK }));
  await page.route("**/fflate@*/**", (r) => r.fulfill({ contentType: "text/javascript", body: "" }));
  await page.route("**/config.js", (r) => r.fulfill({ contentType: "text/javascript", body: `window.GT_CONFIG = { supabaseUrl: "http://mock", supabaseAnonKey: "k" };` }));
  page.on("dialog", (d) => d.accept());
  await page.goto(server.url + "/");
  await page.waitForFunction(() => document.getElementById("connState").textContent.includes("Đã kết nối") && typeof groundTruth[1] === "object" && Object.keys(groundTruth[1] || {}).length === 6);
  people[name] = page;
  return page;
}

const status = (p) => p.textContent("#saveStatus");
const myBlock = (p) => p.evaluate(() => (myBlock ? myBlock.block : null));
async function claim(p, name) {
  await p.fill("#annotatorName", name);
  await p.click("#claimBtn");
  await p.waitForFunction(() => myBlock !== null);
}
async function dragSelected(p, dx = 30, dy = 8) {
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.keyboard.press("1");
  const pt = await p.evaluate(() => { const e = groundTruth[curFrame][selectedIdent], r = canvas.getBoundingClientRect(); return { x: r.left + (0.5 * (e[0] + e[2]) / 1280) * r.width, y: r.top + (0.5 * (e[1] + e[3]) / 720) * r.height }; });
  await p.mouse.move(pt.x, pt.y); await p.mouse.down(); await p.mouse.move(pt.x + dx, pt.y + dy, { steps: 4 }); await p.mouse.up();
}
const entry = (p, f, id = "A#6") => p.evaluate(([f, id]) => groundTruth[f][id].slice(), [f, id]);
const go = (p, f) => p.evaluate((f) => goToFrame(f), f);

before(async () => {
  mkdirSync(OUT, { recursive: true });
  server = await startServer(ROOT);
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => { await browser.close(); await server.close(); });

test("before claiming a block everything is read-only", async () => {
  const a = await person("An");
  assert.match(await a.textContent("#topBlock"), /Chưa nhận khối/);
  assert.match(await a.textContent("#viewNotice"), /Chưa nhận khối: chỉ xem/);
  const before = await entry(a, 1);
  await dragSelected(a);
  assert.deepEqual(await entry(a, 1), before, "no edit without a block");
  assert.equal(await a.evaluate(() => dirty), false);
  assert.equal(await a.isVisible("#claimBtn"), true); assert.equal(await a.isVisible("#doneBtn"), false);
});

test("claiming gives block 1 (frames 1-50) and unlocks editing only inside it", async () => {
  const a = people.An;
  await claim(a, "An");
  assert.equal(await myBlock(a), 0);
  assert.match(await a.textContent("#topBlock"), /Khối 1 · frame 1–50/);
  const before = await entry(a, 1);
  await dragSelected(a);
  const after = await entry(a, 1);
  assert.notDeepEqual(after.slice(0, 4), before.slice(0, 4), "the box moved");
  assert.equal(after[7], true, "flagged as edited");
  const court = await a.evaluate((e) => imgToCourt(0.5 * (e[0] + e[2]), e[3]), after);
  assert.deepEqual([after[4], after[5]], court, "court position derived from the stored (rounded) corners");
  assert.equal(await a.evaluate(() => dirty), true);

  await go(a, 60);                                                                   // outside the block
  assert.match(await a.textContent("#viewNotice"), /Khối 2 chưa ai nhận\. Chỉ xem/);
  const at60 = await entry(a, 60);
  await dragSelected(a);
  assert.deepEqual(await entry(a, 60), at60, "frame 60 is not editable");

  await a.fill("#fStart", "40"); await a.fill("#fEnd", "60"); await a.click("#interpBtn");
  assert.match(await status(a), /vượt ra ngoài khối/);
  assert.deepEqual(await entry(a, 45), (await a.evaluate(() => baseGT[45]["A#6"].slice())), "frame 45 untouched by the refused interpolation");

  await a.fill("#fStart", "1"); await a.fill("#fEnd", "10"); await go(a, 5); await a.click("#interpBtn");   // inside the block it works
  assert.equal((await entry(a, 5))[7], true);
  await a.screenshot({ path: path.join(OUT, "1-claimed-editing.png") });
});

test("a draft can be saved and is stored on the server", async () => {
  const a = people.An;
  await a.keyboard.press("Control+s");
  await a.waitForFunction(() => /Đã lưu bản nháp khối 1/.test(document.getElementById("saveStatus").textContent));
  const b0 = server.backend.blocks.IMG_0114[0];
  assert.equal(b0.status, "claimed"); assert.equal(Object.keys(b0.labels.frames).length, 50); assert.equal(b0.labels.frames["5"]["A#6"][7], true);
  assert.equal(await a.evaluate(() => dirty), false);
});

test("a block with invalid labels cannot be finished", async () => {
  const a = people.An;
  await a.evaluate(() => { groundTruth[3]["B#9"][2] = groundTruth[3]["B#9"][0]; });           // a box of zero width
  await a.click("#doneBtn");
  assert.match(await status(a), /Chưa kết thúc được: frame 3 B#9: box rỗng/);
  assert.equal(server.backend.blocks.IMG_0114[0].status, "claimed");
  await a.evaluate(() => { groundTruth[3]["B#9"] = baseGT[3]["B#9"].slice(); });
});

test("finishing a block locks it for good and moves on to the next free block", async () => {
  const a = people.An;
  await a.click("#doneBtn");                                                                 // the confirm dialog is accepted by the page handler
  await a.waitForFunction(() => myBlock !== null && myBlock.block === 1);
  const b0 = server.backend.blocks.IMG_0114[0];
  assert.equal(b0.status, "done"); assert.equal(b0.done_name, "An"); assert.equal(b0.claimed_by, null);
  assert.equal(await a.evaluate(() => curFrame), 51, "jumped to the first frame of the next block");
  assert.match(await a.textContent("#topBlock"), /Khối 2 · frame 51–100/);
  await go(a, 10);
  assert.match(await a.textContent("#viewNotice"), /Khối 1 đã xong \(An\)\. Chỉ xem/);
  const e10 = await entry(a, 10); await dragSelected(a); assert.deepEqual(await entry(a, 10), e10, "a finished block cannot be edited even by its author");
  await a.waitForFunction(() => document.getElementById("progressText").textContent.startsWith("1 / 231 khối đã xong"));
  await a.screenshot({ path: path.join(OUT, "2-after-done.png") });
});

test("another person gets a different block and sees the finished one with its final labels", async () => {
  const b = await person("Binh");
  await claim(b, "Binh");
  assert.equal(await myBlock(b), 2, "block 1 is done and block 2 is An's");
  await go(b, 5);
  await b.waitForFunction(() => groundTruth[5]["A#6"][7] === true);                          // the final labels of block 1 were fetched and shown
  const shown = await entry(b, 5), saved = server.backend.blocks.IMG_0114[0].labels.frames["5"]["A#6"];
  assert.deepEqual(shown, saved);
  assert.match(await b.textContent("#viewNotice"), /Khối 1 đã xong \(An\)/);
  await go(b, 60);
  assert.match(await b.textContent("#viewNotice"), /Khối 2 đang do An làm/);
  await b.screenshot({ path: path.join(OUT, "3-second-person.png") });
});

test("a claim that lapses is lost: the next save is refused and the unsaved edits are dropped", async () => {
  const a = people.An;
  await go(a, 60); await dragSelected(a);                                                    // An edits frame 60 in block 2
  assert.equal(await a.evaluate(() => dirty), true);
  server.backend.expire("IMG_0114", 1);                                                      // 16 minutes without a save
  const c = await person("Chi");
  await claim(c, "Chi");
  assert.equal(await myBlock(c), 1, "Chi takes over the lapsed block");
  await a.keyboard.press("Control+s");
  await a.waitForFunction(() => myBlock === null);
  assert.match(await status(a), /Khối này không còn thuộc về bạn/);
  assert.deepEqual(await entry(a, 60), await a.evaluate(() => baseGT[60]["A#6"].slice()), "edits that can no longer be saved are dropped");
  assert.equal(server.backend.blocks.IMG_0114[1].claimed_by !== null, true);
  await a.screenshot({ path: path.join(OUT, "4-claim-lost.png") });
});

test("releasing a block keeps the draft for the next person", async () => {
  const b = people.Binh;
  await go(b, 101); await dragSelected(b, 25, 5);
  const edited = await entry(b, 101);
  await b.click("#releaseBtn");
  await b.waitForFunction(() => myBlock === null);
  const blk = server.backend.blocks.IMG_0114[2];
  assert.equal(blk.status, "open"); assert.deepEqual(blk.labels.frames["101"]["A#6"], edited);
  const d = await person("Dung");
  await claim(d, "Dung");
  assert.equal(await myBlock(d), 2);
  assert.deepEqual(await entry(d, 101), edited, "Dung starts from Binh's draft");
});


test("the video file chosen last time is reopened, or offered with one click when the browser wants a gesture", async () => {
  const p = await person("Em");
  // an Origin Private File System handle stands in for a picked file: same interface (getFile, queryPermission), and it can be stored in IndexedDB
  const reopened = await p.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), fh = await root.getFileHandle("IMG_0114.MP4", { create: true });
    const w = await fh.createWritable(); await w.write("not a real video"); await w.close();
    await rememberHandle("IMG_0114", fh);
    let name = null; const orig = handleVideoFile; handleVideoFile = (f) => { name = f.name; };
    await restoreVideo("IMG_0114"); handleVideoFile = orig;
    return { name, buttonHidden: document.getElementById("reopenVideoBtn").hidden };
  });
  assert.deepEqual(reopened, { name: "IMG_0114.MP4", buttonHidden: true }, "permission still granted: opened without a click");

  const offered = await p.evaluate(async () => {
    let name = null; const orig = handleVideoFile, origRecall = recallHandle; handleVideoFile = (f) => { name = f.name; };
    recallHandle = async () => ({ name: "IMG_0114.MP4", queryPermission: async () => "prompt", requestPermission: async () => "granted", getFile: async () => new File(["x"], "IMG_0114.MP4") });
    await restoreVideo("IMG_0114");
    const before = { name, shown: !document.getElementById("reopenVideoBtn").hidden, text: document.getElementById("reopenVideoBtn").textContent };
    document.getElementById("reopenVideoBtn").click(); await new Promise((r) => setTimeout(r, 100));
    handleVideoFile = orig; recallHandle = origRecall;
    return { before, after: name, hiddenAfter: document.getElementById("reopenVideoBtn").hidden };
  });
  assert.deepEqual(offered, { before: { name: null, shown: true, text: "Mở lại IMG_0114.MP4" }, after: "IMG_0114.MP4", hiddenAfter: true });
});

test("no script errors on any page", () => {
  for (const [name, p] of Object.entries(people)) assert.deepEqual(p.errors, [], `${name}: ${p.errors.join(" | ")}`);
});
