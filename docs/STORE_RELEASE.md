# Store releases: setup required

The workflow is **not proof that any store is configured, submitted, approved or live**. No credentials are bundled. Before enabling it, the owner must confirm the existing listings and publication choices below. Never put credentials in issues, PRs, ticket text or release notes. Use the corresponding **GitHub environment secrets**, or provide them through the dedicated OpenClaw Vaultwarden collection for authorized setup. Wallet seeds/private keys are never needed.

## Owner decisions and prerequisites

1. Confirm ownership of Play `com.borodutch.plainwallet`, Chrome `pmnbalegifiefmohkolfpclnmkooifcp` and Firefox GUID `plainwallet@backmeupplz`. Supply Chrome publisher ID. Do not create replacement listings.
2. Which existing **Play track** should receive updates? Recommend production with **managed publishing enabled** (review now, manual public release later). Confirm Play App Signing enrollment and the current approved upload certificate SHA-256, keystore, alias, store password and key password. The upload key is not necessarily the installed-app signing key. Do not generate/reset/rotate either key. Confirm the versionCode ceiling across *all* tracks before the next release.
3. Should approval automatically publish? This implementation holds Chrome using **STAGED_PUBLISH** and requires Play managed publishing. It never performs their final rollout. **AMO's listed Version Create API has no documented review-only hold**: listed versions can become public automatically after approval. Explicitly approve that behavior or leave Firefox disabled. If automatic Chrome/Play rollout is desired, request a separately reviewed change; do not disable managed publishing to bypass this gate.
4. Supply the dedicated Google service accounts/WIF provider identifiers and authorize those identities in the existing stores. For AMO supply API issuer/secret from an account authorized for the existing listing. Confirm listing metadata/privacy/reviewer instructions are complete.

## GitHub protection, permissions and trigger

Create environments **store-chrome**, **store-play**, **store-firefox** in Settings → Environments *before* releasing. Require owner review, prevent self-review/bypass where available, restrict deployments to protected `v*` tags, and protect those tags against deletion/updates and unreviewed creation. Require reviewed PRs and green build CI before tagging. An environment name alone is **not** protection: GitHub otherwise auto-creates it without rules. The approver must check the released SHA/workflow/scripts, artifacts and store gates on every approval.

All environments: set variable `STORE_SETUP_CONFIRMED=true` only after these checks. Store secrets must exist only in that store's environment (not repository/org-wide secrets exposed to other jobs). The build job has read-only contents permission, no environment and no OIDC. Submission runs on fresh runners without npm/Gradle/dependency execution; only Python stdlib and JDK signing tools. No build cache is restored in privileged jobs. Actions are pinned to full commits; review pin updates.

Google jobs use short-lived OIDC tokens, not service-account JSON keys. Submit jobs require `contents:write` solely to append the small idempotency journal assets to the **existing** release. Report needs `issues:write` to notify `@backmeupplz` in one report issue per release. GitHub cannot grant release-assets-only permissions, so protecting the environment and released workflow is essential. Enable GitHub Issues and notifications for mentions. Reports are also in the Actions summary and per-store outcome artifacts.

Only **release.published**, with `draft=false` and `prerelease=false`, submits. PR and main pushes run the same credential-free tests/build/package checks but never access store environments. Drafts/prereleases are ignored. Promotion by merely editing a prerelease does not emit the supported published event: prepare a new, higher stable version/tag and publish its stable release. No manual submission dispatch is provided. Do not create a throwaway release to test. Merge the workflow first, then include it in the next real release's reviewed commit.

Use canonical `vMAJOR.MINOR.PATCH` matching package.json. The immutable event SHA must equal the checkout and current tag target; moved tags fail. Generated Chrome/Firefox manifests and the actual AAB protobuf manifest must match. The existing Android mapping is preserved: `major*10000 + minor*100 + patch`; minor/patch must be 0–99, versionCode must be positive and within Play limits. Never reuse an existing store version or replace a tag to repair a release. No app code, vault format or identity is changed.

## Google OIDC setup (separate accounts per store)

In a dedicated Google Cloud project:

- Enable IAM, IAM Service Account Credentials, Security Token Service, and the relevant **Google Play Android Developer API** / **Chrome Web Store API**.
- Create a separate service account for each store, without broad project Owner/Editor roles or downloadable keys.
- Create a Workload Identity Pool OIDC provider for `https://token.actions.githubusercontent.com`. Map `google.subject=assertion.sub` plus repository ID, repository owner ID, repository, ref and workflow_ref attributes. Restrict its condition to this repository's **numeric repository and owner IDs**, `refs/tags/v...`, the exact `backmeupplz/plainwallet/.github/workflows/store-release.yml@` workflow path, and its corresponding environment subject `repo:backmeupplz/plainwallet:environment:store-play` (or `store-chrome`). Fetch IDs from GitHub repository metadata; do not substitute a name-only trust rule vulnerable to repository reuse.
- Grant only the matching external principal `roles/iam.workloadIdentityUser` on that dedicated service account. Scope the binding to the environment/repository, not the whole pool. Do not grant project-wide Token Creator. The pinned auth action impersonates the authorized account and requests only that store's scope.
- Environment variables: `GOOGLE_WIF_PROVIDER` = full `projects/NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER`; `GOOGLE_SERVICE_ACCOUNT` = dedicated service-account email.

### Play: store-play

Play Console → Users and permissions: invite the service-account email, grant access **only** to `com.borodutch.plainwallet`. Grant view app information and the release permission for the selected track (production: **Release to production, exclude devices, and use Play App Signing**; testing: **Release apps to testing tracks**). Do not grant admin, financial, user-management or unrelated app access. API enablement alone does not grant Play Console permission. Initial listing, content declarations, app access/reviewer instructions, privacy/data safety and any first-release requirements must already be complete.

Variables:

| Name | Required value |
|---|---|
| `PLAY_TRACK` | Existing intended track, usually `production`; `internal` refused because it is not review submission |
| `PLAY_MANAGED_PUBLISHING_CONFIRMED` | `true` only while Publishing overview shows managed publishing enabled; recheck each approval |
| `PLAY_APP_SIGNING_CONFIRMED` | `true` after verifying enrollment/upgrade identity |
| `ANDROID_UPLOAD_CERT_SHA256` | Current approved upload certificate fingerprint, 64 hexadecimal characters, no colons |

Secrets: `ANDROID_KEYSTORE_BASE64` (existing upload keystore, base64 encoded), `ANDROID_KEY_ALIAS`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_PASSWORD`. The README alias is an example, not proof of the real alias. GitHub's secret size limit applies: do not truncate a large keystore; arrange a reviewed secure provisioning alternative instead. The signer verifies the certificate fingerprint before signing an AAB with jarsigner, verifies the signed result, uploads it, and removes the temporary key/output. Gradle never sees this key. This does not change the separately distributed APK signer or release APK process.

The API creates an edit, uploads AAB, updates the selected track to completed, validates and commits with `changesNotSentForReview=false`. It **never** retries with true (that would only save a draft). An API error remains failed/actionable. Managed publishing is an external prerequisite: there is no asserted API proof of its setting here. A successful commit is reported as **committed-for-review; verify Publishing overview**, not “approved” or “live.” The Android Publisher API does not expose the review queue state; the owner must confirm **Changes in review** in Publishing overview and record that proof in the report issue, especially for the first enabled release. If Console says **Changes not yet sent for review**, use its Send for review action and record that the API alone was insufficient; do not call that fully automated. Keep managed publishing enabled until an explicit owner rollout decision.

### Chrome: store-chrome

In the existing Chrome Web Store publisher account settings, authorize/link the dedicated service-account email using Chrome's service-account setup. Copy the publisher ID from the dashboard; verify that its account owns the existing item. Variables: `CHROME_PUBLISHER_ID` and `CHROME_ITEM_ID=pmnbalegifiefmohkolfpclnmkooifcp`, plus Google WIF variables above. The API scope is `https://www.googleapis.com/auth/chromewebstore`. Confirm listing/privacy declarations, distribution settings and reviewer instructions in Dashboard first.

This implementation intentionally supports the service-account/OIDC path only. If the owner cannot authorize a service account and instead supplies an OAuth client ID/client secret/refresh token for an authorized publisher account, **do not paste them into tickets or use a long-lived access-token variable**. Store them in the dedicated collection and request a reviewed OAuth authentication adapter before enabling Chrome. No such secrets are required for the OIDC path.

Upload uses v2 media.upload; only SUCCEEDED proceeds. Publish uses `STAGED_PUBLISH`, `skipReview=false`, `blockOnWarnings=true`. PENDING_REVIEW means submitted; STAGED means approved but held; PUBLISHED means public. Reruns inspect the exact version and never publish again when staged (another publish could make it public). Other pending versions, rejected/cancelled versions and policy warnings require manual reconciliation.

### AMO: store-firefox

Use an AMO account listed as an author of the existing GUID, preferably a dedicated release account with no unrelated add-ons. Generate API credentials in the AMO developer hub. Secrets: `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. Variables: `AMO_ADDON_ID=plainwallet@backmeupplz`; `AMO_AUTO_PUBLISH_APPROVED=true` **only after explicit owner consent**. JWTs are short-lived and never printed.

Existing listing metadata must contain name, summary, categories for compatible applications and appropriate license/privacy details. The workflow will not create an initial listing: if the GUID does not exist, the owner must complete first-listing metadata and establish that exact GUID first, without duplicating a listing. MIT license is submitted with each new version. Complete reviewer build notes using the reproduction instructions below.

The workflow uploads to listed, waits for processed+valid, verifies version/channel, then creates the version **with the source zip in the same multipart request**. Upload validation alone is not success. Source must be present in the resulting version. `unreviewed` is awaiting review; `public` is approved and may be live; `disabled` is failure/requires investigation. No documented hold parameter is invented and no after-the-fact disabling is used as a fake review hold.

## Reproduce and verify without credentials

Linux Ubuntu 24.04, Node **22.16.0**, npm supplied with that Node release, Python 3, JDK 21 and Android SDK with API 36. The Gradle wrapper, distribution hash and dependency verification metadata are checked in. Never weaken dependency verification to make CI pass.

```sh
npm ci
npm test
python3 -m unittest discover -s scripts/release -p 'test_*.py'
npm run build
npm exec -- wxt build -b firefox --mv3
(cd android && ./gradlew --no-daemon --dependency-verification strict bundleRelease)
GITHUB_EVENT_NAME=push python3 scripts/release/build.py ci
```

AMO reviewers: unpack `firefox-source.zip`; use the pinned Node version, `npm ci` then `npm exec -- wxt build -b firefox --mv3`. Compare the resulting `.output/firefox-mv3/` files to the submitted zip (manifest at zip root). No Android SDK is needed for Firefox. The source zip is `git archive` of the exact commit: includes lockfile, .npmrc, sources and these instructions; excludes node_modules, caches, build output and untracked secrets. Extension zip entries have fixed timestamps and ordering. CI builds/tests both extensions and the unsigned AAB, packages them, and verifies their versions/identity. It does not emulate an authenticated store or prove store acceptance.

## Reruns, partial failures and recovery

- Matrix fail-fast is off. Each store has an isolated environment, timeout and outcome. The report preserves successful stores if another fails; GitHub's run still fails for failed stores. Prefer **Re-run failed jobs**, retaining the original unsigned artifact. Rebuilding may produce a different Android binary hash; the journal rejects different bytes for the same release rather than uploading them under the old version.
- Concurrency serializes releases. GitHub retains only one pending run per concurrency group: **wait for the prior release to finish before publishing another**; do not flood new releases. The workflow never edits tags or creates releases.
- Each mutating operation first appends `submission-STORE-OP-started.json` to the existing release, then writes a receipt. These contain commit/version, artifact hashes and store IDs/states, **never credentials**. They are deliberately public audit/recovery evidence. The release must allow appending assets (GitHub immutable-release asset locks are incompatible; do not disable protection silently). A failed journal write prevents the store write. Never delete or overwrite these assets routinely.
- GET retries are bounded to three, honor numeric Retry-After up to two minutes; mutations are **never automatically retried**, including 429. A started marker without a receipt is ambiguous even after a timeout: stop and inspect the exact store version/edit/upload before changing anything. Never delete a marker just to “unstick” a run.
- If remote state confirms success, record the exact remote ID/result and original release metadata as the missing receipt after owner-reviewed reconciliation, or finish the submission manually and record proof. If remote state proves no write happened, an owner may explicitly authorize journal repair/retry; preserve the failed evidence outside the release first. Expired Play edits, conflicting manual store changes, validation failures and uncertain Chrome draft uploads are deliberate blockers, not “success.” A new reviewed fix needs a higher version, not tag replacement.
- Chrome/AMO exact-version lookups avoid repeating submissions. Play commit receipts prevent duplicate edits after commit; without proof, an existing versionCode fails rather than silently claiming success. Do not operate the store consoles concurrently with a run.
- Per-store outcome artifacts retain for 90 days; the release journal persists. The report issue mentions the owner and distinguishes submission, approval and public availability. Later asynchronous approvals arrive through the stores' own notifications; this workflow does not poll forever or claim an approval watcher.

Official contracts checked for this implementation: [Chrome upload](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload), [Chrome publish/staged behavior](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish), [Chrome status](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/fetchStatus), [Chrome service accounts](https://developer.chrome.com/docs/webstore/using-api), [Play commit](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit), [Play managed publishing](https://support.google.com/googleplay/android-developer/answer/9859654), [AMO version/source/upload APIs](https://mozilla.github.io/addons-server/topics/api/addons.html), [AMO JWT](https://mozilla.github.io/addons-server/topics/api/auth.html).
