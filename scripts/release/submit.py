"""Isolated store submission. No third-party Python packages or build tool execution.

Every remote mutation has an append-only write-ahead marker and receipt on the
existing GitHub release. An uncertain write fails closed; it is never retried.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
import uuid

from build import require, release_version


class APIError(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__("HTTP " + str(status) + "; inspect store console (response omitted to protect credentials)")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token, method="GET", body=None, content_type="application/json", missing=False, auth_scheme="Bearer"):
    require(urlparse(url).scheme == "https" and urlparse(url).hostname in ("api.github.com", "uploads.github.com", "chromewebstore.googleapis.com", "androidpublisher.googleapis.com", "addons.mozilla.org"), "Unexpected API host")
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    headers = {"Authorization": auth_scheme + " " + token, "Accept": "application/json", "User-Agent": "plainwallet-release", "Content-Type": content_type}
    for attempt in range(3 if method == "GET" else 1):
        try:
            with build_opener(NoRedirect).open(Request(url, data=body, method=method, headers=headers), timeout=90) as r:
                data = r.read()
                return json.loads(data) if data else {}
        except HTTPError as e:
            e.close()  # Do not leave an error body/response for GC warnings or logging.
            if missing and e.code == 404:
                return None
            if method == "GET" and e.code in (429, 500, 502, 503, 504) and attempt < 2:
                delay = e.headers.get("Retry-After", str(2 ** (attempt + 1)))
                require(delay.isdigit() and int(delay) <= 120, "Retry-After requires later operator retry")
                time.sleep(int(delay))
                continue
            raise APIError(e.code) from None
        except (URLError, TimeoutError):
            raise RuntimeError("Network outcome uncertain; reconcile journal and store before retry") from None


def multipart(fields, files):
    boundary = "plainwallet-" + uuid.uuid4().hex
    parts = []
    for key, value in fields.items():
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode())
    for key, path in files.items():
        path = Path(path)
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{path.name}"\r\nContent-Type: application/zip\r\n\r\n').encode() + path.read_bytes() + b"\r\n")
    return b"".join(parts) + (f"--{boundary}--\r\n").encode(), "multipart/form-data; boundary=" + boundary


def needed(env, *names):
    for name in names:
        require(bool(env.get(name)), "Missing configuration: " + name)


def preflight(store, env):
    needed(env, "GH_TOKEN", "GITHUB_REPOSITORY")
    require(env["GITHUB_REPOSITORY"] == "backmeupplz/plainwallet", "Store submission restricted to upstream repository")
    require(env.get("STORE_SETUP_CONFIRMED") == "true", "Owner must confirm listing ownership and protected environment setup")
    require(env.get("STORE_AUTO_PUBLISH_APPROVED") == "true", "Explicit owner consent to automatic public publication after approval is required")
    if store == "chrome":
        needed(env, "GOOGLE_ACCESS_TOKEN", "CHROME_PUBLISHER_ID", "CHROME_ITEM_ID")
        require(env["CHROME_ITEM_ID"] == "pmnbalegifiefmohkolfpclnmkooifcp", "Unexpected Chrome listing")
        require(re.fullmatch(r"[a-zA-Z0-9_-]+", env["CHROME_PUBLISHER_ID"]), "Invalid publisher ID")
    elif store == "play":
        needed(env, "GOOGLE_ACCESS_TOKEN", "PLAY_TRACK", "ANDROID_KEYSTORE_BASE64", "ANDROID_KEY_ALIAS", "ANDROID_STORE_PASSWORD", "ANDROID_KEY_PASSWORD", "ANDROID_UPLOAD_CERT_SHA256")
        require(env.get("PLAY_MANAGED_PUBLISHING_DISABLED_CONFIRMED") == "true", "Owner must confirm managed publishing is disabled before each release")
        require(env.get("PLAY_MANAGED_PUBLISHING_CONFIRMED") != "true", "Remove obsolete managed-publishing-enabled confirmation")
        require(env.get("PLAY_APP_SIGNING_CONFIRMED") == "true", "Existing Play App Signing/upload key must be confirmed")
        require(env["PLAY_TRACK"] == "production", "Play track must be production")
        require(re.fullmatch(r"[0-9A-Fa-f]{64}", env["ANDROID_UPLOAD_CERT_SHA256"]), "Upload certificate SHA256 must be 64 hex characters")
    elif store == "firefox":
        needed(env, "AMO_JWT_ISSUER", "AMO_JWT_SECRET", "AMO_ADDON_ID")
        require(env["AMO_ADDON_ID"] == "plainwallet@backmeupplz", "Unexpected Firefox listing GUID")
        require(env.get("AMO_AUTO_PUBLISH_APPROVED") == "true", "AMO listed approval may publish immediately: explicit owner consent required")
    else:
        raise ValueError("Unknown store")


class Journal:
    def __init__(self, store, meta, env):
        self.store, self.meta, self.env = store, meta, env
        self.base = "https://api.github.com/repos/" + env["GITHUB_REPOSITORY"]
        self.release = self.base + "/releases/" + str(meta["releaseId"])
        self.assets = {}
        for page in range(1, 11):
            items = self.api(self.release + "/assets?per_page=100&page=" + str(page))
            for item in items:
                self.assets[item["name"]] = item
            if len(items) < 100:
                break
        else:
            raise ValueError("Too many release assets; refusing incomplete journal")

    def api(self, url, **kwargs):
        return request(url, self.env["GH_TOKEN"], **kwargs)

    def name(self, operation, kind):
        return "submission-" + self.store + "-" + operation + "-" + kind + ".json"

    def read(self, name):
        item = self.assets.get(name)
        if not item:
            return None
        # GitHub asset API returns metadata by default; browser_download_url serves public bytes.
        # No GitHub token is forwarded to release CDN redirects.
        with urlopen(item["browser_download_url"], timeout=60) as r:
            record = json.load(r)
        require(record.get("release") == self.meta, "Journal artifact/commit mismatch; do not reuse version")
        return record["result"]

    def put(self, name, result):
        record = {"release": self.meta, "result": result}
        url = "https://uploads.github.com/repos/" + self.env["GITHUB_REPOSITORY"] + "/releases/" + str(self.meta["releaseId"]) + "/assets?" + urlencode({"name": name})
        item = self.api(url, method="POST", body=record)
        self.assets[name] = item

    def once(self, operation, call, project):
        done = self.name(operation, "receipt")
        existing = self.read(done)
        if existing is not None:
            return existing
        marker = self.name(operation, "started")
        require(marker not in self.assets, "Uncertain " + operation + ": inspect store and journal; never blindly repeat")
        self.put(marker, {"state": "started"})
        result = project(call())
        self.put(done, result)
        return result


def older(version, than):
    try:
        return tuple(int(p) for p in str(version).split(".")) < tuple(int(p) for p in than.split("."))
    except ValueError:
        return False


def chrome(meta, env, journal, api=request, pause=time.sleep):
    name = "publishers/" + env["CHROME_PUBLISHER_ID"] + "/items/" + env["CHROME_ITEM_ID"]
    base = "https://chromewebstore.googleapis.com/v2/" + name
    token = env["GOOGLE_ACCESS_TOKEN"]
    status = api(base + ":fetchStatus", token)
    require(not status.get("takenDown") and not status.get("warned"), "Chrome policy warning/takedown requires owner action")
    review = journal.read(journal.name("review", "receipt"))
    for key in ("submittedItemRevisionStatus", "publishedItemRevisionStatus"):
        revision = status.get(key, {})
        if any(c.get("crxVersion") == meta["version"] for c in revision.get("distributionChannels", [])):
            state = revision.get("state")
            require(state != "STAGED", "Chrome STAGED is held, not automatic publication: explicit owner reconciliation required; no publish/review repeated")
            require(state in ("PENDING_REVIEW", "PUBLISHED"), "Existing Chrome version needs console reconciliation")
            if state == "PENDING_REVIEW":
                # fetchStatus does not expose publishType; old/uncertain reviews may be held.
                require(review and review.get("publishType") == "DEFAULT_PUBLISH" and review.get("deployPercentage") == 100, "Chrome pending review lacks automatic-publication receipt; explicit owner reconciliation required")
            return {"store": "chrome", "version": meta["version"], "item": name, "state": state, "existing": True, "publication": "public" if state == "PUBLISHED" else "automatic-after-approval"}
    # Owner decision (2026-10-04): a new release replaces an older version still in review. Never a held, newer or
    # unrecognized submission.
    pending = status.get("submittedItemRevisionStatus")
    if pending:
        versions = [c.get("crxVersion") for c in pending.get("distributionChannels", [])]
        require(pending.get("state") == "PENDING_REVIEW" and versions and all(older(v, meta["version"]) for v in versions), "Another Chrome submission exists; only an older pending review is replaced")
        journal.once("cancel", lambda: api(base + ":cancelSubmission", token, method="POST", body={}), lambda r: {"cancelled": versions})
    require(review is None, "Chrome review receipt disagrees with current status; reconcile in console")
    uploaded = journal.once("upload", lambda: api("https://chromewebstore.googleapis.com/upload/v2/" + name + ":upload", token, method="POST", body=Path("release-out/chrome.zip").read_bytes(), content_type="application/zip"), lambda r: {"uploadState": r.get("uploadState"), "name": r.get("name"), "crxVersion": r.get("crxVersion")})
    require(not uploaded["crxVersion"] or uploaded["crxVersion"] == meta["version"], "Chrome upload version mismatch")
    state = uploaded["uploadState"]
    for _ in range(30):
        if state != "IN_PROGRESS":
            break
        pause(10)
        state = api(base + ":fetchStatus", token).get("lastAsyncUploadState")
    require(state == "SUCCEEDED", "Chrome upload not successful; no review requested")
    submitted = journal.once("review", lambda: api(base + ":publish", token, method="POST", body={"publishType": "DEFAULT_PUBLISH", "deployInfos": [{"deployPercentage": 100}], "skipReview": False, "blockOnWarnings": True}), lambda r: {"name": r.get("name"), "state": r.get("state"), "publishType": "DEFAULT_PUBLISH", "deployPercentage": 100})
    require(submitted["state"] in ("PENDING_REVIEW", "PUBLISHED"), "Chrome did not confirm automatic publication/review; reconcile in console")
    return {"store": "chrome", "version": meta["version"], "item": name, **submitted, "publication": "public" if submitted["state"] == "PUBLISHED" else "automatic-after-approval"}


def amo_token(env):
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).rstrip(b"=")
    now = int(time.time())
    data = enc({"alg": "HS256", "typ": "JWT"}) + b"." + enc({"iss": env["AMO_JWT_ISSUER"], "jti": uuid.uuid4().hex, "iat": now, "exp": now + 300})
    return (data + b"." + base64.urlsafe_b64encode(hmac.new(env["AMO_JWT_SECRET"].encode(), data, hashlib.sha256).digest()).rstrip(b"=")).decode()


def firefox(meta, env, journal, api=request, pause=time.sleep):
    base = "https://addons.mozilla.org/api/v5/addons/"
    addon = base + "addon/" + quote(env["AMO_ADDON_ID"], safe="") + "/"
    def call(url, **kw):
        return api(url, amo_token(env), auth_scheme="JWT", **kw)
    # Existing listing only: never silently create duplicate addon/listing.
    listing = call(addon)
    require(listing.get("guid") == env["AMO_ADDON_ID"], "AMO listing GUID mismatch")
    require(not any(listing.get(k) for k in ("is_disabled", "is_disabled_by_developer", "is_disabled_by_mozilla")), "AMO listing disabled; owner reconciliation required")
    version = call(addon + "versions/" + meta["version"] + "/", missing=True)
    if version:
        require(version.get("source") and version.get("channel") == "listed", "Existing AMO version lacks listed source submission")
    else:
        pending = []
        for page in range(1, 11):
            versions = call(addon + "versions/?filter=all_without_unlisted&page_size=50&page=" + str(page))
            pending += [v for v in versions["results"] if v.get("file", {}).get("status") == "unreviewed"]
            if not versions.get("next"):
                break
        else:
            raise ValueError("Too many AMO versions to safely reconcile")
        # Owner decision (2026-10-09): like Chrome, a new release replaces an older version still awaiting review
        # (developer-disabled, re-enableable in the console). Never a newer or unparseable one.
        require(all(older(v.get("version"), meta["version"]) for v in pending), "Another AMO version awaits review; only an older one is superseded")
        for v in pending:
            journal.once("disable-" + str(v["id"]), lambda v=v: call(addon + "versions/" + str(v["id"]) + "/", method="PATCH", body={"is_disabled": True}), lambda r: {"disabled": v["version"]})
        data, kind = multipart({"channel": "listed"}, {"upload": "release-out/firefox.zip"})
        upload = journal.once("upload", lambda: call(base + "upload/", method="POST", body=data, content_type=kind), lambda r: {"uuid": r["uuid"]})
        for _ in range(30):
            validated = call(base + "upload/" + upload["uuid"] + "/")
            if validated.get("processed"):
                break
            pause(10)
        require(validated.get("processed") and validated.get("valid") and not validated.get("submitted"), "AMO validation failed/pending/already submitted; inspect console")
        require(validated.get("version") == meta["version"] and validated.get("channel") == "listed", "AMO upload identity mismatch")
        data, kind = multipart({"upload": upload["uuid"], "license": "MIT"}, {"source": "release-out/firefox-source.zip"})
        created = journal.once("review", lambda: call(addon + "versions/", method="POST", body=data, content_type=kind), lambda r: {"id": r["id"]})
        version = call(addon + "versions/" + str(created["id"]) + "/")
    require(version.get("version") == meta["version"] and version.get("source") and version.get("channel") == "listed", "AMO did not confirm listed version with source")
    require(not version.get("is_disabled"), "AMO version disabled; owner reconciliation required")
    state = version.get("file", {}).get("status")
    require(state in ("unreviewed", "public"), "AMO submission rejected/disabled; not a successful review submission")
    return {"store": "firefox", "version": meta["version"], "versionId": version["id"], "state": state, "autoPublishApproved": True, "publication": "public" if state == "public" else "automatic-after-approval"}


def signed_bundle(env):
    # Only JDK signing tools get the upload key. No Gradle/npm/dependency scripts here.
    with tempfile.TemporaryDirectory() as directory:
        key = Path(directory) / "upload.keystore"
        key.write_bytes(base64.b64decode(env["ANDROID_KEYSTORE_BASE64"], validate=True))
        key.chmod(0o600)
        signing_env = {k: v for k, v in os.environ.items() if k in ("PATH", "JAVA_HOME", "HOME")}
        signing_env.update({"STORE_PASS": env["ANDROID_STORE_PASSWORD"], "KEY_PASS": env["ANDROID_KEY_PASSWORD"]})
        def run(args):
            p = subprocess.run(args, env=signing_env, capture_output=True)
            require(p.returncode == 0, "JDK signing command failed (output withheld)")
            return p.stdout
        cert = run(["keytool", "-exportcert", "-keystore", str(key), "-alias", env["ANDROID_KEY_ALIAS"], "-storepass:env", "STORE_PASS"])
        require(hashlib.sha256(cert).hexdigest().lower() == env["ANDROID_UPLOAD_CERT_SHA256"].lower(), "Wrong Android upload certificate; never rotate automatically")
        output = Path(directory) / "signed.aab"
        run(["jarsigner", "-keystore", str(key), "-storepass:env", "STORE_PASS", "-keypass:env", "KEY_PASS", "-signedjar", str(output), "release-out/android.aab", env["ANDROID_KEY_ALIAS"]])
        result = run(["jarsigner", "-verify", str(output)])
        require(b"jar verified" in result, "Signed AAB verification failed")
        return output.read_bytes()


def play(meta, env, journal, api=request, sign=signed_bundle):
    base = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.borodutch.plainwallet/edits"
    token = env["GOOGLE_ACCESS_TOKEN"]
    require(env.get("PLAY_TRACK") == "production", "Play track must be production")
    track_receipt = journal.read(journal.name("track", "receipt"))
    require(not track_receipt or track_receipt.get("track") == "production", "Existing Play track receipt is not production; explicit owner reconciliation required")
    # A committed receipt prevents replay even if review is still asynchronous.
    previous = journal.read(journal.name("commit", "receipt"))
    if previous:
        require(previous.get("track") == "production" and previous.get("managedPublishingDisabledConfirmed") is True, "Legacy Play commit lacks automatic-production publication confirmation; explicit owner reconciliation required; no resubmission")
        return {"store": "play", "version": meta["version"], "versionCode": meta["versionCode"], "editId": previous["id"], "track": "production", "state": "committed-for-review; verify Publishing overview", "publication": "automatic-after-approval; console setting owner-confirmed, not API-verified", "existing": True}
    edit = journal.once("edit", lambda: api(base, token, method="POST", body={}), lambda r: {"id": r["id"]})
    path = base + "/" + edit["id"]
    track_url = path + "/tracks/" + quote(env["PLAY_TRACK"], safe="")
    tracks = api(path + "/tracks", token).get("tracks", [])
    # No overwrites of another pending rollout. Empty track or completed releases only.
    track = next((t for t in tracks if t["track"] == env["PLAY_TRACK"]), {})
    require(all(r.get("status") == "completed" for r in track.get("releases", [])), "Play track has draft/staged rollout; reconcile manually")
    # The commit below replaces changes in review: only ever with a newer versionCode.
    require(all(int(c) <= meta["versionCode"] for r in track.get("releases", []) for c in r.get("versionCodes", [])), "Newer Play release exists; reconcile manually")
    for t in tracks:
        for r in t.get("releases", []):
            if str(meta["versionCode"]) in r.get("versionCodes", []):
                require(t["track"] == env["PLAY_TRACK"] and journal.read(journal.name("track", "receipt")), "Version already on a Play track without this journal; verify review in console")
    bundles = api(path + "/bundles", token).get("bundles", [])
    receipt = journal.read(journal.name("bundle", "receipt"))
    if not receipt:
        require(not any(b.get("versionCode") == meta["versionCode"] for b in bundles), "Existing Play versionCode without journal; do not upload twice")
        data = sign(env)
        receipt = journal.once("bundle", lambda: api("https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.borodutch.plainwallet/edits/" + edit["id"] + "/bundles?uploadType=media", token, method="POST", body=data, content_type="application/octet-stream"), lambda r: {"versionCode": r["versionCode"], "sha256": r.get("sha256")})
    require(receipt["versionCode"] == meta["versionCode"], "Play uploaded wrong versionCode")
    track_receipt = journal.once("track", lambda: api(track_url, token, method="PUT", body={"track": env["PLAY_TRACK"], "releases": [{"name": meta["version"], "versionCodes": [str(meta["versionCode"])], "status": "completed"}]}), lambda r: {"track": r["track"]})
    require(track_receipt.get("track") == "production", "Play did not confirm production track; no commit")
    journal.once("validate", lambda: api(path + ":validate", token, method="POST"), lambda r: {"valid": True})
    committed = journal.once("commit", lambda: api(path + ":commit?changesNotSentForReview=false&changesInReviewBehavior=CANCEL_IN_REVIEW_AND_SUBMIT", token, method="POST"), lambda r: {"id": r["id"], "track": "production", "managedPublishingDisabledConfirmed": True})
    return {"store": "play", "version": meta["version"], "versionCode": meta["versionCode"], "editId": committed["id"], "track": "production", "state": "committed-for-review; verify Publishing overview", "publication": "automatic-after-approval; console setting owner-confirmed, not API-verified"}


def main():
    store = sys.argv[1]
    outcome = {"store": store, "state": "failed"}
    try:
        env = os.environ
        preflight(store, env)
        require(env.get("GITHUB_EVENT_NAME") == "release", "Store credentials may only be used on release events")
        meta = json.loads(Path("release-out/release.json").read_text())
        event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
        expected = release_version(event, {"version": meta["version"]}, env["GITHUB_SHA"])
        require(all(meta[k] == v for k, v in expected.items()), "Artifact does not match immutable release")
        for name in ("chrome.zip", "firefox.zip", "firefox-source.zip", "android.aab"):
            require(hashlib.sha256((Path("release-out") / name).read_bytes()).hexdigest() == meta["sha256"][name], "Artifact hash mismatch")
        journal = Journal(store, meta, env)
        outcome = {"chrome": chrome, "firefox": firefox, "play": play}[store](meta, env, journal)
    except Exception as error:
        # Only our bounded errors are safe; never log HTTP bodies, tokens, argv or environment.
        outcome["error"] = str(error) if isinstance(error, (ValueError, APIError, RuntimeError)) else type(error).__name__ + "; inspect store console"
        raise SystemExit(1) from None
    finally:
        Path("outcome.json").write_text(json.dumps(outcome, indent=2) + "\n")
        text = json.dumps(outcome, sort_keys=True)
        print(text)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
                f.write("## Store outcome\n\n")
                f.write("\x60\x60\x60json\n" + text + "\n\x60\x60\x60\n")


if __name__ == "__main__":
    main()
