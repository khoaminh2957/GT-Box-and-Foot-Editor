"""Upload files to Google Drive with an OAuth refresh token (standard library only).

Why OAuth and not a service account: a service account has no storage quota in a personal My Drive (Drive answers storageQuotaExceeded), so files must be
created on behalf of a real user.  The refresh token comes from scripts/drive_oauth_setup.py (run once); CI keeps it in GitHub secrets.

Scope drive.file lets the app see only files it created itself, so by default the script finds or creates its own folder (--folder-name) and puts the files in it.
--folder-id uses an existing folder instead; with drive.file that may be refused by Drive (UNVERIFIED), in which case the token needs the full `drive` scope.
A file that already exists in the folder under the same name is updated in place (same file id, Drive keeps the earlier versions), then Drive's md5 is compared with the local one.

usage: drive_upload.py [--folder-name NAME | --folder-id ID] FILE [FILE ...]
env:   GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET  GOOGLE_REFRESH_TOKEN     (GOOGLE_TOKEN_URL / GOOGLE_API_BASE / GOOGLE_UPLOAD_BASE override the endpoints, for tests)
exit:  0 uploaded, 1 error, 3 not configured (credentials missing: nothing attempted)"""
import argparse, hashlib, json, os, sys, urllib.error, urllib.parse, urllib.request, uuid
from pathlib import Path

FOLDER_MIME = "application/vnd.google-apps.folder"


def endpoints():
    return (os.environ.get("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"), os.environ.get("GOOGLE_API_BASE", "https://www.googleapis.com/drive/v3"),
            os.environ.get("GOOGLE_UPLOAD_BASE", "https://www.googleapis.com/upload/drive/v3"))


def call(method, url, token=None, body=None, content_type=None):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url.split('?')[0]} -> HTTP {e.code}: {e.read().decode(errors='replace')[:300]}") from None


def access_token(client_id, client_secret, refresh_token):
    form = urllib.parse.urlencode({"client_id": client_id, "client_secret": client_secret, "refresh_token": refresh_token, "grant_type": "refresh_token"}).encode()
    return call("POST", endpoints()[0], body=form, content_type="application/x-www-form-urlencoded")["access_token"]


def q_escape(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def list_files(token, q):
    url = f"{endpoints()[1]}/files?" + urllib.parse.urlencode({"q": q, "fields": "files(id,name,md5Checksum)", "spaces": "drive", "pageSize": 10})
    return call("GET", url, token)["files"]


def ensure_folder(token, name):
    found = list_files(token, f"name = '{q_escape(name)}' and mimeType = '{FOLDER_MIME}' and trashed = false")
    if found:
        return found[0]["id"]
    return call("POST", f"{endpoints()[1]}/files?fields=id", token, json.dumps({"name": name, "mimeType": FOLDER_MIME}).encode(), "application/json")["id"]


def multipart(metadata, content, media_type):
    b = uuid.uuid4().hex
    head = f"--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(metadata)}\r\n--{b}\r\nContent-Type: {media_type}\r\n\r\n".encode()
    return head + content + f"\r\n--{b}--".encode(), f"multipart/related; boundary={b}"


def upload_file(token, folder_id, path):
    path = Path(path)
    content = path.read_bytes()
    media = "application/gzip" if path.suffix == ".gz" else ("application/json" if path.suffix == ".json" else "text/plain")
    existing = list_files(token, f"name = '{q_escape(path.name)}' and '{folder_id}' in parents and trashed = false")
    local_md5 = hashlib.md5(content).hexdigest()
    if existing and existing[0].get("md5Checksum") == local_md5:
        return {"file": path.name, "action": "unchanged", "id": existing[0]["id"], "md5": local_md5, "bytes": len(content)}
    if existing:
        body, ctype = multipart({}, content, media)
        r = call("PATCH", f"{endpoints()[2]}/files/{existing[0]['id']}?uploadType=multipart&fields=id,md5Checksum", token, body, ctype)
        action = "updated"
    else:
        body, ctype = multipart({"name": path.name, "parents": [folder_id]}, content, media)
        r = call("POST", f"{endpoints()[2]}/files?uploadType=multipart&fields=id,md5Checksum", token, body, ctype)
        action = "created"
    if r.get("md5Checksum") != local_md5:
        raise RuntimeError(f"{path.name}: Drive reports md5 {r.get('md5Checksum')} but the local file is {local_md5}")
    return {"file": path.name, "action": action, "id": r["id"], "md5": local_md5, "bytes": len(content)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("files", nargs="+")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--folder-name", default="GT Editor output")
    g.add_argument("--folder-id")
    a = ap.parse_args(argv)
    cid, secret, refresh = (os.environ.get(k, "") for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"))
    if not (cid and secret and refresh):
        print("drive_upload: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are not all set; nothing uploaded", file=sys.stderr)
        return 3
    try:
        token = access_token(cid, secret, refresh)
        folder = a.folder_id or ensure_folder(token, a.folder_name)
        for f in a.files:
            print(json.dumps({**upload_file(token, folder, f), "folder": folder}))
    except (RuntimeError, OSError, KeyError) as e:
        print(f"drive_upload: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
