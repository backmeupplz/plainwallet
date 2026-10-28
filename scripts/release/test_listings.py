"""Store listings in every language (Play edit and App Store localizations) against fakes: no network or credentials."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlparse

import submit
from submit import APIError, appstore_listings, play, play_listings, sync_play_listings
from test_release import ENV, META, MemoryJournal
from test_apple_apk_fdroid import FakeAppStore, run, META as APPLE_META


def tree(files):
    root = Path(tempfile.mkdtemp())
    for name, data in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data if isinstance(data, bytes) else data.encode())
    return root


class FakePlay:
    """An edit's listings and images; fail lists (method, url fragment) answers to fail once with 503."""
    def __init__(self, listings=(), fail=()):
        self.listings = {l["language"]: dict(l) for l in listings}
        self.images = {}
        self.fail = list(fail)
        self.calls = []

    def __call__(self, url, token, method="GET", body=None, **kw):
        self.calls.append((method, url))
        for f in self.fail:
            if f[0] == method and f[1] in url:
                self.fail.remove(f)
                raise APIError(503)
        path = urlparse(url).path
        if path.endswith("/tracks"):
            return {"tracks": []}
        if path.endswith("/bundles") and method == "GET":
            return {"bundles": []}
        if "/bundles" in path:
            return {"versionCode": META["versionCode"], "sha256": "fixture"}
        if "/tracks/" in path:
            self.release = body["releases"][0]
            return {"track": "production"}
        if path.endswith("/listings"):
            return {"listings": list(self.listings.values())}
        parts = path.split("/listings/")
        if len(parts) == 2:
            language, _, kind = parts[1].partition("/")
            if not kind:
                self.listings[language] = dict(self.listings[language], **body) if method == "PATCH" else body
                return self.listings[language]
            key = (language, kind)
            if method == "GET":
                return {"images": [{"sha256": s} for s in self.images.get(key, [])]}
            if method == "DELETE":
                self.images[key] = []
                return {}
            self.images.setdefault(key, []).append(hashlib.sha256(body).hexdigest())
            return {"image": {}}
        return {"id": "edit-id"}


class ListingTests(unittest.TestCase):
    def test_play_listings_read_texts_and_images_in_numeric_order(self):
        root = tree({"de-DE/title.txt": "Plain Wallet\n", "de-DE/short_description.txt": "Kurz", "de-DE/images/featureGraphic.jpg": b"f",
                     "de-DE/images/phoneScreenshots/10.jpg": b"10", "de-DE/images/phoneScreenshots/2.jpg": b"2", "de-DE/images/phoneScreenshots/notes.txt": "x",
                     "de-DE/changelogs/505.txt": "x", "xx/changelogs/505.txt": "no listing"})
        texts, images = play_listings(root)["de-DE"]
        self.assertEqual(texts, {"title": "Plain Wallet", "shortDescription": "Kurz"})
        self.assertEqual([f.name for f in images["phoneScreenshots"]], ["2.jpg", "10.jpg"])
        self.assertEqual([f.name for f in images["featureGraphic"]], ["featureGraphic.jpg"])
        self.assertNotIn("xx", play_listings(root))

    def test_play_release_adds_every_listing_then_notes_reach_them_all(self):
        root = tree({"en-US/title.txt": "Plain Wallet", "en-US/images/phoneScreenshots/1.jpg": b"en1",
                     "de-DE/title.txt": "Plain Wallet DE", "de-DE/full_description.txt": "Lang", "de-DE/images/phoneScreenshots/1.jpg": b"de1", "de-DE/images/phoneScreenshots/2.jpg": b"de2"})
        fake = FakePlay([{"language": "en-US", "title": "Plain Wallet"}], fail=[("POST", "de-DE/phoneScreenshots")])
        result = play(META, ENV, MemoryJournal(), fake, sign=lambda e: b"aab", logs={"en-US": "Faster.", "de-DE": "Schneller."}, listings=play_listings(root))
        self.assertEqual(fake.listings["de-DE"], {"language": "de-DE", "title": "Plain Wallet DE", "fullDescription": "Lang"})
        self.assertEqual(fake.images[("de-DE", "phoneScreenshots")], [hashlib.sha256(b"de1").hexdigest(), hashlib.sha256(b"de2").hexdigest()], "a 503 rewrites the kind, without duplicates")
        self.assertEqual(result["listing"], ["de-DE", "de-DE phoneScreenshots", "en-US phoneScreenshots"])
        self.assertEqual(fake.release["releaseNotes"], [{"language": "de-DE", "text": "Schneller."}, {"language": "en-US", "text": "Faster."}])
        # In sync: only reads
        fake.calls = []
        self.assertEqual(sync_play_listings(fake, "t", "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/x/edits/e", play_listings(root)), [])
        self.assertEqual({m for m, _ in fake.calls}, {"GET"})

    def test_play_text_update_keeps_what_the_repo_lacks(self):
        edit = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/x/edits/e"
        fake = FakePlay([{"language": "en-US", "title": "Plain Wallet", "video": "https://youtu.be/x"}])
        self.assertEqual(sync_play_listings(fake, "t", edit, play_listings(tree({"en-US/title.txt": "Plain Wallet 2", "de-DE/title.txt": "Plain Wallet DE"}))), ["de-DE", "en-US"])
        self.assertEqual([c for c in fake.calls if c[0] != "GET"], [("PUT", edit + "/listings/de-DE"), ("PATCH", edit + "/listings/en-US")])
        self.assertEqual(fake.listings["en-US"], {"language": "en-US", "title": "Plain Wallet 2", "video": "https://youtu.be/x"})

    def test_play_client_error_is_not_retried(self):
        root = tree({"en-US/title.txt": "Plain Wallet", "en-US/images/phoneScreenshots/1.jpg": b"en1"})
        fake = FakePlay()
        def api(url, token, method="GET", **kw):
            if method == "POST" and "phoneScreenshots" in url:
                raise APIError(400)
            return fake(url, token, method=method, **kw)
        with self.assertRaises(APIError):
            sync_play_listings(api, "t", "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/x/edits/e", play_listings(root))
        self.assertEqual(sum(1 for m, u in fake.calls if m == "DELETE"), 1)

    def test_appstore_listings_read_sections_and_screenshots(self):
        root = tree({"listing.md": "# x\n\n## Name (max 30)\nPlain Wallet\n\n## Description (max 4000)\nOne.\n\nTwo.\n",
                     "de-DE/listing.md": "## Name (max 30)\nPlain Wallet DE\n", "screenshots/de-DE/2.jpg": b"2", "screenshots/de-DE/1.jpg": b"1",
                     "screenshots/de-DE/duo-outer/1.jpg": b"duo"})
        listings = appstore_listings(root)
        self.assertEqual(listings["en-US"], ({"Name": "Plain Wallet", "Description": "One.\n\nTwo."}, []))
        self.assertEqual([f.name for f in listings["de-DE"][1]], ["1.jpg", "2.jpg"], "Duo sets stay in the repo; the API has no Duo type")


class FakeListingStore(FakeAppStore):
    """FakeAppStore plus app infos, localizations and screenshot sets."""
    def __init__(self, *a, social=True, **kw):
        super().__init__(*a, **kw)
        self.social = social
        self.locs = {"appStoreVersionLocalizations": {}, "appInfoLocalizations": {}}
        self.sets, self.shots, self.put = {}, {}, []
        self.reject = False

    def localizations(self, kind, parent):
        return [{"id": i, "attributes": l} for i, l in self.locs[kind].items() if l["parent"] == parent]

    def __call__(self, path, method="GET", body=None, **kw):
        url = urlparse(path)
        parts = url.path.split("/")
        attrs = (body or {}).get("data", {}).get("attributes", {})
        if parts[0] == "apps" and parts[2] == "appInfos":
            return {"data": [{"id": "live-info", "attributes": {"state": "READY_FOR_DISTRIBUTION"}}, {"id": "info", "attributes": {"state": "PREPARE_FOR_SUBMISSION"}}]}
        if parts[0] == "appInfos" and parts[2] == "ageRatingDeclaration":
            return {"data": {"attributes": {"socialMedia": False if self.social else None}}}
        if parts[0] in ("appInfos", "appStoreVersions") and parts[-1].endswith("Localizations"):
            return {"data": self.localizations(parts[-1], parts[1])}
        if parts[0] in self.locs and len(parts) <= 2:
            self.writes.append((method, url.path, attrs))
            if method == "POST":
                i = "l" + str(sum(len(v) for v in self.locs.values()) + 1)
                parent = next(iter(body["data"]["relationships"].values()))["data"]["id"]
                self.locs[parts[0]][i] = dict(attrs, parent=parent)
                return {"data": {"id": i}}
            self.locs[parts[0]][parts[1]].update(attrs)
            return {}
        if parts[0] == "appStoreVersionLocalizations" and parts[-1] == "appScreenshotSets":
            return {"data": [{"id": s, "attributes": {"screenshotDisplayType": "APP_IPHONE_67"}} for s, loc in self.sets.items() if loc == parts[1]]}
        if parts[0] == "appScreenshotSets" and len(parts) == 3:
            return {"data": [{"id": i, "attributes": {"sourceFileChecksum": s["sum"], "assetDeliveryState": {"state": s.get("state", "COMPLETE" if s["sum"] else "AWAITING_UPLOAD")}}} for i, s in self.shots.items() if s["set"] == parts[1]]}
        if parts[0] == "appScreenshotSets":
            self.writes.append((method, url.path, attrs))
            i = "set" + str(len(self.sets) + 1)
            self.sets[i] = body["data"]["relationships"]["appStoreVersionLocalization"]["data"]["id"]
            return {"data": {"id": i}}
        if parts[0] == "appScreenshots":
            self.writes.append((method, url.path, attrs))
            if method == "DELETE":
                del self.shots[parts[1]]
                return {}
            if method == "POST":
                i = "shot" + str(len(self.shots) + 100 + len(self.writes))
                self.shots[i] = {"set": body["data"]["relationships"]["appScreenshotSet"]["data"]["id"], "sum": None}
                return {"data": {"id": i, "attributes": {"uploadOperations": [{"url": "https://up.apple.com/" + i, "method": "PUT", "offset": 0, "length": attrs["fileSize"]}]}}}
            self.shots[parts[1]]["sum"] = attrs["sourceFileChecksum"]
            if self.reject:  # Apple's check of the file fails
                self.shots[parts[1]]["state"] = "FAILED"
            return {}
        return super().__call__(path, method=method, body=body, **kw)


class AppStoreListingTests(unittest.TestCase):
    def setUp(self):
        root = tree({"listing.md": "## Name (max 30)\nPlain Wallet\n\n## Subtitle (max 30)\nWallet\n\n## Keywords (max 100)\neth\n\n## Description (max 4000)\nEnglish.\n",
                     "de-DE/listing.md": "## Name (max 30)\nPlain Wallet DE\n\n## Keywords (max 100)\nkrypto\n\n## Promotional text (max 170)\nNeu.\n\n## Description (max 4000)\nDeutsch.\n",
                     "screenshots/de-DE/1.jpg": b"de1", "screenshots/de-DE/2.jpg": b"de2"})
        self.listings = appstore_listings(root)

    def store(self, **kw):
        fake = FakeListingStore([{"id": "ios", "platform": "IOS", "versionString": "0.5.1", "state": "WAITING_FOR_REVIEW"}, {"id": "mac", "platform": "MAC_OS", "versionString": "0.5.1", "state": "PREPARE_FOR_SUBMISSION"}],
                                [{"id": "old", "platform": "IOS", "state": "WAITING_FOR_REVIEW", "versions": ["ios"]}], **kw)
        fake.locs["appStoreVersionLocalizations"]["en-ios"] = {"locale": "en-US", "parent": "ios", "description": "Old.", "supportUrl": "https://s", "marketingUrl": "https://m"}
        fake.locs["appInfoLocalizations"]["en-info"] = {"locale": "en-US", "parent": "info", "name": "Plain Wallet", "subtitle": "Wallet", "privacyPolicyUrl": "https://p"}
        return fake

    def test_every_locale_and_its_screenshots_go_on_the_version_before_review(self):
        fake = self.store()
        outcome = submit.appstore(APPLE_META, {"ASC_KEY_P8": "x", "ASC_KEY_ID": "i", "ASC_ISSUER_ID": "s"}, MemoryJournal("appstore"), {}, api=fake, upload=fake.upload,
                                  pause=lambda s: None, listings=self.listings, put=lambda op, data: fake.put.append((op["url"], data)))
        ios, mac = outcome["platforms"]
        self.assertEqual(ios["listing"], {"names": ["de-DE"], "texts": ["de-DE", "en-US"], "screenshots": ["de-DE"]})
        self.assertEqual(mac["listing"]["screenshots"], [], "the Mac shows the primary language's screenshots")
        de_info = next(l for l in fake.locs["appInfoLocalizations"].values() if l["locale"] == "de-DE")
        self.assertEqual((de_info["name"], de_info["privacyPolicyUrl"]), ("Plain Wallet DE", "https://p"))
        de_ios = next(l for l in fake.locs["appStoreVersionLocalizations"].values() if l["locale"] == "de-DE" and l["parent"] == "ios")
        self.assertEqual((de_ios["keywords"], de_ios["promotionalText"], de_ios["supportUrl"]), ("krypto", "Neu.", "https://s"))
        self.assertEqual([d for _, d in fake.put], [b"de1", b"de2"])
        self.assertEqual(sorted(s["sum"] for s in fake.shots.values()), sorted(hashlib.md5(b).hexdigest() for b in (b"de1", b"de2")))
        # Listings come before the review submission
        order = [w[1].split("/")[0] for w in fake.writes]
        self.assertLess(max(i for i, k in enumerate(order) if k == "appScreenshots"), order.index("reviewSubmissions", order.index("appScreenshots")))

    def test_in_sync_listing_writes_nothing_more(self):
        fake = self.store()
        put = lambda op, data: fake.put.append(data)
        listing = lambda platform, version: submit.sync_appstore_listing(fake, platform, version, self.listings, put)
        listing("ios", "ios")
        writes = len(fake.writes)
        self.assertEqual(listing("ios", "ios"), {"texts": [], "screenshots": []})
        self.assertEqual(len(fake.writes), writes)

    def test_a_screenshot_apple_rejects_stops_the_release(self):
        fake = self.store()
        fake.reject = True
        with self.assertRaisesRegex(ValueError, "rejected a screenshot of de-DE"):
            submit.sync_appstore_listing(fake, "ios", "ios", self.listings, lambda op, data: None, lambda s: None)

    def test_unanswered_social_media_question_stops_before_anything_changes(self):
        fake = self.store(social=False)
        with self.assertRaisesRegex(ValueError, "socialMedia"):
            submit.appstore(APPLE_META, {"ASC_KEY_P8": "x", "ASC_KEY_ID": "i", "ASC_ISSUER_ID": "s"}, MemoryJournal("appstore"), {}, api=fake, upload=fake.upload,
                            pause=lambda s: None, listings=self.listings, put=lambda op, data: None)
        self.assertEqual(fake.writes, [], "nothing changes before the check")
        self.assertEqual(fake.submissions["old"]["state"], "WAITING_FOR_REVIEW", "the older version stays in review")

    def test_age_rating_is_read_from_the_live_app_info_between_releases(self):
        fake, read = self.store(), []
        def api(path, **kw):
            read.append(path)
            return {"data": [{"id": "live-info", "attributes": {"state": "READY_FOR_DISTRIBUTION"}}]} if path.endswith("/appInfos") else fake(path, **kw)
        self.assertTrue(submit.social_media_answered(api))
        self.assertIn("appInfos/live-info/ageRatingDeclaration", read)
        with self.assertRaisesRegex(ValueError, "No editable"):
            submit.pending_app_info(api)

    def test_names_already_live_need_no_editable_app_info(self):
        fake = self.store()
        submit.sync_app_info(fake, self.listings)
        writes = len(fake.writes)
        # the version went live, so its app info is the newest (next to a replaced one, without the names): a rerun (the
        # Mac job's, say) has nothing to write
        infos = [{"id": "old-info", "attributes": {"state": "REPLACED_WITH_NEW_INFO"}}, {"id": "info", "attributes": {"state": "READY_FOR_DISTRIBUTION"}}]
        live = lambda path, **kw: {"data": infos} if path.endswith("/appInfos") else fake(path, **kw)
        self.assertEqual(submit.sync_app_info(live, self.listings), [])
        self.assertEqual(len(fake.writes), writes)
        # a name that differs still needs one
        next(l for l in fake.locs["appInfoLocalizations"].values() if l["locale"] == "de-DE")["name"] = "Old"
        with self.assertRaisesRegex(ValueError, "No editable"):
            submit.sync_app_info(live, self.listings)

    def test_every_older_review_is_pulled_before_the_shared_names_change(self):
        fake = self.store()
        fake.versions["mac"]["state"] = "WAITING_FOR_REVIEW"
        fake.submissions["oldmac"] = {"id": "oldmac", "platform": "MAC_OS", "state": "WAITING_FOR_REVIEW", "versions": ["mac"]}
        outcome = submit.appstore(APPLE_META, {"ASC_KEY_P8": "x", "ASC_KEY_ID": "i", "ASC_ISSUER_ID": "s"}, MemoryJournal("appstore"), {}, api=fake, upload=fake.upload,
                                  pause=lambda s: None, listings=self.listings, put=lambda op, data: None)
        self.assertEqual([p["state"] for p in outcome["platforms"]], ["WAITING_FOR_REVIEW", "WAITING_FOR_REVIEW"])
        order = [w[1] for w in fake.writes]
        uploads = [i for i, w in enumerate(fake.writes) if w[0] == "upload"]
        cancels = [order.index("reviewSubmissions/old"), order.index("reviewSubmissions/oldmac")]
        self.assertLess(max(uploads), min(cancels), "both builds are in before any review is pulled")
        self.assertLess(max(cancels), next(i for i, p in enumerate(order) if p.startswith("appInfoLocalizations")))

    def test_a_newer_mac_submission_stops_before_the_ios_review_is_pulled(self):
        fake = self.store()
        fake.versions["mac2"] = {"platform": "MAC_OS", "versionString": "0.5.3", "state": "WAITING_FOR_REVIEW"}
        fake.submissions["newmac"] = {"id": "newmac", "platform": "MAC_OS", "state": "WAITING_FOR_REVIEW", "versions": ["mac2"]}
        with self.assertRaisesRegex(ValueError, "only an older one is replaced"):
            submit.appstore(APPLE_META, {"ASC_KEY_P8": "x", "ASC_KEY_ID": "i", "ASC_ISSUER_ID": "s"}, MemoryJournal("appstore"), {}, api=fake, upload=fake.upload,
                            pause=lambda s: None, listings=self.listings, put=lambda op, data: None)
        self.assertEqual(fake.submissions["old"]["state"], "WAITING_FOR_REVIEW", "iOS stays in review")


if __name__ == "__main__":
    unittest.main()
