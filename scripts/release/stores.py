"""Credential-free submission policy. Firefox, F-Droid and the App Store stay paused until the owner enables them."""
import json
import os
from pathlib import Path

from build import require

STORES = ("chrome", "firefox", "play", "apk", "fdroid", "appstore")
# Missing config keeps these paused: Firefox by owner decision, F-Droid until its merge request exists,
# the App Store until its protected environment and key are set up (docs/STORE_RELEASE.md).
PAUSED_BY_DEFAULT = ("firefox", "fdroid", "appstore")


def paused(store, env):
    require(store in STORES, "Unknown store")
    value = env.get("STORE_" + store.upper() + "_PAUSED", "")
    # Missing config must preserve a default pause. Typos fail closed.
    value = value or ("true" if store in PAUSED_BY_DEFAULT else "false")
    require(value in ("true", "false"), "Store pause control must be true or false")
    return value == "true"


def paused_outcome(store):
    return {"store": store, "state": "paused", "submission": "skipped", "reason": "Owner pause; no store access or submission attempted"}


def main():
    # Owner authorized v0.2.5 for Chrome only. Bind this cap to the immutable tag,
    # not mutable pause variables: full reruns must never acquire Play/AMO environments.
    chrome_only = os.environ.get("GITHUB_REF") == "refs/tags/v0.2.5"
    enabled = [store for store in STORES if not paused(store, os.environ) and (not chrome_only or store == "chrome")]
    # The App Store needs a macOS runner and the Apple archives, so it gets a job of its own.
    matrix = [store for store in enabled if store != "appstore"]
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("stores=" + json.dumps(matrix) + "\n")
        output.write("has_stores=" + str(bool(matrix)).lower() + "\n")
        output.write("appstore=" + str("appstore" in enabled).lower() + "\n")
    for store in STORES:
        directory = Path("selection-outcomes") / ("selection-" + store + "-" + os.environ["GITHUB_RUN_ATTEMPT"])
        directory.mkdir(parents=True, exist_ok=True)
        outcome = paused_outcome(store) if store not in enabled else {"store": store, "state": "not submitted: selected, but no submission outcome recorded"}
        (directory / "outcome.json").write_text(json.dumps(outcome) + "\n")


if __name__ == "__main__":
    main()
