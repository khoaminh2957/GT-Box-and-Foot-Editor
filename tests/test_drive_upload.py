"""scripts/drive_upload.py against a stub of the Google token and Drive endpoints (the real Drive is NOT contacted by any test)."""
import hashlib, json, re, sys, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import drive_upload as du  # noqa: E402


class Drive(BaseHTTPRequestHandler):
    files = {}            # id -> {"name", "parents", "mime", "content"}
    counter = [0]
    corrupt_md5 = [False]
    log = []

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def _auth_ok(self):
        return self.headers.get("Authorization") == "Bearer ACCESS"

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        Drive.log.append(("POST", u.path))
        if u.path == "/token":
            form = urllib.parse.parse_qs(self._body().decode())
            ok = form.get("refresh_token") == ["REFRESH"] and form.get("grant_type") == ["refresh_token"] and form.get("client_id") == ["CID"] and form.get("client_secret") == ["SECRET"]
            return self._json({"access_token": "ACCESS"}) if ok else self._json({"error": "invalid_grant"}, 400)
        if not self._auth_ok():
            return self._json({"error": "unauth"}, 401)
        if u.path == "/drive/v3/files":
            meta = json.loads(self._body())
            fid = self._new(meta["name"], meta.get("parents", []), meta["mimeType"], b"")
            return self._json({"id": fid})
        if u.path == "/upload/drive/v3/files":
            meta, content = self._multipart()
            fid = self._new(meta["name"], meta["parents"], "x", content)
            return self._json({"id": fid, "md5Checksum": self._md5(fid)})
        self._json({}, 404)

    def do_PATCH(self):
        u = urllib.parse.urlparse(self.path)
        Drive.log.append(("PATCH", u.path))
        fid = u.path.rsplit("/", 1)[1]
        if not self._auth_ok() or fid not in Drive.files:
            return self._json({"error": "nope"}, 404)
        _, content = self._multipart()
        Drive.files[fid]["content"] = content
        self._json({"id": fid, "md5Checksum": self._md5(fid)})

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        Drive.log.append(("GET", u.path))
        if not self._auth_ok():
            return self._json({"error": "unauth"}, 401)
        q = urllib.parse.parse_qs(u.query)["q"][0]
        name = re.search(r"name = '((?:[^'\\]|\\.)*)'", q).group(1).replace("\\'", "'").replace("\\\\", "\\")
        parent = re.search(r"'([^']+)' in parents", q)
        want_folder = "mimeType = 'application/vnd.google-apps.folder'" in q
        hits = [{"id": i, "name": f["name"], "md5Checksum": self._md5(i)} for i, f in Drive.files.items()
                if f["name"] == name and (f["mime"] == du.FOLDER_MIME) == want_folder and (not parent or parent.group(1) in f["parents"])]
        self._json({"files": hits})

    def _new(self, name, parents, mime, content):
        Drive.counter[0] += 1
        fid = f"id{Drive.counter[0]}"
        Drive.files[fid] = {"name": name, "parents": parents, "mime": mime, "content": content}
        return fid

    def _md5(self, fid):
        return "0" * 32 if Drive.corrupt_md5[0] else hashlib.md5(Drive.files[fid]["content"]).hexdigest()

    def _multipart(self):
        boundary = re.search(r"boundary=(\w+)", self.headers["Content-Type"]).group(1).encode()
        parts = self._body().split(b"--" + boundary)
        meta_part, media_part = parts[1], parts[2]
        meta = json.loads(meta_part.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0])
        content = media_part.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0]
        return meta, content

    def log_message(self, *a):
        pass


@pytest.fixture()
def drive(monkeypatch):
    srv = HTTPServer(("127.0.0.1", 0), Drive)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    Drive.files, Drive.counter[0], Drive.corrupt_md5[0], Drive.log = {}, 0, False, []
    for k, v in {"GOOGLE_TOKEN_URL": f"{base}/token", "GOOGLE_API_BASE": f"{base}/drive/v3", "GOOGLE_UPLOAD_BASE": f"{base}/upload/drive/v3",
                 "GOOGLE_CLIENT_ID": "CID", "GOOGLE_CLIENT_SECRET": "SECRET", "GOOGLE_REFRESH_TOKEN": "REFRESH"}.items():
        monkeypatch.setenv(k, v)
    yield
    srv.shutdown()


def test_first_upload_creates_the_folder_and_the_files_second_upload_updates_in_place(drive, tmp_path, capsys):
    a = tmp_path / "IMG_0114.txt"; a.write_bytes(b"1,2.00,3.00,A,6\n")
    b = tmp_path / "IMG_0114_gt_boxes.csv.gz"; b.write_bytes(b"\x1f\x8b binary \x00 bytes")
    assert du.main([str(a), str(b)]) == 0
    out = [json.loads(l) for l in capsys.readouterr().out.splitlines()]
    assert [o["action"] for o in out] == ["created", "created"] and out[0]["md5"] == hashlib.md5(a.read_bytes()).hexdigest()
    folders = [f for f in Drive.files.values() if f["mime"] == du.FOLDER_MIME]
    assert len(folders) == 1 and folders[0]["name"] == "GT Editor output" and all(f["parents"] == [out[0]["folder"]] for f in Drive.files.values() if f["mime"] != du.FOLDER_MIME)

    a.write_bytes(b"1,9.00,9.00,A,6\n")
    assert du.main([str(a)]) == 0
    again = json.loads(capsys.readouterr().out)
    assert again["action"] == "updated" and again["id"] == out[0]["id"] and again["folder"] == out[0]["folder"]
    assert len(Drive.files) == 3 and Drive.files[out[0]["id"]]["content"] == a.read_bytes()


def test_names_with_quotes_survive_the_query_and_explicit_folder_id_is_used(drive, tmp_path, capsys):
    f = tmp_path / "it's.txt"; f.write_bytes(b"x")
    Drive.files["root1"] = {"name": "mine", "parents": [], "mime": du.FOLDER_MIME, "content": b""}
    assert du.main(["--folder-id", "root1", str(f)]) == 0
    assert json.loads(capsys.readouterr().out)["folder"] == "root1" and ("POST", "/drive/v3/files") not in Drive.log      # no folder was created
    assert du.main(["--folder-id", "root1", str(f)]) == 0 and sum(1 for x in Drive.files.values() if x["name"] == "it's.txt") == 1


def test_missing_credentials_is_exit_3_and_contacts_nobody(drive, tmp_path, monkeypatch):
    monkeypatch.delenv("GOOGLE_REFRESH_TOKEN")
    assert du.main([str(tmp_path / "x")]) == 3 and Drive.log == []


def test_bad_refresh_token_and_md5_mismatch_are_errors(drive, tmp_path, monkeypatch, capsys):
    f = tmp_path / "a.txt"; f.write_bytes(b"data")
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "WRONG")
    assert du.main([str(f)]) == 1 and "HTTP 400" in capsys.readouterr().err
    monkeypatch.setenv("GOOGLE_REFRESH_TOKEN", "REFRESH")
    Drive.corrupt_md5[0] = True
    assert du.main([str(f)]) == 1 and "md5" in capsys.readouterr().err


def test_identical_content_is_not_uploaded_again(drive, tmp_path, capsys):
    f = tmp_path / "IMG_0114.txt"; f.write_bytes(b"1,2.00,3.00,A,6\n")
    assert du.main([str(f)]) == 0
    capsys.readouterr(); Drive.log.clear()
    assert du.main([str(f)]) == 0
    assert json.loads(capsys.readouterr().out)["action"] == "unchanged" and not any(m in ("PATCH",) or p.startswith("/upload") for m, p in Drive.log)
