import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from report import outcomes
from stores import STORES, paused

ROOT = Path(__file__).resolve().parents[2]


class StoreSelectionTests(unittest.TestCase):
    def select(self, variables):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        env = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(root / "output"), "GITHUB_RUN_ATTEMPT": "2", **variables}
        result = subprocess.run([sys.executable, str(ROOT / "scripts/release/stores.py")], cwd=root, env=env, capture_output=True, text=True)
        return root, result

    def test_defaults_pause_firefox_without_any_credentials(self):
        root, result = self.select({})
        self.assertEqual(result.returncode, 0, result.stderr)
        output = dict(line.split("=", 1) for line in (root / "output").read_text().splitlines())
        self.assertEqual(json.loads(output["stores"]), ["chrome", "play"])
        self.assertEqual(output["has_stores"], "true")
        rows = {r["store"]: r for r in outcomes(root / "selection-outcomes")}
        self.assertEqual(rows["firefox"]["state"], "paused")
        self.assertEqual(rows["firefox"]["submission"], "skipped")
        self.assertNotEqual(rows["chrome"]["state"], "paused")
        self.assertTrue(paused("firefox", {"STORE_FIREFOX_PAUSED": ""}))

    def test_explicit_reenable_retains_all_stores(self):
        root, result = self.select({"STORE_FIREFOX_PAUSED": "false"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('stores=["chrome", "firefox", "play"]', (root / "output").read_text())
        self.assertTrue(all("selected" in r["state"] for r in outcomes(root / "selection-outcomes")))

    def test_all_paused_emits_no_matrix_jobs_and_three_outcomes(self):
        root, result = self.select({"STORE_" + s.upper() + "_PAUSED": "true" for s in STORES})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / "output").read_text(), "stores=[]\nhas_stores=false\n")
        self.assertEqual([r["state"] for r in outcomes(root / "selection-outcomes")], ["paused"] * 3)

    def test_v025_is_chrome_only_even_after_pause_controls_are_restored(self):
        for variables in ({}, {"STORE_" + s.upper() + "_PAUSED": "false" for s in STORES}):
            root, result = self.select({**variables, "GITHUB_REF": "refs/tags/v0.2.5"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "output").read_text(), 'stores=["chrome"]\nhas_stores=true\n')
            rows = {r["store"]: r for r in outcomes(root / "selection-outcomes")}
            for store in ("firefox", "play"):
                self.assertEqual(rows[store]["submission"], "skipped")
                self.assertEqual(rows[store]["state"], "paused")
        root, result = self.select({"GITHUB_REF": "refs/tags/v0.2.5", "STORE_CHROME_PAUSED": "true"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((root / "output").read_text(), "stores=[]\nhas_stores=false\n")
        # Later general releases can restore Play intentionally; Firefox remains paused by default.
        root, result = self.select({"GITHUB_REF": "refs/tags/v0.2.6", "STORE_PLAY_PAUSED": "false"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('stores=["chrome", "play"]', (root / "output").read_text())

    def test_invalid_configuration_fails_before_output(self):
        for value in ("TRUE", "False", "yes", " false "):
            root, result = self.select({"STORE_FIREFOX_PAUSED": value})
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "output").exists())
            self.assertFalse((root / "selection-outcomes").exists())

    def test_pause_report_preserves_other_store_success_and_failure(self):
        root, result = self.select({})
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = root / "selection-outcomes"
        for store, state in (("chrome", "PENDING_REVIEW"), ("play", "failed")):
            d = folder / ("outcome-" + store + "-2")
            d.mkdir()
            (d / "outcome.json").write_text(json.dumps({"store": store, "state": state}))
        # Older Firefox result must not override a newer pause.
        d = folder / "outcome-firefox-1"
        d.mkdir()
        (d / "outcome.json").write_text(json.dumps({"store": "firefox", "state": "unreviewed"}))
        self.assertEqual({r["store"]: r["state"] for r in outcomes(folder)}, {"chrome": "PENDING_REVIEW", "firefox": "paused", "play": "failed"})

    def test_workflow_selection_precedes_environment_and_secrets(self):
        workflow = (ROOT / ".github/workflows/store-release.yml").read_text()
        select = workflow.split("  select-stores:\n", 1)[1].split("  submit:\n", 1)[0]
        self.assertNotIn("secrets.", select)
        self.assertNotIn("environment:", select)
        self.assertNotIn("id-token:", select)
        self.assertIn("github.event_name == 'release'", select)
        self.assertIn("!github.event.release.prerelease", select)
        self.assertIn("!github.event.release.draft", select)
        self.assertIn("if: needs.select-stores.outputs.has_stores == 'true'", workflow)
        self.assertIn("needs: [build, select-stores]", workflow)
        self.assertIn("store: ${{ fromJSON(needs.select-stores.outputs.stores) }}", workflow)
        self.assertIn("fail-fast: false", workflow)
        self.assertIn("needs: [build, select-stores, submit]", workflow)
        self.assertIn("pattern: selection-outcomes-*", workflow)
        self.assertIn("merge-multiple: true", workflow)
