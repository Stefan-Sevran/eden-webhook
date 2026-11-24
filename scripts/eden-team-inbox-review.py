#!/usr/bin/env python3
"""Run a local, read-only Proton inbox watcher and Eden draft review queue."""

import argparse
import contextlib
from email import policy
from email.parser import BytesParser
from getpass import getpass
from html import escape
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import imaplib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import ssl
import subprocess
import threading
from urllib.parse import parse_qs
import webbrowser


TEAM = "team@clinicnet.live"
MAX_EMAIL_BYTES = 128 * 1024
MAX_TEXT = 4000
BATCH = 25
INTERVAL = 30
ROOT = Path(__file__).resolve().parent.parent
PARSER = BytesParser(policy=policy.default)
DRAFT_JS = """
const { draftEdenSupportEmail } = require('./eden-support-email');
const text = require('node:fs').readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify(draftEdenSupportEmail(text)));
"""
SCHEMA = """
CREATE TABLE IF NOT EXISTS checkpoint (
    id INTEGER PRIMARY KEY CHECK (id = 1), validity INTEGER NOT NULL, last_uid INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS review (
    id INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, sender TEXT NOT NULL,
    subject TEXT NOT NULL, context TEXT NOT NULL, draft TEXT NOT NULL, reason TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'dismissed'))
);
"""


class MessageHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks = []
        self.ignored = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.ignored += 1
        if tag in {"p", "div", "br", "li", "blockquote"}:
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"} and self.ignored:
            self.ignored -= 1
        if tag in {"p", "div", "li", "blockquote"}:
            self.chunks.append("\n")

    def handle_data(self, data):
        if not self.ignored:
            self.chunks.append(data)


def message_body(message):
    part = message.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        body = part.get_content()
    except (LookupError, UnicodeError, ValueError):
        return ""
    if part.get_content_type() == "text/html":
        parser = MessageHTML()
        parser.feed(body)
        parser.close()
        body = "".join(parser.chunks)
    return body.strip()


def route_message(raw):
    message = PARSER.parsebytes(raw)
    to = message.get_all("To", [])
    cc = message.get_all("Cc", [])
    if any(len(headers) > 1 for headers in (to, cc)):
        return None
    recipients = {address.addr_spec.lower() for header in to + cc for address in header.addresses}
    if TEAM not in recipients:
        return None
    if message.get("Auto-Submitted", "no").split(";", 1)[0].strip().lower() != "no":
        return None
    if message.get("Precedence", "").strip().lower() in {"bulk", "list", "junk"} or message.get("List-Id"):
        return None

    senders = message.get_all("From", [])
    ids = message.get_all("Message-ID", [])
    if len(senders) != 1 or len(senders[0].addresses) != 1 or len(ids) != 1:
        return None
    sender = senders[0].addresses[0].addr_spec.lower()
    message_id = str(ids[0])
    if not re.fullmatch(r"<[^<>\s]{1,998}>", message_id):
        return None
    if "@" not in sender or sender in {TEAM, "eden@auth.clinicnet.live"}:
        return None
    if re.match(r"^(?:mailer-daemon|postmaster|no-?reply|do-?not-?reply)@", sender):
        return None

    subject = str(message.get("Subject", "")).strip()
    if message.get("In-Reply-To") or message.get("References") or re.match(r"^(?:re|fwd?):", subject, re.I):
        return message_id, sender, subject, "", "", "Follow-up or forwarded email"
    if len(raw) > MAX_EMAIL_BYTES or any(message.iter_attachments()):
        return message_id, sender, subject, "", "", "Email is too large or includes attachments"
    body = message_body(message)
    if not body or len(body) > MAX_TEXT:
        return message_id, sender, subject, "", "", "No short message body available"
    output = subprocess.run(
        ["node", "-e", DRAFT_JS], cwd=ROOT, input=body, text=True,
        capture_output=True, check=True, timeout=10,
    )
    result = json.loads(output.stdout)
    if result["decision"] != "draft":
        return message_id, sender, subject, "", "", "Eden could not confidently answer"
    return message_id, sender, subject, body, result["body"], ""


@contextlib.contextmanager
def database(path):
    with contextlib.closing(sqlite3.connect(path, timeout=10)) as connection, connection:
        connection.row_factory = sqlite3.Row
        yield connection


@contextlib.contextmanager
def inbox(args, password, tls):
    if args.security == "ssl":
        imap = imaplib.IMAP4_SSL("127.0.0.1", args.port, ssl_context=tls, timeout=15)
    else:
        imap = imaplib.IMAP4("127.0.0.1", args.port, timeout=15)
    with imap:
        if args.security == "starttls":
            imap.starttls(ssl_context=tls)
        imap.login(TEAM, password)
        status, _ = imap.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("Bridge could not open the team inbox.")
        yield imap


def scan(imap, path):
    validity = int(imap.response("UIDVALIDITY")[1][0])
    with database(path) as connection:
        cursor = connection.execute("SELECT validity, last_uid FROM checkpoint WHERE id = 1").fetchone()
        if cursor is None:
            latest = int(imap.response("UIDNEXT")[1][0]) - 1
            connection.execute("INSERT INTO checkpoint VALUES (1, ?, ?)", (validity, latest))
            return
        if cursor["validity"] != validity:
            raise RuntimeError("The inbox changed identity. The watcher is paused to avoid reprocessing old mail.")
        last = cursor["last_uid"]
    status, result = imap.uid("SEARCH", None, "UID", f"{last + 1}:*")
    if status != "OK":
        raise RuntimeError("Bridge could not search for new mail.")
    uids = sorted({int(uid) for uid in (result[0] or b"").split() if int(uid) > last})
    for uid in uids[:BATCH]:
        status, parts = imap.uid("FETCH", str(uid), f"(BODY.PEEK[]<0.{MAX_EMAIL_BYTES + 1}>)")
        if status != "OK":
            raise RuntimeError("Bridge could not read a new message. It will retry.")
        raw = next((part[1] for part in parts if isinstance(part, tuple)), b"")
        review = route_message(raw) if raw else None
        with database(path) as connection:
            if review:
                connection.execute(
                    "INSERT OR IGNORE INTO review (message_id, sender, subject, context, draft, reason) "
                    "VALUES (?, ?, ?, ?, ?, ?)", review,
                )
            connection.execute("UPDATE checkpoint SET last_uid = MAX(last_uid, ?) WHERE id = 1", (uid,))


def watch(args, password, tls, path, stopped, status):
    while not stopped.is_set():
        try:
            with inbox(args, password, tls) as imap:
                scan(imap, path)
            status["message"] = "Watching for new team inbox mail"
        except (OSError, imaplib.IMAP4.error, subprocess.SubprocessError, ValueError, TypeError):
            status["message"] = "Inbox unavailable. Check that Bridge is open and connected. Retrying shortly."
        except RuntimeError as error:
            status["message"] = str(error)
        stopped.wait(INTERVAL)


STYLE = """
*{box-sizing:border-box}body{margin:0;background:#f6f7fb;color:#202535;font:16px/1.55 system-ui,sans-serif}
main{max-width:860px;margin:48px auto;padding:0 20px}h1,h2,h3,p{margin:0 0 10px}h1{font-size:2rem}
h2{font-size:1.25rem;margin-top:28px}.status{color:#536077}article{margin:12px 0;padding:20px;
border:1px solid #dce1ec;border-radius:14px;background:#fff}small{color:#536077;overflow-wrap:anywhere}
pre,textarea{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}textarea{width:100%;min-height:180px;
margin:8px 0;padding:12px;border:1px solid #a0aabe;border-radius:8px;color:inherit;background:#fff}
button,a.action{display:inline-block;font:inherit;padding:8px 13px;border:1px solid #18463e;border-radius:8px;
background:#18463e;color:#fff;text-decoration:none;cursor:pointer}button.secondary,a.secondary{background:#fff;color:#18463e}
button:focus-visible,a:focus-visible,textarea:focus-visible{outline:3px solid #6f54d2;outline-offset:2px}
"""


def card(row):
    heading = f"<h3>{escape(row['subject'] or '(No subject)')}</h3><small>{escape(row['sender'])}</small>"
    controls = ""
    if row["state"] == "pending":
        controls = f'<form method="post" action="./review"><input type="hidden" name="id" value="{row["id"]}">'
        if row["draft"]:
            controls += (
                f'<details><summary>Original question</summary><pre>{escape(row["context"])}</pre></details>'
                f'<label>Suggested reply<textarea name="draft" required maxlength="6000">{escape(row["draft"])}</textarea></label>'
                '<button name="action" value="approved">Approve draft</button> '
            )
        else:
            controls += f"<p>{escape(row['reason'])}. Open the email in Proton.</p>"
        controls += '<button class="secondary" name="action" value="dismissed" formnovalidate>Dismiss</button></form>'
    elif row["state"] == "approved":
        controls = (
            f'<p>Ready to send from Proton</p><label>Approved reply<textarea readonly>{escape(row["draft"])}</textarea></label>'
            f'<form method="post" action="./review"><input type="hidden" name="id" value="{row["id"]}">'
            '<button class="secondary" name="action" value="archived">Clear from queue</button></form>'
        )
    return f"<article>{heading}{controls}</article>"


def review_handler(path, status, token, origin):
    prefix = "/" + token + "/"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status_code, body=""):
            self.send_response(status_code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def do_GET(self):
            if self.headers.get("Host") != origin.removeprefix("http://") or self.path != prefix:
                return self.reply(404)
            with database(path) as connection:
                pending, approved = (
                    "".join(card(row) for row in connection.execute(
                        "SELECT * FROM review WHERE state = ? ORDER BY id DESC LIMIT 100", (state,),
                    ))
                    for state in ("pending", "approved")
                )
            self.reply(200, f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Eden email review</title>
<style>{STYLE}</style><main><h1>Eden email review</h1>
<p class="status">{escape(status["message"])}</p>
<p>Approve a draft here, then reply in Proton when you’re ready.</p>
<a class="action secondary" href="./">Refresh</a>
<h2>Needs review</h2>{pending or "<p>Nothing waiting for review.</p>"}
<h2>Approved drafts</h2>{approved or "<p>No approved drafts yet.</p>"}</main></html>""")

        def do_POST(self):
            if (self.headers.get("Host") != origin.removeprefix("http://")
                    or self.headers.get("Origin") != origin or self.path != prefix + "review"):
                return self.reply(403)
            content_length = self.headers.get("Content-Length", "")
            if not content_length.isdecimal() or not 0 < int(content_length) <= 100_000:
                return self.reply(400)
            try:
                fields = parse_qs(self.rfile.read(int(content_length)).decode("utf-8", "replace"), max_num_fields=8)
            except ValueError:
                return self.reply(400)
            row_id = fields.get("id", [""])[0]
            action = fields.get("action", [""])[0]
            draft = fields.get("draft", [""])[0].strip()
            if not re.fullmatch(r"[0-9]{1,18}", row_id) or action not in {"approved", "dismissed", "archived"}:
                return self.reply(400)
            if action == "approved" and not 0 < len(draft) <= 6000:
                return self.reply(400)
            with database(path) as connection:
                if action == "approved":
                    connection.execute(
                        "UPDATE review SET state = 'approved', draft = ? WHERE id = ? AND state = 'pending' AND draft != ''",
                        (draft, row_id),
                    )
                else:
                    prior_state = "approved" if action == "archived" else "pending"
                    connection.execute(
                        "UPDATE review SET state = 'dismissed', context = '', draft = '' WHERE id = ? AND state = ?",
                        (row_id, prior_state),
                    )
            self.send_response(303)
            self.send_header("Location", prefix)
            self.end_headers()

    return Handler


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--certificate", required=True)
    args.add_argument("--port", required=True, type=int)
    args.add_argument("--security", choices=("starttls", "ssl"), required=True)
    options = args.parse_args()
    os.umask(0o077)
    directory = Path.home() / "Library" / "Application Support" / "Eden" / "Email Review"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "queue.sqlite3"
    with database(path) as connection:
        connection.executescript(SCHEMA)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.load_verify_locations(cafile=options.certificate)
    # Trust only the Bridge certificate saved locally. Its name may differ from the loopback IP.
    tls.check_hostname = False
    password = getpass("Proton Bridge IMAP password: ")
    with inbox(options, password, tls) as imap:
        scan(imap, path)
    stopped = threading.Event()
    status = {"message": "Watching for new team inbox mail"}
    token = secrets.token_urlsafe(24)
    with ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler) as server:
        origin = f"http://127.0.0.1:{server.server_port}"
        server.RequestHandlerClass = review_handler(path, status, token, origin)
        thread = threading.Thread(target=watch, args=(options, password, tls, path, stopped, status), daemon=True)
        thread.start()
        url = f"{origin}/{token}/"
        print(f"Review Eden drafts at {url}\nLeave this window and Proton Bridge open. Press Ctrl+C to stop.", flush=True)
        webbrowser.open(url)
        try:
            server.serve_forever()
        finally:
            stopped.set()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (OSError, imaplib.IMAP4.error, subprocess.SubprocessError, RuntimeError, TypeError, ValueError) as error:
        raise SystemExit(f"Eden email review could not start ({type(error).__name__})."
                         + (f" {error}" if type(error) is RuntimeError else "")) from None
