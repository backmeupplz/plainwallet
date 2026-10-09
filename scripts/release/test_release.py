import base64
import hashlib
import subprocess
from contextlib import redirect_stdout
from urllib.parse import parse_qs, urlparse
import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import zipfile
import xml.etree.ElementTree as ET

import submit

ROOT = Path(__file__).resolve().parents[2]

from build import release_version, validate_manifest, validate_android, archive
from submit import Journal, preflight, chrome, firefox, play, request, APIError, signed_bundle
from report import outcomes

META = {"version": "0.2.3", "versionCode": 203, "sha": "a" * 40, "releaseId": 1}
EVENT = {"action": "published", "release": {"draft": False, "prerelease": False, "tag_name": "v0.2.3", "id": 1}}
ENV = {"GOOGLE_ACCESS_TOKEN": "fake", "CHROME_PUBLISHER_ID": "publisher", "CHROME_ITEM_ID": "pmnbalegifiefmohkolfpclnmkooifcp", "AMO_ADDON_ID": "plainwallet@backmeupplz", "AMO_JWT_ISSUER": "fixture", "AMO_JWT_SECRET": "not-a-real-secret", "PLAY_TRACK": "production"}


class MemoryJournal(Journal):
    def __init__(self, store="fixture"):
        self.assets = {}
        self.store = store
    def read(self, name):
        return self.assets.get(name)
    def put(self, name, value):
        if name in self.assets:
            raise ValueError("duplicate journal entry")
        self.assets[name] = value


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        Path("release-out").mkdir()
        for name in ("chrome.zip", "firefox.zip", "firefox-source.zip", "android.aab"):
            Path("release-out", name).write_bytes(b"synthetic artifact")
    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def test_stable_release_only_and_version_binding(self):
        self.assertEqual(release_version(EVENT, {"version": "0.2.3"}, "a" * 40), META)
        for field, value in (("draft", True), ("prerelease", True), ("tag_name", "v0.2.4")):
            event = copy.deepcopy(EVENT)
            event["release"][field] = value
            with self.assertRaises(ValueError):
                release_version(event, {"version": "0.2.3"}, "a" * 40)
        for v in ("0.2.100", "0.100.1", "0.2.3-beta", "00.2.3", "0.0.0"):
            with self.assertRaises(ValueError):
                release_version(EVENT, {"version": v}, "a" * 40)
        with self.assertRaises(ValueError):
            release_version({**EVENT, "action": "edited"}, {"version": "0.2.3"}, "a" * 40)

    def test_manifest_version_and_identity(self):
        manifest = {"version": "0.2.3", "manifest_version": 3, "browser_specific_settings": {"gecko": {"id": "plainwallet@backmeupplz"}}}
        validate_manifest(manifest, "0.2.3", "firefox")
        with self.assertRaises(ValueError):
            validate_manifest(manifest, "0.2.4", "firefox")
        manifest["browser_specific_settings"]["gecko"]["id"] = "different"
        with self.assertRaises(ValueError):
            validate_manifest(manifest, "0.2.3", "firefox")

    def test_android_metadata_checksums_and_strict_verification(self):
        # Maven Central provenance and published sidecars: docs/STORE_RELEASE.md.
        metadata = ET.parse(ROOT / "android/gradle/verification-metadata.xml")
        ns = {"v": "https://schema.gradle.org/dependency-verification"}
        self.assertEqual(metadata.findtext("v:configuration/v:verify-metadata", namespaces=ns), "true")
        self.assertIsNone(metadata.find("v:configuration/v:trusted-artifacts", ns))
        expected = [
            ("com.google.guava", "guava-parent", "33.4.0-jre", "pom", "3a499ed34a0d9ee0f1bcc39230021a1cd4e2f7dd0426ab6844f585465d41dcd7"),
            ("org.apache.groovy", "groovy-bom", "4.0.29", "pom", "c24277dec93f146bcda25f5ae4391d6527e384e2132efa32184c1e852b42bca9"),
            ("org.junit", "junit-bom", "5.10.2", "module", "de23b114b3e4119a8fe6eb17bed5a3852816698bace67071579d6d927ebb080a"),
            ("org.junit", "junit-bom", "5.11.0-M2", "module", "86477abcf490d6ca059aa9973cb108d22a506f49d1a5569bb32cc6cbf43c2cce"),
        ]
        for group, name, version, extension, digest in expected:
            with self.subTest(group=group, name=name, version=version):
                path = f"v:components/v:component[@group='{group}'][@name='{name}'][@version='{version}']/v:artifact[@name='{name}-{version}.{extension}']"
                artifacts = metadata.findall(path, ns)
                self.assertEqual(len(artifacts), 1)
                checksums = list(artifacts[0])
                self.assertEqual(len(checksums), 1)
                self.assertEqual(checksums[0].tag, "{" + ns["v"] + "}sha256")
                self.assertEqual(checksums[0].get("value"), digest)
                self.assertEqual(list(checksums[0]), [])  # No alternate accepted hashes.
        workflow = (ROOT / ".github/workflows/store-release.yml").read_text()
        self.assertIn("./gradlew --no-daemon --dependency-verification strict bundleRelease", workflow)
        self.assertNotRegex(workflow, r"--dependency-verification[ =]+(?:off|lenient)\b")
        self.assertNotIn("--write-verification-metadata", workflow)

    def test_android_binary_manifest(self):
        def varint(n):
            out = b""
            while n > 127:
                out += bytes([(n & 127) | 128])
                n >>= 7
            return out + bytes([n])
        def field(n, data):
            if isinstance(data, str):
                data = data.encode()
            return varint(n * 8 + 2) + varint(len(data)) + data
        element = field(3, "manifest")
        for name, value in (("package", "com.borodutch.plainwallet"), ("versionName", "0.2.3"), ("versionCode", "203")):
            attr = field(2, name) + field(3, value)
            if name != "package":
                attr += field(1, "http://schemas.android.com/apk/res/android")
            element += field(4, attr)
        validate_android(field(1, element), META)
        with self.assertRaises(ValueError):
            validate_android(field(1, element), {**META, "versionCode": 204})
        with self.assertRaises(ValueError):
            validate_android(field(1, element)[:-2], META)

    def test_reproducible_zip_root(self):
        Path("extension").mkdir()
        Path("extension/manifest.json").write_text("{}")
        archive("extension", "a.zip")
        archive("extension", "b.zip")
        self.assertEqual(Path("a.zip").read_bytes(), Path("b.zip").read_bytes())
        with zipfile.ZipFile("a.zip") as z:
            self.assertEqual(z.namelist(), ["manifest.json"])

    def test_missing_credentials_and_publication_consent(self):
        for store in ("chrome", "firefox", "play"):
            with self.assertRaisesRegex(ValueError, "Missing configuration"):
                preflight(store, {})
        env = {**ENV, "GH_TOKEN": "fake", "GITHUB_REPOSITORY": "backmeupplz/plainwallet", "STORE_SETUP_CONFIRMED": "true", "STORE_AUTO_PUBLISH_APPROVED": "true"}
        preflight("chrome", env)
        with self.assertRaisesRegex(ValueError, "explicit owner consent"):
            preflight("firefox", env)
        preflight("firefox", {**env, "AMO_AUTO_PUBLISH_APPROVED": "true"})


    def test_all_stores_require_new_automatic_publication_consent(self):
        env = {**ENV, "GH_TOKEN": "fake", "GITHUB_REPOSITORY": "backmeupplz/plainwallet", "STORE_SETUP_CONFIRMED": "true", "AMO_AUTO_PUBLISH_APPROVED": "true", "PLAY_MANAGED_PUBLISHING_DISABLED_CONFIRMED": "true", "PLAY_APP_SIGNING_CONFIRMED": "true", "ANDROID_KEYSTORE_BASE64": "fake", "ANDROID_KEY_ALIAS": "fake", "ANDROID_STORE_PASSWORD": "fake", "ANDROID_KEY_PASSWORD": "fake", "ANDROID_UPLOAD_CERT_SHA256": "a" * 64}
        for store in ("chrome", "firefox", "play"):
            for value in (None, "", "false", "TRUE"):
                with self.subTest(store=store, value=value), self.assertRaisesRegex(ValueError, "Explicit owner consent"):
                    preflight(store, {**env, "STORE_AUTO_PUBLISH_APPROVED": value})
            preflight(store, {**env, "STORE_AUTO_PUBLISH_APPROVED": "true"})
        env["STORE_AUTO_PUBLISH_APPROVED"] = "true"
        for field, value, error in (("PLAY_MANAGED_PUBLISHING_DISABLED_CONFIRMED", "", "managed publishing is disabled"), ("PLAY_MANAGED_PUBLISHING_DISABLED_CONFIRMED", "false", "managed publishing is disabled"), ("PLAY_MANAGED_PUBLISHING_CONFIRMED", "true", "obsolete"), ("PLAY_TRACK", "internal", "must be production"), ("PLAY_TRACK", "beta", "must be production"), ("PLAY_TRACK", "alpha", "must be production"), ("PLAY_TRACK", "custom-track", "must be production"), ("PLAY_TRACK", "Production", "must be production")):
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, error):
                preflight("play", {**env, field: value})

    def test_workflow_pre_auth_publication_gates_execute_fail_closed(self):
        workflow = (ROOT / ".github/workflows/store-release.yml").read_text()
        gate = workflow.split("      - name: Verify setup gates before authentication\n", 1)[1].split("      - id: google\n", 1)[0]
        script = "\n".join(line[10:] for line in gate.split("        run: |\n", 1)[1].splitlines())
        for name in ("STORE_AUTO_PUBLISH_APPROVED", "PLAY_MANAGED_PUBLISHING_DISABLED_CONFIRMED", "PLAY_MANAGED_PUBLISHING_CONFIRMED", "PLAY_TRACK", "AMO_AUTO_PUBLISH_APPROVED"):
            self.assertEqual(workflow.count("vars." + name + " }}"), 2)
        env = {"CONFIRMED": "true", "AUTO_PUBLISH_APPROVED": "true", "WIF_PROVIDER": "fixture", "SERVICE_ACCOUNT": "fixture", "PLAY_TRACK": "production", "PLAY_MANAGED_PUBLISHING_DISABLED_CONFIRMED": "true", "PLAY_MANAGED_PUBLISHING_CONFIRMED": "", "AMO_AUTO_PUBLISH_APPROVED": "true"}
        for store in ("chrome", "firefox", "play"):
            def run(changes):
                return subprocess.run(["/bin/bash", "-eu", "-c", script], env={**env, "STORE": store, **changes}, capture_output=True).returncode
            self.assertEqual(run({}), 0)
            self.assertNotEqual(run({"AUTO_PUBLISH_APPROVED": ""}), 0)
            self.assertNotEqual(run({"CONFIRMED": ""}), 0)
            if store == "play":
                for bad in ({"PLAY_TRACK": "beta"}, {"PLAY_MANAGED_PUBLISHING_DISABLED_CONFIRMED": ""}, {"PLAY_MANAGED_PUBLISHING_CONFIRMED": "true"}):
                    self.assertNotEqual(run(bad), 0)
            if store == "firefox":
                self.assertNotEqual(run({"AMO_AUTO_PUBLISH_APPROVED": ""}), 0)

    def test_chrome_default_publish_reruns_pending_then_public_without_writes(self):
        journal, writes = MemoryJournal(), []
        remote = {}
        def api(url, token, **kw):
            if url.endswith(":fetchStatus"):
                return remote
            writes.append((url, kw))
            if url.endswith(":upload"):
                return {"uploadState": "SUCCEEDED", "crxVersion": META["version"]}
            self.assertEqual(kw["body"], {"publishType": "DEFAULT_PUBLISH", "deployInfos": [{"deployPercentage": 100}], "skipReview": False, "blockOnWarnings": True})
            remote["submittedItemRevisionStatus"] = {"state": "PENDING_REVIEW", "distributionChannels": [{"crxVersion": META["version"], "deployPercentage": 100}]}
            return {"state": "PENDING_REVIEW"}
        self.assertEqual(chrome(META, ENV, journal, api)["publication"], "automatic-after-approval")
        for _ in range(2):
            self.assertEqual(chrome(META, ENV, journal, api)["state"], "PENDING_REVIEW")
        revision = remote.pop("submittedItemRevisionStatus")
        revision["state"] = "PUBLISHED"
        remote["publishedItemRevisionStatus"] = revision
        self.assertEqual(chrome(META, ENV, journal, api)["publication"], "public")
        self.assertEqual(len(writes), 2)  # One upload and one review, ever.
        self.assertEqual(journal.read(journal.name("review", "receipt"))["publishType"], "DEFAULT_PUBLISH")

    def test_chrome_legacy_staged_or_pending_requires_reconciliation_no_writes(self):
        for state in ("STAGED", "PENDING_REVIEW"):
            for receipt in (None, {"state": "PENDING_REVIEW"}, {"state": "STAGED", "publishType": "STAGED_PUBLISH"}):
                with self.subTest(state=state, receipt=receipt):
                    journal = MemoryJournal()
                    if receipt:
                        journal.put(journal.name("review", "receipt"), receipt)
                    journal.put(journal.name("review", "started"), {"state": "started"})
                    def api(url, token, **kw):
                        self.assertEqual(kw.get("method", "GET"), "GET")
                        return {"submittedItemRevisionStatus": {"state": state, "distributionChannels": [{"crxVersion": META["version"]}]}}
                    for _ in range(2):
                        with self.assertRaisesRegex(ValueError, "reconciliation required"):
                            chrome(META, ENV, journal, api)

    def test_chrome_unexpected_staged_response_never_counts_as_automatic_success(self):
        journal = MemoryJournal()
        def api(url, token, **kw):
            if url.endswith(":fetchStatus"):
                return {}
            if url.endswith(":upload"):
                return {"uploadState": "SUCCEEDED"}
            return {"state": "STAGED"}
        with self.assertRaisesRegex(ValueError, "did not confirm automatic"):
            chrome(META, ENV, journal, api)
        with self.assertRaisesRegex(ValueError, "receipt disagrees"):
            chrome(META, ENV, journal, api)

    def test_chrome_immediate_published_response_is_not_resubmitted(self):
        journal = MemoryJournal()
        def api(url, token, **kw):
            if url.endswith(":fetchStatus"):
                if journal.read(journal.name("review", "receipt")):
                    return {"publishedItemRevisionStatus": {"state": "PUBLISHED", "distributionChannels": [{"crxVersion": META["version"]}]}}
                return {}
            if url.endswith(":upload"):
                return {"uploadState": "SUCCEEDED"}
            return {"state": "PUBLISHED"}
        for _ in range(2):
            self.assertEqual(chrome(META, ENV, journal, api)["publication"], "public")

    def test_play_legacy_commit_or_nonproduction_track_fails_without_network(self):
        for operation, receipt in (("commit", {"id": "old-edit"}), ("commit", {"id": "old-edit", "track": "beta", "managedPublishingDisabledConfirmed": True}), ("commit", {"id": "old-edit", "track": "production", "managedPublishingDisabledConfirmed": False}), ("track", {"track": "beta"})):
            journal = MemoryJournal()
            journal.put(journal.name(operation, "receipt"), receipt)
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, "reconciliation required"):
                    play(META, ENV, journal, api=lambda *a, **kw: self.fail("legacy state must not resubmit"))
        with self.assertRaisesRegex(ValueError, "must be production"):
            play(META, {**ENV, "PLAY_TRACK": "beta"}, MemoryJournal(), api=lambda *a, **kw: self.fail("nonproduction write"))

    def test_play_commit_error_is_not_retried(self):
        journal, commits = MemoryJournal(), []
        journal.put(journal.name("edit", "receipt"), {"id": "e"})
        journal.put(journal.name("bundle", "receipt"), {"versionCode": 203})
        journal.put(journal.name("track", "receipt"), {"track": "production"})
        def api(url, token, **kw):
            if ":commit" in url:
                self.assertEqual(parse_qs(urlparse(url).query), {"changesNotSentForReview": ["false"], "changesInReviewBehavior": ["CANCEL_IN_REVIEW_AND_SUBMIT"]})
                commits.append(url)
                raise APIError(400)
            return {}
        with self.assertRaises(APIError):
            play(META, ENV, journal, api)
        with self.assertRaisesRegex(ValueError, "Uncertain commit"):
            play(META, ENV, journal, api)
        self.assertEqual(len(commits), 1)

    def test_firefox_existing_public_and_disabled_versions_no_writes(self):
        version = {"id": 7, "version": META["version"], "channel": "listed", "source": "source.zip", "file": {"status": "public"}}
        listing = {"guid": ENV["AMO_ADDON_ID"]}
        def api(url, token, **kw):
            self.assertEqual(kw.get("method", "GET"), "GET")
            return version if "/versions/" in url else listing
        for _ in range(2):
            self.assertEqual(firefox(META, ENV, MemoryJournal(), api)["publication"], "public")
        version["is_disabled"] = True
        with self.assertRaisesRegex(ValueError, "version disabled"):
            firefox(META, ENV, MemoryJournal(), api)
        version["is_disabled"] = False
        listing["is_disabled_by_developer"] = True
        with self.assertRaisesRegex(ValueError, "listing disabled"):
            firefox(META, ENV, MemoryJournal(), api)

    def test_report_distinguishes_automatic_intent_from_live_evidence(self):
        import report
        Path("event.json").write_text(json.dumps({"release": {"id": 1, "tag_name": "v0.2.3", "html_url": "https://github.com/fixture/release"}}))
        env = {"GITHUB_EVENT_NAME": "release", "GITHUB_EVENT_PATH": "event.json", "GITHUB_REPOSITORY": "backmeupplz/plainwallet", "GITHUB_RUN_ID": "1", "GITHUB_STEP_SUMMARY": "summary.md"}
        rows = [{"store": "chrome", "state": "PENDING_REVIEW", "publication": "automatic-after-approval"}, {"store": "play", "state": "failed", "error": "Legacy Play commit"}, {"store": "firefox", "state": "public", "publication": "public"}]
        with patch.dict(os.environ, env, clear=True), patch("report.outcomes", return_value=rows), patch("builtins.print"):
            report.main()
        body = Path("summary.md").read_text()
        for expected in ("Submitted is not approved/live", "Play targets production", "owner-confirmed, not API-verified", "STAGED or legacy/uncertain", '"state": "failed"', '"state": "public"'):
            self.assertIn(expected, body)

    def test_journal_idempotent_and_uncertain_write_stops(self):
        journal = MemoryJournal()
        calls = []
        for _ in range(2):
            result = journal.once("upload", lambda: calls.append(1) or {"id": "u"}, lambda r: r)
            self.assertEqual(result, {"id": "u"})
        self.assertEqual(calls, [1])
        def fail():
            raise RuntimeError("connection lost after write")
        with self.assertRaises(RuntimeError):
            journal.once("review", fail, lambda r: r)
        with self.assertRaisesRegex(ValueError, "Uncertain"):
            journal.once("review", lambda: self.fail("unsafe retry"), lambda r: r)

    def test_chrome_cancels_only_an_older_pending_review(self):
        def pending(state, version):
            return {"submittedItemRevisionStatus": {"state": state, "distributionChannels": [{"crxVersion": version}]}}
        journal, writes, remote = MemoryJournal(), [], pending("PENDING_REVIEW", "0.2.2")
        def api(url, token, **kw):
            if url.endswith(":fetchStatus"):
                return remote
            writes.append(url.rsplit(":", 1)[1])
            if url.endswith(":upload"):
                return {"uploadState": "SUCCEEDED", "crxVersion": META["version"]}
            return {"state": "PENDING_REVIEW"}
        self.assertEqual(chrome(META, ENV, journal, api)["state"], "PENDING_REVIEW")
        self.assertEqual(writes, ["cancelSubmission", "upload", "publish"])
        self.assertEqual(journal.read(journal.name("cancel", "receipt")), {"cancelled": ["0.2.2"]})
        for state, version in (("PENDING_REVIEW", "0.2.4"), ("PENDING_REVIEW", "0.10.0"), ("PENDING_REVIEW", "x"), ("STAGED", "0.2.2")):
            with self.subTest(state=state, version=version):
                def refuse(url, token, **kw):
                    self.assertEqual(kw.get("method", "GET"), "GET")
                    return pending(state, version)
                with self.assertRaisesRegex(ValueError, "only an older pending review"):
                    chrome(META, ENV, MemoryJournal(), refuse)

    def test_play_refuses_to_replace_a_newer_release(self):
        def api(url, token, **kw):
            if url.endswith("/tracks"):
                return {"tracks": [{"track": "production", "releases": [{"status": "completed", "versionCodes": ["204"]}]}]}
            return {"id": "edit-id"}
        with self.assertRaisesRegex(ValueError, "Newer Play release"):
            play(META, ENV, MemoryJournal(), api, sign=lambda e: self.fail("must not sign"))

    def test_chrome_upload_submit_and_staged_replay_never_publishes(self):
        calls = []
        def api(url, token, **kw):
            calls.append((url, kw))
            if url.endswith(":fetchStatus"):
                return {}
            if url.endswith(":upload"):
                return {"uploadState": "SUCCEEDED", "crxVersion": "0.2.3"}
            self.assertEqual(kw["body"], {"publishType": "DEFAULT_PUBLISH", "deployInfos": [{"deployPercentage": 100}], "skipReview": False, "blockOnWarnings": True})
            return {"state": "PENDING_REVIEW", "name": "fixture"}
        result = chrome(META, ENV, MemoryJournal(), api)
        self.assertEqual(result["state"], "PENDING_REVIEW")
        self.assertEqual(len(calls), 3)
        def staged(url, token, **kw):
            self.assertEqual(kw.get("method", "GET"), "GET")
            return {"submittedItemRevisionStatus": {"state": "STAGED", "distributionChannels": [{"crxVersion": "0.2.3"}]}}
        with self.assertRaisesRegex(ValueError, "STAGED is held"):
            chrome(META, ENV, MemoryJournal(), staged)

    def test_chrome_validation_failure_never_submits(self):
        def api(url, token, **kw):
            if url.endswith(":fetchStatus"):
                return {}
            self.assertTrue(url.endswith(":upload"))
            return {"uploadState": "FAILED"}
        with self.assertRaisesRegex(ValueError, "upload not successful"):
            chrome(META, ENV, MemoryJournal(), api)

    def test_firefox_source_atomic_submission_and_replay(self):
        methods = []
        version = {"id": 7, "version": "0.2.3", "channel": "listed", "source": "source.zip", "file": {"status": "unreviewed"}}
        def api(url, token, **kw):
            self.assertEqual(kw["auth_scheme"], "JWT")
            methods.append(kw.get("method", "GET"))
            if "?filter=all_without_unlisted" in url:
                return {"results": [], "next": None}
            if url.endswith("/versions/0.2.3/"):
                return None
            if url.endswith("/versions/7/"):
                return version
            if url.endswith("/versions/"):
                self.assertIn(b'name="source"', kw["body"])
                self.assertIn(b'name="upload"', kw["body"])
                return {"id": 7}
            if url.endswith("/upload/"):
                return {"uuid": "fixture-upload"}
            if url.endswith("/upload/fixture-upload/"):
                return {"processed": True, "valid": True, "version": "0.2.3", "channel": "listed"}
            return {"guid": ENV["AMO_ADDON_ID"]}
        self.assertEqual(firefox(META, ENV, MemoryJournal(), api)["versionId"], 7)
        self.assertEqual(methods.count("POST"), 2)
        def existing(url, token, **kw):
            self.assertEqual(kw.get("method", "GET"), "GET")
            return version if "/versions/" in url else {"guid": ENV["AMO_ADDON_ID"]}
        self.assertEqual(firefox(META, ENV, MemoryJournal(), existing)["state"], "unreviewed")

    def test_firefox_disables_only_an_older_pending_review(self):
        def listing(pending_version):
            def api(url, token, **kw):
                if "?filter=all_without_unlisted" in url:
                    return {"results": [{"id": 5, "version": pending_version, "file": {"status": "unreviewed"}}], "next": None}
                if url.endswith("/versions/0.2.3/"):
                    return None
                if kw.get("method") == "PATCH":
                    writes.append((url, kw["body"]))
                    return {}
                if url.endswith("/upload/"):
                    return {"uuid": "u"}
                if url.endswith("/upload/u/"):
                    return {"processed": True, "valid": False}
                return {"guid": ENV["AMO_ADDON_ID"]}
            return api
        journal, writes = MemoryJournal(), []
        with self.assertRaisesRegex(ValueError, "validation failed"):
            firefox(META, ENV, journal, listing("0.2.1"))
        self.assertEqual(writes, [("https://addons.mozilla.org/api/v5/addons/addon/plainwallet%40backmeupplz/versions/5/", {"is_disabled": True})])
        self.assertEqual(journal.read(journal.name("disable-5", "receipt")), {"disabled": "0.2.1"})
        for version in ("0.2.3", "0.10.0", "x"):
            with self.subTest(version=version):
                writes = []
                with self.assertRaisesRegex(ValueError, "only an older one"):
                    firefox(META, ENV, MemoryJournal(), listing(version))
                self.assertEqual(writes, [])

    def test_firefox_invalid_upload_stops_before_version_create(self):
        def api(url, token, **kw):
            if "?filter=all_without_unlisted" in url:
                return {"results": [], "next": None}
            if url.endswith("/versions/0.2.3/"):
                return None
            if url.endswith("/upload/"):
                return {"uuid": "u"}
            if url.endswith("/upload/u/"):
                return {"processed": True, "valid": False}
            self.assertNotIn("/versions/", url)
            return {"guid": ENV["AMO_ADDON_ID"]}
        with self.assertRaisesRegex(ValueError, "validation failed"):
            firefox(META, ENV, MemoryJournal(), api)

    def test_play_commit_requests_review_and_replay_no_writes(self):
        calls = []
        journal = MemoryJournal()
        def api(url, token, **kw):
            calls.append((url, kw))
            if url.endswith("/tracks"):
                return {"tracks": []}
            if url.endswith("/bundles"):
                return {"bundles": []}
            if "uploadType=media" in url:
                return {"versionCode": 203, "sha256": "fixture"}
            if "/tracks/" in url:
                self.assertEqual(kw["body"], {"track": "production", "releases": [{"name": META["version"], "versionCodes": ["203"], "status": "completed"}]})
                self.assertTrue(url.endswith("/tracks/production"))
                return {"track": "production"}
            return {"id": "edit-id"}
        result = play(META, ENV, journal, api, sign=lambda e: b"signed-fixture")
        self.assertEqual(result["editId"], "edit-id")
        self.assertTrue(calls[-1][0].endswith(":commit?changesNotSentForReview=false&changesInReviewBehavior=CANCEL_IN_REVIEW_AND_SUBMIT"))
        self.assertNotIn("body", calls[-1][1])
        self.assertEqual(result["track"], "production")
        self.assertIn("automatic-after-approval", result["publication"])
        play(META, ENV, journal, api=lambda *a, **kw: self.fail("duplicate Play call"))

    def test_play_wrong_track_response_never_commits(self):
        journal = MemoryJournal()
        journal.put(journal.name("edit", "receipt"), {"id": "e"})
        journal.put(journal.name("bundle", "receipt"), {"versionCode": 203})
        def api(url, token, **kw):
            self.assertNotIn(":commit", url)
            self.assertNotIn(":validate", url)
            return {"track": "beta"} if kw.get("method") == "PUT" else {}
        with self.assertRaisesRegex(ValueError, "did not confirm production"):
            play(META, ENV, journal, api)

    def test_play_validation_failure_never_commits(self):
        journal = MemoryJournal()
        journal.put(journal.name("edit", "receipt"), {"id": "e"})
        journal.put(journal.name("bundle", "receipt"), {"versionCode": 203})
        journal.put(journal.name("track", "receipt"), {"track": "production"})
        def api(url, token, **kw):
            self.assertNotIn(":commit", url)
            if url.endswith(":validate"):
                raise APIError(400)
            return {}
        with self.assertRaises(APIError):
            play(META, ENV, journal, api)

    def test_partial_results_keep_success_when_other_store_fails(self):
        for store, state, attempt in (("chrome", "PENDING_REVIEW", 1), ("play", "failed", 1), ("play", "committed-for-review", 2)):
            d = Path("outcomes", "outcome-" + store + "-" + str(attempt))
            d.mkdir(parents=True)
            (d / "outcome.json").write_text(json.dumps({"store": store, "state": state}))
        result = {r["store"]: r["state"] for r in outcomes("outcomes")}
        self.assertEqual(result["chrome"], "PENDING_REVIEW")
        self.assertEqual(result["play"], "committed-for-review")
        self.assertIn("not submitted", result["firefox"])

    def test_workflow_uses_verified_node_and_typechecks_generated_wxt_types(self):
        workflow = (ROOT / ".github/workflows/store-release.yml").read_text()
        self.assertIn("node-version: '26.8.2'", workflow)
        self.assertIn("Node **26.8.2**", (ROOT / "docs/STORE_RELEASE.md").read_text())
        self.assertLess(workflow.index("npm run build"), workflow.index("npm exec -- tsc --noEmit"))
        self.assertNotIn("22.16.0", workflow)

    def test_chrome_async_upload_polls_before_single_submission(self):
        reads = iter([{}, {"lastAsyncUploadState": "IN_PROGRESS"}, {"lastAsyncUploadState": "SUCCEEDED"}])
        writes, sleeps = [], []
        def api(url, token, **kw):
            if url.endswith(":fetchStatus"):
                return next(reads)
            writes.append(url)
            if url.endswith(":upload"):
                return {"uploadState": "IN_PROGRESS"}
            self.assertEqual(kw["body"]["publishType"], "DEFAULT_PUBLISH")
            return {"state": "PENDING_REVIEW"}
        self.assertEqual(chrome(META, ENV, MemoryJournal(), api, pause=sleeps.append)["state"], "PENDING_REVIEW")
        self.assertEqual(sleeps, [10, 10])
        self.assertEqual(len(writes), 2)

    def test_chrome_async_upload_timeout_does_not_submit(self):
        reads, writes, sleeps = [], [], []
        def api(url, token, **kw):
            if url.endswith(":fetchStatus"):
                reads.append(url)
                return {"lastAsyncUploadState": "IN_PROGRESS"}
            writes.append(url)
            self.assertTrue(url.endswith(":upload"))
            return {"uploadState": "IN_PROGRESS"}
        with self.assertRaisesRegex(ValueError, "upload not successful"):
            chrome(META, ENV, MemoryJournal(), api, pause=sleeps.append)
        self.assertEqual(len(reads), 31)  # initial status plus 30 bounded polls
        self.assertEqual(len(writes), 1)
        self.assertEqual(sleeps, [10] * 30)

    def test_submit_entrypoint_rejects_event_and_artifact_mismatch_before_network(self):
        env = {**ENV, "GH_TOKEN": "fake", "GITHUB_REPOSITORY": "backmeupplz/plainwallet", "STORE_SETUP_CONFIRMED": "true", "STORE_AUTO_PUBLISH_APPROVED": "true", "GITHUB_EVENT_NAME": "release", "GITHUB_EVENT_PATH": "event.json", "GITHUB_SHA": META["sha"]}
        meta = {**META, "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in Path("release-out").iterdir()}}
        cases = [("sha", "b" * 40, "immutable release"), ("releaseId", 2, "immutable release"), ("version", "0.2.4", "tag/package version mismatch"), ("hash", "0" * 64, "Artifact hash mismatch"), ("event", "push", "only be used on release events")]
        for field, value, expected_error in cases:
            with self.subTest(field=field):
                test_meta, test_env = copy.deepcopy(meta), dict(env)
                if field == "hash":
                    test_meta["sha256"]["chrome.zip"] = value
                elif field == "event":
                    test_env["GITHUB_EVENT_NAME"] = value
                else:
                    test_meta[field] = value
                Path("release-out/release.json").write_text(json.dumps(test_meta))
                Path("event.json").write_text(json.dumps(EVENT))
                with patch.dict(os.environ, test_env, clear=True), patch("sys.argv", ["submit.py", "chrome"]), patch("submit.Journal") as network, redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as failed:
                        submit.main()
                    self.assertEqual(failed.exception.code, 1)
                    network.assert_not_called()
                outcome = json.loads(Path("outcome.json").read_text())
                self.assertEqual(outcome["state"], "failed")
                self.assertIn(expected_error, outcome["error"])

    def test_real_journal_http_roundtrip_replay_and_metadata_binding(self):
        assets, records, writes, calls = {}, {}, [], []
        def transport(req, **kw):
            self.assertEqual(req.get_header("Authorization"), "Bearer fixture-token")
            if req.get_method() == "GET":
                self.assertIn("/releases/1/assets?", req.full_url)
                return io.BytesIO(json.dumps(list(assets.values())).encode())
            self.assertEqual(req.get_method(), "POST")
            self.assertTrue(req.full_url.startswith("https://uploads.github.com/"))
            name = parse_qs(urlparse(req.full_url).query)["name"][0]
            self.assertNotIn(name, assets)
            writes.append(name)
            records[name] = json.loads(req.data)
            asset = {"name": name, "browser_download_url": "https://github.com/fixture/" + name}
            assets[name] = asset
            return io.BytesIO(json.dumps(asset).encode())
        def download(url, **kw):
            self.assertIsInstance(url, str)  # token-free public asset request
            return io.BytesIO(json.dumps(records[url.rsplit("/", 1)[1]]).encode())
        env = {"GH_TOKEN": "fixture-token", "GITHUB_REPOSITORY": "backmeupplz/plainwallet"}
        with patch("urllib.request.OpenerDirector.open", side_effect=transport), patch("submit.urlopen", side_effect=download):
            first = Journal("chrome", META, env)
            first.once("upload", lambda: calls.append(1) or {"id": "upload-id"}, lambda r: r)
            resumed = Journal("chrome", META, env)
            self.assertEqual(resumed.once("upload", lambda: self.fail("duplicate store upload"), lambda r: r), {"id": "upload-id"})
            self.assertEqual(calls, [1])
            self.assertEqual(writes, ["submission-chrome-upload-started.json", "submission-chrome-upload-receipt.json"])
            wrong = Journal("chrome", {**META, "sha": "b" * 40}, env)
            with self.assertRaisesRegex(ValueError, "Journal artifact/commit mismatch"):
                wrong.read(wrong.name("upload", "receipt"))

    def test_real_journal_failed_marker_prevents_store_mutation(self):
        error = HTTPError("https://uploads.github.com", 403, "denied", {}, io.BytesIO(b"private error"))
        def transport(req, **kw):
            if req.get_method() == "GET":
                return io.BytesIO(b"[]")
            raise error
        with patch("urllib.request.OpenerDirector.open", side_effect=transport):
            journal = Journal("chrome", META, {"GH_TOKEN": "fixture-token", "GITHUB_REPOSITORY": "backmeupplz/plainwallet"})
            with self.assertRaises(APIError):
                journal.once("upload", lambda: self.fail("store write without durable marker"), lambda r: r)

    @unittest.skipUnless(os.environ.get("JAVA_HOME"), "JDK unavailable locally; exercised in CI")
    def test_real_isolated_signer_and_wrong_certificate(self):
        # Disposable CI signer, never a production signing identity.
        subprocess.run(["keytool", "-genkeypair", "-alias", "fixture", "-keystore", "fixture.p12", "-storepass", "fixture-password", "-keypass", "fixture-password", "-keyalg", "RSA", "-dname", "CN=Disposable release test", "-validity", "1"], capture_output=True, check=True)
        cert = subprocess.check_output(["keytool", "-exportcert", "-alias", "fixture", "-keystore", "fixture.p12", "-storepass", "fixture-password"])
        with zipfile.ZipFile("release-out/android.aab", "w") as z:
            z.writestr("base/manifest/AndroidManifest.xml", b"synthetic")
        env = {"ANDROID_KEYSTORE_BASE64": base64.b64encode(Path("fixture.p12").read_bytes()).decode(), "ANDROID_KEY_ALIAS": "fixture", "ANDROID_STORE_PASSWORD": "fixture-password", "ANDROID_KEY_PASSWORD": "fixture-password", "ANDROID_UPLOAD_CERT_SHA256": hashlib.sha256(cert).hexdigest()}
        signed = signed_bundle(env)
        with zipfile.ZipFile(io.BytesIO(signed)) as z:
            self.assertTrue(any(n.endswith(".RSA") for n in z.namelist()))
        env["ANDROID_UPLOAD_CERT_SHA256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Wrong Android upload certificate"):
            signed_bundle(env)

    def test_no_automatic_mutation_retry_or_error_body_leak(self):
        error = HTTPError("https://api.github.com", 503, "secret response", {}, io.BytesIO(b"secret"))
        with patch("urllib.request.OpenerDirector.open", side_effect=error) as mocked:
            with self.assertRaises(APIError) as caught:
                request("https://api.github.com", "fake", method="POST", body={})
            self.assertEqual(mocked.call_count, 1)
            self.assertNotIn("secret", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
