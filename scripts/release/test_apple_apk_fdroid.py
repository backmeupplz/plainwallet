"""App Store, APK and F-Droid stores against fakes: no network, credentials or Apple tools."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlparse

import fdroid as fdroid_script
from submit import apk, fdroid, appstore, app_store_notes, changelogs, preflight, whats_new, APP_STORE_APP, APPLE_LOCALES
from test_release import MemoryJournal

META = {"version": "0.5.2", "versionCode": 502, "sha": "a" * 40, "releaseId": 1}

EVENT = {"release": {"body": "Faster unlock and clearer approvals.\n\nAlso fixes Firefox."}}


class FakeAppStore:
    """Just enough of App Store Connect: versions, builds and review submissions for one platform."""
    def __init__(self, versions, submissions=(), builds=()):
        self.versions = {v["id"]: dict(v) for v in versions}
        self.submissions = {s["id"]: dict(s) for s in submissions}
        self.builds = list(builds)
        self.writes = []
        self.notes = {}
        self.attached = {}

    def upload(self, platform):
        self.writes.append(("upload", platform))
        self.builds.append({"id": "b-" + platform, "version": str(META["versionCode"]), "platform": {"ios": "IOS", "macos": "MAC_OS"}[platform], "pre": META["version"], "processingState": "VALID"})
        return {"uploaded": True}

    def __call__(self, path, method="GET", body=None, **kw):
        url = urlparse(path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        parts = url.path.split("/")
        attrs = (body or {}).get("data", {}).get("attributes", {})
        if method != "GET":
            self.writes.append((method, url.path, attrs))
        if parts[0] == "apps" and parts[2] == "appStoreVersions":
            return {"data": [{"id": i, "attributes": {"versionString": v["versionString"], "appStoreState": v["state"]}} for i, v in self.versions.items() if v["platform"] == q["filter[platform]"]]}
        if parts[0] == "builds":
            found = [b for b in self.builds if b["platform"] == q["filter[preReleaseVersion.platform]"] and q.get("filter[version]", b["version"]) == b["version"] and q.get("filter[preReleaseVersion.version]", b["pre"]) == b["pre"]]
            return {"data": [{"id": b["id"], "attributes": {"version": b["version"], "processingState": b["processingState"]}} for b in found]}
        if parts[0] == "reviewSubmissions" and len(parts) == 1 and method == "GET":
            states = q["filter[state]"].split(",")
            return {"data": [{"id": i} for i, s in self.submissions.items() if s["platform"] == q["filter[platform]"] and s["state"] in states]}
        if parts[0] == "reviewSubmissions" and len(parts) == 3:
            items = self.submissions[parts[1]]["versions"]
            return {"data": [], "included": [{"type": "appStoreVersions", "id": i, "attributes": {"versionString": self.versions[i]["versionString"]}} for i in items]}
        if parts[0] == "reviewSubmissions" and method == "PATCH":
            submission = self.submissions[parts[1]]
            if attrs.get("canceled"):
                submission["state"] = "CANCELING"
                for i in submission["versions"]:
                    self.versions[i]["state"] = "DEVELOPER_REJECTED"
                return {"data": {"attributes": {"state": "CANCELING"}}}
            submission["state"] = "WAITING_FOR_REVIEW"
            for i in submission["versions"]:
                self.versions[i]["state"] = "WAITING_FOR_REVIEW"
            return {"data": {"attributes": {"state": "WAITING_FOR_REVIEW"}}}
        if parts[0] == "reviewSubmissions" and method == "POST":
            i = "s" + str(len(self.submissions) + 1)
            self.submissions[i] = {"platform": attrs["platform"], "state": "READY_FOR_REVIEW", "versions": []}
            return {"data": {"id": i}}
        if parts[0] == "reviewSubmissionItems":
            rel = body["data"]["relationships"]
            self.submissions[rel["reviewSubmission"]["data"]["id"]]["versions"].append(rel["appStoreVersion"]["data"]["id"])
            return {"data": {"id": "item"}}
        if parts[0] == "appStoreVersions" and len(parts) == 1:
            i = "v" + str(len(self.versions) + 1)
            self.versions[i] = {"platform": attrs["platform"], "versionString": attrs["versionString"], "state": "PREPARE_FOR_SUBMISSION"}
            return {"data": {"id": i}}
        if parts[0] == "appStoreVersions" and parts[-1] == "build":
            self.attached[parts[1]] = body["data"]["id"]
            return {}
        if parts[0] == "appStoreVersions" and parts[-1] == "appStoreVersionLocalizations":
            return {"data": [{"id": "loc-" + parts[1]}]}
        if parts[0] == "appStoreVersions":
            assert self.versions[parts[1]]["state"] != "READY_FOR_SALE", "never edit a live version"
            self.versions[parts[1]]["versionString"] = attrs["versionString"]
            return {}
        if parts[0] == "appStoreVersionLocalizations":
            self.notes[parts[1]] = attrs["whatsNew"]
            return {}
        raise AssertionError("Unexpected App Store Connect call: " + method + " " + path)


def run(fake, journal=None):
    return appstore(META, {"ASC_KEY_P8": "fixture", "ASC_KEY_ID": "id", "ASC_ISSUER_ID": "issuer"}, journal or MemoryJournal("appstore"), EVENT, api=fake, upload=fake.upload, pause=lambda s: None)


class AppleApkFdroidTests(unittest.TestCase):
    def test_replaces_older_versions_in_review_and_submits_with_automatic_release(self):
        # Today's state: iOS 0.3.0 waiting for review, macOS 0.2.5 in review, neither ever live.
        fake = FakeAppStore(
            [{"id": "ios", "platform": "IOS", "versionString": "0.3.0", "state": "WAITING_FOR_REVIEW"}, {"id": "mac", "platform": "MAC_OS", "versionString": "0.2.5", "state": "IN_REVIEW"}],
            [{"id": "old-ios", "platform": "IOS", "state": "WAITING_FOR_REVIEW", "versions": ["ios"]}, {"id": "old-mac", "platform": "MAC_OS", "state": "IN_REVIEW", "versions": ["mac"]}],
            [{"id": "b1", "version": "1", "platform": "IOS", "pre": "0.3.0", "processingState": "VALID"}])
        journal = MemoryJournal("appstore")
        outcome = run(fake, journal)
        self.assertEqual([r["state"] for r in outcome["platforms"]], ["WAITING_FOR_REVIEW", "WAITING_FOR_REVIEW"])
        self.assertEqual({v["versionString"] for v in fake.versions.values()}, {META["version"]})
        self.assertEqual(fake.attached, {"ios": "b-ios", "mac": "b-macos"})
        self.assertEqual(fake.notes, {}, "first versions can't have What's New")
        self.assertIn(("PATCH", "reviewSubmissions/old-ios", {"canceled": True}), fake.writes)
        self.assertIn(("PATCH", "appStoreVersions/ios", {"versionString": META["version"], "releaseType": "AFTER_APPROVAL"}), fake.writes)
        # A rerun finds both submitted and writes nothing.
        writes = len(fake.writes)
        again = run(fake, journal)
        self.assertTrue(all(r.get("existing") for r in again["platforms"]))
        self.assertEqual(len(fake.writes), writes)

    def test_newer_submission_in_review_is_never_cancelled(self):
        fake = FakeAppStore([{"id": "ios", "platform": "IOS", "versionString": "9.0.0", "state": "IN_REVIEW"}], [{"id": "new", "platform": "IOS", "state": "IN_REVIEW", "versions": ["ios"]}])
        with self.assertRaisesRegex(ValueError, "only an older one is replaced"):
            run(fake)
        self.assertNotIn("canceled", json.dumps(fake.writes))

    def test_live_app_gets_a_new_version_with_safe_whats_new(self):
        fake = FakeAppStore([{"id": "ios", "platform": "IOS", "versionString": "0.2.0", "state": "READY_FOR_SALE"}, {"id": "mac", "platform": "MAC_OS", "versionString": "0.2.0", "state": "READY_FOR_SALE"}])
        run(fake)
        new = [v for v in fake.versions.values() if v["versionString"] == META["version"]]
        self.assertEqual([v["state"] for v in new], ["WAITING_FOR_REVIEW", "WAITING_FOR_REVIEW"])
        self.assertEqual(fake.versions["ios"]["state"], "READY_FOR_SALE")
        self.assertEqual(set(fake.notes.values()), {"Faster unlock and clearer approvals."})

    def test_build_number_must_be_new_and_notes_never_name_other_platforms(self):
        fake = FakeAppStore([{"id": "ios", "platform": "IOS", "versionString": "0.2.0", "state": "READY_FOR_SALE"}], builds=[{"id": "b", "version": str(META["versionCode"]), "platform": "IOS", "pre": "0.2.2", "processingState": "VALID"}])
        with self.assertRaisesRegex(ValueError, "already has a build"):
            run(fake)
        self.assertNotIn(("upload", "ios"), fake.writes)
        self.assertEqual(app_store_notes({"release": {"body": "Works on Android and Chrome too."}}), "Fixes and improvements.")
        self.assertEqual(app_store_notes({}), "Fixes and improvements.")

    def test_whats_new_per_locale_from_the_changelogs(self):
        with tempfile.TemporaryDirectory() as root:
            for language, text in (("en-US", "Faster unlock.\n"), ("de-DE", "Schneller entsperren.\nJetzt auch für Android."), ("ja-JP", "Android 版の修正"), ("zh-CN", "解锁更快。\n修复了安卓版的问题。"), ("ru-RU", "Исправления для Андроид."), ("fr-FR", "  ")):
                os.makedirs(os.path.join(root, language, "changelogs"))
                with open(os.path.join(root, language, "changelogs", "502.txt"), "w", encoding="utf-8") as f:
                    f.write(text)
            with open(os.path.join(root, "en-US", "changelogs", "501.txt"), "w") as f:
                f.write("Older.")
            logs = changelogs(META, Path(root))
        self.assertEqual(logs, {"de-DE": "Schneller entsperren.\nJetzt auch für Android.", "en-US": "Faster unlock.", "ja-JP": "Android 版の修正", "ru-RU": "Исправления для Андроид.", "zh-CN": "解锁更快。\n修复了安卓版的问题。"})
        notes = whats_new(EVENT, logs)
        self.assertEqual(notes("de-DE"), "Schneller entsperren.") # the line naming another platform is left out
        self.assertEqual(notes("ja"), "Faster unlock.") # nothing left: English
        self.assertEqual(notes("zh-Hans"), "解锁更快。") # platform names in other scripts too
        self.assertEqual(notes("ru"), "Faster unlock.")
        self.assertEqual(notes("fr-FR"), "Faster unlock.")
        self.assertEqual(notes(None), "Faster unlock.")
        self.assertEqual(whats_new(EVENT, {})("de-DE"), "Faster unlock and clearer approvals.")
        self.assertEqual(changelogs(META, Path(root)), {}) # gone with the directory

    def test_mac_whats_new_leaves_out_favorites_in_every_language(self):
        logs = changelogs({"versionCode": 505}, Path(__file__).resolve().parents[2] / "fastlane/metadata/android")
        self.assertEqual(len(logs), len(APPLE_LOCALES))
        ios, mac = whats_new(EVENT, logs), whats_new(EVENT, logs, "macos")
        for language, text in logs.items():
            locale, favorites = APPLE_LOCALES[language], text.split("\n")[1]
            self.assertEqual(ios(locale), text, language)
            self.assertEqual(mac(locale), text.replace(favorites + "\n", ""), language) # just the favorites line goes
            self.assertLessEqual(len(text), 500, language)
        self.assertEqual(whats_new({"release": {"body": "Your favorite sites, side by side."}}, {}, "macos")("en-US"), "Fixes and improvements.")

    def test_apk_attaches_both_names_once(self):
        journal = MemoryJournal("apk")
        uploads = []
        journal.api = lambda url, **kw: uploads.append(url) or {"name": parse_qs(urlparse(url).query)["name"][0], "size": len(kw["body"])}
        env = {"GITHUB_REPOSITORY": "backmeupplz/plainwallet"}
        signed = []
        outcome = apk(META, env, journal, sign=lambda e: signed.append(1) or b"signed apk")
        self.assertEqual(outcome["assets"], ["plainwallet-" + META["version"] + "-android.apk", "plainwallet.apk"])
        self.assertEqual(len(uploads), 2)
        self.assertEqual(apk(META, env, journal, sign=lambda e: self.fail("no re-sign"))["sha256"], outcome["sha256"])
        self.assertEqual((len(signed), len(uploads)), (1, 2))

    def test_fdroid_waits_for_the_apk_then_updates_the_merge_request(self):
        journal = MemoryJournal("fdroid")
        journal.assets = {}
        journal.load = lambda: journal.assets.update({"plainwallet-" + META["version"] + "-android.apk": {}})
        env = {"GITLAB_TOKEN": "fixture", "FDROID_MR": "123", "FDROID_APP_ID": "com.borodutch.plainwallet", "FDROID_FORK": "backmeupplz/fdroiddata", "FDROID_BRANCH": "com.borodutch.plainwallet"}
        calls = []
        def run_ok(argv, **kw):
            calls.append((argv[-3:], kw["env"]["GITLAB_TOKEN"]))
            return subprocess.CompletedProcess(argv, 0, "diff\nF-Droid merge request !123 is at 0.2.3 now\n", "")
        outcome = fdroid(META, env, journal, run=run_ok, pause=lambda s: None)
        self.assertEqual(calls, [([META["version"], str(META["versionCode"]), META["sha"]], "fixture")])
        self.assertIn("is at 0.2.3 now", outcome["state"])
        with self.assertRaisesRegex(ValueError, "update failed"):
            fdroid(META, env, journal, run=lambda argv, **kw: subprocess.CompletedProcess(argv, 1, "", "Expected one Binaries line"), pause=lambda s: None)
        empty = MemoryJournal("fdroid")
        empty.assets, empty.load = {}, lambda: None
        with self.assertRaisesRegex(ValueError, "Release APK missing"):
            fdroid(META, env, empty, run=run_ok, pause=lambda s: None)

    def test_fdroid_push_failure_reports_git_output_without_the_token(self):
        metadata = "AutoName: Plain Wallet\nBuilds:\n  - versionName: 0.5.4\n    versionCode: 504\n    commit: " + "b" * 40 + "\nCurrentVersion: 0.5.4\nCurrentVersionCode: 504\n"
        def urlopen(url):
            body = json.dumps({"state": "opened", "iid": 123, "web_url": "https://gitlab.com/mr"}) if "merge_requests" in url else metadata
            return io.BytesIO(body.encode())
        def run(argv, cwd, **kw):
            self.assertTrue(kw["capture_output"])
            if "push" not in argv:
                if "sparse-checkout" in argv:
                    os.makedirs(os.path.join(cwd, "metadata"))
                return subprocess.CompletedProcess(argv, 0, "", "")
            return subprocess.CompletedProcess(argv, 1, "", "remote: HTTP Basic: Access denied for s3cret-token\nfatal: Authentication failed for 'https://gitlab.com/backmeupplz/fdroiddata.git/'\n")
        env = {"GITLAB_TOKEN": "s3cret-token", "FDROID_MR": "123", "FDROID_APP_ID": "com.borodutch.plainwallet", "FDROID_FORK": "backmeupplz/fdroiddata", "FDROID_BRANCH": "com.borodutch.plainwallet"}
        with mock.patch.dict(os.environ, env), mock.patch("sys.argv", ["fdroid.py", "0.5.5", "505", "a" * 40]), \
                mock.patch("fdroid.urllib.request.urlopen", urlopen), mock.patch("fdroid.subprocess.run", run), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit:
            fdroid_script.main()
        self.assertEqual(exit.exception.code, "git push failed with status 1: remote: HTTP Basic: Access denied for *** | fatal: Authentication failed for 'https://gitlab.com/backmeupplz/fdroiddata.git/'")

    def test_new_stores_need_their_configuration(self):
        base = {"GH_TOKEN": "fake", "GITHUB_REPOSITORY": "backmeupplz/plainwallet", "STORE_SETUP_CONFIRMED": "true", "STORE_AUTO_PUBLISH_APPROVED": "true"}
        for store in ("apk", "fdroid", "appstore"):
            with self.assertRaisesRegex(ValueError, "Missing configuration"):
                preflight(store, base)
        preflight("appstore", {**base, "ASC_KEY_P8": "fixture", "ASC_KEY_ID": "id", "ASC_ISSUER_ID": "issuer"})
        fd = {**base, "GITLAB_TOKEN": "t", "FDROID_MR": "12", "FDROID_APP_ID": "com.borodutch.plainwallet", "FDROID_FORK": "f", "FDROID_BRANCH": "b"}
        preflight("fdroid", fd)
        with self.assertRaisesRegex(ValueError, "Unexpected F-Droid"):
            preflight("fdroid", {**fd, "FDROID_APP_ID": "com.other"})
        self.assertEqual(APP_STORE_APP, "6817506091")


if __name__ == "__main__":
    unittest.main()
