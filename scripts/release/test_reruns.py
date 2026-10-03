import json
import tempfile
import unittest
from pathlib import Path
from report import outcomes

class RerunTests(unittest.TestCase):
    def test_reenable_cannot_reuse_pause_and_partial_rerun_keeps_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def put(prefix, store, attempt, state):
                d = root / (prefix + "-" + store + "-" + str(attempt))
                d.mkdir()
                (d / "outcome.json").write_text(json.dumps({"store": store, "state": state}))
            put("selection", "firefox", 1, "paused")
            put("selection", "firefox", 2, "not submitted: selected")
            row = next(r for r in outcomes(root) if r["store"] == "firefox")
            self.assertEqual(row["state"], "not submitted: selected")
            self.assertEqual(row["attempt"], 2)
            self.assertEqual(row["evidence"], "selection")
            put("outcome", "firefox", 2, "failed")
            put("outcome", "chrome", 2, "PENDING_REVIEW")
            put("outcome", "play", 2, "failed")
            put("outcome", "play", 3, "committed-for-review")
            rows = {r["store"]: r for r in outcomes(root)}
            self.assertEqual(rows["firefox"]["state"], "failed")
            self.assertEqual(rows["firefox"]["evidence"], "submission-job")
            self.assertEqual(rows["chrome"]["state"], "PENDING_REVIEW")
            self.assertEqual(rows["chrome"]["attempt"], 2)
            self.assertEqual(rows["play"]["attempt"], 3)

    def test_early_failure_without_checkout_preserves_existing_outcome(self):
        import os
        import subprocess
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/store-release.yml").read_text()
        step = workflow.split("      - name: Record early submission failure without credentials" + chr(10), 1)[1].split("      - uses:", 1)[0]
        self.assertIn("if: always()", step)
        script = chr(10).join(line[10:] for line in step.split("        run: |" + chr(10), 1)[1].splitlines())
        with tempfile.TemporaryDirectory() as temp:
            env = {"PATH": os.environ["PATH"], "STORE": "firefox"}
            result = subprocess.run(["bash", "-c", script], cwd=temp, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            p = Path(temp) / "outcome.json"
            self.assertEqual(json.loads(p.read_text())["state"], "failed")
            p.write_text(json.dumps({"store": "firefox", "state": "unreviewed"}))
            subprocess.run(["bash", "-c", script], cwd=temp, env=env, check=True)
            self.assertEqual(json.loads(p.read_text())["state"], "unreviewed")
