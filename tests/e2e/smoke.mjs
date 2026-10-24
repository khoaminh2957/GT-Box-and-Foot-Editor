// Smoke test of a deployed site: every file is served and the page loads the base labels without script errors.
// usage: node smoke.mjs https://site.example   (uses the Chrome installed on the machine)
import { chromium } from "playwright-core";

const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base) { console.error("usage: node smoke.mjs <site url>"); process.exit(2); }
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };

for (const f of ["", "app.js", "logic.js", "cloud.js", "config.js", "style.css", "output_ground_truth/IMG_0114_gt_boxes.csv.gz", "output_ground_truth/IMG_0115_gt_boxes.csv.gz"]) {
  const r = await fetch(`${base}/${f}`);
  check(r.status === 200, `${r.status} /${f}`);
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(base + "/");
try {
  await page.waitForFunction(() => /Đã tải IMG_0114/.test(document.getElementById("saveStatus").textContent), null, { timeout: 30000 });
  check(true, "page loaded the base labels of IMG_0114");
} catch { check(false, `page did not finish loading (status: ${await page.textContent("#saveStatus")})`); }
check((await page.title()).includes("GT Editor"), `title: ${await page.title()}`);
check(errors.length === 0, `no script errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
