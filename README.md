# Play Store Pipeline

**Google Play Console without a browser.** A small Bun/TypeScript CLI over the official
**Android Publisher API v3** — and an agent skill (`SKILL.md`) that teaches an AI coding agent to use it.

Upload an AAB, promote a version code across tracks, run a staged rollout (halt / resume / complete), set
release notes in any language, edit the store listing, replace screenshots / feature graphic / icon for
many locales in one atomic edit (with sha1 readback), submit the Data safety form as CSV, read testers, read
and reply to reviews. Also documents exactly which Console tasks the API **cannot** do.

```text
$ bun play-api.ts tracks --package com.example.app
edit 01234567890123456789
production => completed:vc=12 "1.2.0"
alpha => completed:vc=13 "1.3.0" notes[en-US,de-DE]
edit 01234567890123456789 deleted (nothing published)
```

- **Safe by default:** read-only commands discard their edit; `--dry-run` prints the plan; `--validate-only`
  runs Play's own validation and discards; production needs `--confirm-production`.
- **One edit per invocation**, validated before commit, deleted on any failure — no half-applied changes.
- **No browser automation, no scraping** — only the official API with a service account.
- Single dependency: [`googleapis`](https://www.npmjs.com/package/googleapis).

## Setup

### 1. Requirements

[Bun](https://bun.sh) ≥ 1.0.

```bash
git clone https://github.com/ZoriaSoft/play-store-pipeline.git
cd play-store-pipeline && bun install
```

### 2. A Play service account (once per developer account)

1. **Google Cloud Console** → the project linked to your Play Console (or a new one) →
   **IAM & Admin → Service accounts → Create service account** (e.g. `play-api`). No Cloud roles are needed.
2. Open it → **Keys → Add key → JSON** → download. Keep the file **outside** any git repository.
3. **Play Console → Users and permissions → Invite new users** → the service account's e-mail → grant per app
   (or account-wide) what you need:
   - *Releases*: manage testing track releases (add production releases only if you want that),
   - *Store presence*: manage store listings (for `listing-set`, `images-*`),
   - *Replies to reviews* (for `review-reply`), *App content* (for `data-safety`).
4. Accept / wait until the account is active. A brand-new service account can take a while (up to ~24 h) to work.
   If `tracks` returns 401/403, the invite or project link is the problem, not the CLI.

### 3. Credentials (pick one; first match wins)

```bash
export PLAY_SERVICE_ACCOUNT_KEY_FILE=/secure/path/play-sa.json     # a) path — local use
export PLAY_SERVICE_ACCOUNT_JSON="$(cat /secure/path/play-sa.json)" # b) content — CI / secret managers
cp /secure/path/play-sa.json service-account.json                  # c) file next to play-api.ts (git-ignored)
```

Or copy `.env.example` to `.env` (git-ignored); it only fills variables that are not already set.

### 4. First test (read-only)

```bash
bun play-api.ts tracks --package com.your.app
bun play-api.ts --help
```

## Usage

The full reference — every command, the edit rules, the release flow, image and Data safety rules, common
failures and the Console-only tasks — is in **[`SKILL.md`](SKILL.md)**. In short:

```bash
P="--package com.your.app"
bun play-api.ts upload  $P --aab app-release.aab --track internal --notes en-US="Bug fixes" --dry-run
bun play-api.ts upload  $P --aab app-release.aab --track internal --notes en-US="Bug fixes"
bun play-api.ts promote $P --vc 27 --track alpha
bun play-api.ts promote $P --vc 27 --track production --fraction 0.1 --confirm-production
bun play-api.ts rollout $P --track production --vc 27 --complete
bun play-api.ts images-batch $P --spec images.json          # see examples/images.example.json
bun play-api.ts data-safety  $P --csv data-safety.csv       # see examples/data-safety.example.csv
bun play-api.ts reviews $P --max 20
```

### Using it as an agent skill

Put this directory where your agent loads skills (for example `.claude/skills/play-store-pipeline/` or your
tool's equivalent) and run `bun install` inside it. The agent reads `SKILL.md` and runs the commands itself.
Keep the service-account key out of the agent's context: give it the variable name or file path, never the content.

## Verification status

| Command | How it is verified |
|---|---|
| `tracks`, `listing-get`, `images-list`, `testers`, `details` (read), `reviews` | live against a real app (read-only, edits deleted) |
| `upload`, `promote` | same API call sequence (`bundles.upload` → `tracks.update` → `commit`) as the scripts used for real releases; unit tests |
| `images-batch` | the same calls were used for real multi-locale listing replacements with sha1 readback; unit tests |
| `data-safety` | the same endpoint was used for real submissions (HTTP 204); unit tests |
| `listing-set`, `release-notes`, `rollout`, `details` (write), `review-reply` | unit tests only — rehearse with `--dry-run` / `--validate-only` first |

```bash
bun test              # no network: the Play client is faked
bun run typecheck
```

## Security notes

- Credentials are read from the environment, a git-ignored `.env`, or a git-ignored `service-account.json`; they
  are never printed. Grant the service account only the permissions you use.
- Every write rehearses cleanly with `--dry-run` and `--validate-only`. Review replies are public.

## License

[MIT](LICENSE) © 2026 ZoriaSoft. Not affiliated with Google. Google Play is a trademark of Google LLC.
