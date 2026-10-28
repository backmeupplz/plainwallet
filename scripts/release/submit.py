"""Isolated store submission. No third-party Python packages or build tool execution.

Every remote mutation has an append-only write-ahead marker and receipt on the
GitHub release. An uncertain write fails closed; it is never retried.
"""
import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
import uuid

from build import require, release_version, BUNDLE_ID, TEAM


class APIError(Exception):
    def __init__(self, status, reason=""):
        self.status = status
        super().__init__("HTTP " + str(status) + (": " + reason if reason else "") + "; inspect store console")


def error_reason(e):
    """The store's own error message from a JSON error (Google, App Store Connect, AMO), never the raw body"""
    try:
        data = json.loads(e.read(65536))
    except Exception:
        return ""
    if not isinstance(data, dict):
        return ""
    error, errors = data.get("error"), data.get("errors")
    if isinstance(error, dict):
        reason = str(error.get("status", "")) + " " + str(error.get("message", ""))
    elif isinstance(errors, list) and errors and isinstance(errors[0], dict):
        reason = str(errors[0].get("code", "")) + " " + str(errors[0].get("detail", ""))
    else:
        reason = str(data.get("detail", ""))
    return " ".join(reason.split())[:300]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token, method="GET", body=None, content_type="application/json", missing=False, auth_scheme="Bearer"):
    require(urlparse(url).scheme == "https" and urlparse(url).hostname in ("api.github.com", "uploads.github.com", "chromewebstore.googleapis.com", "androidpublisher.googleapis.com", "addons.mozilla.org", "api.appstoreconnect.apple.com"), "Unexpected API host")
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    headers = {"Authorization": auth_scheme + " " + token, "Accept": "application/json", "User-Agent": "plainwallet-release", "Content-Type": content_type}
    for attempt in range(3 if method == "GET" else 1):
        try:
            with build_opener(NoRedirect).open(Request(url, data=body, method=method, headers=headers), timeout=90) as r:
                data = r.read()
                return json.loads(data) if data else {}
        except HTTPError as e:
            reason = error_reason(e)
            e.close()  # Do not leave an error body/response for GC warnings or logging.
            if missing and e.code == 404:
                return None
            if method == "GET" and e.code in (429, 500, 502, 503, 504) and attempt < 2:
                delay = e.headers.get("Retry-After", str(2 ** (attempt + 1)))
                require(delay.isdigit() and int(delay) <= 120, "Retry-After requires later operator retry")
                time.sleep(int(delay))
                continue
            raise APIError(e.code, reason) from None
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
    elif store == "apk":
        needed(env, "ANDROID_KEYSTORE_BASE64", "ANDROID_KEY_ALIAS", "ANDROID_STORE_PASSWORD", "ANDROID_KEY_PASSWORD", "ANDROID_UPLOAD_CERT_SHA256")
        require(re.fullmatch(r"[0-9A-Fa-f]{64}", env["ANDROID_UPLOAD_CERT_SHA256"]), "Upload certificate SHA256 must be 64 hex characters")
    elif store == "fdroid":
        needed(env, "GITLAB_TOKEN", "FDROID_MR", "FDROID_APP_ID", "FDROID_FORK", "FDROID_BRANCH")
        require(env["FDROID_MR"].isdigit() and env["FDROID_APP_ID"] == BUNDLE_ID, "Unexpected F-Droid merge request configuration")
    elif store == "appstore":
        needed(env, "ASC_KEY_P8", "ASC_KEY_ID", "ASC_ISSUER_ID")
    else:
        raise ValueError("Unknown store")


class Journal:
    def __init__(self, store, meta, env):
        self.store, self.meta, self.env = store, meta, env
        self.base = "https://api.github.com/repos/" + env["GITHUB_REPOSITORY"]
        # The journal is on the GitHub release of the tag. Releases published on Forgejo carry Forgejo's release id,
        # so the GitHub one is looked up; on GitHub it must be the event's own release.
        release = self.api(self.base + "/releases/tags/" + quote("v" + meta["version"], safe=""))
        require(not release["draft"] and not release["prerelease"], "GitHub release must be published and stable")
        require(env.get("GITHUB_SERVER_URL", "https://github.com") != "https://github.com" or release["id"] == meta["releaseId"], "GitHub release differs from the event's release")
        self.release_id = release["id"]
        self.release = self.base + "/releases/" + str(self.release_id)
        self.load()

    def load(self):
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
        url = "https://uploads.github.com/repos/" + self.env["GITHUB_REPOSITORY"] + "/releases/" + str(self.release_id) + "/assets?" + urlencode({"name": name})
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
    # Owner decision (2026-10-04, 2026-10-10): a new release replaces an older version still in review, or one that was
    # rejected or cancelled (nothing to cancel then). Never a held, newer or unrecognized submission.
    pending = status.get("submittedItemRevisionStatus")
    if pending:
        versions = [c.get("crxVersion") for c in pending.get("distributionChannels", [])]
        require(pending.get("state") in ("PENDING_REVIEW", "REJECTED", "CANCELLED") and versions and all(older(v, meta["version"]) for v in versions), "Another Chrome submission exists; only an older pending, rejected or cancelled one is replaced")
        if pending["state"] == "PENDING_REVIEW":
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


@contextmanager
def upload_key(env):
    # Only JDK/Android SDK signing tools get the upload key. No Gradle/npm/dependency scripts here.
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
        yield key, run, Path(directory)


def signed_bundle(env):
    with upload_key(env) as (key, run, directory):
        output = directory / "signed.aab"
        run(["jarsigner", "-keystore", str(key), "-storepass:env", "STORE_PASS", "-keypass:env", "KEY_PASS", "-signedjar", str(output), "release-out/android.aab", env["ANDROID_KEY_ALIAS"]])
        result = run(["jarsigner", "-verify", str(output)])
        require(b"jar verified" in result, "Signed AAB verification failed")
        return output.read_bytes()


def signed_apk(env):
    # apksigner (Android SDK build-tools) for the v2/v3 signatures Android 11+ needs; same key as the AAB and earlier APKs.
    # No v1 (minSdk 30) and Gradle's zip layout kept, so F-Droid can copy the signature onto its own build and verify it.
    tools = sorted(Path(os.environ["ANDROID_HOME"], "build-tools").glob("*/apksigner"))
    require(tools, "apksigner not found in the Android SDK")
    with upload_key(env) as (key, run, directory):
        output = directory / "signed.apk"
        run([str(tools[-1]), "sign", "--ks", str(key), "--ks-key-alias", env["ANDROID_KEY_ALIAS"], "--ks-pass", "env:STORE_PASS", "--key-pass", "env:KEY_PASS", "--v1-signing-enabled", "false", "--alignment-preserved", "--out", str(output), "release-out/android.apk"])
        certs = run([str(tools[-1]), "verify", "--print-certs", str(output)]).decode()
        require("certificate SHA-256 digest: " + env["ANDROID_UPLOAD_CERT_SHA256"].lower() in certs, "Signed APK verification failed")
        return output.read_bytes()


def apk(meta, env, journal, sign=signed_apk):
    # The README and F-Droid (Binaries) use the versioned name; the site links releases/latest/download/plainwallet.apk.
    names = ("plainwallet-" + meta["version"] + "-android.apk", "plainwallet.apk")
    done = [journal.read(journal.name("asset-" + name, "receipt")) for name in names]
    if not all(done):
        data = sign(env)
        url = "https://uploads.github.com/repos/" + env["GITHUB_REPOSITORY"] + "/releases/" + str(journal.release_id) + "/assets?"
        done = [journal.once("asset-" + name, lambda name=name: journal.api(url + urlencode({"name": name}), method="POST", body=data, content_type="application/vnd.android.package-archive"), lambda r: {"name": r["name"], "size": r["size"], "sha256": hashlib.sha256(data).hexdigest()}) for name in names]
    require([d["name"] for d in done] == list(names) and done[0]["sha256"] == done[1]["sha256"], "APK assets disagree; reconcile the release")
    return {"store": "apk", "version": meta["version"], "assets": list(names), "sha256": done[0]["sha256"], "state": "attached", "publication": "public"}


def fdroid(meta, env, journal, run=subprocess.run, pause=time.sleep):
    # F-Droid verifies its build against the versioned APK (Binaries), which the apk job attaches in parallel.
    name = "plainwallet-" + meta["version"] + "-android.apk"
    for _ in range(40):
        if name in journal.assets:
            break
        pause(30)
        journal.load()
    require(name in journal.assets, "Release APK missing: the apk store must attach it before F-Droid can verify the build")
    # No journal: fdroid.py compares the merge request's metadata and pushes only a change, so a rerun is a no-op.
    child = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
    child.update({k: env[k] for k in ("GITLAB_TOKEN", "FDROID_MR", "FDROID_APP_ID", "FDROID_FORK", "FDROID_BRANCH")})
    p = run([sys.executable, str(Path(__file__).with_name("fdroid.py")), meta["version"], str(meta["versionCode"]), meta["sha"]], env=child, capture_output=True, text=True)
    print(p.stdout)
    require(p.returncode == 0, "F-Droid merge request update failed: " + (p.stderr.strip().splitlines() or ["see log"])[-1])
    return {"store": "fdroid", "version": meta["version"], "mergeRequest": int(env["FDROID_MR"]), "state": (p.stdout.strip().splitlines() or ["updated"])[-1], "publication": "after F-Droid merges, builds and verifies it"}


APP_STORE_APP = "6817506091"
PLATFORMS = {"ios": "IOS", "macos": "MAC_OS"}
# Owner decision (2026-10-16): a new release replaces an older version still waiting for or in review.
OPEN_REVIEW = ("WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES")
EDITABLE = ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY")
PENDING = ("WAITING_FOR_REVIEW", "IN_REVIEW", "READY_FOR_REVIEW", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE", "WAITING_FOR_EXPORT_COMPLIANCE")


def asc_token(key, env):
    # ES256 through the openssl CLI: the stdlib can't sign with EC keys.
    def enc(obj):
        return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).rstrip(b"=")
    now = int(time.time())
    data = enc({"alg": "ES256", "kid": env["ASC_KEY_ID"], "typ": "JWT"}) + b"." + enc({"iss": env["ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"})
    p = subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(key)], input=data, capture_output=True)
    require(p.returncode == 0, "Could not sign the App Store Connect token")
    der = p.stdout  # SEQUENCE { INTEGER r, INTEGER s }
    i = 3 if der[1] & 0x80 else 2
    r = der[i + 2:i + 2 + der[i + 1]]
    j = i + 2 + der[i + 1]
    s = der[j + 2:j + 2 + der[j + 1]]
    return (data + b"." + base64.urlsafe_b64encode(r.lstrip(b"\0").rjust(32, b"\0") + s.lstrip(b"\0").rjust(32, b"\0")).rstrip(b"=")).decode()


def export_upload(platform, key, env):
    # Apple's own tools only: cloud signing with the API key, and the export uploads the build itself.
    with tempfile.TemporaryDirectory() as directory:
        subprocess.run(["ditto", "-x", "-k", "release-out-apple/" + platform + ".xcarchive.zip", directory], check=True)
        options = Path(directory) / "ExportOptions.plist"
        options.write_bytes(plistlib.dumps({"method": "app-store-connect", "destination": "upload", "teamID": TEAM, "signingStyle": "automatic", "uploadSymbols": True, "manageAppVersionAndBuildNumber": False}))
        p = subprocess.run(["xcodebuild", "-exportArchive", "-archivePath", str(Path(directory) / (platform + ".xcarchive")), "-exportOptionsPlist", str(options), "-exportPath", str(Path(directory) / "export"), "-allowProvisioningUpdates", "-authenticationKeyPath", str(key), "-authenticationKeyID", env["ASC_KEY_ID"], "-authenticationKeyIssuerID", env["ASC_ISSUER_ID"]], capture_output=True, text=True, timeout=2700)
        print("\n".join((p.stdout + p.stderr).splitlines()[-30:]))
        require(p.returncode == 0, "Apple export/upload failed; inspect App Store Connect builds before any rerun")
    return {"uploaded": True}


# App Review rejects mentions of other platforms (2.3.10), which release notes often have.
# Localized notes spell them in their own scripts too.
OTHER_PLATFORMS = re.compile(r"android|chrome|firefox|google|play store|edge|brave|f-droid"
                             r"|安卓|谷歌|火狐|アンドロイド|グーグル|クローム|ファイアフォックス|안드로이드|구글|크롬|파이어폭스"
                             r"|андроид|андроїд|гугл|хром|файрфокс|أندرويد|اندرويد|جوجل|غوغل|كروم|فايرفوكس"
                             r"|एंड्रॉयड|एंड्रॉइड|गूगल|क्रोम|แอนดรอยด์|กูเกิล|โครม", re.I)
# Release notes in each store language: fastlane/metadata/android/<Play language>/changelogs/<versionCode>.txt, which
# F-Droid shows too. The App Store gets them under its own locale codes.
CHANGELOGS = Path("fastlane/metadata/android")
APPLE_LOCALES = {"ar": "ar-SA", "de-DE": "de-DE", "en-GB": "en-GB", "en-US": "en-US", "es-419": "es-MX", "es-ES": "es-ES", "fr-FR": "fr-FR",
                 "hi-IN": "hi", "id": "id", "it-IT": "it", "ja-JP": "ja", "ko-KR": "ko", "nl-NL": "nl-NL", "pl-PL": "pl", "pt-BR": "pt-BR",
                 "pt-PT": "pt-PT", "ru-RU": "ru", "sv-SE": "sv", "th": "th", "tr-TR": "tr", "uk": "uk", "vi": "vi", "zh-CN": "zh-Hans", "zh-TW": "zh-Hant"}


def app_store_notes(event):
    text = (event.get("release", {}).get("body") or "").replace("\r", "").strip().split("\n\n")[0][:4000]
    return text if text and not OTHER_PLATFORMS.search(text) else "Fixes and improvements."


def changelogs(meta, root=CHANGELOGS):
    """Play language -> this version's release notes, for the languages that have them."""
    files = sorted(root.glob("*/changelogs/" + str(meta["versionCode"]) + ".txt")) if root.is_dir() else []
    return {f.parts[-3]: text for f in files if (text := f.read_text(encoding="utf-8").replace("\r", "").strip())}


def whats_new(event, logs):
    """App Store locale -> What's New: its language's notes without the lines naming another platform, else English's,
    else the release's own text."""
    def safe(text):
        return "\n".join(line for line in text.split("\n") if not OTHER_PLATFORMS.search(line)).strip()[:4000]
    notes = {APPLE_LOCALES[language]: safe(text) for language, text in logs.items() if language in APPLE_LOCALES}
    fallback = notes.get("en-US") or app_store_notes(event)
    return lambda locale: notes.get(locale) or fallback


def appstore_platform(meta, journal, platform, api, upload, notes, pause):
    p = PLATFORMS[platform]
    def versions():
        return api("apps/" + APP_STORE_APP + "/appStoreVersions?filter[platform]=" + p + "&limit=50&fields[appStoreVersions]=versionString,appStoreState")["data"]
    def state(v):
        return v["attributes"]["appStoreState"]
    mine = [v for v in versions() if v["attributes"]["versionString"] == meta["version"] and state(v) not in EDITABLE]
    if mine:
        return {"platform": platform, "version": meta["version"], "state": state(mine[0]), "existing": True}
    builds = api("builds?filter[app]=" + APP_STORE_APP + "&filter[preReleaseVersion.platform]=" + p + "&limit=200&fields[builds]=version,processingState")["data"]
    upload_receipt = journal.read(journal.name("upload-" + platform, "receipt"))
    if not upload_receipt:
        numbers = [int(b["attributes"]["version"]) for b in builds if b["attributes"]["version"].isdigit()]
        require(all(n < meta["versionCode"] for n in numbers), "App Store already has a build numbered " + str(meta["versionCode"]) + " or higher; reconcile, never reuse it")
    journal.once("upload-" + platform, lambda: upload(platform), lambda r: {"build": meta["versionCode"]})
    for _ in range(90):
        found = api("builds?filter[app]=" + APP_STORE_APP + "&filter[version]=" + str(meta["versionCode"]) + "&filter[preReleaseVersion.version]=" + meta["version"] + "&filter[preReleaseVersion.platform]=" + p + "&fields[builds]=processingState")["data"]
        processing = found[0]["attributes"]["processingState"] if found else "PROCESSING"
        require(processing in ("PROCESSING", "VALID"), "App Store processing of build " + str(meta["versionCode"]) + " failed: " + processing)
        if processing == "VALID":
            build = found[0]["id"]
            break
        pause(40)
    else:
        raise ValueError("Build still processing; rerun the failed job later")
    for submission in api("reviewSubmissions?filter[app]=" + APP_STORE_APP + "&filter[platform]=" + p + "&filter[state]=" + ",".join(OPEN_REVIEW))["data"]:
        items = api("reviewSubmissions/" + submission["id"] + "/items?include=appStoreVersion&fields[appStoreVersions]=versionString")
        names = [i["attributes"]["versionString"] for i in items.get("included", []) if i["type"] == "appStoreVersions"]
        require(names and all(older(n, meta["version"]) for n in names), "Another App Store submission is open; only an older one is replaced")
        journal.once("cancel-" + platform + "-" + submission["id"], lambda submission=submission: api("reviewSubmissions/" + submission["id"], method="PATCH", body={"data": {"type": "reviewSubmissions", "id": submission["id"], "attributes": {"canceled": True}}}), lambda r, names=names: {"cancelled": names})
    for _ in range(30):
        current = versions()
        if not any(state(v) in ("WAITING_FOR_REVIEW", "IN_REVIEW") for v in current):
            break
        pause(20)
    else:
        raise ValueError("Cancelled App Store review still pending; rerun the failed job later")
    editable = [v for v in current if state(v) in EDITABLE]
    require(len(editable) <= 1 and not any(state(v) in PENDING for v in current), "App Store version state needs console reconciliation")
    attributes = {"versionString": meta["version"], "releaseType": "AFTER_APPROVAL"}
    if editable:
        version = editable[0]["id"]
        api("appStoreVersions/" + version, method="PATCH", body={"data": {"type": "appStoreVersions", "id": version, "attributes": attributes}})
    else:
        version = journal.once("version-" + platform, lambda: api("appStoreVersions", method="POST", body={"data": {"type": "appStoreVersions", "attributes": {"platform": p, **attributes}, "relationships": {"app": {"data": {"type": "apps", "id": APP_STORE_APP}}}}}), lambda r: {"id": r["data"]["id"]})["id"]
    api("appStoreVersions/" + version + "/relationships/build", method="PATCH", body={"data": {"type": "builds", "id": build}})
    if any(state(v) == "READY_FOR_SALE" for v in current):  # a first version can't have What's New
        for localization in api("appStoreVersions/" + version + "/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale")["data"]:
            api("appStoreVersionLocalizations/" + localization["id"], method="PATCH", body={"data": {"type": "appStoreVersionLocalizations", "id": localization["id"], "attributes": {"whatsNew": notes(localization.get("attributes", {}).get("locale"))}}})
    ready = api("reviewSubmissions?filter[app]=" + APP_STORE_APP + "&filter[platform]=" + p + "&filter[state]=READY_FOR_REVIEW")["data"]
    submission = ready[0]["id"] if ready else journal.once("submission-" + platform, lambda: api("reviewSubmissions", method="POST", body={"data": {"type": "reviewSubmissions", "attributes": {"platform": p}, "relationships": {"app": {"data": {"type": "apps", "id": APP_STORE_APP}}}}}), lambda r: {"id": r["data"]["id"]})["id"]
    items = api("reviewSubmissions/" + submission + "/items?include=appStoreVersion")
    if not any(i["id"] == version for i in items.get("included", []) if i["type"] == "appStoreVersions"):
        journal.once("item-" + platform, lambda: api("reviewSubmissionItems", method="POST", body={"data": {"type": "reviewSubmissionItems", "relationships": {"reviewSubmission": {"data": {"type": "reviewSubmissions", "id": submission}}, "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version}}}}}), lambda r: {"id": r["data"]["id"]})
    submitted = journal.once("review-" + platform, lambda: api("reviewSubmissions/" + submission, method="PATCH", body={"data": {"type": "reviewSubmissions", "id": submission, "attributes": {"submitted": True}}}), lambda r: {"id": submission, "state": r["data"]["attributes"]["state"]})
    require(submitted["state"] in ("WAITING_FOR_REVIEW", "IN_REVIEW", "COMPLETE"), "App Store did not confirm the review submission; reconcile in App Store Connect")
    return {"platform": platform, "version": meta["version"], "build": meta["versionCode"], "submission": submission, "state": submitted["state"]}


def appstore(meta, env, journal, event, api=None, upload=None, pause=time.sleep):
    with tempfile.TemporaryDirectory() as directory:
        key = Path(directory) / "AuthKey.p8"
        key.write_text(env["ASC_KEY_P8"])
        key.chmod(0o600)
        call = api or (lambda path, **kw: request("https://api.appstoreconnect.apple.com/v1/" + path, asc_token(key, env), **kw))
        send = upload or (lambda platform: export_upload(platform, key, env))
        notes = whats_new(event, changelogs(meta))
        results = [appstore_platform(meta, journal, platform, call, send, notes, pause) for platform in PLATFORMS]
    return {"store": "appstore", "version": meta["version"], "platforms": results, "state": ", ".join(r["platform"] + ": " + r["state"] for r in results), "publication": "automatic-after-approval"}


def play(meta, env, journal, api=request, sign=signed_bundle, logs=None):
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
    # Notes go only to the languages the listing has (Play refuses others), up to 500 characters each.
    listed = {listing.get("language") for listing in api(path + "/listings", token).get("listings", [])}
    notes = [{"language": language, "text": text[:500]} for language, text in sorted((changelogs(meta) if logs is None else logs).items()) if language in listed]
    release = {"name": meta["version"], "versionCodes": [str(meta["versionCode"])], "status": "completed", **({"releaseNotes": notes} if notes else {})}
    track_receipt = journal.once("track", lambda: api(track_url, token, method="PUT", body={"track": env["PLAY_TRACK"], "releases": [release]}), lambda r: {"track": r["track"]})
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
        for name in ("chrome.zip", "firefox.zip", "firefox-source.zip", "android.aab", "android.apk"):
            require(hashlib.sha256((Path("release-out") / name).read_bytes()).hexdigest() == meta["sha256"][name], "Artifact hash mismatch")
        journal = Journal(store, meta, env)
        if store == "appstore":
            apple = json.loads(Path("release-out-apple/apple.json").read_text())
            require(all(apple[k] == meta[k] for k in ("version", "versionCode", "sha", "releaseId")), "Apple archives do not match immutable release")
            for name in ("ios.xcarchive.zip", "macos.xcarchive.zip"):
                require(hashlib.sha256((Path("release-out-apple") / name).read_bytes()).hexdigest() == apple["sha256"][name], "Apple archive hash mismatch")
            outcome = appstore(meta, env, journal, event)
        else:
            outcome = {"chrome": chrome, "firefox": firefox, "play": play, "apk": apk, "fdroid": fdroid}[store](meta, env, journal)
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
