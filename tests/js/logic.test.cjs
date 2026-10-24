// logic.js: block arithmetic, edit permission, payload building and validation, homography parity with scripts/gt_export.py.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../logic.js");

const ROSTER = ["A#6", "A#9", "A#10", "B#6", "B#9", "B#11"];
const gtFor = (first, last) => Object.fromEntries(Array.from({ length: last - first + 1 }, (_, i) => [first + i,
  Object.fromEntries(ROSTER.map((id, k) => [id, [100 + k, 200, 130 + k, 290, ...L.imgToCourt(0.5 * (230 + 2 * k), 290), true, false]]))]));

test("blocks: frame <-> block arithmetic matches the database layout", () => {
  assert.equal(L.blockOfFrame(1), 0); assert.equal(L.blockOfFrame(50), 0); assert.equal(L.blockOfFrame(51), 1); assert.equal(L.blockOfFrame(11536), 230);
  assert.deepEqual(L.blockRange(0, 11536), { first: 1, last: 50 });
  assert.deepEqual(L.blockRange(230, 11536), { first: 11501, last: 11536 });   // the last block is short
  assert.deepEqual(L.blockRange(236, 11823), { first: 11801, last: 11823 });
  for (const f of [1, 49, 50, 51, 100, 101, 11536]) { const b = L.blockOfFrame(f), r = L.blockRange(b, 11536); assert.ok(f >= r.first && f <= r.last, `frame ${f}`); }
});

test("editing is free in local mode; with the cloud only the claimed block is editable", () => {
  const mine = { first_frame: 101, last_frame: 150 };
  assert.equal(L.canEditFrame(false, null, 7), true);
  assert.equal(L.canEditFrame(true, null, 7), false, "no claim -> read only");
  assert.equal(L.canEditFrame(true, mine, 100), false); assert.equal(L.canEditFrame(true, mine, 101), true);
  assert.equal(L.canEditFrame(true, mine, 150), true); assert.equal(L.canEditFrame(true, mine, 151), false);
  assert.equal(L.rangeInsideBlock(true, mine, 110, 120), true); assert.equal(L.rangeInsideBlock(true, mine, 120, 110), true);
  assert.equal(L.rangeInsideBlock(true, mine, 90, 120), false); assert.equal(L.rangeInsideBlock(true, mine, 140, 151), false); assert.equal(L.rangeInsideBlock(true, null, 1, 2), false);
  assert.equal(L.rangeInsideBlock(false, null, 1, 99999), true);
});

test("payload holds exactly the frames of the block with all players, as copies", () => {
  const gt = gtFor(1, 200);
  const p = L.buildBlockPayload(gt, ROSTER, 51, 100);
  assert.equal(Object.keys(p.frames).length, 50); assert.ok(p.frames["51"] && p.frames["100"] && !p.frames["50"] && !p.frames["101"]);
  assert.deepEqual(Object.keys(p.frames["60"]), ROSTER); assert.equal(p.frames["60"]["A#6"].length, 8);
  p.frames["60"]["A#6"][0] = -1; assert.notEqual(gt[60]["A#6"][0], -1, "copy, not a reference");
  delete gt[70]["B#9"]; assert.throws(() => L.buildBlockPayload(gt, ROSTER, 51, 100), /frame 70: B#9/);
  delete gt[80]; assert.throws(() => L.buildBlockPayload(gt, ROSTER, 51, 100), /frame 70|frame 80/);
});

test("validation accepts good labels and reports each kind of problem", () => {
  const gt = gtFor(1, 60);
  assert.deepEqual(L.validateBlockFrames(gt, ROSTER, 1, 50), []);
  gt[3]["A#6"][2] = gt[3]["A#6"][0];                                     assert.match(L.validateBlockFrames(gt, ROSTER, 1, 50)[0], /frame 3 A#6: box rỗng/);
  gt[3]["A#6"][2] = gt[3]["A#6"][0] + 30;
  gt[4]["B#6"][4] = NaN;                                                 assert.match(L.validateBlockFrames(gt, ROSTER, 1, 50).join("\n"), /frame 4 B#6: giá trị không hợp lệ/);
  gt[4]["B#6"][4] = 500;
  delete gt[5]["A#9"];                                                   assert.match(L.validateBlockFrames(gt, ROSTER, 1, 50).join("\n"), /frame 5: thiếu A#9/);
  gt[5]["A#9"] = [100, 200, 130, 290, 1, 1, true, true];               assert.match(L.validateBlockFrames(gt, ROSTER, 1, 50).join("\n"), /frame 5 A#9: tọa độ sân không khớp/);
  const many = gtFor(1, 50); for (let f = 1; f <= 50; f++) delete many[f]["A#6"]; assert.ok(L.validateBlockFrames(many, ROSTER, 1, 50).length <= 20, "the list is capped");
});

test("a frame edited through updateBox rounding stays within the validation tolerance", () => {
  // app.js rounds corners to 0.01 px and derives the court value from the rounded corners
  const x1 = 441.0949, x2 = 474.0447, y2 = 349.7312, rx1 = Math.round(x1 * 100) / 100, rx2 = Math.round(x2 * 100) / 100, ry2 = Math.round(y2 * 100) / 100;
  const [cx, cy] = L.imgToCourt(0.5 * (rx1 + rx2), ry2);
  const gt = { 1: Object.fromEntries(ROSTER.map((id) => [id, [rx1, 264.99, rx2, ry2, cx, cy, true, true]])) };
  assert.deepEqual(L.validateBlockFrames(gt, ROSTER, 1, 1), []);
});

test("overlay replaces whole frames and copies the entries", () => {
  const gt = gtFor(1, 10), payload = { frames: { "3": { "A#6": [1, 2, 3, 4, 5, 6, true, true] } } };
  L.overlayFrames(gt, payload);
  assert.deepEqual(Object.keys(gt[3]), ["A#6"]); assert.equal(gt[4]["A#6"][0], 100); payload.frames["3"]["A#6"][0] = 99; assert.equal(gt[3]["A#6"][0], 1);
  L.overlayFrames(gt, null); L.overlayFrames(gt, {});
});

test("homography: identical to the Python exporter to 0.01 cm (golden values printed by scripts/gt_export.court_from_foot)", () => {
  const golden = [[457.565, 349.73, 1214.66, 569.87], [100, 500, 922.14, 1597.86], [640, 360, 856.25, 426.6], [1000.125, 420.4, 100.43, 497.48], [300.005, 250.5, 2840.11, -533.07]];
  for (const [u, v, gx, gy] of golden) assert.deepEqual(L.imgToCourt(u, v), [gx, gy], `(${u}, ${v})`);
});

test("status counts", () => {
  assert.deepEqual(L.countStatuses([{ status: "done" }, { status: "open" }, { status: "done" }, { status: "claimed" }]), { open: 1, claimed: 1, done: 2 });
});
