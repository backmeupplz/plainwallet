"""Credential-free Actions summary; individual stores retain their outcomes."""
import json
import os
from pathlib import Path
from build import require


def outcomes(root):
    results = {}
    paths = list(Path(root).glob("selection-*/outcome.json")) + list(Path(root).glob("outcome-*/outcome.json"))
    # Selection resets stale outcomes on a full rerun; actual results win ties.
    for p in sorted(paths, key=lambda p: (int(p.parent.name.rsplit("-", 1)[1]), p.parent.name.startswith("outcome-"))):
        value = json.loads(p.read_text())
        require(value["store"] in ("chrome", "firefox", "play"), "Invalid outcome store")
        value["attempt"] = int(p.parent.name.rsplit("-", 1)[1])
        value["evidence"] = "submission-job" if p.parent.name.startswith("outcome-") else "selection"
        results[value["store"]] = value
    return [results.get(store, {"store": store, "state": "not submitted: build/setup/authentication did not complete"}) for store in ("chrome", "firefox", "play")]


def main():
    env = os.environ
    require(env["GITHUB_EVENT_NAME"] == "release", "Report requires release event")
    event = json.loads(Path(env["GITHUB_EVENT_PATH"]).read_text())
    release = event["release"]
    title = "Store submissions: " + release["tag_name"] + " (release " + str(release["id"]) + ")"
    rows = outcomes("outcomes")
    run = "https://github.com/" + env["GITHUB_REPOSITORY"] + "/actions/runs/" + env["GITHUB_RUN_ID"]
    body = "## " + title + "\n\nStore submission outcomes. Release policy is automatic publication after approval for enabled stores; Play targets production. Only successful per-store outcomes confirm a submission request. Each outcome includes its evidence attempt; older outcomes are historical, not proof of current-attempt success. Paused/skipped stores made no submission attempt in that reported attempt. Submitted is not approved/live.\n\n"
    body += "Release: " + release["html_url"] + "\nRun: " + run + "\n\n"
    for row in rows:
        body += "### " + row["store"] + "\n\x60\x60\x60json\n" + json.dumps(row, indent=2) + "\n\x60\x60\x60\n"
    body += "\nPlay commit requests review with managed publishing disabled (owner-confirmed, not API-verified); confirm Changes in review and eventual production availability in Publishing overview. Chrome PENDING_REVIEW with a DEFAULT_PUBLISH receipt will publish after approval; STAGED or legacy/uncertain pending reviews require explicit reconciliation, not another submission. Chrome PUBLISHED and AMO public indicate public store state; pending states never prove live availability. Legacy Play commits are not proof of automatic production rollout.\n"
    with open(env["GITHUB_STEP_SUMMARY"], "a") as f:
        f.write(body)
    print(body)


if __name__ == "__main__":
    main()
