# Changelog

## 1.0.1 — 2026-10-09 — pre-release hardening fixes

- **Production guard is case-insensitive** and now also covers `release-notes`
  and `rollout`: any write to a production track requires
  `--confirm-production`. `rollout --halt` is the single exempt command —
  an emergency stop must stay one command.
- **`version`, `--version` and `-v` print the version** before credentials are
  loaded (previously `--version`/`-v` died on "credentials missing" or
  "needs a value").
- **Failed `edits.delete` is reported honestly** — the log no longer claims
  "deleted (nothing published)" when the delete call itself failed.
- **`listing-set --lang` rejects comma lists** — it takes a single language
  code (a comma-joined value used to reach the API as an invalid code).
- **Image uploads compare the API-returned sha1 against the local file**;
  a mismatch aborts before commit (edit deleted, nothing published).
- **`--fraction` with `--status` other than `inProgress` is a usage error**
  instead of being silently ignored.
- **`.env` loader strips ` #comment` tails** on unquoted values (quoted
  values are unchanged).

## 1.0.0 — 2026-10-08 — first public release

- One CLI (`play-api.ts`) for tracks, upload, promote, staged rollout, release notes (any language), store
  listing text, listing images (single-edit batch with sha1 readback), Data safety CSV, app details, testers,
  reviews and replies.
- Edit safety: one edit per invocation, validate before commit, delete on failure; `--dry-run`, `--validate-only`,
  `--not-sent-for-review`, `--confirm-production` for production releases.
- Input validation up front (flags, files, image types, language codes, limits) — usage errors exit with 2 before
  any API call.
- Agent skill (`SKILL.md`) with the release flow, Play's image / Data safety rules, common failures and the
  Console-only tasks.
- Unit tests with a fake Play client (no network); TypeScript strict type check.
