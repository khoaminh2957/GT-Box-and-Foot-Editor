"""Merge the finished ground-truth blocks held in Supabase into the BTC output files.

For each video: the blocks marked `done` replace the same frames of the shipped base labels (output_ground_truth/<video>_gt_boxes.csv.gz);
the result is validated, then written as
    <out>/<video>.txt                 BTC 5 columns   frame,court_x,court_y,team,jersey
    <out>/<video>_gt_boxes.csv.gz     box state       frame,team,jersey,x1,y1,x2,y2,court_x,court_y,observed,edited
    <out>/manifest_<video>.json       who labelled what, counts, sha256 of both files
Only when EVERY block of a video is done is the video exported under its final name; with --partial the not-yet-done blocks keep the base labels
and the files get a _DRAFT suffix and `complete: false` in the manifest.

Entry format (same as app.js): [x1, y1, x2, y2, court_x, court_y, observed, edited]; court_x/court_y are stored, not recomputed, because the shipped base
court values are not always the homography of the stored box foot (IMG_0114 differs by up to 9.55 cm).  Rows with edited == true must satisfy court = homography(foot).

usage: gt_export.py [--supabase-url URL --anon-key KEY | --config config.js] [--video IMG_0114] [--out export] [--partial]
       (without --supabase-url/--anon-key the values are read from config.js, the same file the web app uses; the anon key is a public key)
exit status: 0 exported, 2 a video is incomplete (nothing written for it), 1 validation or connection error, 3 Supabase is not configured."""
import argparse, csv, datetime, gzip, hashlib, io, json, math, re, sys, urllib.parse, urllib.request
from pathlib import Path

# Official BTC 4-point homography (720p image -> court 1505 x 1105 cm); identical to H_IMG2COURT in app.js.
H = [[3.86833481736599, 4.0210322443672855, -5829.427872343548],
     [2.9798861427158427, -24.201507726651634, 5855.758151558235],
     [0.00030566688359773373, -0.009504842405414103, 1.0]]
ROSTERS = {"IMG_0114": ["A#6", "A#9", "A#10", "B#6", "B#9", "B#11"], "IMG_0115": ["A#4", "A#10", "A#12", "B#1", "B#3", "B#5"]}
COURT_W, COURT_H = 1505.0, 1105.0
MARGIN = 100.0        # beyond this a position is reported as a warning: the shipped base labels already have 363 + 204 rows 100-294 cm outside the court (none beyond 300 cm)
HARD_MARGIN = 500.0   # beyond this it is an error (a typo or a tampered value, not a player)
EDITED_TOL = 0.1   # cm.  The editor rounds stored box corners to 0.01 px but derives court_x/court_y from the unrounded corners; at the foot points of the shipped
                  # labels that costs at most 0.084 cm (derivative of the homography x 0.005 px, over all 140,154 rows; the shipped edited rows differ by at most 0.06 cm)
                  # plus 0.005 cm output rounding.  Anything beyond 0.1 cm is not rounding.


def js_round(x):
    return math.floor(x + 0.5)                              # Math.round: ties go up (Python's round() ties go to even)


def court_from_foot(u, v):
    w = H[2][0] * u + H[2][1] * v + H[2][2]
    return (js_round((H[0][0] * u + H[0][1] * v + H[0][2]) / w * 100) / 100, js_round((H[1][0] * u + H[1][1] * v + H[1][2]) / w * 100) / 100)


def read_base(path, video):
    """Shipped base labels -> {frame: {ident: [x1, y1, x2, y2, cx, cy, observed, edited]}}."""
    frames = {}
    with gzip.open(path, "rt", newline="") as fh:
        for r in csv.DictReader(fh):
            ident = f"{r['team']}#{r['jersey']}"
            frames.setdefault(int(r["frame"]), {})[ident] = [float(r["x1"]), float(r["y1"]), float(r["x2"]), float(r["y2"]), float(r["court_x"]), float(r["court_y"]), r["observed"] == "True", r["edited"] == "True"]
    return frames


def merge(base, blocks):
    """Base labels with every `done` block's frames substituted -> (frames, list of block numbers taken from the blocks)."""
    frames = {f: {i: list(e) for i, e in d.items()} for f, d in base.items()}
    taken = []
    for b in blocks:
        if b["status"] != "done":
            continue
        payload = b.get("labels") or {}
        got = {int(k): v for k, v in (payload.get("frames") or {}).items()}
        for f in range(b["first_frame"], b["last_frame"] + 1):
            if f not in got:
                raise ValueError(f"block {b['block']} is done but has no labels for frame {f}")
            frames[f] = {i: list(e) for i, e in got[f].items()}
        taken.append(b["block"])
    return frames, taken


def validate(video, frames, n_frames, blocks=None):
    """-> (errors, warnings).  Structure and value checks on the merged labels; nothing here needs ground truth."""
    roster, errors, warnings = ROSTERS[video], [], []
    if sorted(frames) != list(range(1, n_frames + 1)):
        errors.append(f"frames are not exactly 1..{n_frames}")
    n_unedited_mismatch = n_outside = 0
    for f in sorted(frames):
        d = frames[f]
        if set(d) != set(roster):
            errors.append(f"frame {f}: players {sorted(d)} != roster {roster}")
            continue
        for ident, e in d.items():
            if len(e) != 8 or not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in e[:6]):
                errors.append(f"frame {f} {ident}: malformed entry {e}")
                continue
            x1, y1, x2, y2, cx, cy, _, edited = e
            if not (x2 > x1 and y2 > y1):
                errors.append(f"frame {f} {ident}: empty or inverted box")
            if not (-HARD_MARGIN <= cx <= COURT_W + HARD_MARGIN and -HARD_MARGIN <= cy <= COURT_H + HARD_MARGIN):
                errors.append(f"frame {f} {ident}: court position ({cx}, {cy}) more than {HARD_MARGIN:.0f} cm outside the court")
            elif not (-MARGIN <= cx <= COURT_W + MARGIN and -MARGIN <= cy <= COURT_H + MARGIN):
                n_outside += 1
            if edited is True:
                ex, ey = court_from_foot(0.5 * (x1 + x2), y2)
                if abs(ex - cx) > EDITED_TOL or abs(ey - cy) > EDITED_TOL:
                    errors.append(f"frame {f} {ident}: edited row but court ({cx}, {cy}) != homography of the foot ({ex}, {ey})")
            else:
                ex, ey = court_from_foot(0.5 * (x1 + x2), y2)
                n_unedited_mismatch += abs(ex - cx) > 0.5 or abs(ey - cy) > 0.5
    if n_outside:
        warnings.append(f"{n_outside} rows are more than {MARGIN:.0f} cm outside the court (up to {HARD_MARGIN:.0f} cm is accepted)")
    if n_unedited_mismatch:
        warnings.append(f"{n_unedited_mismatch} unedited rows have a stored court position more than 0.5 cm from the homography of their box foot (shipped base data; not an error)")
    return errors[:50], warnings


def to_btc_txt(frames, roster):
    out = []
    for f in sorted(frames):
        for ident in roster:
            team, jersey = ident.split("#")
            e = frames[f][ident]
            out.append(f"{f},{e[4]:.2f},{e[5]:.2f},{team},{jersey}")
    return "\n".join(out) + "\n"


def to_csv(frames, roster):
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["frame", "team", "jersey", "x1", "y1", "x2", "y2", "court_x", "court_y", "observed", "edited"])
    for f in sorted(frames):
        for ident in roster:
            team, jersey = ident.split("#")
            e = frames[f][ident]
            w.writerow([f, team, jersey, e[0], e[1], e[2], e[3], e[4], e[5], "True" if e[6] else "False", "True" if e[7] else "False"])
    return buf.getvalue()


def read_config(path):
    """-> (supabaseUrl, supabaseAnonKey) from config.js; empty strings when the file or the values are missing."""
    try:
        text = Path(path).read_text()
    except OSError:
        return "", ""
    grab = lambda k: (re.search(rf'{k}\s*:\s*"([^"]*)"', text) or [None, ""])[1]
    return grab("supabaseUrl"), grab("supabaseAnonKey")


def fetch_blocks(url, key, video):
    q = urllib.parse.urlencode({"video": f"eq.{video}", "select": "block,first_frame,last_frame,status,labels,done_name,done_at", "order": "block.asc"})
    req = urllib.request.Request(f"{url.rstrip('/')}/rest/v1/gt_blocks?{q}", headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def export_video(video, blocks, base_path, out_dir, partial=False, now=None):
    """-> (status, details).  status in {'exported', 'incomplete', 'invalid'}."""
    if not blocks:
        return "invalid", {"errors": [f"no blocks found for {video}"]}
    n_frames = max(b["last_frame"] for b in blocks)
    done = [b for b in blocks if b["status"] == "done"]
    complete = len(done) == len(blocks)
    details = {"video": video, "blocks_done": len(done), "blocks_total": len(blocks), "complete": complete}
    if not complete and not partial:
        return "incomplete", details
    base = read_base(base_path, video)
    if max(base) != n_frames:
        return "invalid", {**details, "errors": [f"base labels have {max(base)} frames but the database blocks cover {n_frames}"]}
    frames, taken = merge(base, blocks)
    errors, warnings = validate(video, frames, n_frames)
    details.update(warnings=warnings)
    if errors:
        return "invalid", {**details, "errors": errors}
    roster = ROSTERS[video]
    suffix = "" if complete else "_DRAFT"
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    txt = to_btc_txt(frames, roster).encode()
    csv_gz = gzip.compress(to_csv(frames, roster).encode(), mtime=0)           # mtime=0: identical content -> identical bytes
    (out_dir / f"{video}{suffix}.txt").write_bytes(txt)
    (out_dir / f"{video}{suffix}_gt_boxes.csv.gz").write_bytes(csv_gz)
    who = {}
    for b in done:
        who[b.get("done_name") or "?"] = who.get(b.get("done_name") or "?", 0) + 1
    manifest = {**details, "frames": n_frames, "rows": n_frames * len(roster), "blocks_taken_from_database": taken, "annotators_blocks": who,
                "sha256": {f"{video}{suffix}.txt": hashlib.sha256(txt).hexdigest(), f"{video}{suffix}_gt_boxes.csv.gz": hashlib.sha256(csv_gz).hexdigest()},
                "generated_at": (now or datetime.datetime.now(datetime.timezone.utc)).isoformat(timespec="seconds")}
    (out_dir / f"manifest_{video}{suffix}.json").write_text(json.dumps(manifest, indent=1))
    return "exported", manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--supabase-url")
    ap.add_argument("--anon-key")
    ap.add_argument("--config", default="config.js")
    ap.add_argument("--video", action="append", choices=sorted(ROSTERS), help="default: both videos")
    ap.add_argument("--out", default="export")
    ap.add_argument("--base-dir", default="output_ground_truth")
    ap.add_argument("--partial", action="store_true", help="also write a _DRAFT export when blocks are still open")
    a = ap.parse_args(argv)
    cfg_url, cfg_key = read_config(a.config)
    a.supabase_url, a.anon_key = a.supabase_url or cfg_url, a.anon_key or cfg_key
    if not (a.supabase_url and a.anon_key):
        print("gt_export: Supabase is not configured (no --supabase-url/--anon-key and none in config.js); nothing exported", file=sys.stderr)
        return 3
    status = 0
    for video in a.video or sorted(ROSTERS):
        try:
            blocks = fetch_blocks(a.supabase_url, a.anon_key, video)
            result, info = export_video(video, blocks, Path(a.base_dir) / f"{video}_gt_boxes.csv.gz", a.out, a.partial)
        except Exception as exc:                                                    # connection, JSON, missing frame in a done block
            print(f"{video}: ERROR {exc}", file=sys.stderr)
            status = 1
            continue
        print(f"{video}: {result} ({info.get('blocks_done')}/{info.get('blocks_total')} blocks done)")
        for w in info.get("warnings", []):
            print(f"  warning: {w}")
        for e in info.get("errors", []):
            print(f"  error: {e}", file=sys.stderr)
        code = {"exported": 0, "incomplete": 2, "invalid": 1}[result]
        status = 1 if 1 in (code, status) else max(status, code)
    return status


if __name__ == "__main__":
    sys.exit(main())
