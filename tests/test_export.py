"""scripts/gt_export.py: format parity with the shipped files, merge, validation, export, and the HTTP/CLI path against a local stub server."""
import gzip, hashlib, json, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import gt_export as ex  # noqa: E402

BASE = {v: ROOT / "output_ground_truth" / f"{v}_gt_boxes.csv.gz" for v in ex.ROSTERS}
TXT = {v: ROOT / "output_ground_truth" / f"{v}.txt" for v in ex.ROSTERS}
SIZE = 50


@pytest.fixture(scope="module")
def base():
    return {v: ex.read_base(BASE[v], v) for v in ex.ROSTERS}


def make_blocks(frames, total, done=None, who="tester"):
    """Database-shaped blocks of SIZE frames; `done` = set of block numbers that are finished (default all)."""
    out = []
    for b in range((total + SIZE - 1) // SIZE):
        first, last = b * SIZE + 1, min(total, (b + 1) * SIZE)
        is_done = done is None or b in done
        out.append({"block": b, "first_frame": first, "last_frame": last, "status": "done" if is_done else "open",
                    "labels": {"frames": {str(f): frames[f] for f in range(first, last + 1)}} if is_done else None,
                    "done_name": who if is_done else None, "done_at": "2026-10-25T00:00:00+00:00" if is_done else None})
    return out


def test_js_rounding_ties_go_up_not_to_even():
    assert ex.js_round(0.5) == 1 and ex.js_round(1.5) == 2 and ex.js_round(2.5) == 3 and ex.js_round(-1.5) == -1


def test_homography_reproduces_a_shipped_row_within_rounding(base):
    e = base["IMG_0115"][1]["A#4"]
    cx, cy = ex.court_from_foot(0.5 * (e[0] + e[2]), e[3])
    assert abs(cx - e[4]) < 0.1 and abs(cy - e[5]) < 0.1


@pytest.mark.parametrize("video", sorted(ex.ROSTERS))
def test_txt_output_is_byte_identical_to_the_shipped_btc_file(base, video):
    assert ex.to_btc_txt(base[video], ex.ROSTERS[video]) == TXT[video].read_text()


@pytest.mark.parametrize("video", sorted(ex.ROSTERS))
def test_csv_roundtrips_to_the_same_frames(base, video, tmp_path):
    p = tmp_path / "x.csv.gz"
    p.write_bytes(gzip.compress(ex.to_csv(base[video], ex.ROSTERS[video]).encode()))
    assert ex.read_base(p, video) == base[video]


def test_shipped_base_validates_with_only_a_warning_about_unedited_court_values(base):
    errors, warnings = ex.validate("IMG_0114", base["IMG_0114"], 11536)
    assert errors == [] and any("unedited rows" in w for w in warnings) and any("outside the court" in w for w in warnings)


def test_merge_substitutes_only_done_blocks_and_rejects_a_done_block_with_a_missing_frame(base):
    frames = {f: {i: list(e) for i, e in d.items()} for f, d in base["IMG_0115"].items()}
    frames[60]["A#4"][0] += 5.0
    blocks = make_blocks(frames, 11823, done={1})                       # block 1 = frames 51..100 only
    merged, taken = ex.merge(base["IMG_0115"], blocks)
    assert taken == [1] and merged[60]["A#4"][0] == frames[60]["A#4"][0] and merged[10] == base["IMG_0115"][10] and merged[101] == base["IMG_0115"][101]
    del blocks[1]["labels"]["frames"]["75"]
    with pytest.raises(ValueError, match="frame 75"):
        ex.merge(base["IMG_0115"], blocks)


def test_validation_catches_each_kind_of_bad_label(base):
    def bad(mutate):
        frames = {f: {i: list(e) for i, e in d.items()} for f, d in base["IMG_0115"].items()}
        mutate(frames)
        return ex.validate("IMG_0115", frames, 11823)[0]
    assert any("roster" in e for e in bad(lambda fr: fr[3].pop("B#5")))
    assert any("inverted" in e for e in bad(lambda fr: fr[3]["B#5"].__setitem__(2, fr[3]["B#5"][0] - 1)))
    assert any("outside the court" in e for e in bad(lambda fr: fr[3]["B#5"].__setitem__(4, 5000.0)))
    assert any("malformed" in e for e in bad(lambda fr: fr[3]["B#5"].__setitem__(0, float("nan"))))
    assert any("malformed" in e for e in bad(lambda fr: fr[3]["B#5"].__setitem__(0, True)))
    assert any("1..11823" in e for e in bad(lambda fr: fr.pop(7)))

    def edited_wrong(fr):
        fr[3]["B#5"][7] = True                                             # claims to be edited but keeps the old court value after moving the box
        fr[3]["B#5"][0] += 30.0
        fr[3]["B#5"][2] += 30.0
    assert any("edited row" in e for e in bad(edited_wrong))


def test_edited_row_with_consistent_court_value_is_accepted(base):
    frames = {f: {i: list(e) for i, e in d.items()} for f, d in base["IMG_0115"].items()}
    e = frames[3]["B#5"]
    e[0] += 12.0; e[2] += 12.0
    e[4], e[5] = ex.court_from_foot(0.5 * (e[0] + e[2]), e[3]); e[7] = True
    assert ex.validate("IMG_0115", frames, 11823)[0] == []


def test_export_complete_partial_and_incomplete(base, tmp_path):
    frames = base["IMG_0115"]
    st, info = ex.export_video("IMG_0115", make_blocks(frames, 11823), BASE["IMG_0115"], tmp_path / "full")
    assert st == "exported" and info["complete"] and info["annotators_blocks"] == {"tester": 237}
    assert (tmp_path / "full" / "IMG_0115.txt").read_text() == TXT["IMG_0115"].read_text()
    m = json.loads((tmp_path / "full" / "manifest_IMG_0115.json").read_text())
    assert m["sha256"]["IMG_0115.txt"] == hashlib.sha256((tmp_path / "full" / "IMG_0115.txt").read_bytes()).hexdigest() and m["rows"] == 70938

    st, info = ex.export_video("IMG_0115", make_blocks(frames, 11823, done={0, 1}), BASE["IMG_0115"], tmp_path / "none")
    assert st == "incomplete" and not (tmp_path / "none").exists()
    st, info = ex.export_video("IMG_0115", make_blocks(frames, 11823, done={0, 1}), BASE["IMG_0115"], tmp_path / "draft", partial=True)
    assert st == "exported" and not info["complete"] and (tmp_path / "draft" / "IMG_0115_DRAFT.txt").exists() and not (tmp_path / "draft" / "IMG_0115.txt").exists()


def test_export_is_deterministic_and_rejects_a_frame_count_mismatch(base, tmp_path):
    b = make_blocks(base["IMG_0114"], 11536)
    ex.export_video("IMG_0114", b, BASE["IMG_0114"], tmp_path / "a")
    ex.export_video("IMG_0114", b, BASE["IMG_0114"], tmp_path / "b")
    for name in ("IMG_0114.txt", "IMG_0114_gt_boxes.csv.gz"):
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()
    st, info = ex.export_video("IMG_0114", b[:-1], BASE["IMG_0114"], tmp_path / "c")
    assert st == "invalid" and "11536" in info["errors"][0] and not (tmp_path / "c").exists()


class Stub(BaseHTTPRequestHandler):
    blocks = {}
    seen = []

    def do_GET(self):
        Stub.seen.append((self.path, self.headers.get("apikey"), self.headers.get("Authorization")))
        video = self.path.split("video=eq.")[1].split("&")[0]
        body = json.dumps(Stub.blocks[video]).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture()
def server():
    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    Stub.seen = []
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_cli_exit_codes_and_request_shape(base, server, tmp_path):
    Stub.blocks = {"IMG_0114": make_blocks(base["IMG_0114"], 11536), "IMG_0115": make_blocks(base["IMG_0115"], 11823, done={0})}
    args = ["--supabase-url", server, "--anon-key", "KEY", "--base-dir", str(ROOT / "output_ground_truth"), "--out", str(tmp_path)]
    assert ex.main(args + ["--video", "IMG_0114"]) == 0 and (tmp_path / "IMG_0114.txt").exists()
    assert ex.main(args + ["--video", "IMG_0115"]) == 2 and not (tmp_path / "IMG_0115.txt").exists()
    assert ex.main(args) == 2                                                   # both videos: one exported, one incomplete -> overall 2
    path, apikey, auth = Stub.seen[0]
    assert path.startswith("/rest/v1/gt_blocks?") and "video=eq.IMG_0114" in path and "order=block.asc" in path and apikey == "KEY" and auth == "Bearer KEY"
    Stub.blocks["IMG_0114"][0]["labels"]["frames"]["3"]["A#6"][2] = Stub.blocks["IMG_0114"][0]["labels"]["frames"]["3"]["A#6"][0]       # inverted box
    assert ex.main(args + ["--video", "IMG_0114"]) == 1


def test_config_values_are_read_from_config_js_and_missing_ones_mean_not_configured(tmp_path, capsys):
    cfg = tmp_path / "config.js"
    cfg.write_text('window.GT_CONFIG = {\n  supabaseUrl: "https://abc.supabase.co",   // comment\n  supabaseAnonKey: "KEY123",\n  driveVideos: {}\n};')
    assert ex.read_config(cfg) == ("https://abc.supabase.co", "KEY123")
    assert ex.read_config(tmp_path / "missing.js") == ("", "")
    cfg.write_text('window.GT_CONFIG = { supabaseUrl: "", supabaseAnonKey: "" };')
    assert ex.main(["--config", str(cfg), "--out", str(tmp_path / "o")]) == 3 and "not configured" in capsys.readouterr().err
