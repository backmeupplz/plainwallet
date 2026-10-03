"""One notification issue per release; individual stores retain their outcomes."""
import json
import os
from pathlib import Path
from submit import request
from build import require


def outcomes(root):
    results = {}
    for p in sorted(Path(root).glob("outcome-*/outcome.json"), key=lambda p: int(p.parent.name.rsplit("-", 1)[1])):
        value = json.loads(p.read_text())
        require(value["store"] in ("chrome", "firefox", "play"), "Invalid outcome store")
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
    body = "@backmeupplz — store submission outcomes. Release policy is automatic publication after approval for enabled stores; Play targets production. Only successful per-store outcomes confirm a submission request. Paused/skipped stores made no submission attempt in that reported attempt. Submitted is not approved/live.\n\n"
    body += "Release: " + release["html_url"] + "\nRun: " + run + "\n\n"
    for row in rows:
        body += "### " + row["store"] + "\n\x60\x60\x60json\n" + json.dumps(row, indent=2) + "\n\x60\x60\x60\n"
    body += "\nPlay commit requests review with managed publishing disabled (owner-confirmed, not API-verified); confirm Changes in review and eventual production availability in Publishing overview. Chrome PENDING_REVIEW with a DEFAULT_PUBLISH receipt will publish after approval; STAGED or legacy/uncertain pending reviews require explicit reconciliation, not another submission. Chrome PUBLISHED and AMO public indicate public store state; pending states never prove live availability. Legacy Play commits are not proof of automatic production rollout.\n"
    with open(env["GITHUB_STEP_SUMMARY"], "a") as f:
        f.write(body)
    base = "https://api.github.com/repos/" + env["GITHUB_REPOSITORY"] + "/issues"
    token = env["GH_TOKEN"]
    found = None
    for page in range(1, 11):
        issues = request(base + "?state=all&per_page=100&page=" + str(page), token)
        found = next((i for i in issues if i["title"] == title and i.get("user", {}).get("login") == "github-actions[bot]"), None)
        if found or len(issues) < 100:
            break
    else:
        raise ValueError("Too many issues to safely deduplicate report")
    if found:
        if found.get("body") != body:
            request(found["url"], token, method="PATCH", body={"body": body})
    else:
        request(base, token, method="POST", body={"title": title, "body": body})


if __name__ == "__main__":
    main()
