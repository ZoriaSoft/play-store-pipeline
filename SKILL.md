---
name: play-store-pipeline
description: "Google Play Console without a browser, via the Android Publisher API v3: upload an AAB to a track, promote a version code, staged rollout / halt / resume / complete, release notes in any language, store listing text, listing images (screenshots, feature graphic, icon) with sha1 readback, Data safety CSV, app details, testers, reviews and replies — plus the exact Console paths for what the API cannot do. Every step is one shell command (bun). Triggers: play console, publish, release, upload aab, rollout, promote, store listing, screenshots upload, feature graphic, data safety, reviews reply, testers, closed testing, version code, edit expired."
compatibility: any Linux/macOS/Windows host with bun ≥ 1.0 and a Google Play service account
metadata:
  author: ZoriaSoft
  version: 1.0.0
---

# Play Store Pipeline — Play Console without a browser

One CLI (`play-api.ts`) for everything the Play Console does that the **Android Publisher API v3** can also
do, and the Console paths for what it cannot (§9). Written so any model or agent can follow it with a shell only.

Setup (service account, API access, credentials): see `README.md` → *Setup*. Then:

```bash
cd <this skill dir> && bun install
export PLAY_SERVICE_ACCOUNT_KEY_FILE=/secure/path/play-sa.json   # or PLAY_SERVICE_ACCOUNT_JSON / .env / service-account.json
PKG=com.example.yourapp
bun play-api.ts tracks --package $PKG                            # read-only smoke test
```

**Never print or paste credentials.** Refer to them by variable name only.

## 1. The edit lifecycle — read this first

Almost every Play change goes through an **edit** (a draft transaction):
`edits.insert → changes → edits.validate → edits.commit`. Read-only commands, `--dry-run` and
`--validate-only` delete the edit at the end (nothing is published).

1. **Never run two edits at once for the same app.** Inserting an edit invalidates other open edits; the
   first then fails with `editId … has expired` / `This Edit has been deleted`. Serialize *every* Play call
   (including read-only ones): no parallel jobs, no background readback while an upload runs.
2. **One logical change set = one edit.** Put all locales and image types into one `images-batch` so the
   listing never shows a half-updated state.
3. Rehearse writes: `--dry-run` (plan only) → `--validate-only` (real `edits.validate`, then discard) → real run.
4. Commit fails with *"Changes cannot be sent for review automatically … changesNotSentForReview"* → re-run with
   `--not-sent-for-review`, then Console → **Publishing overview** → *Send changes for review*. With managed
   publishing on, committed changes wait there until you publish them.
5. Edits expire after ~1 h idle; just re-run (each invocation opens a fresh edit).
6. `data-safety` and `reviews` / `review-reply` are **not** edit-scoped.

## 2. Command reference

```
bun play-api.ts tracks        --package P
bun play-api.ts upload        --package P --aab app.aab --track internal [--notes en-US="…" ...]
bun play-api.ts promote       --package P --vc N --track alpha [--notes …] [--fraction F --confirm-production]
bun play-api.ts release-notes --package P --track alpha --notes en-US="…" --notes tr-TR="…"
bun play-api.ts rollout       --package P --track production --vc N (--fraction 0.2 | --resume | --complete) [--confirm-production]
                                              # --halt is exempt from --confirm-production (emergency stop)
bun play-api.ts listing-get   --package P [--lang en-US]
bun play-api.ts listing-set   --package P --lang en-US [--title T] [--short S] [--full-file F] [--video URL]
bun play-api.ts images-list   --package P [--lang en-US,tr-TR] [--types icon,featureGraphic,phoneScreenshots]
bun play-api.ts images-set    --package P --lang en-US --type phoneScreenshots --files a.png,b.png
bun play-api.ts images-batch  --package P --spec images.json
bun play-api.ts testers       --package P [--track alpha]
bun play-api.ts details       --package P [--contact-email E] [--contact-website W] [--default-lang L]
bun play-api.ts data-safety   --package P --csv data-safety.csv
bun play-api.ts reviews       --package P [--max 50]
bun play-api.ts review-reply  --package P --review-id ID --text "…"
Common: --dry-run | --validate-only | --not-sent-for-review | --confirm-production | --help
```

Release notes: `--notes LANG=TEXT` (repeatable, ≤500 chars), `--notes-file LANG=PATH`; `--notes-en` / `--notes-tr`
are kept as shortcuts. Exit codes: `0` ok, `1` API error (message printed), `2` usage error (nothing was sent).

## 3. Release flow

```bash
# 1) upload once — always to internal (or alpha) first
bun play-api.ts upload  --package $PKG --aab build/app-release.aab --track internal --notes en-US="Bug fixes" --dry-run
bun play-api.ts upload  --package $PKG --aab build/app-release.aab --track internal --notes en-US="Bug fixes"
# 2) promote the same version code — no re-upload
bun play-api.ts promote --package $PKG --vc 27 --track alpha --notes en-US="Bug fixes"
# 3) production, staged
bun play-api.ts promote --package $PKG --vc 27 --track production --fraction 0.1 --confirm-production
bun play-api.ts rollout --package $PKG --track production --vc 27 --fraction 0.5 --confirm-production
bun play-api.ts rollout --package $PKG --track production --vc 27 --complete --confirm-production
bun play-api.ts rollout --package $PKG --track production --vc 27 --halt    # emergency: no flag needed
bun play-api.ts tracks  --package $PKG                                            # readback
```

- Track ids: `internal`, `alpha` (closed), `beta` (open), `production`, plus custom closed tracks by name.
- `upload` / `promote` **replace** the releases on the target track with one release (status `completed`,
  or `inProgress` + `userFraction` with `--fraction`, or `--status draft`).
- Writing to production requires `--confirm-production` (upload, promote, release-notes, rollout; matching is case-insensitive). Only `rollout --halt` is exempt — an emergency stop must stay a single command.
- A versionCode can be uploaded **once per app, forever** (even a discarded draft burns it) — promote instead.
- Before uploading, check the signature: `keytool -printcert -jarfile app-release.aab` must show your
  **upload** certificate (not a debug one); a wrong key is rejected by Play.
- New personal developer accounts must run a closed test (12 testers × 14 days) before production access (§9).

## 4. Listing text

```bash
bun play-api.ts listing-get --package $PKG
bun play-api.ts listing-set --package $PKG --lang en-US --short "…" --full-file full_en.txt --dry-run
```
Limits: title ≤30, short ≤80, full ≤4000 chars. Fields you do not pass are kept.

## 5. Listing images

Play rules: JPEG or 24-bit PNG **without alpha**; phone screenshots 2–8 per locale, each side 320–3840 px,
long side ≤ 2× short side (1080×1920 is a safe size); feature graphic exactly **1024×500**; icon **512×512**
32-bit PNG (≤1 MB). Types: `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvScreenshots`,
`wearScreenshots`, `featureGraphic`, `promoGraphic`, `icon`, `tvBanner`.

```bash
cp examples/images.example.json images.json          # edit paths
bun play-api.ts images-batch --package $PKG --spec images.json --dry-run   # validates files, prints sha1 plan
bun play-api.ts images-batch --package $PKG --spec images.json             # deleteall + upload per entry, ONE edit
bun play-api.ts images-list  --package $PKG --lang en-US,tr-TR              # readback
```
Readback: counts must match and each local `sha1sum` must appear in `images-list` (in upload order). Locales and
types not in the spec are untouched; text and tracks are untouched. **Look at every PNG** before uploading
(clipped text, wrong locale, placeholders).

Producing screenshots is outside this CLI. A reliable pattern: build the exact release, capture on an emulator
with a fixed resolution and font scale, drive the real UI (tap by accessibility label, not coordinates), frame
the captures into store-sized PNGs, then upload with `images-batch`.

## 6. Data safety

```bash
bun play-api.ts data-safety --package $PKG --csv data-safety.csv --dry-run
bun play-api.ts data-safety --package $PKG --csv data-safety.csv            # success = HTTP 204
```
- Start from the Console export (Console → App content → Data safety → *Export to CSV*) so every question id
  exists. Both the current header (`Question ID (machine readable),…,Human-friendly question label`) and the
  legacy one (`Question ID,…,Human label`) are accepted. `examples/data-safety.example.csv` is a skeleton for an
  app that collects nothing.
- `PSL_SUPPORTED_ACCOUNT_CREATION_METHODS` → `PSL_ACM_NONE` when the app has no accounts.
- Answer `PSL_DATA_USAGE_*` rows **only** for data types you selected — extra rows are rejected ("cannot answer").
  `PSL_DATA_USAGE_EPHEMERAL` rows take `false`.
- The answers go to review with your next publish.

## 7. Details, testers, reviews

- `details` reads contact info and default language; `--contact-email`, `--contact-website`, `--default-lang`
  patch them. The privacy policy URL is **not** in the API (§9).
- `testers --track alpha` → Google Groups on the track (the API exposes groups only; email lists are Console-only).
- `reviews --max 50` → `id ★rating lang vc "text" [replied]`. The API only returns reviews **with text** from
  roughly the last 7 days. `review-reply` (≤350 chars) posts a **public** reply — get the wording approved first.

## 8. Common failures → fixes

| Symptom | Cause | Fix |
|---|---|---|
| `This Edit has been deleted` / `edit … expired` at commit | another edit was opened (parallel script, Console) or >1 h idle | serialize all Play calls; re-run |
| `APK specifies a version code that has already been used` | version code burned (any track, even a deleted draft) | bump the version code and rebuild; to move a build between tracks, `promote` |
| `The Android App Bundle was signed with the wrong key` | debug or another keystore | rebuild with the upload key; check with `keytool -printcert -jarfile` |
| `Changes cannot be sent for review automatically` | managed publishing / pending review | `--not-sent-for-review`, then Publishing overview |
| Image 400 `imageDimensionsTooLarge/Small` / aspect | outside 320–3840 px, long side >2× short, feature ≠1024×500 | resize and re-export |
| Image rejected for alpha | PNG with alpha channel | flatten to RGB (`magick in.png -background white -alpha remove -alpha off out.png`) |
| Upload rejected: target API level too low | Play's targetSdk requirement | raise `targetSdk` and rebuild |
| `HTTP 401/403` on every call | service account not invited / invite not accepted / wrong Cloud project | README → Setup §2; propagation can take hours |
| `credentials missing` (exit 2) | no credential configured | set `PLAY_SERVICE_ACCOUNT_KEY_FILE` / `PLAY_SERVICE_ACCOUNT_JSON`, `.env`, or `service-account.json` |
| Data safety `cannot answer` | answered usage rows for unselected data types | remove those rows |
| Shell/agent tool times out during a long build | foreground time limit of the agent harness | run the build detached (`nohup … &` / `Start-Process`) and poll a log |

## 9. What the API cannot do (Console only)

Play Console → select the app, then:

| Task | Console path |
|---|---|
| App access / reviewer sign-in credentials | **Policy and programs → App content → App access** |
| Content rating questionnaire (IARC) | **App content → Content rating** |
| Target audience and content | **App content → Target audience and content** |
| Ads, Government apps, Financial features, Health apps declarations | **App content → (declaration)** |
| News / Families / Photo & video permissions / Foreground service declarations | **App content → (declaration)** |
| Privacy policy URL | **App content → Privacy policy** |
| Account / data deletion URL | **App content → Data safety → Data deletion** (answers can go in the CSV; the web URL is entered in the form) |
| Policy and rejection appeals | **Policy and programs → Policy status** → issue → *Appeal* |
| Closed-testing requirement (new personal accounts) → production access | **Dashboard → Apply for production** |
| Tester email lists, opt-in link, testing countries | **Test and release → Testing → Closed/Open testing → Testers** |
| Managed publishing / send changes for review | **Publishing overview** |
| Countries/regions, pricing, in-app products UI | **Production → Countries/regions**, **Monetize** |
| Pre-launch report, Android vitals | **Test and release → Pre-launch report**, **Monitor → Android vitals** |
| Store listing experiments, custom store listings | **Grow → Store presence** |
| App signing key / upload key reset | **Test and release → App integrity → App signing** (upload key reset = support request) |
| Developer account, payments profile, identity verification | account settings (not per app) |
