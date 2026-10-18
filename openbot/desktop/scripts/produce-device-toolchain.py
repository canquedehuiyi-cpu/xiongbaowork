#!/usr/bin/env python3
"""D1 build inputs from a separate carrier and clean frozen C81 --repository.
Not a C82/final-source build, device manifest, installed-runtime or ready issuer.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import ssl
import struct
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

SCHEMA = "device-toolchain-sources-v1"
HEX = re.compile(r"[a-f0-9]{64}\Z")
FINGERPRINT = re.compile(r"(?:[A-F0-9]{40}|[A-F0-9]{64})\Z")
HOSTS = frozenset(("github.com", "api.github.com", "release-assets.githubusercontent.com",
                  "objects.githubusercontent.com", "nodejs.org", "static.rust-lang.org",
                  "cdn.playwright.dev", "playwright.download.prss.microsoft.com"))
MAX_ARCHIVE = 1024 ** 3
MAX_DOWNLOAD = 3 * 1024 ** 3
MAX_EXPANDED = 8 * 1024 ** 3
MAX_MEMBERS = 20000
MAX_EVIDENCE = 2 * 1024 ** 2
WINDOWS_NAMES = frozenset(("CON", "PRN", "AUX", "NUL") +
                         tuple("COM%d" % n for n in range(1, 10)) +
                         tuple("LPT%d" % n for n in range(1, 10)))


class Refused(Exception):
    pass


def need(value, code):
    if not value:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    need(isinstance(value, str) and HEX.fullmatch(value), "PIN_MISSING")
    return value


def plain(path, limit=MAX_ARCHIVE):
    path = Path(path)
    before = path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
         0 <= before.st_size <= limit and not
         getattr(before, "st_file_attributes", 0) &
         getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0), "FILE_REFUSED")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        held = os.fstat(stream.fileno())
        need((held.st_dev, held.st_ino) == (before.st_dev, before.st_ino), "FILE_CHANGED")
        h = hashlib.sha256()
        size = 0
        while True:
            data = stream.read(65536)
            if not data:
                break
            size += len(data)
            need(size <= limit, "FILE_TOO_LARGE")
            h.update(data)
        after = os.fstat(stream.fileno())
    again = path.lstat()
    fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    need(fields(before) == fields(after) == fields(again) and size == held.st_size,
         "FILE_CHANGED")
    return {"bytes": size, "sha256": h.hexdigest()}


def read_json(path, expected=None):
    info = plain(path, MAX_EVIDENCE)
    if expected is not None:
        need(info["sha256"] == digest(expected), "LOCK_DIGEST_MISMATCH")
    raw = Path(path).read_bytes()
    need(len(raw) == info["bytes"] and sha(raw) == info["sha256"], "FILE_CHANGED")
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, "JSON_DUPLICATE_KEY")
            result[key] = value
        return result
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs), info


def write_json(path, value):
    raw = (json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
    need(len(raw) <= MAX_EVIDENCE, "EVIDENCE_TOO_LARGE")
    with open(path, "xb") as stream:
        stream.write(raw)
    return {"bytes": len(raw), "sha256": sha(raw)}


def safe_name(value):
    need(isinstance(value, str) and value and value.isascii() and len(value) <= 1000 and
         not any(ord(c) < 32 or ord(c) == 127 for c in value) and
         not any(c in value for c in ("\\", ":", "\x00")), "ARCHIVE_PATH_REFUSED")
    need(not value.endswith("//"), "ARCHIVE_PATH_REFUSED")
    name = value[:-1] if value.endswith("/") else value
    parts = name.split("/")
    need(all(p and p not in (".", "..") and not p.endswith((" ", ".")) and
             p.split(".")[0].upper() not in WINDOWS_NAMES for p in parts) and
         not PurePosixPath(name).is_absolute(), "ARCHIVE_PATH_REFUSED")
    return name


def check_url(url, approved_url=None):
    need(isinstance(url, str), "SOURCE_URL_REFUSED")
    value = urllib.parse.urlsplit(url)
    need(value.scheme == "https" and value.hostname in HOSTS and not value.username and
         not value.password and value.port in (None, 443) and not value.fragment,
         "SOURCE_URL_REFUSED")
    if approved_url is not None:
        need(url == approved_url, "SOURCE_URL_REFUSED")
    return url


class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, approved_url):
        self.approved_url = check_url(approved_url)
        self.count = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.count += 1
        need(self.count <= 5, "SOURCE_REDIRECT_REFUSED")
        # No cross-URL CDN rule has an independently reviewed asset/path binding.
        # In particular, opaque GitHub release-assets URLs cannot be inferred from
        # a hostname or filename. Refuse until a new exact rule is reviewed.
        need(req.full_url == self.approved_url and newurl == self.approved_url,
             "SOURCE_UNAVAILABLE")
        check_url(newurl, self.approved_url)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, destination, maximum, approved_url):
    check_url(url, approved_url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        Redirects(approved_url))
    end = time.monotonic() + 120
    h = hashlib.sha256()
    total = 0
    request = urllib.request.Request(url, headers={"User-Agent": "xiongbao-d1-source/1"})
    # Ten-second socket operations; 120-second deadline checked between reads.
    # A blocking socket operation can finish after that checkpoint, by at most its timeout.
    # No retry/fallback and no claim of a hard process-family deadline.
    with opener.open(request, timeout=10) as response, open(destination, "xb") as out:
        need(response.status == 200, "SOURCE_UNAVAILABLE")
        check_url(response.geturl(), approved_url)
        while True:
            need(time.monotonic() < end, "SOURCE_DEADLINE")
            raw = response.read(65536)
            if not raw:
                break
            total += len(raw)
            need(total <= maximum, "SOURCE_TOO_LARGE")
            h.update(raw)
            out.write(raw)
    need(time.monotonic() < end, "SOURCE_DEADLINE")
    return {"bytes": total, "sha256": h.hexdigest()}


class WireReader:
    """Count response bytes before a parser can consume an unbounded header."""
    def __init__(self, raw, budget):
        self.raw, self.budget, self.lines = raw, budget, 0

    def read(self, size=-1):
        need(size >= 0, "HTTP_UNBOUNDED_READ_REFUSED")
        maximum = min(size, self.budget.remaining() + 1)
        value = self.raw.read(maximum)
        self.budget.received += len(value)
        need(self.budget.received <= self.budget.limit, "HTTP_BYTE_LIMIT")
        return value

    def readline(self, size=-1):
        maximum = min(16385 - self.lines, self.budget.remaining() + 1)
        if size >= 0:
            maximum = min(maximum, size)
        need(maximum > 0, "HTTP_HEADER_LIMIT")
        value = self.raw.readline(maximum)
        self.lines += len(value)
        self.budget.received += len(value)
        need(self.lines <= 16384, "HTTP_HEADER_LIMIT")
        need(self.budget.received <= self.budget.limit, "HTTP_BYTE_LIMIT")
        return value

    def close(self):
        self.raw.close()


class SourceHTTP:
    """No proxy, credentials, retry or automatic redirect; one owned connection."""
    def __init__(self, deadline, limit, requests=26):
        self.deadline, self.limit, self.maximum = deadline, limit, requests
        self.requests, self.received = 0, 0
        self.held = set()

    def remaining(self):
        return self.limit - self.received

    def close(self):
        for connection in tuple(self.held):
            connection.close()
            self.held.discard(connection)

    def request(self, url, method="GET", accept="*/*"):
        need(method in ("GET", "HEAD") and accept in ("*/*", "application/vnd.github+json") and
             isinstance(url, str) and len(url) <= 8192,
             "HTTP_REQUEST_REFUSED")
        value = urllib.parse.urlsplit(url)
        need(value.scheme == "https" and value.hostname and not value.username and
             not value.password and value.port in (None, 443) and not value.fragment and
             not any(ord(c) < 33 or ord(c) == 127 for c in url), "SOURCE_URL_REFUSED")
        need(self.requests < self.maximum and time.monotonic() < self.deadline,
             "HTTP_REQUEST_LIMIT")
        self.requests += 1
        owner = self
        class Response(http.client.HTTPResponse):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.fp = WireReader(self.fp, owner)
        connection = http.client.HTTPSConnection(value.hostname,
            timeout=min(10, self.deadline - time.monotonic()), context=ssl.create_default_context())
        connection.response_class = Response
        self.held.add(connection)
        try:
            path = value.path or "/"
            if value.query:
                path += "?" + value.query
            connection.request(method, path, headers={
                "User-Agent": "xiongbao-d1-source/1", "Accept": accept,
                "Accept-Encoding": "identity", "Connection": "close"})
            return connection, connection.getresponse()
        except BaseException:
            connection.close()
            self.held.discard(connection)
            raise

    def release(self, connection, response):
        try:
            response.close()
        finally:
            connection.close()
            self.held.discard(connection)

    def body(self, response, maximum):
        need(response.status == 200 and response.getheader("Content-Encoding", "identity") == "identity",
             "SOURCE_UNAVAILABLE")
        raw = bytearray()
        while True:
            need(time.monotonic() < self.deadline, "SOURCE_DEADLINE")
            value = response.read(min(65536, maximum - len(raw) + 1))
            if not value:
                break
            raw.extend(value)
            need(len(raw) <= maximum, "SOURCE_TOO_LARGE")
        return bytes(raw)

    def json(self, url):
        connection, response = self.request(url, accept="application/vnd.github+json")
        try:
            return json.loads(self.body(response, MAX_EVIDENCE))
        finally:
            self.release(connection, response)


def checked_github_asset(release, asset, lock, name):
    spec = lock["githubReleaseAssets"]
    expected = spec["assets"][name]
    need(spec["repository"] == "oven-sh/bun" and spec["repositoryID"] == 357728969 and
         spec["releaseID"] == 320260981 and spec["tag"] == "bun-v1.3.14" and
         spec["target"] == "0d9b296af33f2b851fcbf4df3e9ec89751734ba4" and
         release["id"] == spec["releaseID"] and release["tag_name"] == spec["tag"] and
         release["target_commitish"] == spec["target"], "GITHUB_RELEASE_CHANGED")
    need(sum(a.get("id") == expected["id"] for a in release["assets"]) == 1,
         "GITHUB_ASSET_CHANGED")
    member = next(a for a in release["assets"] if a.get("id") == expected["id"])
    keys = ("id", "name", "url", "browser_download_url", "size", "digest", "state")
    need(set(expected) == set(keys) and all(asset.get(k) == member.get(k) == expected[k]
         for k in keys) and expected["name"] == name and expected["state"] == "uploaded" and
         type(expected["id"]) is int and
         expected["url"] == "https://api.github.com/repos/oven-sh/bun/releases/assets/" +
         str(expected["id"]) and expected["browser_download_url"] ==
         "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/" + name and
         type(expected["size"]) is int and 0 < expected["size"] <= MAX_ARCHIVE and
         expected["digest"] == "sha256:" + digest(expected["digest"].removeprefix("sha256:")),
         "GITHUB_ASSET_CHANGED")
    return expected


class AssetLocation:
    """An exact Location learned only from this asset's owned HTTPS response."""
    def __init__(self, expected):
        self.expected = expected
        self.target = None
        self.used = False

    def accept(self, request_url, status, locations):
        need(self.target is None and not self.used and status == 302 and
             request_url == self.expected["browser_download_url"] and len(locations) == 1,
             "GITHUB_REDIRECT_REFUSED")
        target = locations[0]
        value = urllib.parse.urlsplit(target)
        need(value.scheme == "https" and value.netloc == "release-assets.githubusercontent.com" and
             value.path.startswith("/github-production-release-asset/357728969/") and
             value.path != "/github-production-release-asset/357728969/" and
             not value.fragment and len(target) <= 8192 and
             not any(ord(c) < 33 or ord(c) == 127 for c in target) and
             not any(p in (".", "..") for p in urllib.parse.unquote(value.path).split("/")) and
             "\\" not in urllib.parse.unquote(value.path), "GITHUB_REDIRECT_REFUSED")
        # No caller URL/old capability is accepted by download_asset.
        self.target = target
        return target

    def consume(self, url):
        need(self.target is not None and url == self.target and not self.used,
             "GITHUB_REDIRECT_REFUSED")
        self.used = True


def download_asset(net, expected, destination, maximum):
    need(expected["size"] <= maximum, "SOURCE_TOO_LARGE")
    capability = AssetLocation(expected)
    url = expected["browser_download_url"]
    connection, response = net.request(url)
    try:
        if response.status == 302:
            target = capability.accept(url, response.status,
                                       response.headers.get_all("Location", []))
            net.release(connection, response)
            connection = response = None
            capability.consume(target)
            connection, response = net.request(target)
        need(response.status == 200 and
             response.getheader("Content-Encoding", "identity") == "identity",
             "SOURCE_UNAVAILABLE")
        h, count = hashlib.sha256(), 0
        with open(destination, "xb") as out:
            while True:
                need(time.monotonic() < net.deadline, "SOURCE_DEADLINE")
                raw = response.read(min(65536, expected["size"] - count + 1))
                if not raw:
                    break
                count += len(raw)
                need(count <= expected["size"], "ARCHIVE_SIZE_MISMATCH")
                out.write(raw)
                h.update(raw)
        need(count == expected["size"] and "sha256:" + h.hexdigest() == expected["digest"],
             "ARCHIVE_PIN_MISMATCH")
        return {"bytes": count, "sha256": h.hexdigest()}
    finally:
        if connection is not None:
            net.release(connection, response)
        # The capability and full signed query are not persisted or returned.


def pinned_github_source(source, lock):
    """Validate the Root-reviewed local directory before creating any transport."""
    spec = lock.get("githubReleaseAssets")
    need(isinstance(spec, dict) and spec.get("repository") == "oven-sh/bun" and
         spec.get("repositoryID") == 357728969 and spec.get("releaseID") == 320260981 and
         spec.get("tag") == "bun-v1.3.14" and
         spec.get("target") == "0d9b296af33f2b851fcbf4df3e9ec89751734ba4" and
         isinstance(spec.get("assets"), dict), "GITHUB_RELEASE_CHANGED")
    catalog = {
        "bun-linux-x64-baseline.zip": (418774976, 35595658,
            "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7"),
        "bun-windows-x64-baseline.zip": (418774449, 38023440,
            "538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f"),
    }
    need(isinstance(source, dict) and source.get("name") == "bun" and
         source.get("version") == "1.3.14" and source.get("archive") in catalog,
         "GITHUB_ASSET_CHANGED")
    name = source["archive"]
    asset_id, size, archive_sha = catalog[name]
    expected = {"id": asset_id, "name": name,
        "url": "https://api.github.com/repos/oven-sh/bun/releases/assets/" + str(asset_id),
        "browser_download_url": "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/" + name,
        "size": size, "digest": "sha256:" + archive_sha, "state": "uploaded"}
    need(spec["assets"].get(name) == expected and
         source.get("url") == expected["browser_download_url"] and
         source.get("archiveBytes") == size and source.get("archiveSHA256") == archive_sha,
         "GITHUB_ASSET_CHANGED")
    return expected


def fetch_github_source(source, destination, maximum, lock):
    expected = pinned_github_source(source, lock)
    net = SourceHTTP(time.monotonic() + 120, maximum + 2 * MAX_EVIDENCE + 65536, 4)
    try:
        release = net.json("https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.3.14")
        asset = net.json(expected["url"])
        expected = checked_github_asset(release, asset, lock, source["archive"])
        need(source["url"] == expected["browser_download_url"] and
             source["archiveBytes"] == expected["size"] and
             "sha256:" + digest(source["archiveSHA256"]) == expected["digest"],
             "GITHUB_ASSET_CHANGED")
        return download_asset(net, expected, destination, maximum)
    finally:
        net.close()


def approved_source_url(name, platform):
    """Fixed source identity, not a host-wide permission or mutable redirect target."""
    linux = platform == "linux-x86_64"
    rust_target = "x86_64-unknown-linux-gnu" if linux else "x86_64-pc-windows-msvc"
    bun = "bun-linux-x64-baseline.zip" if linux else "bun-windows-x64-baseline.zip"
    node = "node-v22.14.0-linux-x64.tar.xz" if linux else "node-v22.14.0-win-x64.zip"
    chrome = "linux64/chrome-linux64.zip" if linux else "win64/chrome-win64.zip"
    urls = {
        "bun": "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/" + bun,
        "node": "https://nodejs.org/dist/v22.14.0/" + node,
        "chromium": "https://cdn.playwright.dev/builds/cft/151.0.7922.34/" + chrome,
        **{part: "https://static.rust-lang.org/dist/" + part + "-1.94.0-" +
           rust_target + ".tar.xz" for part in ("rustc", "cargo", "rust-std")},
    }
    need(platform in ("linux-x86_64", "windows-x86_64") and name in urls,
         "SOURCE_SET_REFUSED")
    return urls[name]


def source_list(lock, platform):
    need(lock.get("schema") == SCHEMA and platform in ("linux-x86_64", "windows-x86_64"),
         "LOCK_SCHEMA_REFUSED")
    sources = lock["platforms"][platform]["sources"]
    need(isinstance(sources, list) and len(sources) == 6, "SOURCE_SET_REFUSED")
    need([s["name"] for s in sources] == ["bun", "node", "chromium", "rustc", "cargo", "rust-std"],
         "SOURCE_SET_REFUSED")
    for source in sources:
        need(set(source) == {"name", "version", "url", "archive", "archiveBytes",
                             "archiveSHA256", "kind", "prefix", "binary",
                             "binarySHA256", "verification"}, "SOURCE_SCHEMA_REFUSED")
        safe_name(source["archive"])
        need("/" not in source["archive"], "SOURCE_SCHEMA_REFUSED")
        check_url(source["url"], approved_source_url(source["name"], platform))
        safe_name(source["prefix"])
        if source["binary"] is not None:
            safe_name(source["binary"])
    need([s["version"] for s in sources] ==
         ["1.3.14", "22.14.0", "151.0.7922.34", "1.94.0", "1.94.0", "1.94.0"],
         "SOURCE_VERSION_REFUSED")
    return sources


def complete_lock(lock, platform):
    sources = source_list(lock, platform)
    for source in sources:
        digest(source["archiveSHA256"])
        need(type(source["archiveBytes"]) is int and 0 < source["archiveBytes"] <= MAX_ARCHIVE,
             "SOURCE_SIZE_MISSING")
        if source["binary"] is not None:
            digest(source["binarySHA256"])
        verification = source["verification"]
        need(isinstance(verification, dict), "TRUST_INPUT_MISSING")
        if verification.get("kind") == "openpgp":
            need(FINGERPRINT.fullmatch(verification.get("signerFingerprint") or ""),
                 "SIGNER_PIN_MISSING")
            need(verification.get("signerSourceURL") and
                 check_url(verification["signerSourceURL"]), "SIGNER_SOURCE_MISSING")
            for key in ("messageSHA256", "signatureSHA256", "keyringSHA256"):
                digest(verification.get(key))
            for key in ("message", "signature", "keyring"):
                safe_name(verification[key])
                need("/" not in verification[key], "TRUST_INPUT_REFUSED")
            need(verification.get("signatureMode") in ("detached", "clearsigned"),
                 "SIGNATURE_MODE_MISSING")
            need(verification.get("binding") in ("sha256-list", "rust-manifest"),
                 "SIGNATURE_BINDING_REFUSED")
        elif verification.get("kind") == "root-approved-official-digest":
            # Explicit review of independently retained official metadata is required.
            # A checksum calculated from the archive itself is not this evidence.
            check_url(verification.get("evidenceURL"))
            digest(verification.get("evidenceSHA256"))
        else:
            raise Refused("TRUST_INPUT_MISSING")
    item = lock["platforms"][platform]
    digest(item["chromiumTreeSHA256"])
    digest(item["rustTreeSHA256"])
    digest(lock["cargoLockSHA256"])
    digest(item["vendorTreeSHA256"])
    return sources


def validated_entries(entries):
    seen = {}
    count = 0
    expanded = 0
    result = []
    for path, size, directory, reader, executable in entries:
        path = safe_name(path)
        folded = path.casefold()
        need(folded not in seen, "ARCHIVE_DUPLICATE")
        # A file may not also be an implicit ancestor directory.
        need(not any(p in seen and not seen[p] for p in
                     ("/".join(path.split("/")[:i]).casefold()
                      for i in range(1, len(path.split("/"))))), "ARCHIVE_PATH_COLLISION")
        need(directory or not any(p.startswith(folded + "/") for p in seen),
             "ARCHIVE_PATH_COLLISION")
        seen[folded] = directory
        count += 1
        expanded += size
        need(count <= MAX_MEMBERS and type(size) is int and size >= 0 and
             expanded <= MAX_EXPANDED, "ARCHIVE_LIMIT")
        result.append((path, size, directory, reader, executable))
    return result


def check_zip_layout(archive, z):
    # Only single-disk non-ZIP64 archives; each supported source is far below 4GiB.
    with open(archive, "rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - 65557))
        tail = stream.read()
        at = tail.rfind(b"PK\x05\x06")
        need(at >= 0 and len(tail) >= at + 22, "ZIP_DIRECTORY_REFUSED")
        fields = struct.unpack("<4s4H2LH", tail[at:at + 22])
        _, disk, central_disk, local_count, count, cd_size, cd_offset, comment = fields
        eocd = size - len(tail) + at
        need(disk == central_disk == 0 and count == local_count == len(z.infolist()) and
             count < 65535 and cd_offset + cd_size == eocd and
             at + 22 + comment == len(tail), "ZIP_DIRECTORY_REFUSED")
        ordered = sorted(z.infolist(), key=lambda e: e.header_offset)
        need(ordered and ordered[0].header_offset == 0, "ZIP_LOCAL_REFUSED")
        for i, entry in enumerate(ordered):
            stream.seek(entry.header_offset)
            header = stream.read(30)
            need(len(header) == 30, "ZIP_LOCAL_REFUSED")
            v = struct.unpack("<4s5H3L2H", header)
            need(v[0] == b"PK\x03\x04" and v[2] == entry.flag_bits and
                 v[3] == entry.compress_type, "ZIP_LOCAL_REFUSED")
            raw_name = stream.read(v[9])
            name = raw_name.decode("utf-8" if v[2] & 0x800 else "cp437")
            need(name == entry.orig_filename, "ZIP_LOCAL_REFUSED")
            end = entry.header_offset + 30 + v[9] + v[10] + entry.compress_size
            boundary = ordered[i + 1].header_offset if i + 1 < len(ordered) else cd_offset
            need(end <= boundary, "ZIP_LOCAL_REFUSED")
            if v[2] & 8:
                stream.seek(end)
                descriptor = stream.read(boundary - end)
                if descriptor.startswith(b"PK\x07\x08"):
                    descriptor = descriptor[4:]
                need(len(descriptor) == 12 and struct.unpack("<3L", descriptor) ==
                     (entry.CRC, entry.compress_size, entry.file_size), "ZIP_LOCAL_REFUSED")
            else:
                need(end == boundary and (v[6], v[7], v[8]) ==
                     (entry.CRC, entry.compress_size, entry.file_size), "ZIP_LOCAL_REFUSED")


def extract_archive(archive, destination, kind, node_prefix=None):
    """No external extractor and no archive-provided code is executed."""
    destination = Path(destination)
    need(not destination.exists(), "OUTPUT_EXISTS")
    destination.mkdir(mode=0o700)
    try:
        if kind == "zip":
            with zipfile.ZipFile(archive) as z:
                check_zip_layout(archive, z)
                members = []
                for entry in z.infolist():
                    need(entry.orig_filename == entry.filename, "ARCHIVE_PATH_REFUSED")
                    mode = entry.external_attr >> 16
                    directory = entry.is_dir()
                    filetype = stat.S_IFMT(mode)
                    need(not entry.flag_bits & 1 and entry.compress_type in
                         (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) and
                         filetype in (0, stat.S_IFREG, stat.S_IFDIR) and
                         (not filetype or directory == (filetype == stat.S_IFDIR)),
                         "ARCHIVE_KIND_REFUSED")
                    need(len(members) < MAX_MEMBERS, "ARCHIVE_LIMIT")
                    members.append((entry.filename, entry.file_size, directory,
                                    lambda e=entry: z.open(e), bool(mode & 0o111)))
                extract_entries(validated_entries(members), destination)
        elif kind in ("tar.xz", "tar.gz"):
            with tarfile.open(archive, "r:xz" if kind == "tar.xz" else "r:gz") as t:
                members = []
                for entry in t:
                    name = safe_name(entry.name)
                    ignored_shim = (node_prefix is not None and entry.issym() and
                                    name in {node_prefix + "/bin/" + n
                                             for n in ("npm", "npx", "corepack")})
                    need(entry.isfile() or entry.isdir() or ignored_shim,
                         "ARCHIVE_KIND_REFUSED")
                    need(len(members) < MAX_MEMBERS and entry.size <= MAX_EXPANDED,
                         "ARCHIVE_LIMIT")
                    members.append((name, entry.size, entry.isdir(),
                                    lambda e=entry: t.extractfile(e), bool(entry.mode & 0o111)))
                entries = validated_entries(members)
                if node_prefix is not None:
                    # Only ordinary node and its original license are runtime inputs.
                    # The three known package-manager symlinks are never materialized.
                    wanted = {node_prefix + "/bin/node", node_prefix + "/LICENSE"}
                    entries = [e for e in entries if e[0] in wanted]
                    need({e[0] for e in entries} == wanted and
                         all(not e[2] for e in entries), "NODE_PAYLOAD_MISSING")
                extract_entries(entries, destination)
        else:
            raise Refused("ARCHIVE_FORMAT_REFUSED")
    except BaseException:
        shutil.rmtree(destination)
        raise


def extract_entries(entries, root):
    for name, size, directory, reader, executable in entries:
        target = root.joinpath(*name.split("/"))
        if directory:
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            continue
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        need(not target.exists(), "ARCHIVE_PATH_COLLISION")
        count = 0
        with reader() as source, open(target, "xb") as out:
            while True:
                data = source.read(min(65536, size - count + 1))
                if not data:
                    break
                count += len(data)
                need(count <= size, "ARCHIVE_SIZE_MISMATCH")
                out.write(data)
        need(count == size, "ARCHIVE_SIZE_MISMATCH")
        os.chmod(target, 0o755 if executable else 0o644)


def clean_env():
    # No proxy/token/compiler/runtime injection inherited by child processes.
    keep = ("SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME",
            "USERPROFILE", "PATH", "LANG", "LC_ALL")
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env["PYTHONNOUSERSITE"] = "1"
    return env


def run(executable, args, cwd, timeout, env=None):
    """Bound both output files and elapsed time. No shell or success-on-timeout."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child = subprocess.Popen([str(executable), *map(str, args)], cwd=cwd,
                                 env=env or clean_env(), stdin=subprocess.DEVNULL,
                                 stdout=out, stderr=err)
        end = time.monotonic() + timeout
        try:
            while child.poll() is None:
                need(time.monotonic() < end, "TOOL_DEADLINE")
                need(os.fstat(out.fileno()).st_size <= MAX_EVIDENCE and
                     os.fstat(err.fileno()).st_size <= MAX_EVIDENCE, "TOOL_OUTPUT_LIMIT")
                try:
                    child.wait(timeout=min(0.05, max(0.001, end - time.monotonic())))
                except subprocess.TimeoutExpired:
                    pass
            need(child.returncode == 0, "TOOL_FAILED")
            need(time.monotonic() < end, "TOOL_DEADLINE")
            out.seek(0)
            err.seek(0)
            stdout, stderr = out.read(MAX_EVIDENCE + 1), err.read(MAX_EVIDENCE + 1)
            need(len(stdout) <= MAX_EVIDENCE and len(stderr) <= MAX_EVIDENCE,
                 "TOOL_OUTPUT_LIMIT")
            return stdout, stderr
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            # Direct child exit is observed, not an installed-runtime family witness.


def check_repository(repo, lock):
    repo = Path(repo).resolve(strict=True)
    builder = repo / "openbot/desktop/scripts/build-device-runtime.ts"
    raw = builder.read_bytes()
    gitblob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    need(gitblob == lock["builderBlob"], "BUILDER_SOURCE_CHANGED")
    cargo = repo / "openbot/desktop/src-tauri/Cargo.lock"
    raw = cargo.read_bytes()
    need(hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() ==
         lock["cargoLockBlob"], "CARGO_LOCK_CHANGED")
    head, _ = run("git", ["rev-parse", "HEAD"], repo, 5)
    tree, _ = run("git", ["rev-parse", "HEAD^{tree}"], repo, 5)
    status, _ = run("git", ["status", "--porcelain", "--untracked-files=no"], repo, 5)
    need(head.decode().strip() == lock["sourceSHA"] and
         tree.decode().strip() == lock["sourceTree"] and not status, "SOURCE_CHANGED")
    return repo, builder, cargo


def builder_inventory(bun, builder, root):
    code = ("const {memberFiles}=await import(process.argv[1]);"
            "const {createHash}=await import('node:crypto');"
            "const files=await memberFiles(process.argv[2]);"
            "process.stdout.write(JSON.stringify({files,treeSHA256:"
            "createHash('sha256').update(JSON.stringify(files)).digest('hex')}));")
    stdout, _ = run(bun, ["--no-env-file", "-e", code, str(builder), str(root)], builder.parent, 30)
    value = json.loads(stdout)
    need(set(value) == {"files", "treeSHA256"} and isinstance(value["files"], list),
         "INVENTORY_REFUSED")
    digest(value["treeSHA256"])
    return value


def verify_source(source, cache, lock, gpgv, rust_target):
    archive = cache / source["archive"]
    info = plain(archive)
    need(info == {"bytes": source["archiveBytes"], "sha256": source["archiveSHA256"]},
         "ARCHIVE_PIN_MISMATCH")
    verification = source["verification"]
    if verification["kind"] == "root-approved-official-digest":
        # This exact metadata object and digest must be independently reviewed in the approved lock.
        evidence = cache / (source["name"] + ".official-evidence")
        need(plain(evidence, MAX_EVIDENCE)["sha256"] == verification["evidenceSHA256"],
             "TRUST_EVIDENCE_MISMATCH")
        return
    need(gpgv is not None, "GPGV_MISSING")
    message, signature, keyring = [cache / verification[key]
                                  for key in ("message", "signature", "keyring")]
    for key, file in (("message", message), ("signature", signature), ("keyring", keyring)):
        need(plain(file, MAX_EVIDENCE)["sha256"] == verification[key + "SHA256"],
             "TRUST_EVIDENCE_MISMATCH")
    need(plain(gpgv)["sha256"] == digest(lock["gpgvSHA256"]), "GPGV_PIN_MISMATCH")
    with tempfile.TemporaryDirectory(prefix="d1-gpgv-") as home:
        args = ["--homedir", home, "--status-fd", "1", "--keyring", str(keyring)]
        if verification["signatureMode"] == "clearsigned":
            decoded = Path(home) / "message.txt"
            stdout, _ = run(gpgv, args + ["--output", str(decoded), str(signature)], cache, 30)
            need(plain(decoded, MAX_EVIDENCE)["sha256"] == verification["messageSHA256"],
                 "SIGNED_MESSAGE_MISMATCH")
        else:
            stdout, _ = run(gpgv, args + [str(signature), str(message)], cache, 30)
    need(not any(("[GNUPG:] " + status + " ") in stdout.decode("ascii", "strict")
                 for status in ("BADSIG", "ERRSIG", "REVKEYSIG", "EXPKEYSIG", "EXPSIG")),
         "SIGNATURE_REFUSED")
    valid = [line.split() for line in stdout.decode("ascii", "strict").splitlines()
             if line.startswith("[GNUPG:] VALIDSIG ")]
    expected = verification["signerFingerprint"]
    need(len(valid) == 1 and (valid[0][2] == expected or valid[0][-1] == expected),
         "SIGNER_MISMATCH")
    content = message.read_bytes()
    if verification["binding"] == "sha256-list":
        matches = [line.split() for line in content.decode("utf-8").splitlines()
                   if len(line.split()) == 2 and
                   line.split()[1].lstrip("*") == source["archive"]]
        need(len(matches) == 1 and matches[0][0] == source["archiveSHA256"],
             "SIGNED_DIGEST_MISMATCH")
    else:
        import tomllib
        manifest = tomllib.loads(content.decode("utf-8"))
        item = manifest["pkg"][source["name"]]["target"][rust_target]
        need(item["available"] is True and item["xz_url"] == source["url"] and
             item["xz_hash"] == source["archiveSHA256"] and
             manifest["pkg"]["rust"]["version"].split()[0] == "1.94.0",
             "RUST_MANIFEST_MISMATCH")


def materialize(sources, cache, out):
    selected = {}
    for source in sources:
        extracted = out / ("unpacked-" + source["name"])
        before = plain(cache / source["archive"])
        extract_archive(cache / source["archive"], extracted, source["kind"],
                        source["prefix"] if source["name"] == "node" and
                        source["kind"] == "tar.xz" else None)
        need(plain(cache / source["archive"]) == before, "FILE_CHANGED")
        prefix = extracted.joinpath(*safe_name(source["prefix"]).split("/"))
        need(prefix.is_dir() and not prefix.is_symlink(), "ARCHIVE_PREFIX_MISSING")
        selected[source["name"]] = prefix
    return selected


def merge_rust(selected, rust_root):
    rust_root.mkdir()
    for name in ("rustc", "cargo", "rust-std"):
        for path in sorted(selected[name].rglob("*")):
            relative = path.relative_to(selected[name])
            # The component installer map is retained in the original unpacked tree.
            # It is not an installed compiler payload member.
            if relative.as_posix() == "manifest.in":
                continue
            target = rust_root / relative
            need(not path.is_symlink(), "RESOURCE_ALIAS_REFUSED")
            if path.is_dir():
                need(not target.exists() or target.is_dir(), "RUST_COMPONENT_COLLISION")
                target.mkdir(parents=True, exist_ok=True)
            else:
                need(not target.exists(), "RUST_COMPONENT_COLLISION")
                info = plain(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
                os.chmod(target, 0o755 if path.stat().st_mode & 0o111 else 0o644)
                need(plain(target) == info and plain(path) == info, "FILE_CHANGED")
    return rust_root


def propose(lock, platform, cache, out, repo, inventory_bun, inventory_pin, vendor=None, crate_cache=None):
    sources = source_list(lock, platform)
    repo, builder, cargo_lock = check_repository(repo, lock)
    # An independently approved build-side Bun is not the just-downloaded archive.
    need(plain(inventory_bun)["sha256"] == digest(inventory_pin), "INVENTORY_RUNTIME_REFUSED")
    cache.mkdir(mode=0o700)
    observations = []
    downloaded = 0
    for source in sources:
        need(downloaded < MAX_DOWNLOAD, "DOWNLOAD_LIMIT")
        maximum = min(MAX_ARCHIVE, MAX_DOWNLOAD - downloaded)
        observation = (fetch_github_source(source, cache / source["archive"], maximum, lock)
                       if source["name"] == "bun" else
                       fetch(source["url"], cache / source["archive"], maximum,
                             approved_source_url(source["name"], platform)))
        downloaded += observation["bytes"]
        if source["archiveSHA256"] is not None:
            need(observation["sha256"] == source["archiveSHA256"], "ARCHIVE_PIN_MISMATCH")
        if source["archiveBytes"] is not None:
            need(observation["bytes"] == source["archiveBytes"], "ARCHIVE_SIZE_MISMATCH")
        observations.append({"name": source["name"], "url": source["url"], **observation})
    selected = materialize(sources, cache, out)
    for item, source in zip(observations, sources):
        item["binary"] = (plain(selected[source["name"]].joinpath(
            *safe_name(source["binary"]).split("/"))) if source["binary"] else None)
    rust_root = merge_rust(selected, out / "rust")
    inventories = {"chromium": builder_inventory(inventory_bun, builder, selected["chromium"]),
                   "rust": builder_inventory(inventory_bun, builder, rust_root)}
    if vendor is not None:
        validate_vendor(Path(vendor), cargo_lock, crate_cache)
        inventories["vendor"] = builder_inventory(inventory_bun, builder, Path(vendor))
    # This is a recipe for a separately approved build-input operation, not execution.
    cargo_name = "cargo.exe" if platform.startswith("windows") else "cargo"
    return write_json(out / "toolchain-proposal.json", {
        "schema": "device-toolchain-proposal-v1", "status": "PROPOSED_NOT_APPROVED",
        "sourceSHA": lock["sourceSHA"], "platform": platform, "observations": observations,
        "inventories": inventories, "cargoLock": plain(cargo_lock),
        "vendorPreparationRecipe": {
            "executable": str(rust_root / "bin" / cargo_name),
            "args": ["vendor", "--locked", "--versioned-dirs", "<NEW_OWNED_VENDOR_ROOT>"],
            "cwd": str(cargo_lock.parent), "executed": False},
        "signatureVerification": "NOT_RUN", "builderInputs": None,
        "downloadedToolsExecuted": False, "deviceAcceptance": "NOT_RUN"})


def copy_regular_tree(source, destination):
    need(not destination.exists(), "OUTPUT_EXISTS")
    destination.mkdir()
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        need(not path.is_symlink(), "RESOURCE_ALIAS_REFUSED")
        target = destination / relative
        if path.is_dir():
            target.mkdir(exist_ok=True)
        else:
            info = plain(path)
            shutil.copyfile(path, target)
            os.chmod(target, 0o755 if path.stat().st_mode & 0o111 else 0o644)
            need(plain(target) == info and plain(path) == info, "FILE_CHANGED")


def consume(lock, platform, cache, out, repo, gpgv, vendor, crate_cache):
    sources = complete_lock(lock, platform)  # Before invoking any downloaded executable.
    repo, builder, cargo_lock = check_repository(repo, lock)
    need(plain(cargo_lock)["sha256"] == lock["cargoLockSHA256"], "CARGO_LOCK_CHANGED")
    for source in sources:
        verify_source(source, cache, lock, gpgv, lock["platforms"][platform]["rustTarget"])
    selected = materialize(sources, cache, out)
    binaries = {}
    for name in ("bun", "node", "rustc", "cargo"):
        source = next(s for s in sources if s["name"] == name)
        file = selected[name].joinpath(*safe_name(source["binary"]).split("/"))
        info = plain(file)
        need(info["sha256"] == source["binarySHA256"], "BINARY_PIN_MISMATCH")
        os.chmod(file, 0o755)
        binaries[name] = file
    rust_root = merge_rust(selected, out / "rust")
    for name in ("rustc", "cargo"):
        source = next(s for s in sources if s["name"] == name)
        binaries[name] = rust_root.joinpath(*safe_name(source["binary"]).split("/"))
        need(plain(binaries[name])["sha256"] == source["binarySHA256"], "BINARY_PIN_MISMATCH")
    chromium = selected["chromium"]
    source = next(s for s in sources if s["name"] == "chromium")
    chrome = chromium.joinpath(*safe_name(source["binary"]).split("/"))
    need(plain(chrome)["sha256"] == source["binarySHA256"], "BINARY_PIN_MISMATCH")
    os.chmod(chrome, 0o755)
    bun = binaries["bun"]
    inventories = {}
    for name, root in (("chromium", chromium), ("rust", rust_root)):
        inventories[name] = builder_inventory(bun, builder, root)
        need(inventories[name]["treeSHA256"] ==
             lock["platforms"][platform][name + "TreeSHA256"], "TREE_PIN_MISMATCH")
    vendor_root = out / "vendor"
    copy_regular_tree(Path(vendor).resolve(strict=True), vendor_root)
    vendored = builder_inventory(bun, builder, vendor_root)
    need(vendored["treeSHA256"] == lock["platforms"][platform]["vendorTreeSHA256"],
         "VENDOR_PIN_MISMATCH")
    validate_vendor(vendor_root, cargo_lock, crate_cache)
    cargo_home = out / "cargo-home"
    cargo_home.mkdir()
    # JSON string quoting is also a valid TOML basic string for these canonical paths.
    config = ('[source.crates-io]\nreplace-with = "vendored-sources"\n'
              '[source.vendored-sources]\ndirectory = ' +
              json.dumps(str(vendor_root)) + '\n[net]\noffline = true\n')
    (cargo_home / "config.toml").write_text(config, encoding="utf-8")
    for name, expected in (("bun", "1.3.14"), ("node", "v22.14.0")):
        stdout, _ = run(binaries[name], ["--version"], out, 5)
        need(stdout.decode().strip() == expected, "TOOL_VERSION_MISMATCH")
    rustc, _ = run(binaries["rustc"], ["-vV"], out, 5)
    cargo, _ = run(binaries["cargo"], ["--version", "--verbose"], out, 5)
    need(rustc.decode().startswith("rustc 1.94.0 ") and
         ("\nhost: " + lock["platforms"][platform]["rustTarget"] + "\n") in rustc.decode() and
         ("\ncommit-hash: " + lock["rustCommit"] + "\n") in rustc.decode() and
         cargo.decode().startswith("cargo 1.94.0 "), "RUST_VERSION_MISMATCH")
    # Recheck bytes and original inventories after probes, before issuing builder data.
    for name in ("bun", "node", "cargo", "rustc"):
        source = next(s for s in sources if s["name"] == name)
        need(plain(binaries[name])["sha256"] == source["binarySHA256"], "FILE_CHANGED")
    for name, root in (("chromium", chromium), ("rust", rust_root), ("vendor", vendor_root)):
        expected = vendored if name == "vendor" else inventories[name]
        need(builder_inventory(bun, builder, root) == expected, "FILE_CHANGED")
    check_repository(repo, lock)
    flags = {}
    for name in ("bun", "node", "cargo", "rustc"):
        flags["--" + name] = str(binaries[name])
        flags["--" + name + "-sha256"] = plain(binaries[name])["sha256"]
    flags.update({"--chromium-root": str(chromium), "--chromium-executable": source_list(lock, platform)[2]["binary"],
                  "--chromium-sha256": plain(chrome)["sha256"],
                  "--chromium-tree-sha256": inventories["chromium"]["treeSHA256"]})
    return write_json(out / "device-toolchain-inputs.json", {
        "schema": "device-toolchain-inputs-v1", "scope": "BUILD_INPUTS_ONLY",
        "sourceSHA": lock["sourceSHA"], "platform": platform, "flags": flags,
        "environment": {"CARGO_HOME": str(cargo_home), "RUSTC": str(binaries["rustc"]),
                        "PATHPrefix": str(rust_root / "bin")},
        "inventories": {"chromium": inventories["chromium"], "rust": inventories["rust"],
                        "vendor": vendored}, "d2Inputs": None, "builderInvoked": False,
        "installationProtection": "NOT_VERIFIED", "deviceAcceptance": "NOT_RUN",
        "processFamilyClosure": "NOT_ATTESTED"})


def validate_vendor(root, lockfile, crate_cache):
    import tomllib
    need(crate_cache is not None, "CRATE_CACHE_MISSING")
    crate_cache = Path(crate_cache)
    value = tomllib.loads(Path(lockfile).read_text(encoding="utf-8"))
    required = {}
    for package in value["package"]:
        source = package.get("source")
        if source is None:
            continue
        need(source == "registry+https://github.com/rust-lang/crates.io-index",
             "VENDOR_GIT_SOURCE_NOT_QUALIFIED")
        required[(package["name"], package["version"])] = digest(package.get("checksum"))
    actual = {}
    for directory in root.iterdir():
        need(directory.is_dir() and not directory.is_symlink(), "VENDOR_LAYOUT_REFUSED")
        package = tomllib.loads((directory / "Cargo.toml").read_text(encoding="utf-8"))["package"]
        key = (package["name"], package["version"])
        need(key in required and key not in actual, "VENDOR_PACKAGE_MISMATCH")
        checksums, _ = read_json(directory / ".cargo-checksum.json")
        need(checksums.get("package") == required[key] and
             isinstance(checksums.get("files"), dict), "VENDOR_CHECKSUM_MISMATCH")
        actual_files = {p.relative_to(directory).as_posix() for p in directory.rglob("*")
                        if p.is_file() and p.relative_to(directory).as_posix() != ".cargo-checksum.json"}
        need(actual_files == set(checksums["files"]), "VENDOR_MEMBER_MISMATCH")
        for name, expected in checksums["files"].items():
            file = directory.joinpath(*safe_name(name).split("/"))
            need(plain(file)["sha256"] == digest(expected), "VENDOR_CHECKSUM_MISMATCH")
        archive = crate_cache / (key[0] + "-" + key[1] + ".crate")
        need(plain(archive)["sha256"] == required[key], "CRATE_PIN_MISMATCH")
        with tempfile.TemporaryDirectory(prefix="d1-crate-check-") as temp:
            unpacked = Path(temp) / "unpacked"
            extract_archive(archive, unpacked, "tar.gz")
            children = list(unpacked.iterdir())
            need(len(children) == 1 and children[0].is_dir() and
                 children[0].name == key[0] + "-" + key[1], "CRATE_LAYOUT_REFUSED")
            payload = children[0]
            original_files = {p.relative_to(payload).as_posix() for p in payload.rglob("*")
                              if p.is_file()}
            need(original_files == actual_files, "CRATE_MEMBER_MISMATCH")
            for name in original_files:
                need(plain(payload.joinpath(*safe_name(name).split("/"))) ==
                     plain(directory.joinpath(*safe_name(name).split("/"))),
                     "CRATE_CONTENT_MISMATCH")
        need(plain(archive)["sha256"] == required[key], "FILE_CHANGED")
        actual[key] = True
    need(set(actual) == set(required), "VENDOR_PACKAGE_MISSING")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("propose", "consume"))
    parser.add_argument("--lock", required=True)
    parser.add_argument("--lock-sha256", required=True)
    parser.add_argument("--platform", choices=("linux-x86_64", "windows-x86_64"), required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--cache")
    parser.add_argument("--repository", "--repo", dest="repo",
                        help="clean frozen C81 input checkout; producer carrier is separate")
    parser.add_argument("--gpgv")
    parser.add_argument("--vendor")
    parser.add_argument("--crate-cache")
    parser.add_argument("--inventory-bun")
    parser.add_argument("--inventory-bun-sha256")
    args = parser.parse_args()
    lock, info = read_json(args.lock, args.lock_sha256)
    source_list(lock, args.platform)
    if args.operation == "consume":
        complete_lock(lock, args.platform)  # Null pins fail before output or process creation.
        need(args.cache and args.repo and args.vendor and args.crate_cache, "CONSUME_INPUT_MISSING")
    if args.operation == "propose":
        need(args.repo and args.inventory_bun and args.inventory_bun_sha256,
             "INVENTORY_RUNTIME_MISSING")
    out = Path(args.out)
    need(out.is_absolute() and not out.exists() and not out.is_symlink(), "OUTPUT_EXISTS")
    parent = out.parent.resolve(strict=True)
    need(parent == out.parent and parent.is_dir(), "OUTPUT_PARENT_REFUSED")
    out.mkdir(mode=0o700)
    try:
        if args.operation == "propose":
            receipt = propose(lock, args.platform, out / "archives", out, args.repo,
                              args.inventory_bun, args.inventory_bun_sha256, args.vendor, args.crate_cache)
        else:
            receipt = consume(lock, args.platform, Path(args.cache).resolve(strict=True),
                              out, args.repo, args.gpgv, args.vendor, args.crate_cache)
        print(json.dumps({"schema": "d1-producer-result-v1", "operation": args.operation,
                          "platform": args.platform, "receipt": receipt,
                          "builderInvoked": False, "deviceAcceptance": "NOT_RUN"}))
    except BaseException:
        # Keep failed evidence quarantined; it cannot be accepted as a successful inputs receipt.
        # Do not unlink or overwrite any caller-owned cache, repository, or older output.
        try:
            write_json(out / "FAILED.json", {"schema": "d1-producer-failed-v1",
                                           "status": "FAILED", "builderInvoked": False})
        except (OSError, Refused):
            pass
        raise


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error.args[0] if isinstance(error, Refused) else "D1_PRODUCER_FAILED",
              file=__import__("sys").stderr)
        raise SystemExit(1)
