// Browserless Google Play Console operations (Android Publisher API v3).
//
// Every edit-scoped command runs inside exactly ONE edit:
//   edits.insert → change(s) → edits.validate → edits.commit
// Read-only commands, --dry-run and --validate-only delete the edit instead (nothing is published).
// `data-safety` and `reviews` are not edit-scoped.
//
// The Play client is injected (`Deps.play`), so everything here can be tested without the network.

import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";

export const VERSION = "1.0.0";

export class UsageError extends Error {}

export interface Deps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  play: any; // google.androidpublisher({ version: "v3" }) or a fake with the same shape
  log: (line: string) => void;
  readFile: (path: string) => Buffer;
  fileSize: (path: string) => number;
  fileExists: (path: string) => boolean;
  openStream: (path: string) => unknown;
}

export const TRACKS_HINT = "internal | alpha (closed) | beta (open) | production | <custom closed track name>";
const BOOL_FLAGS = new Set(["dry-run", "validate-only", "not-sent-for-review", "halt", "resume", "complete",
  "confirm-production", "help"]);
const IMAGE_TYPES = new Set(["phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots", "tvScreenshots",
  "wearScreenshots", "featureGraphic", "promoGraphic", "icon", "tvBanner"]);
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const USAGE = `play-api ${VERSION} — Google Play Console without a browser

usage: bun play-api.ts <command> --package <com.example.app> [options]

Read
  tracks                                          releases per track
  listing-get     [--lang L]                      store text per locale
  images-list     [--lang L,L] [--types T,T]      images with sha1/sha256
  testers         [--track alpha]                 Google Groups on a testing track
  details                                         contact info / default language
  reviews         [--max 50]                      recent reviews with text (~last 7 days)

Release
  upload          --aab FILE --track T [--notes L=TEXT ...] [--status completed|draft|inProgress --fraction F]
  promote         --vc N --track T [--notes L=TEXT ...] [--status ... --fraction F]
  release-notes   --track T --notes L=TEXT ...    replace notes of every release on the track
  rollout         --track production --vc N (--fraction F | --halt | --resume | --complete)

Store listing
  listing-set     --lang L [--title T] [--short S] [--full-file F] [--video URL]
  images-set      --lang L --type TYPE --files a.png,b.png
  images-batch    --spec images.json              many lang×type replacements in ONE edit
  details         [--contact-email E] [--contact-website W] [--default-lang L]
  data-safety     --csv data-safety.csv           Play's Data safety CSV (HTTP 204 = ok)
  review-reply    --review-id ID --text "..."     public reply (≤350 chars)

Common flags
  --dry-run              print the plan, call no write API
  --validate-only        run edits.validate, then discard the edit
  --not-sent-for-review  commit with changesNotSentForReview=true (managed publishing)
  --confirm-production   required to upload/promote straight to production

Notes: --notes en-US="Bug fixes" --notes tr-TR="Hata düzeltmeleri" (repeatable, ≤500 chars each);
       --notes-file en-US=notes_en.txt; legacy --notes-en / --notes-tr still work.
Tracks: ${TRACKS_HINT}`;

// ---- argument parsing ---------------------------------------------------------------------------
export interface Args {
  cmd: string;
  values: Map<string, string[]>;
  bools: Set<string>;
}

export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { bools.add("help"); continue; }
    if (!a.startsWith("--")) {
      if (!cmd) { cmd = a; continue; }
      throw new UsageError(`unexpected argument: ${a}`);
    }
    let key = a.slice(2), value: string | undefined;
    const eq = key.indexOf("=");
    if (eq > 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }   // --notes=en-US=text → notes, "en-US=text"
    if (BOOL_FLAGS.has(key)) { bools.add(key); continue; }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || (value.startsWith("--") && value.length > 2)) throw new UsageError(`--${key} needs a value`);
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return { cmd, values, bools };
}

const get = (a: Args, k: string) => a.values.get(k)?.at(-1);
function need(a: Args, ...keys: string[]): string[] {
  const missing = keys.filter((k) => !get(a, k));
  if (missing.length) throw new UsageError(`${a.cmd}: missing ${missing.map((k) => "--" + k).join(", ")}`);
  return keys.map((k) => get(a, k)!);
}
function positiveInt(v: string, name: string): string {
  if (!/^[1-9][0-9]*$/.test(v)) throw new UsageError(`--${name} must be a positive integer`);
  return v;
}
function fraction(v: string): number {
  const f = Number(v);
  if (!(f > 0 && f < 1)) throw new UsageError("--fraction must be between 0 and 1 (exclusive), e.g. 0.1");
  return f;
}
function langs(v: string): string[] {
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const l of out) if (!LANG_RE.test(l)) throw new UsageError(`invalid language code: ${l} (use e.g. en-US, tr-TR)`);
  return out;
}

export function releaseNotes(a: Args, deps: Deps): { language: string; text: string }[] {
  const notes = new Map<string, string>();
  const add = (language: string, text: string) => {
    if (!LANG_RE.test(language)) throw new UsageError(`invalid release-notes language: ${language}`);
    if (text.length > 500) throw new UsageError(`release notes > 500 chars (${language})`);
    notes.set(language, text);
  };
  for (const [flag, lang] of [["notes-en", "en-US"], ["notes-tr", "tr-TR"]] as const) {
    const v = get(a, flag);
    if (v) add(lang, v);
  }
  for (const item of a.values.get("notes") ?? []) {
    const i = item.indexOf("=");
    if (i < 1) throw new UsageError(`--notes expects LANG=TEXT, got: ${item}`);
    add(item.slice(0, i), item.slice(i + 1));
  }
  for (const item of a.values.get("notes-file") ?? []) {
    const i = item.indexOf("=");
    if (i < 1) throw new UsageError(`--notes-file expects LANG=PATH, got: ${item}`);
    add(item.slice(0, i), deps.readFile(item.slice(i + 1)).toString("utf8").trim());
  }
  return [...notes].map(([language, text]) => ({ language, text }));
}

const mime = (p: string) => {
  const ext = extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  throw new UsageError(`unsupported image type ${ext} (use .png or .jpg): ${p}`);
};

// ---- edit lifecycle -----------------------------------------------------------------------------
async function withEdit(deps: Deps, a: Args, pkg: string, write: boolean, fn: (editId: string) => Promise<void>) {
  const { play, log } = deps;
  const P = { packageName: pkg };
  const editId: string = (await play.edits.insert(P)).data.id;
  log(`edit ${editId}`);
  let committed = false;
  try {
    await fn(editId);
    if (write && !a.bools.has("dry-run")) {
      await play.edits.validate({ ...P, editId });
      log("✓ edits.validate");
      if (!a.bools.has("validate-only")) {
        const r = await play.edits.commit({ ...P, editId,
          ...(a.bools.has("not-sent-for-review") ? { changesNotSentForReview: true } : {}) });
        committed = true;
        log(`✓ edits.commit ${r.data.id ?? editId}`);
      }
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/changesNotSentForReview/i.test(msg)) {
      log("hint: re-run with --not-sent-for-review, then send the changes for review in Play Console → Publishing overview");
    } else if (/expired|has been deleted/i.test(msg)) {
      log("hint: another edit was opened for this app meanwhile (parallel script or Console) — serialize Play calls and re-run");
    }
    throw e;
  } finally {
    if (!committed) {
      await play.edits.delete({ ...P, editId }).catch(() => {});
      log(`edit ${editId} deleted (nothing published)`);
    }
  }
}

function productionGate(a: Args, track: string) {
  if (track === "production" && !a.bools.has("confirm-production")) {
    throw new UsageError("production release: test on internal/alpha first, then re-run with --confirm-production");
  }
}

function releaseBody(a: Args, deps: Deps, vc: string) {
  const status = get(a, "status") ?? (get(a, "fraction") ? "inProgress" : "completed");
  if (!["completed", "draft", "inProgress", "halted"].includes(status)) throw new UsageError("--status: completed | draft | inProgress | halted");
  const rel: Record<string, unknown> = { versionCodes: [vc], status };
  if (status === "inProgress") rel.userFraction = fraction(need(a, "fraction")[0]);
  const notes = releaseNotes(a, deps);
  if (notes.length) rel.releaseNotes = notes;
  return rel;
}

// ---- commands -----------------------------------------------------------------------------------
export async function run(argv: string[], deps: Deps): Promise<void> {
  const a = parseArgs(argv);
  if (a.bools.has("help") || !a.cmd || a.cmd === "help") { deps.log(USAGE); return; }
  if (a.cmd === "version" || a.cmd === "--version") { deps.log(VERSION); return; }
  const [pkg] = need(a, "package");
  const { play, log } = deps;
  const P = { packageName: pkg };
  const dry = a.bools.has("dry-run");

  switch (a.cmd) {
    case "tracks":
      return withEdit(deps, a, pkg, false, async (editId) => {
        for (const t of (await play.edits.tracks.list({ ...P, editId })).data.tracks ?? []) {
          const rel = (t.releases ?? []).map((r: any) => `${r.status}:vc=${(r.versionCodes ?? []).join(",")}` +
            `${r.userFraction ? `@${r.userFraction}` : ""}${r.name ? ` "${r.name}"` : ""}` +
            (r.releaseNotes?.length ? ` notes[${r.releaseNotes.map((n: any) => n.language).join(",")}]` : ""));
          log(`${t.track} => ${rel.join(" | ") || "(empty)"}`);
        }
      });

    case "listing-get":
      return withEdit(deps, a, pkg, false, async (editId) => {
        const lang = get(a, "lang");
        const ls = lang ? [(await play.edits.listings.get({ ...P, editId, language: lang })).data]
          : (await play.edits.listings.list({ ...P, editId })).data.listings ?? [];
        for (const l of ls) log(JSON.stringify({ language: l.language, title: l.title, shortDescription: l.shortDescription,
          fullDescriptionChars: l.fullDescription?.length, video: l.video }));
      });

    case "listing-set": {
      const [language] = need(a, "lang");
      langs(language);
      const fullFile = get(a, "full-file");
      const full = fullFile ? deps.readFile(fullFile).toString("utf8") : undefined;
      return withEdit(deps, a, pkg, true, async (editId) => {
        const cur = (await play.edits.listings.get({ ...P, editId, language })).data;
        const body = { language, title: get(a, "title") ?? cur.title, shortDescription: get(a, "short") ?? cur.shortDescription,
          fullDescription: full ?? cur.fullDescription, video: get(a, "video") ?? cur.video };
        if ((body.title ?? "").length > 30) throw new UsageError("title > 30 chars");
        if ((body.shortDescription ?? "").length > 80) throw new UsageError("short description > 80 chars");
        if ((body.fullDescription ?? "").length > 4000) throw new UsageError("full description > 4000 chars");
        log(`plan listings.update ${language}`);
        if (!dry) await play.edits.listings.update({ ...P, editId, language, requestBody: body });
      });
    }

    case "images-list":
      return withEdit(deps, a, pkg, false, async (editId) => {
        const ls = get(a, "lang") ? langs(get(a, "lang")!)
          : ((await play.edits.listings.list({ ...P, editId })).data.listings ?? []).map((l: any) => l.language);
        const types = (get(a, "types") ?? "icon,featureGraphic,phoneScreenshots").split(",");
        for (const t of types) if (!IMAGE_TYPES.has(t)) throw new UsageError(`unknown image type: ${t}`);
        for (const language of ls) for (const imageType of types) {
          const imgs = (await play.edits.images.list({ ...P, editId, language, imageType })).data.images ?? [];
          log(`${language} ${imageType}: ${imgs.length}` + imgs.map((i: any) => `\n  ${i.id} sha1=${i.sha1} sha256=${i.sha256}`).join(""));
        }
      });

    case "images-set":
    case "images-batch": {
      let spec: { lang: string; type: string; files: string[] }[];
      if (a.cmd === "images-set") {
        const [lang, type, files] = need(a, "lang", "type", "files");
        spec = [{ lang, type, files: files.split(",").map((f) => f.trim()).filter(Boolean) }];
      } else {
        const [specFile] = need(a, "spec");
        spec = JSON.parse(deps.readFile(specFile).toString("utf8"));
        if (!Array.isArray(spec) || !spec.length) throw new UsageError("--spec must be a non-empty JSON array");
      }
      for (const e of spec) {
        if (!e || typeof e.lang !== "string" || typeof e.type !== "string" || !Array.isArray(e.files) || !e.files.length) {
          throw new UsageError('each spec entry needs {"lang": "...", "type": "...", "files": ["..."]}');
        }
        langs(e.lang);
        if (!IMAGE_TYPES.has(e.type)) throw new UsageError(`unknown image type: ${e.type}`);
        for (const f of e.files) {
          if (!deps.fileExists(f)) throw new UsageError(`file not found: ${f}`);
          mime(f);
          const sha1 = createHash("sha1").update(deps.readFile(f)).digest("hex");
          log(`plan ${e.lang} ${e.type} ← ${f} (${deps.fileSize(f)} B, sha1 ${sha1})`);
        }
      }
      return withEdit(deps, a, pkg, true, async (editId) => {
        if (dry) return;
        for (const e of spec) {
          await play.edits.images.deleteall({ ...P, editId, language: e.lang, imageType: e.type });
          for (const f of e.files) {
            const r = await play.edits.images.upload({ ...P, editId, language: e.lang, imageType: e.type,
              media: { mimeType: mime(f), body: deps.openStream(resolve(f)) } });
            log(`✓ upload ${e.lang} ${e.type} ${f} → sha1=${r.data.image?.sha1}`);
          }
        }
      });
    }

    case "upload": {
      const [aab, track] = need(a, "aab", "track");
      if (!deps.fileExists(aab)) throw new UsageError(`AAB not found: ${aab}`);
      if (!/\.aab$/i.test(aab)) throw new UsageError("--aab must be an .aab file (Android App Bundle)");
      productionGate(a, track);
      const preview = releaseBody(a, deps, "<new>");
      log(`plan bundles.upload ${aab} (${(deps.fileSize(aab) / 1048576).toFixed(2)} MB) → ${track} ${JSON.stringify(preview)}`);
      return withEdit(deps, a, pkg, true, async (editId) => {
        if (dry) return;
        const up = await play.edits.bundles.upload({ ...P, editId,
          media: { mimeType: "application/octet-stream", body: deps.openStream(resolve(aab)) } });
        const vc = String(up.data.versionCode);
        log(`✓ bundles.upload versionCode=${vc} sha256=${up.data.sha256 ?? "?"}`);
        await play.edits.tracks.update({ ...P, editId, track, requestBody: { track, releases: [releaseBody(a, deps, vc)] } });
        log(`✓ tracks.update ${track} vc=${vc}`);
      });
    }

    case "promote": {
      const [vc, track] = need(a, "vc", "track");
      positiveInt(vc, "vc");
      productionGate(a, track);
      const rel = releaseBody(a, deps, vc);
      log(`plan tracks.update ${track} ← ${JSON.stringify(rel)}`);
      return withEdit(deps, a, pkg, true, async (editId) => {
        if (!dry) await play.edits.tracks.update({ ...P, editId, track, requestBody: { track, releases: [rel] } });
      });
    }

    case "release-notes": {
      const [track] = need(a, "track");
      const notes = releaseNotes(a, deps);
      if (!notes.length) throw new UsageError("release-notes: give at least one --notes LANG=TEXT");
      return withEdit(deps, a, pkg, true, async (editId) => {
        const t = (await play.edits.tracks.get({ ...P, editId, track })).data;
        t.releases = (t.releases ?? []).map((r: any) => ({ ...r, releaseNotes: notes }));
        log(`plan ${track}: ${t.releases.length} release(s) ← notes ${notes.map((n) => n.language).join(",")}`);
        if (!t.releases.length) throw new UsageError(`track ${track} has no release to annotate`);
        if (!dry) await play.edits.tracks.update({ ...P, editId, track, requestBody: t });
      });
    }

    case "rollout": {
      const [track, vc] = need(a, "track", "vc");
      positiveInt(vc, "vc");
      const modes = ["halt", "resume", "complete"].filter((m) => a.bools.has(m));
      if (modes.length > 1 || (modes.length && get(a, "fraction"))) throw new UsageError("use one of --fraction, --halt, --resume, --complete");
      const status = a.bools.has("halt") ? "halted" : a.bools.has("complete") ? "completed" : "inProgress";
      const f = get(a, "fraction") ? fraction(get(a, "fraction")!) : undefined;
      if (status === "inProgress" && f === undefined && !a.bools.has("resume")) throw new UsageError("rollout: --fraction F, --resume, --halt or --complete");
      return withEdit(deps, a, pkg, true, async (editId) => {
        const t = (await play.edits.tracks.get({ ...P, editId, track })).data;
        const rel = (t.releases ?? []).find((r: any) => (r.versionCodes ?? []).includes(String(vc)));
        if (!rel) throw new UsageError(`vc ${vc} is not on track ${track}`);
        rel.status = status;
        if (status === "completed") delete rel.userFraction;
        else if (f !== undefined) rel.userFraction = f;
        log(`plan ${track} vc=${vc} → ${status}${rel.userFraction ? `@${rel.userFraction}` : ""}`);
        if (!dry) await play.edits.tracks.update({ ...P, editId, track, requestBody: t });
      });
    }

    case "testers": {
      const track = get(a, "track") ?? "alpha";
      return withEdit(deps, a, pkg, false, async (editId) => {
        const t = (await play.edits.testers.get({ ...P, editId, track })).data;
        log(`${track} googleGroups=${JSON.stringify(t.googleGroups ?? [])}`);
      });
    }

    case "details": {
      const patch: Record<string, string> = {};
      if (get(a, "contact-email")) patch.contactEmail = get(a, "contact-email")!;
      if (get(a, "contact-website")) patch.contactWebsite = get(a, "contact-website")!;
      if (get(a, "default-lang")) patch.defaultLanguage = langs(get(a, "default-lang")!)[0];
      const write = Object.keys(patch).length > 0;
      return withEdit(deps, a, pkg, write, async (editId) => {
        log(JSON.stringify((await play.edits.details.get({ ...P, editId })).data));
        if (!write) { log("(read only)"); return; }
        log(`plan details.patch ${JSON.stringify(patch)}`);
        if (!dry) await play.edits.details.patch({ ...P, editId, requestBody: patch });
      });
    }

    case "data-safety": {
      const [file] = need(a, "csv");
      const csv = deps.readFile(file).toString("utf8").replace(/^﻿/, "");
      const rows = csv.trim().split(/\r?\n/);
      // Current Console export header, or the older documented one.
      if (!/^Question ID( \(machine readable\))?,Response ID( \(machine readable\))?,Response value,Answer requirement,(Human label|Human-friendly question label)/.test(rows[0])) {
        throw new UsageError("CSV header must be Play's Data safety export format (Console → App content → Data safety → Export to CSV)");
      }
      log(`plan applications.dataSafety ${rows.length - 1} rows`);
      if (!dry) {
        const r = await play.applications.dataSafety({ ...P, requestBody: { safetyLabels: csv } });
        log(`✓ dataSafety HTTP ${r.status}`);
      }
      return;
    }

    case "reviews": {
      const max = positiveInt(get(a, "max") ?? "50", "max");
      const r = await play.reviews.list({ ...P, maxResults: Number(max) });
      if (!r.data.reviews?.length) log("(no reviews returned — the API lists reviews with text from roughly the last week only)");
      for (const rv of r.data.reviews ?? []) {
        const c = rv.comments?.[0]?.userComment;
        log(`${rv.reviewId} ★${c?.starRating} ${c?.reviewerLanguage} vc=${c?.appVersionCode} ` +
          `${JSON.stringify(c?.text?.trim().slice(0, 160))}${rv.comments?.[1]?.developerComment ? " [replied]" : ""}`);
      }
      return;
    }

    case "review-reply": {
      const [reviewId, text] = need(a, "review-id", "text");
      if (text.length > 350) throw new UsageError("reply > 350 chars");
      log(`plan reply ${reviewId}: ${text}`);
      if (!dry) { await play.reviews.reply({ ...P, reviewId, requestBody: { replyText: text } }); log("✓ replied"); }
      return;
    }

    default:
      throw new UsageError(`unknown command: ${a.cmd} (see --help)`);
  }
}
