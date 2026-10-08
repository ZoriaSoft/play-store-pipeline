#!/usr/bin/env bun
// play-api.ts — Google Play Console without a browser. Run `bun play-api.ts --help`.
//
// Credentials (first match wins; never printed):
//   PLAY_SERVICE_ACCOUNT_JSON      the service-account JSON *content*
//   PLAY_SERVICE_ACCOUNT_KEY_FILE  path to the JSON key file
//   ./service-account.json         next to this script
// A `.env` file ($PLAY_ENV_FILE, else next to this script) only fills variables that are not set yet.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { run, UsageError, USAGE } from "./src/commands.ts";

function loadEnvFile() {
  const file = [process.env.PLAY_ENV_FILE, join(import.meta.dir, ".env")].find((p) => p && existsSync(p));
  if (!file) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

async function client() {
  const json = process.env.PLAY_SERVICE_ACCOUNT_JSON?.trim();
  const keyFile = process.env.PLAY_SERVICE_ACCOUNT_KEY_FILE
    ?? [join(import.meta.dir, "service-account.json")].find((p) => existsSync(p));
  if (!json && !keyFile) {
    throw new UsageError("credentials missing: set PLAY_SERVICE_ACCOUNT_JSON (content) or PLAY_SERVICE_ACCOUNT_KEY_FILE (path), " +
      "or put service-account.json next to play-api.ts (see README → Setup)");
  }
  let credentials: object | undefined;
  if (json) {
    try { credentials = JSON.parse(json); } catch { throw new UsageError("PLAY_SERVICE_ACCOUNT_JSON is not valid JSON"); }
  }
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ ...(credentials ? { credentials } : { keyFile }),
    scopes: ["https://www.googleapis.com/auth/androidpublisher"] });
  return google.androidpublisher({ version: "v3", auth });
}

loadEnvFile();
const argv = process.argv.slice(2);
const wantsHelp = !argv.length || argv.includes("--help") || argv.includes("-h") || argv[0] === "help" || argv[0] === "version";
try {
  await run(argv, {
    play: wantsHelp ? null : await client(),
    log: (line) => console.log(line),
    readFile: (p) => readFileSync(p),
    fileSize: (p) => statSync(p).size,
    fileExists: (p) => existsSync(p),
    openStream: (p) => createReadStream(p),
  });
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`error: ${e.message}`);
    if (!argv.length) console.error(USAGE);
    process.exit(2);
  }
  // googleapis errors carry the API message (and sometimes a list of reasons); never dump credentials
  const err = e as { message?: string; errors?: { message?: string; reason?: string }[]; code?: number };
  console.error(`✗ ${err.code ? `HTTP ${err.code}: ` : ""}${err.message ?? e}`);
  for (const r of err.errors ?? []) if (r.message && r.message !== err.message) console.error(`  - ${r.reason ?? ""} ${r.message}`);
  process.exit(1);
}
