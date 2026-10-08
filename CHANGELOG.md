# Changelog

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
