#!/usr/bin/env python3
"""Read one synthetic team-inbox email through Proton Bridge and draft locally."""

import argparse
from email import policy
from email.parser import BytesParser
from getpass import getpass
from html.parser import HTMLParser
import imaplib
import json
from pathlib import Path
import re
import ssl
import subprocess


TEAM_ADDRESS = "team@clinicnet.live"
TEST_SUBJECT = "Eden Team Inbox Test"
TEST_SUBJECTS = {TEST_SUBJECT, TEST_SUBJECT + " 2"}
TEST_SENDERS = {"verify@clinicnet.live", "steloa@protonmail.com"}
TEST_QUESTION = "Hi Eden, where do I review a support access request?"
MAX_TEST_BYTES = 65536
ROOT = Path(__file__).resolve().parent.parent


def fetch_parts(mailbox, uid, section):
    status, parts = mailbox.uid("FETCH", uid, section)
    if status != "OK":
        raise RuntimeError("Proton Bridge could not read the test message.")
    return parts


def message_text(parts):
    return next((part[1] for part in parts if isinstance(part, tuple)), b"")


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.text = []

    def handle_data(self, data):
        self.text.append(data)


def is_test_question(part):
    text = part.get_content()
    if part.get_content_type() == "text/html":
        parser = PlainHTML()
        parser.feed(text)
        parser.close()
        text = "".join(parser.text)
    return " ".join(text.split()).rstrip("?").casefold() == TEST_QUESTION.rstrip("?").casefold()


def read_test_message(mailbox):
    status, _ = mailbox.select("INBOX", readonly=True)
    if status != "OK":
        raise RuntimeError("Proton Bridge could not open the team inbox.")
    status, matches = mailbox.uid("SEARCH", None, "HEADER", "SUBJECT", f'"{TEST_SUBJECT}"')
    if status != "OK":
        raise RuntimeError("Proton Bridge could not search the team inbox.")

    parser = BytesParser(policy=policy.default)
    uids = (matches[0] or b"").split() if matches else []
    eligible = 0
    for uid in reversed(uids):
        raw_headers = message_text(fetch_parts(
            mailbox, uid, "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT MESSAGE-ID)])"
        ))
        headers = parser.parsebytes(raw_headers, headersonly=True)
        from_headers = headers.get_all("From", [])
        to_headers = headers.get_all("To", [])
        message_ids = headers.get_all("Message-ID", [])
        if len(from_headers) != 1 or len(from_headers[0].addresses) != 1 or len(to_headers) != 1:
            continue
        sender = from_headers[0].addresses[0].addr_spec.lower()
        recipients = {address.addr_spec.lower() for address in to_headers[0].addresses}
        if (sender not in TEST_SENDERS or recipients != {TEAM_ADDRESS}
                or headers["Subject"] not in TEST_SUBJECTS or len(message_ids) != 1
                or not re.fullmatch(r"<[^<>\s]+>", message_ids[0])):
            continue
        eligible += 1
        raw_message = message_text(fetch_parts(mailbox, uid, f"(BODY.PEEK[]<0.{MAX_TEST_BYTES + 1}>)"))
        if raw_message and len(raw_message) <= MAX_TEST_BYTES:
            part = parser.parsebytes(raw_message).get_body(preferencelist=("plain", "html"))
            if part is not None and is_test_question(part):
                return {"sender": sender, "messageId": str(message_ids[0]), "text": TEST_QUESTION}
    raise RuntimeError(
        f"No matching test email in the team inbox. Subject matches: {len(uids)}. "
        f"Matching sender, recipient and thread headers: {eligible}."
    )


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--certificate", required=True, help="The public TLS certificate from Proton Bridge")
    args.add_argument("--port", required=True, type=int, help="The IMAP port shown by Proton Bridge")
    args.add_argument("--security", choices=("starttls", "ssl"), required=True)
    options = args.parse_args()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=options.certificate)
    # The exported certificate is the only trust anchor. Some Bridge certificates
    # name localhost instead of including the loopback IP in their SAN.
    context.check_hostname = False
    if options.security == "ssl":
        connection = imaplib.IMAP4_SSL("127.0.0.1", options.port, ssl_context=context, timeout=15)
    else:
        connection = imaplib.IMAP4("127.0.0.1", options.port, timeout=15)
    with connection as mailbox:
        if options.security == "starttls":
            mailbox.starttls(ssl_context=context)
        mailbox.login(TEAM_ADDRESS, getpass("Proton Bridge IMAP password: "))
        message = read_test_message(mailbox)

    response = subprocess.run(
        ["node", "-e",
         "const {draftEdenSupportEmail} = require('./eden-support-email');"
         "const text = require('node:fs').readFileSync(0, 'utf8');"
         "process.stdout.write(JSON.stringify(draftEdenSupportEmail(text)));"],
        cwd=ROOT, input=message.pop("text"), text=True, capture_output=True, check=True,
    )
    print(json.dumps({
        "replyRecipient": message["sender"],
        "inReplyTo": message["messageId"],
        "replyTo": TEAM_ADDRESS,
        **json.loads(response.stdout),
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, imaplib.IMAP4.error, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Team inbox test stopped ({type(error).__name__})."
                         + (f" {error}" if type(error) is RuntimeError else "")) from None
