// Block queue (supabase/migrations/20261025000000_gt_blocks.sql) on a REAL Postgres.
// PG_URL = admin connection, e.g. postgres://postgres:pw@localhost:55432/postgres  (CI uses a postgres:16 service container).
// A throw-away database is created per run; Supabase's roles and auth.uid() are emulated by the bootstrap below.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

const ADMIN_URL = process.env.PG_URL;
if (!ADMIN_URL) {
  test("block queue SQL tests", { skip: "PG_URL is not set" }, () => {});
} else {
  const dbName = `gt_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const dbUrl = new URL(ADMIN_URL); dbUrl.pathname = `/${dbName}`;
  const MIGRATION = readFileSync(process.env.GT_MIGRATION ?? new URL("../../supabase/migrations/20261025000000_gt_blocks.sql", import.meta.url), "utf8");   // GT_MIGRATION: mutation checks
  const BOOTSTRAP = `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;`;   // Supabase's default: the migration must take write access away again
  let admin; const open = [];

  // One connection = one browser: role `authenticated` (anonymous sign-ins use it) with its own auth.uid().
  async function user(id = randomUUID(), role = "authenticated") {
    const c = new pg.Client({ connectionString: dbUrl.toString() });
    await c.connect(); open.push(c);
    await c.query(`set role ${role}`);
    if (id) await c.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    c.uid = id; return c;
  }
  const claim = async (c, video = "IMG_0114", prefer = 0, name = "Tester") => (await c.query("select * from public.gt_claim_block($1, $2, $3)", [video, prefer, name])).rows[0];
  const labels = (first, last, players = 6) => ({ frames: Object.fromEntries(Array.from({ length: last - first + 1 }, (_, i) => [String(first + i),
    Object.fromEntries(Array.from({ length: players }, (_, p) => [`P#${p}`, [10, 10, 40, 90, 500, 500, true, false]]))])) });
  const code = (c) => (e) => { assert.equal(e.code, c, `expected ${c}, got ${e.code}: ${e.message}`); return true; };
  const asAdmin = (sql, params) => admin.query(sql, params);

  before(async () => {
    const boot = new pg.Client({ connectionString: ADMIN_URL }); await boot.connect(); await boot.query(`create database ${dbName}`); await boot.end();
    admin = new pg.Client({ connectionString: dbUrl.toString() }); await admin.connect();
    await admin.query(BOOTSTRAP); await admin.query(MIGRATION);
  });
  after(async () => {
    for (const c of open) await c.end().catch(() => {});
    await admin.end();
    const boot = new pg.Client({ connectionString: ADMIN_URL }); await boot.connect(); await boot.query(`drop database ${dbName} with (force)`); await boot.end();
  });

  test("the migration can be applied twice (idempotent) and seeds 231 + 237 blocks with the right frame ranges", async () => {
    await asAdmin(MIGRATION);
    const { rows } = await asAdmin("select video, count(*)::int n, min(first_frame) lo, max(last_frame) hi from gt_blocks group by video order by video");
    assert.deepEqual(rows, [{ video: "IMG_0114", n: 231, lo: 1, hi: 11536 }, { video: "IMG_0115", n: 237, lo: 1, hi: 11823 }]);
    const last = (await asAdmin("select first_frame, last_frame from gt_blocks where video = 'IMG_0114' and block = 230")).rows[0];
    assert.deepEqual(last, { first_frame: 11501, last_frame: 11536 });
    const gaps = (await asAdmin(`select count(*)::int n from gt_blocks a join gt_blocks b on a.video = b.video and b.block = a.block + 1 where b.first_frame <> a.last_frame + 1`)).rows[0].n;
    assert.equal(gaps, 0);
  });

  test("clients can read but never write the tables directly; signed-out callers cannot use the functions", async () => {
    const u = await user(), anon = await user(null, "anon");
    assert.equal((await u.query("select count(*)::int n from gt_blocks")).rows[0].n, 468);
    assert.equal((await anon.query("select count(*)::int n from gt_block_status")).rows[0].n, 468);
    await assert.rejects(u.query("update gt_blocks set status = 'done' where block = 0"), code("42501"));
    await assert.rejects(u.query("delete from gt_blocks"), code("42501"));
    await assert.rejects(u.query("insert into gt_blocks (video, block, first_frame, last_frame) values ('IMG_0114', 9999, 1, 2)"), code("42501"));
    await assert.rejects(anon.query("select * from public.gt_claim_block('IMG_0114', 0, 'x')"), code("42501"));
    const nobody = await user(null);                                                     // authenticated role but no uid
    await assert.rejects(nobody.query("select * from public.gt_claim_block('IMG_0114', 0, 'x')"), code("GT000"));
  });

  test("claim: first free block, then the next one for the next person; the same person gets the same block back", async () => {
    const a = await user(), b = await user();
    const ra = await claim(a, "IMG_0115", 0, "An"), rb = await claim(b, "IMG_0115", 0, "Binh");
    assert.deepEqual([ra.block, rb.block], [0, 1]);
    assert.equal(ra.status, "claimed"); assert.equal(ra.claimed_by, a.uid); assert.equal(rb.claimed_name, "Binh");
    assert.equal((await claim(a, "IMG_0115", 100, "An")).block, 0, "claiming again resumes the own block");
  });

  test("claim honours the preferred position and wraps around", async () => {
    const c = await user(); const r = await claim(c, "IMG_0114", 100, "Chi");
    assert.equal(r.block, 100);
    const d = await user(); assert.equal((await claim(d, "IMG_0114", 230, "Dung")).block, 230);
    const e = await user(); assert.equal((await claim(e, "IMG_0114", 230, "Em")).block, 0, "past the last free block it wraps to the first free one");
  });

  test("claim validates its arguments", async () => {
    const c = await user();
    await assert.rejects(claim(c, "IMG_0114", 0, "   "), code("GT002"));
    await assert.rejects(claim(c, "IMG_0114", 0, "x".repeat(41)), code("GT002"));
    await assert.rejects(claim(c, "IMG_9999", 0, "ok"), code("GT002"));
  });

  test("draft saves: only the claimant, only while the claim is held; release keeps the draft and frees the block", async () => {
    const a = await user(), b = await user();
    const r = await claim(a, "IMG_0114", 150, "An"); assert.equal(r.block, 150);
    await a.query("select public.gt_save_draft('IMG_0114', 150, $1)", [labels(7501, 7550)]);
    await assert.rejects(b.query("select public.gt_save_draft('IMG_0114', 150, $1)", [labels(7501, 7550)]), code("GT001"));
    await assert.rejects(a.query("select public.gt_save_draft('IMG_0114', 150, $1)", [{ nope: 1 }]), code("GT003"));
    await assert.rejects(a.query("select public.gt_release_block('IMG_0114', 151)"), code("GT001"));
    await a.query("select public.gt_release_block('IMG_0114', 150)");
    await assert.rejects(a.query("select public.gt_save_draft('IMG_0114', 150, $1)", [labels(7501, 7550)]), code("GT001"));
    const row = (await asAdmin("select status, claimed_by, labels is not null as has_draft from gt_blocks where video = 'IMG_0114' and block = 150")).rows[0];
    assert.deepEqual(row, { status: "open", claimed_by: null, has_draft: true });
    assert.equal((await claim(b, "IMG_0114", 150, "Binh")).block, 150, "the released block can be taken by someone else");
  });

  test("complete locks the block for good: no second completion, no draft, no release, never handed out again", async () => {
    const a = await user(), b = await user();
    const r = await claim(a, "IMG_0115", 200, "An"); assert.equal(r.block, 200);
    const { first_frame: f, last_frame: l } = r;
    await assert.rejects(a.query("select * from public.gt_complete_block('IMG_0115', 200, $1)", [labels(f + 1, l)]), code("GT003"));      // a frame missing
    await assert.rejects(a.query("select * from public.gt_complete_block('IMG_0115', 200, $1)", [labels(f, l, 5)]), code("GT003"));       // five players instead of six
    await assert.rejects(a.query("select * from public.gt_complete_block('IMG_0115', 200, $1)", [labels(f, l + 1)]), code("GT003"));     // a frame too many
    await assert.rejects(b.query("select * from public.gt_complete_block('IMG_0115', 200, $1)", [labels(f, l)]), code("GT001"));         // not his block
    const done = (await a.query("select * from public.gt_complete_block('IMG_0115', 200, $1)", [labels(f, l)])).rows[0];
    assert.equal(done.status, "done"); assert.equal(done.done_name, "An"); assert.equal(done.claimed_by, null);
    for (const sql of ["select * from public.gt_complete_block('IMG_0115', 200, $1)", "select public.gt_save_draft('IMG_0115', 200, $1)"])
      await assert.rejects(a.query(sql, [labels(f, l)]), code("GT001"));
    await assert.rejects(a.query("select public.gt_release_block('IMG_0115', 200)"), code("GT001"));
    const c = await user(); assert.notEqual((await claim(c, "IMG_0115", 200, "Chi")).block, 200);
  });

  test("a claim that has not been renewed for 15 minutes is taken over; the old claimant loses the right to save", async () => {
    const a = await user(), b = await user();
    const r = await claim(a, "IMG_0114", 60, "An"); assert.equal(r.block, 60);
    await asAdmin("update gt_blocks set claimed_at = now() - interval '16 minutes' where video = 'IMG_0114' and block = 60");
    assert.equal((await asAdmin("select status from gt_block_status where video = 'IMG_0114' and block = 60")).rows[0].status, "open", "the view already reports it as open");
    const rb = await claim(b, "IMG_0114", 60, "Binh"); assert.equal(rb.block, 60); assert.equal(rb.claimed_by, b.uid);
    await assert.rejects(a.query("select public.gt_save_draft('IMG_0114', 60, $1)", [labels(2951, 3000)]), code("GT001"));
    await assert.rejects(a.query("select * from public.gt_complete_block('IMG_0114', 60, $1)", [labels(2951, 3000)]), code("GT001"));
    // a fresh claim (14 minutes) is NOT taken over
    await asAdmin("update gt_blocks set claimed_at = now() - interval '14 minutes' where video = 'IMG_0114' and block = 60");
    const c = await user(); assert.notEqual((await claim(c, "IMG_0114", 60, "Chi")).block, 60);
  });

  test("40 people claiming at the same instant get 40 different blocks (no block is ever handed out twice)", async () => {
    const people = await Promise.all(Array.from({ length: 40 }, () => user()));
    const got = await Promise.all(people.map((p, i) => claim(p, "IMG_0115", 30, `P${i}`)));
    const blocks = got.map((r) => r.block);
    assert.equal(new Set(blocks).size, 40, `duplicates in ${blocks}`);
    const owners = (await asAdmin("select claimed_by, count(*)::int n from gt_blocks where video = 'IMG_0115' and claimed_by = any($1) group by claimed_by", [people.map((p) => p.uid)])).rows;
    assert.equal(owners.length, 40); assert.ok(owners.every((o) => o.n === 1));
  });

  test("when every block is taken, claim returns nothing", async () => {
    await asAdmin("update gt_blocks set status = 'done', done_by = gen_random_uuid(), done_at = now(), labels = '{\"frames\":{}}' where video = 'IMG_0114' and status <> 'done'");
    // the 'done' rows above bypass the functions on purpose (admin) just to exhaust the queue
    const c = await user(); assert.equal((await claim(c, "IMG_0114", 0, "Cuoi")).block, null);
  });
}
