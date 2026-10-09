"""Exercise the real reporting entrypoint without network or credentials."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import re
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
STORES = ("chrome", "firefox", "play")


class ReportTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        previous = Path.cwd()
        os.chdir(temp.name)
        self.addCleanup(os.chdir, previous)
        self.env = {
            "GITHUB_EVENT_NAME": "release", "GITHUB_EVENT_PATH": "event.json",
            "GITHUB_REPOSITORY": "fixture/wallet", "GITHUB_RUN_ID": "42",
            "GITHUB_RUN_ATTEMPT": "1", "GITHUB_STEP_SUMMARY": "summary.md",
        }
        Path("event.json").write_text(json.dumps({"release": {
            "id": 7, "tag_name": "v0.4.0", "html_url": "https://github.com/fixture/wallet/releases/tag/v0.4.0",
        }}))

    def put(self, prefix, store, attempt, state, **fields):
        path = Path("outcomes") / f"{prefix}-{store}-{attempt}" / "outcome.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"store": store, "state": state, **fields}))

    def report(self, attempt=1, token=False):
        env = {**self.env, "GITHUB_RUN_ATTEMPT": str(attempt)}
        if token:
            env["GH_TOKEN"] = "synthetic-unused-token"
        evidence = {p: p.read_bytes() for p in Path("outcomes").glob("*/outcome.json")}
        summary = Path("summary.md")
        summary.write_text("Existing summary\n")
        output = io.StringIO()
        # Intercept the stdlib boundary used by the old issue API client, even
        # when report imports it afresh; prohibit subprocess/network alternatives.
        with patch.dict(os.environ, env, clear=True), redirect_stdout(output), \
                patch("urllib.request.urlopen", side_effect=AssertionError("No HTTP in reports")) as http, \
                patch("socket.socket", side_effect=AssertionError("No sockets in reports")) as sockets, \
                patch("subprocess.Popen", side_effect=AssertionError("No CLI in reports")) as process:
            runpy.run_path(str(ROOT / "scripts/release/report.py"), run_name="__main__")
        http.assert_not_called()
        sockets.assert_not_called()
        process.assert_not_called()
        body = summary.read_text().removeprefix("Existing summary\n")
        self.assertTrue(summary.read_text().startswith("Existing summary\n"))
        self.assertEqual(output.getvalue(), body + "\n")
        self.assertIn("Store submissions: v0.4.0 (release 7)", body)
        self.assertIn("https://github.com/fixture/wallet/actions/runs/42", body)
        self.assertIn("https://github.com/fixture/wallet/releases/tag/v0.4.0", body)
        self.assertIn("Submitted is not approved/live", body)
        self.assertIn("older outcomes are historical", body)
        self.assertIn("pending states never prove live availability", body)
        self.assertNotIn("@backmeupplz", body)
        self.assertEqual(evidence, {p: p.read_bytes() for p in evidence})
        rows = [json.loads(value) for value in re.findall(r"```json\n(.*?)\n```", body, re.S)]
        self.assertEqual([row["store"] for row in rows], list(STORES))
        return {row["store"]: row for row in rows}

    def test_success_and_public_states_without_issue_calls(self):
        for store, state in zip(STORES, ("PENDING_REVIEW", "public", "committed-for-review; verify Publishing overview")):
            self.put("outcome", store, 1, state, publication="automatic-after-approval")
        for token in (False, True):
            with self.subTest(token_present=token):
                rows = self.report(token=token)
                self.assertEqual(rows["chrome"]["state"], "PENDING_REVIEW")
                self.assertEqual(rows["firefox"]["state"], "public")
                self.assertEqual(rows["play"]["state"], "committed-for-review; verify Publishing overview")
                self.assertTrue(all(row["evidence"] == "submission-job" for row in rows.values()))

    def test_failure_partial_and_all_paused_without_issue_calls(self):
        self.put("outcome", "chrome", 1, "PENDING_REVIEW")
        self.put("outcome", "play", 1, "failed", error="Signing failed")
        self.put("selection", "firefox", 1, "paused", submission="skipped")
        rows = self.report(token=True)
        self.assertEqual(rows["chrome"]["state"], "PENDING_REVIEW")
        self.assertEqual(rows["play"]["error"], "Signing failed")
        self.assertEqual(rows["firefox"]["submission"], "skipped")
        for store in STORES:
            self.put("outcome", store, 2, "failed", error="Setup failed")
        self.assertTrue(all(row["state"] == "failed" for row in self.report(2).values()))
        for store in STORES:
            self.put("selection", store, 3, "paused", submission="skipped")
        rows = self.report(3)
        self.assertTrue(all(row["state"] == "paused" and row["submission"] == "skipped" for row in rows.values()))

    def test_full_and_failed_only_reruns_preserve_attempt_evidence(self):
        for store in STORES:
            self.put("selection", store, 1, "paused", submission="skipped")
            self.put("selection", store, 2, "not submitted: selected, but no submission outcome recorded")
        self.put("outcome", "chrome", 2, "PENDING_REVIEW")
        self.put("outcome", "play", 2, "failed", error="Authentication failed")
        rows = self.report(2)
        self.assertEqual(rows["firefox"]["evidence"], "selection")
        self.assertTrue(rows["firefox"]["state"].startswith("not submitted: selected"))
        self.assertEqual(rows["chrome"]["evidence"], "submission-job")
        self.assertEqual(rows["play"]["error"], "Authentication failed")
        self.put("outcome", "play", 3, "committed-for-review")
        rows = self.report(3, token=True)
        self.assertEqual([rows[s]["attempt"] for s in STORES], [2, 2, 3])
        self.assertEqual(rows["chrome"]["state"], "PENDING_REVIEW")
        self.assertEqual(rows["play"]["state"], "committed-for-review")

    def test_missing_outcomes_are_not_success(self):
        rows = self.report()
        self.assertTrue(all(row["state"].startswith("not submitted:") for row in rows.values()))
        self.assertTrue(all("attempt" not in row for row in rows.values()))

    def test_workflow_keeps_reporting_and_artifacts_without_issue_permission(self):
        workflow = (ROOT / ".github/workflows/store-release.yml").read_text()
        report = workflow.split("  report:\n", 1)[1]
        self.assertNotIn("issues:", workflow)
        for forbidden in ("GH_TOKEN", "secrets.", "environment:", "id-token:"):
            self.assertNotIn(forbidden, report)
        self.assertIn("contents: read", report)
        self.assertIn("if: always()", report)
        self.assertIn("pattern: outcome-*", report)
        self.assertIn("pattern: selection-outcomes-*", report)
        self.assertIn("run: python3 scripts/release/report.py", report)
        self.assertIn("name: outcome-${{ matrix.store }}-${{ github.run_attempt }}", workflow)
        self.assertIn("retention-days: 90", workflow)
        submit = workflow.split("  submit:\n", 1)[1].split("  report:\n", 1)[0]
        self.assertIn("contents: write", submit)
        self.assertIn("id-token: write", submit)
