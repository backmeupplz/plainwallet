"""Credential-free release validation and packaging (stdlib only)."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile


def require(ok, message):
    if not ok:
        raise ValueError(message)


def release_version(event, package, sha):
    r = event.get("release", {})
    require(event.get("action") == "published" and not r.get("draft", True) and not r.get("prerelease", True), "Only published stable releases are accepted")
    v = package["version"]
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", v), "Version must be canonical major.minor.patch")
    major, minor, patch = map(int, v.split("."))
    code = major * 10000 + minor * 100 + patch
    require(major <= 65535 and minor < 100 and patch < 100 and 0 < code <= 2100000000, "Version exceeds existing Android mapping")
    require(r.get("tag_name") == "v" + v, "Release tag/package version mismatch")
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "Expected immutable commit SHA")
    return {"version": v, "versionCode": code, "sha": sha, "releaseId": r["id"]}


def validate_manifest(m, version, browser):
    require(m["version"] == version, "Built manifest version mismatch")
    require(m["manifest_version"] == 3, "Expected MV3")
    if browser == "firefox":
        require(m["browser_specific_settings"]["gecko"]["id"] == "plainwallet@backmeupplz", "Firefox identity changed")


def archive(directory, target):
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(Path(directory).rglob("*")):
            if p.is_file():
                info = zipfile.ZipInfo(p.relative_to(directory).as_posix(), (2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                z.writestr(info, p.read_bytes())


def proto_fields(data):
    # Read only Android's XmlNode/XmlElement/XmlAttribute raw strings, no generated code.
    # Schema: AOSP tools/aapt2/Resources.proto. Unknown fields are skipped.
    i = 0
    def varint():
        nonlocal i
        n = 0
        for shift in range(0, 70, 7):
            require(i < len(data), "Truncated protobuf")
            b = data[i]
            i += 1
            n |= (b & 127) << shift
            if b < 128:
                return n
        raise ValueError("Invalid protobuf varint")
    fields = {}
    while i < len(data):
        key = varint()
        field, wire = key >> 3, key & 7
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else {1: 8, 5: 4}[wire]
            require(i + size <= len(data), "Truncated protobuf field")
            value = data[i:i + size]
            i += size
        else:
            raise ValueError("Unsupported protobuf wire type")
        fields.setdefault(field, []).append(value)
    return fields


def validate_android(data, meta):
    element = proto_fields(proto_fields(data)[1][0])
    require(element[3] == [b"manifest"], "Expected Android manifest")
    attrs = {}
    for raw in element.get(4, []):
        a = proto_fields(raw)
        name = a[2][0].decode()
        namespace = a.get(1, [b""])[0].decode()
        attrs[(namespace, name)] = a.get(3, [b""])[0].decode()
    android = "http://schemas.android.com/apk/res/android"
    require(attrs.get(("", "package")) == "com.borodutch.plainwallet", "AAB package mismatch")
    require(attrs.get((android, "versionName")) == meta["version"], "AAB versionName mismatch")
    require(attrs.get((android, "versionCode")) == str(meta["versionCode"]), "AAB versionCode mismatch")


def main():
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    package = json.loads(Path("package.json").read_text())
    if os.environ["GITHUB_EVENT_NAME"] == "release":
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        require(sha == os.environ["GITHUB_SHA"], "Checkout differs from event commit")
        meta = release_version(event, package, sha)
        tag = subprocess.check_output(["git", "rev-list", "-n", "1", "refs/tags/v" + meta["version"]], text=True).strip()
        require(tag == sha, "Tag moved since release event")
    else:
        require(sys.argv[1] == "ci", "Submission requires release event")
        meta = release_version({"action": "published", "release": {"draft": False, "prerelease": False, "tag_name": "v" + package["version"], "id": 0}}, package, sha)
    out = Path("release-out")
    out.mkdir(exist_ok=True)
    for browser in ("chrome", "firefox"):
        directory = Path(".output") / (browser + "-mv3")
        validate_manifest(json.loads((directory / "manifest.json").read_text()), meta["version"], browser)
        archive(directory, out / (browser + ".zip"))
    subprocess.run(["git", "archive", "--format=zip", "--output=" + str(out / "firefox-source.zip"), sha], check=True)
    aab = Path("android/app/build/outputs/bundle/release/app-release.aab")
    require(aab.is_file(), "Unsigned release AAB missing")
    gradle = Path("android/app/build.gradle.kts").read_text()
    require('applicationId = "com.borodutch.plainwallet"' in gradle and 'versionName = version' in gradle and 'major * 10000 + minor * 100 + patch' in gradle, "Android identity/mapping changed")
    with zipfile.ZipFile(aab) as z:
        validate_android(z.read("base/manifest/AndroidManifest.xml"), meta)
        require(not any(n.upper().startswith("META-INF/") and n.upper().endswith((".RSA", ".DSA", ".EC")) for n in z.namelist()), "Build must not sign AAB")
    (out / "android.aab").write_bytes(aab.read_bytes())
    meta["sha256"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.name != "release.json"}
    (out / "release.json").write_text(json.dumps(meta, indent=2) + "\n")


if __name__ == "__main__":
    main()
