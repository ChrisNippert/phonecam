#!/usr/bin/env python3
"""
PhoneCam - stream your phone's camera to your PC over the local network.

Zero dependencies: standard-library Python 3.8+.
  * HTTPS on 0.0.0.0:8443   (phones only allow camera access on secure pages)
  * HTTP  on 127.0.0.1:8080 (local-only viewer, handy as an OBS Browser Source)

The server only does signalling (a tiny WebSocket relay). Video goes
phone -> PC directly over WebRTC and never passes through Python.

Run:  python server.py     then open the printed URL on your phone.
"""

import argparse
import asyncio
import base64
import datetime
import hashlib
import ipaddress
import json
import mimetypes
import shutil
import socket
import ssl
import struct
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CERT_DIR = ROOT / "certs"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PAGES = {"/": "index.html", "/phone": "phone.html", "/viewer": "viewer.html"}

PHONE_URL = None  # set at startup


# --------------------------------------------------------------------------
# Network helpers
# --------------------------------------------------------------------------


def lan_ips():
    """LAN IPv4 addresses, the one with the default route first."""
    ips = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent
        ips.append(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return ips


# --------------------------------------------------------------------------
# Self-signed certificate
# --------------------------------------------------------------------------


def ensure_cert(hosts):
    """Create (or reuse) a self-signed cert valid for every address we'll be reached at."""
    CERT_DIR.mkdir(exist_ok=True)
    crt, key, meta = CERT_DIR / "cert.pem", CERT_DIR / "key.pem", CERT_DIR / "hosts.json"
    wanted = sorted(set(h for h in hosts if h) | {"127.0.0.1", "localhost"})
    if crt.exists() and key.exists() and meta.exists():
        try:
            if set(json.loads(meta.read_text())) >= set(wanted):
                return crt, key
        except ValueError:
            pass

    print("Generating self-signed certificate for:", ", ".join(wanted))
    try:
        _cert_with_cryptography(wanted, crt, key)
    except ImportError:
        if not shutil.which("openssl"):
            sys.exit(
                "Need either the 'cryptography' package (pip install cryptography)\n"
                "or the 'openssl' command to create the HTTPS certificate."
            )
        _cert_with_openssl(wanted, crt, key)
    meta.write_text(json.dumps(wanted))
    return crt, key


def _san_entries(hosts):
    out = []
    for h in hosts:
        try:
            ipaddress.ip_address(h)
            out.append(("IP", h))
        except ValueError:
            out.append(("DNS", h))
    return out


def _cert_with_cryptography(hosts, crt, key):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    k = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "PhoneCam local")])
    san = [
        x509.IPAddress(ipaddress.ip_address(v)) if t == "IP" else x509.DNSName(v)
        for t, v in _san_entries(hosts)
    ]
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(k.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(k, hashes.SHA256())
    )
    key.write_bytes(k.private_bytes(serialization.Encoding.PEM,
                                    serialization.PrivateFormat.PKCS8,
                                    serialization.NoEncryption()))
    crt.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _cert_with_openssl(hosts, crt, key):
    san = ",".join(f"{t}:{v}" for t, v in _san_entries(hosts))
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
         "-nodes", "-days", "825", "-subj", "/CN=PhoneCam local",
         "-addext", f"subjectAltName={san}", "-keyout", str(key), "-out", str(crt)],
        check=True, capture_output=True,
    )


# --------------------------------------------------------------------------
# Minimal WebSocket (RFC 6455) on asyncio streams
# --------------------------------------------------------------------------


class WebSocket:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.closed = False

    def send_text(self, text):
        if self.closed:
            return
        payload = text.encode()
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x81, n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x81, 126, n)
        else:
            header = struct.pack("!BBQ", 0x81, 127, n)
        self._write(header + payload)

    def send(self, obj):
        self.send_text(json.dumps(obj))

    def _write(self, data):
        try:
            self.writer.write(data)
        except (ConnectionError, RuntimeError):
            self.closed = True

    async def recv(self):
        """Next text message, or None when the connection ends."""
        message, have_msg = b"", False
        while True:
            b1, b2 = await self.reader.readexactly(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", await self.reader.readexactly(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", await self.reader.readexactly(8))
            if length > 4 * 1024 * 1024:
                return None
            mask = await self.reader.readexactly(4) if b2 & 0x80 else b"\0\0\0\0"
            raw = await self.reader.readexactly(length)
            data = bytes(b ^ mask[i & 3] for i, b in enumerate(raw)) if b2 & 0x80 else raw

            if opcode == 0x8:  # close
                self._write(struct.pack("!BB", 0x88, len(data[:2])) + data[:2])
                return None
            if opcode == 0x9:  # ping -> pong
                self._write(struct.pack("!BB", 0x8A, len(data)) + data)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                message, have_msg = data, True
            elif opcode == 0x0:
                message += data
            if fin and have_msg:
                return message.decode("utf-8", "replace")

    def close(self):
        if not self.closed:
            self._write(struct.pack("!BBH", 0x88, 2, 1000))
            self.closed = True
        try:
            self.writer.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Signalling hub: one phone, one viewer. Messages are relayed verbatim.
# (All on the event loop thread, so no locks needed.)
# --------------------------------------------------------------------------


class Hub:
    def __init__(self):
        self.peers = {"phone": None, "viewer": None}

    @staticmethod
    def other(role):
        return "viewer" if role == "phone" else "phone"

    def join(self, role, ws):
        old = self.peers[role]
        self.peers[role] = ws
        if old is not None and not old.closed:
            old.send({"type": "replaced"})
            old.close()
        other = self.peers[self.other(role)]
        if other is not None:
            other.send({"type": "peer-joined", "role": role})
            ws.send({"type": "peer-joined", "role": self.other(role)})
        else:
            ws.send({"type": "waiting"})
        print(f"[ws] {role} connected")

    def leave(self, role, ws):
        if self.peers[role] is not ws:
            return
        self.peers[role] = None
        other = self.peers[self.other(role)]
        if other is not None:
            other.send({"type": "peer-left", "role": role})
        print(f"[ws] {role} disconnected")

    def relay(self, role, text):
        other = self.peers[self.other(role)]
        if other is not None:
            other.send_text(text)


HUB = Hub()


async def keepalive(ws):
    """Ping every 20s so NAT/Wi-Fi idle timeouts don't kill the socket."""
    try:
        while not ws.closed:
            await asyncio.sleep(20)
            ws._write(b"\x89\x00")
    except asyncio.CancelledError:
        pass


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


def http_response(writer, status, body=b"", ctype="text/plain; charset=utf-8"):
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed"}[status]
    head = (
        f"HTTP/1.1 {status} {reason}\r\n"
        f"Content-Type: {ctype}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: keep-alive\r\n\r\n"
    )
    writer.write(head.encode() + body)


def static_file(path):
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    if path.suffix == ".js":
        ctype = "text/javascript"
    if ctype.startswith("text/"):
        ctype += "; charset=utf-8"
    return path.read_bytes(), ctype


async def handle_client(reader, writer):
    try:
        while True:  # keep-alive loop
            try:
                request_line = await asyncio.wait_for(reader.readline(), timeout=60)
            except asyncio.TimeoutError:
                return
            if not request_line:
                return
            parts = request_line.decode("latin-1").split()
            headers = {}
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                k, _, v = line.decode("latin-1").partition(":")
                headers[k.strip().lower()] = v.strip()
            if len(parts) < 2:
                return
            method, target = parts[0], parts[1]
            if method != "GET":
                http_response(writer, 405, b"GET only")
                await writer.drain()
                continue

            url = urlparse(target)
            if url.path == "/ws":
                await handle_ws(reader, writer, headers, parse_qs(url.query))
                return

            if url.path == "/api/info":
                body = json.dumps({"phoneUrl": PHONE_URL, "qr": qr_available()}).encode()
                http_response(writer, 200, body, "application/json")
            elif url.path == "/qr.svg" and PHONE_URL and qr_available():
                http_response(writer, 200, qr_svg(PHONE_URL).encode(), "image/svg+xml")
            elif url.path in PAGES:
                http_response(writer, 200, *static_file(STATIC / PAGES[url.path]))
            elif url.path.startswith("/static/"):
                p = (STATIC / url.path[len("/static/"):]).resolve()
                if STATIC.resolve() in p.parents and p.is_file():
                    http_response(writer, 200, *static_file(p))
                else:
                    http_response(writer, 404, b"not found")
            else:
                http_response(writer, 404, b"not found")
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError, ssl.SSLError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle_ws(reader, writer, headers, query):
    role = (query.get("role") or [""])[0]
    key = headers.get("sec-websocket-key")
    if role not in ("phone", "viewer") or not key or "websocket" not in headers.get("upgrade", "").lower():
        http_response(writer, 400, b"bad websocket request")
        await writer.drain()
        return
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    writer.write(
        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
         f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode()
    )
    await writer.drain()

    ws = WebSocket(reader, writer)
    HUB.join(role, ws)
    pinger = asyncio.ensure_future(keepalive(ws))
    try:
        while True:
            msg = await ws.recv()
            if msg is None:
                break
            HUB.relay(role, msg)
    except (ConnectionError, asyncio.IncompleteReadError, ssl.SSLError, OSError):
        pass
    finally:
        pinger.cancel()
        ws.closed = True
        HUB.leave(role, ws)


# --------------------------------------------------------------------------
# Optional QR code (pip install qrcode) - in the terminal and on the viewer
# --------------------------------------------------------------------------


def qr_available():
    try:
        import qrcode.image.svg  # noqa: F401
        return True
    except ImportError:
        return False


def qr_svg(data):
    import qrcode
    import qrcode.image.svg
    out = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, border=2).to_string()
    return out.decode() if isinstance(out, bytes) else out


def print_qr(data):
    try:
        import qrcode
    except ImportError:
        print("  (pip install qrcode  to get a scannable QR code here and on the viewer)")
        return
    qr = qrcode.QRCode(border=1)
    qr.add_data(data)
    qr.print_ascii(invert=True)


# --------------------------------------------------------------------------


def quiet_exceptions(loop, context):
    # Phones drop TLS handshakes when showing the cert warning; don't spam the console.
    exc = context.get("exception")
    if isinstance(exc, (ssl.SSLError, ConnectionError, OSError)):
        return
    loop.default_exception_handler(context)


async def serve(args):
    global PHONE_URL
    asyncio.get_running_loop().set_exception_handler(quiet_exceptions)

    ips = lan_ips()
    host = args.host or (ips[0] if ips else "127.0.0.1")
    crt, key = ensure_cert(ips + [host, socket.gethostname()])
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)

    servers = [await asyncio.start_server(handle_client, "0.0.0.0", args.port, ssl=ctx,
                                          ssl_handshake_timeout=10)]
    if args.local_port:
        servers.append(await asyncio.start_server(handle_client, "127.0.0.1", args.local_port))

    PHONE_URL = f"https://{host}:{args.port}/phone"
    print("\nPhoneCam is running")
    print(f"  Phone  : {PHONE_URL}")
    if args.local_port:
        print(f"  Viewer : http://localhost:{args.local_port}/viewer        (this PC)")
        print(f"           http://localhost:{args.local_port}/viewer?clean  (video only, for OBS)")
    print(f"  Viewer : https://{host}:{args.port}/viewer     (from another device)")
    if len(ips) > 1:
        print("  Other addresses on this PC:", ", ".join(ips[1:]))
    print()
    print_qr(PHONE_URL)
    print("\nThe phone will warn about a self-signed certificate - that's expected.")
    print("Tap 'Advanced' -> 'Proceed'. Ctrl+C to stop.\n")

    await asyncio.gather(*(s.serve_forever() for s in servers))


def main():
    ap = argparse.ArgumentParser(description="Stream your phone camera to your PC.")
    ap.add_argument("--port", type=int, default=8443, help="HTTPS port for the phone (default 8443)")
    ap.add_argument("--local-port", type=int, default=8080,
                    help="plain-HTTP localhost port for the viewer/OBS (default 8080, 0 = off)")
    ap.add_argument("--host", default=None,
                    help="IP to put in the phone URL, if the auto-detected one is wrong")
    args = ap.parse_args()
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("Bye.")


if __name__ == "__main__":
    main()
