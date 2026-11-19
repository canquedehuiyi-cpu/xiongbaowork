"""Archive/trust regressions for D1. These tests perform no network or tool execution."""
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("d1_producer", HERE / "produce-device-toolchain.py")
D1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D1)


class ProducerThreatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def archive(self, entries):
        target = self.root / "input.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as z:
            for name, data in entries:
                z.writestr(name, data)
        return target

    def refused(self, archive, kind="zip", **options):
        out = self.root / "out"
        with self.assertRaises((D1.Refused, zipfile.BadZipFile)):
            D1.extract_archive(archive, out, kind, **options)
        self.assertFalse(out.exists())
        return out

    def test_ordinary_payload_is_preserved_and_output_is_never_overwritten(self):
        archive = self.archive([("tool/bin/run", b"ordinary"), ("tool/LICENSE", b"license")])
        out = self.root / "out"
        D1.extract_archive(archive, out, "zip")
        self.assertEqual((out / "tool/bin/run").read_bytes(), b"ordinary")
        with self.assertRaisesRegex(D1.Refused, "OUTPUT_EXISTS"):
            D1.extract_archive(archive, out, "zip")
        self.assertEqual((out / "tool/LICENSE").read_bytes(), b"license")

    def test_traversal_case_alias_and_file_parent_refuse_without_escape(self):
        for index, entries in enumerate((
                [("../escape", b"x")],
                [("tool/A", b"x"), ("tool/a", b"y")],
                [("tool", b"x"), ("tool/child", b"y")],
                [("tool/child", b"y"), ("tool", b"x")],
                [("CON.txt", b"x")])):
            with self.subTest(index=index):
                archive = self.archive(entries)
                self.refused(archive)
                archive.unlink()
        self.assertFalse((self.root.parent / "escape").exists())

    def test_zip_symbolic_link_is_not_materialized(self):
        archive = self.root / "input.zip"
        link = zipfile.ZipInfo("tool/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr(link, "../escape")
        self.refused(archive)

    def test_corrupt_payload_fails_crc_and_removes_partial_output(self):
        archive = self.archive([("tool/run", b"payload")])
        raw = bytearray(archive.read_bytes())
        name_size, extra_size = struct.unpack_from("<HH", raw, 26)
        raw[30 + name_size + extra_size] ^= 1
        archive.write_bytes(raw)
        self.refused(archive)

    def test_local_central_name_disagreement_is_rejected(self):
        archive = self.archive([("tool/run", b"payload")])
        raw = bytearray(archive.read_bytes())
        raw[30] = ord("X")
        archive.write_bytes(raw)
        self.refused(archive)

    def test_member_expansion_cap_is_checked_before_writing_payload(self):
        archive = self.archive([("tool/run", b"123456")])
        with patch.object(D1, "MAX_EXPANDED", 5):
            self.refused(archive)

    def tar(self, names):
        archive = self.root / "input.tar.xz"
        with tarfile.open(archive, "w:xz") as t:
            for name, kind, data in names:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind == tarfile.SYMTYPE:
                    member.linkname = data
                    t.addfile(member)
                else:
                    member.size = len(data)
                    t.addfile(member, io.BytesIO(data))
        return archive

    def test_tar_alias_refuses_by_default(self):
        archive = self.tar([("tool/bin/node", tarfile.REGTYPE, b"node"),
                            ("tool/bin/npm", tarfile.SYMTYPE, "../lib/npm.js")])
        self.refused(archive, "tar.xz")

    def test_node_selected_payload_never_materializes_package_manager_alias(self):
        archive = self.tar([("node/bin/node", tarfile.REGTYPE, b"node"),
                            ("node/LICENSE", tarfile.REGTYPE, b"original license"),
                            ("node/bin/npm", tarfile.SYMTYPE, "../lib/npm.js")])
        out = self.root / "out"
        D1.extract_archive(archive, out, "tar.xz", node_prefix="node")
        self.assertEqual((out / "node/bin/node").read_bytes(), b"node")
        self.assertFalse((out / "node/bin/npm").exists())
        self.assertEqual((out / "node/LICENSE").read_bytes(), b"original license")

    def test_node_alias_cannot_replace_selected_binary(self):
        archive = self.tar([("node/bin/node", tarfile.SYMTYPE, "../outside"),
                            ("node/LICENSE", tarfile.REGTYPE, b"license")])
        self.refused(archive, "tar.xz", node_prefix="node")

    def test_initial_url_is_bound_to_exact_reviewed_origin_path_and_query(self):
        approved = D1.approved_source_url("node", "linux-x86_64")
        self.assertEqual(D1.check_url(approved, approved), approved)
        for changed in (
                approved.replace("/v22.14.0/", "/v22.15.0/"),
                approved.replace("node-v22.14.0-linux-x64", "node-v22.14.0-linux-arm64"),
                approved + "?alternate=1",
                approved.replace("/dist/", "/arbitrary/"),
                approved.replace("nodejs.org", "github.com")):
            with self.subTest(url=changed), self.assertRaises(D1.Refused):
                D1.check_url(changed, approved)

    def test_lock_cannot_expand_fixed_source_identity_to_other_repo_or_version(self):
        lock = json.loads((HERE / "device-toolchain-sources.json").read_text())
        for platform in ("linux-x86_64", "windows-x86_64"):
            D1.source_list(lock, platform)
            for name, old, new in (
                    ("bun", "/oven-sh/bun/", "/other/repository/"),
                    ("bun", "/bun-v1.3.14/", "/bun-v1.3.15/"),
                    ("chromium", "/151.0.7922.34/", "/151.0.7922.35/"),
                    ("rustc", "rustc-1.94.0-", "rustc-1.95.0-")):
                changed = json.loads(json.dumps(lock))
                source = next(s for s in changed["platforms"][platform]["sources"]
                              if s["name"] == name)
                source["url"] = source["url"].replace(old, new)
                with self.subTest(platform=platform, name=name, changed=new):
                    with self.assertRaises(D1.Refused):
                        D1.source_list(changed, platform)

    def test_redirect_cannot_cross_asset_version_repo_or_unbound_cdn_path(self):
        approved = D1.approved_source_url("bun", "linux-x86_64")
        request = D1.urllib.request.Request(approved)
        for target in (
                approved.replace("bun-linux-x64-baseline.zip", "bun-windows-x64-baseline.zip"),
                approved.replace("/bun-v1.3.14/", "/bun-v1.3.15/"),
                approved.replace("/oven-sh/bun/", "/other/repository/"),
                "https://release-assets.githubusercontent.com/opaque/bun-linux-x64-baseline.zip",
                "https://objects.githubusercontent.com/opaque/bun-linux-x64-baseline.zip",
                "https://playwright.download.prss.microsoft.com/opaque/chrome-linux64.zip",
                approved + "?asset=other"):
            handler = D1.Redirects(approved)
            with self.subTest(target=target), self.assertRaisesRegex(
                    D1.Refused, "SOURCE_UNAVAILABLE"):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        # Even the correct target cannot launder a request that started on another URL.
        changed_request = D1.urllib.request.Request(approved.replace("/oven-sh/", "/other/"))
        with self.assertRaisesRegex(D1.Refused, "SOURCE_UNAVAILABLE"):
            D1.Redirects(approved).redirect_request(
                changed_request, None, 302, "Found", {}, approved)

    def test_same_exact_url_redirect_retains_identity_and_still_has_hop_cap(self):
        approved = D1.approved_source_url("chromium", "linux-x86_64")
        handler = D1.Redirects(approved)
        request = D1.urllib.request.Request(approved)
        for _ in range(5):
            redirected = handler.redirect_request(request, None, 302, "Found", {}, approved)
            self.assertEqual(redirected.full_url, approved)
        with self.assertRaisesRegex(D1.Refused, "SOURCE_REDIRECT_REFUSED"):
            handler.redirect_request(request, None, 302, "Found", {}, approved)

    def asset(self):
        lock = json.loads((HERE / "device-toolchain-sources.json").read_text())
        asset = lock["githubReleaseAssets"]["assets"]["bun-linux-x64-baseline.zip"]
        release = {"id": 320260981, "tag_name": "bun-v1.3.14",
                   "target_commitish": "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
                   "assets": [dict(asset)]}
        return lock, release, dict(asset)

    def test_release_membership_and_full_asset_tuple_cannot_be_substituted(self):
        lock, release, asset = self.asset()
        self.assertEqual(D1.checked_github_asset(release, asset, lock, asset["name"]), asset)
        for field, value in (("id", 418774449), ("name", "other.zip"),
                             ("digest", "sha256:" + "0" * 64), ("size", asset["size"] + 1)):
            changed = dict(asset)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(D1.Refused):
                D1.checked_github_asset(release, changed, lock, asset["name"])
        release["assets"] = []
        with self.assertRaises(D1.Refused):
            D1.checked_github_asset(release, asset, lock, asset["name"])

    def test_asset_location_is_single_use_request_bound_and_never_host_wide(self):
        _, _, asset = self.asset()
        url = ("https://release-assets.githubusercontent.com/"
               "github-production-release-asset/357728969/opaque?signature=synthetic")
        cap = D1.AssetLocation(asset)
        self.assertEqual(cap.accept(asset["browser_download_url"], 302, [url]), url)
        with self.assertRaises(D1.Refused):
            cap.consume(url.replace("opaque", "other"))
        cap.consume(url)
        with self.assertRaises(D1.Refused):
            cap.consume(url)
        for request, locations in (
                (asset["browser_download_url"].replace("baseline", "other"), [url]),
                (asset["browser_download_url"], [url, url]),
                (asset["browser_download_url"], [url.replace("/357728969/", "/123/")]),
                (asset["browser_download_url"], [url.replace("https:", "http:")]),
                (asset["browser_download_url"], [url.replace("opaque", "%2e%2e/other")])):
            with self.subTest(request=request, locations=locations), self.assertRaises(D1.Refused):
                D1.AssetLocation(asset).accept(request, 302, locations)

    def test_asset_download_checks_bytes_digest_and_refuses_second_redirect(self):
        from email.message import Message
        class Response:
            def __init__(self, status, raw=b"", location=None):
                self.status, self.stream = status, io.BytesIO(raw)
                self.headers = Message()
                if location:
                    self.headers["Location"] = location
            def getheader(self, key, default=None):
                return self.headers.get(key, default)
            def read(self, size):
                return self.stream.read(size)
        class Net:
            def __init__(self, responses):
                self.responses, self.urls, self.released = iter(responses), [], []
                self.deadline = D1.time.monotonic() + 5
            def request(self, url):
                self.urls.append(url)
                return object(), next(self.responses)
            def release(self, connection, response):
                self.released.append(connection)
        _, _, asset = self.asset()
        expected = dict(asset, size=7, digest="sha256:" + D1.sha(b"payload"))
        location = ("https://release-assets.githubusercontent.com/"
                    "github-production-release-asset/357728969/only-this?signature=synthetic")
        net = Net([Response(302, location=location), Response(200, b"payload")])
        result = D1.download_asset(net, expected, self.root / "good", 7)
        self.assertEqual(result, {"bytes": 7, "sha256": D1.sha(b"payload")})
        self.assertEqual(net.urls, [expected["browser_download_url"], location])
        self.assertEqual(len(net.released), 2)
        self.assertNotIn("signature", json.dumps(result))
        for name, response in (
                ("second-hop", Response(302, location=location + "&next=1")),
                ("bad-sha", Response(200, b"changed")),
                ("short", Response(200, b"x"))):
            net = Net([Response(302, location=location), response])
            with self.subTest(name=name), self.assertRaises(D1.Refused):
                D1.download_asset(net, expected, self.root / name, 7)
            self.assertEqual(len(net.urls), 2)
            self.assertEqual(len(net.released), 2)

    def test_wire_caps_include_headers_before_parser_and_accumulate_body(self):
        budget = D1.SourceHTTP(D1.time.monotonic() + 5, 8)
        reader = D1.WireReader(io.BytesIO(b"1234\n5678"), budget)
        self.assertEqual(reader.readline(), b"1234\n")
        with self.assertRaisesRegex(D1.Refused, "HTTP_BYTE_LIMIT"):
            reader.read(4)
        self.assertEqual(budget.received, 9)
        reader = D1.WireReader(io.BytesIO(b"x" * 16385), D1.SourceHTTP(
            D1.time.monotonic() + 5, 32768))
        with self.assertRaisesRegex(D1.Refused, "HTTP_HEADER_LIMIT"):
            reader.readline()

    def test_corrupt_local_asset_identity_refuses_before_any_transport_or_request(self):
        lock = json.loads((HERE / "device-toolchain-sources.json").read_text())
        source = next(s for s in lock["platforms"]["linux-x86_64"]["sources"]
                      if s["name"] == "bun")
        name = source["archive"]
        self.assertEqual(D1.pinned_github_source(source, lock),
                         lock["githubReleaseAssets"]["assets"][name])
        mutations = (
            ("asset-url", "url", "https://example.invalid/never-request"),
            ("asset-id", "id", 418774449),
            ("asset-name", "name", "bun-windows-x64-baseline.zip"),
            ("asset-digest", "digest", "sha256:" + "0" * 64),
            ("directory-owner", "repository", "other/repository"),
            ("source-url", "url", "https://example.invalid/never-request"),
            ("source-size", "archiveBytes", source["archiveBytes"] + 1),
            ("source-hash", "archiveSHA256", "0" * 64),
        )
        for label, field, value in mutations:
            changed = json.loads(json.dumps(lock))
            changed_source = dict(source)
            target = (changed_source if label.startswith("source-") else
                      changed["githubReleaseAssets"] if label == "directory-owner" else
                      changed["githubReleaseAssets"]["assets"][name])
            target[field] = value
            with self.subTest(label=label), patch.object(D1, "SourceHTTP") as transport:
                with self.assertRaises(D1.Refused):
                    D1.fetch_github_source(changed_source, self.root / label, D1.MAX_ARCHIVE, changed)
                transport.assert_not_called()
                self.assertFalse((self.root / label).exists())

    def test_current_metadata_lock_refuses_consume_before_any_process_or_output(self):
        lock = json.loads((HERE / "device-toolchain-sources.json").read_text())
        out = self.root / "never-created"
        for platform in ("linux-x86_64", "windows-x86_64"):
            with self.subTest(platform=platform), patch.object(D1, "run") as run:
                with self.assertRaises(D1.Refused):
                    D1.consume(lock, platform, self.root, out, self.root, None,
                               self.root, self.root)
                run.assert_not_called()
                self.assertFalse(out.exists())

    def test_vendor_package_hash_cannot_be_faked_by_checksum_json(self):
        vendor = self.root / "vendor"
        package = vendor / "example-1.0.0"
        package.mkdir(parents=True)
        cargo = b'[package]\nname="example"\nversion="1.0.0"\n'
        (package / "Cargo.toml").write_bytes(cargo)
        checksum = "0" * 64
        (package / ".cargo-checksum.json").write_text(json.dumps({
            "package": checksum, "files": {"Cargo.toml": D1.sha(cargo)}}))
        lock = self.root / "Cargo.lock"
        lock.write_text('version=3\n[[package]]\nname="example"\nversion="1.0.0"\n'
                        'source="registry+https://github.com/rust-lang/crates.io-index"\n'
                        'checksum="' + checksum + '"\n')
        cache = self.root / "crates"
        cache.mkdir()
        (cache / "example-1.0.0.crate").write_bytes(b"not the locked crate")
        with self.assertRaisesRegex(D1.Refused, "CRATE_PIN_MISMATCH"):
            D1.validate_vendor(vendor, lock, cache)


if __name__ == "__main__":
    unittest.main()
