"""One-time helper: obtain the Google OAuth refresh token that scripts/drive_upload.py needs.

Before running it, in Google Cloud Console (a personal project is fine):
  1. APIs & Services -> Library: enable "Google Drive API".
  2. OAuth consent screen: user type External.  PUBLISH the app ("In production").  While it stays in "Testing" Google expires refresh tokens after 7 days.
     The only scope used is drive.file, which is non-sensitive, so no verification is needed for personal use (you will see an "unverified app" screen once; continue).
  3. Credentials -> Create credentials -> OAuth client ID -> application type "Desktop app".  Copy the client id and secret.
Then:  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... python scripts/drive_oauth_setup.py
It opens the consent page, receives the code on http://127.0.0.1:<port>, and prints the refresh token.  Store the three values as GitHub secrets
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.  The token is a password: do not paste it into chat, issues or commits."""
import http.server, json, os, sys, threading, urllib.parse, urllib.request, webbrowser

SCOPE = "https://www.googleapis.com/auth/drive.file"


def main():
    cid, secret = os.environ.get("GOOGLE_CLIENT_ID", ""), os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not (cid and secret):
        sys.exit("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see the top of this file)")
    got = {}
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got["code"], got["error"] = (q.get("code") or [""])[0], (q.get("error") or [""])[0]
            self.send_response(200); self.send_header("Content-Type", "text/plain; charset=utf-8"); self.end_headers()
            self.wfile.write("Xong. Quay lại cửa sổ terminal.".encode() if got["code"] else f"Lỗi: {got['error']}".encode())
        def log_message(self, *a): pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    redirect = f"http://127.0.0.1:{srv.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({"client_id": cid, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE, "access_type": "offline", "prompt": "consent"})
    print("Open this page and approve:\n" + url)
    webbrowser.open(url)
    t = threading.Thread(target=srv.handle_request); t.start(); t.join(timeout=300)
    if not got.get("code"):
        sys.exit(f"no authorisation code received ({got.get('error') or 'timeout'})")
    form = urllib.parse.urlencode({"code": got["code"], "client_id": cid, "client_secret": secret, "redirect_uri": redirect, "grant_type": "authorization_code"}).encode()
    with urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=form), timeout=60) as r:
        tok = json.load(r)
    if "refresh_token" not in tok:
        sys.exit("Google returned no refresh token (revoke the app at myaccount.google.com/permissions and run again)")
    print("\nGOOGLE_REFRESH_TOKEN=" + tok["refresh_token"])


if __name__ == "__main__":
    main()
