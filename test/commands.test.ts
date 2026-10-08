import { describe, expect, test } from "bun:test";
import { parseArgs, releaseNotes, run, UsageError, type Deps } from "../src/commands.ts";

// A fake androidpublisher client that records every call as "path(args)".
function fakePlay(state: { tracks?: Record<string, unknown[]>; failCommit?: string } = {}) {
  const calls: { name: string; args: any }[] = [];
  const tracks: Record<string, any[]> = JSON.parse(JSON.stringify(state.tracks ?? {}));
  const rec = (name: string, result: any = {}) => async (args: any) => { calls.push({ name, args }); return { data: result, status: 200 }; };
  const play = {
    edits: {
      insert: rec("edits.insert", { id: "E1" }),
      validate: rec("edits.validate"),
      commit: async (args: any) => {
        calls.push({ name: "edits.commit", args });
        if (state.failCommit) throw new Error(state.failCommit);
        return { data: { id: "E1" } };
      },
      delete: rec("edits.delete"),
      tracks: {
        list: async (args: any) => { calls.push({ name: "tracks.list", args });
          return { data: { tracks: Object.entries(tracks).map(([track, releases]) => ({ track, releases })) } }; },
        get: async (args: any) => { calls.push({ name: "tracks.get", args });
          return { data: { track: args.track, releases: JSON.parse(JSON.stringify(tracks[args.track] ?? [])) } }; },
        update: rec("tracks.update"),
      },
      bundles: { upload: rec("bundles.upload", { versionCode: 42, sha256: "abc" }) },
      listings: {
        list: rec("listings.list", { listings: [{ language: "en-US", title: "App" }, { language: "tr-TR", title: "Uyg" }] }),
        get: rec("listings.get", { language: "en-US", title: "Old title", shortDescription: "Old short", fullDescription: "Old full" }),
        update: rec("listings.update"),
      },
      images: { list: rec("images.list", { images: [{ id: "i1", sha1: "s1", sha256: "s256" }] }),
        deleteall: rec("images.deleteall"), upload: rec("images.upload", { image: { sha1: "up" } }) },
      testers: { get: rec("testers.get", { googleGroups: ["g@example.com"] }) },
      details: { get: rec("details.get", { defaultLanguage: "en-US" }), patch: rec("details.patch") },
    },
    applications: { dataSafety: async (args: any) => { calls.push({ name: "applications.dataSafety", args }); return { status: 204, data: {} }; } },
    reviews: { list: rec("reviews.list", { reviews: [] }), reply: rec("reviews.reply") },
  };
  return { play, calls, names: () => calls.map((c) => c.name) };
}

function deps(play: any, files: Record<string, string> = {}): Deps & { out: string[] } {
  const out: string[] = [];
  return {
    play, out, log: (l) => out.push(l),
    readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return Buffer.from(files[p]); },
    fileSize: (p) => (files[p] ?? "").length,
    fileExists: (p) => p in files,
    openStream: (p) => `stream:${p}`,
  };
}

const PKG = ["--package", "com.example.app"];

describe("edit lifecycle", () => {
  test("read-only command deletes its edit", async () => {
    const f = fakePlay({ tracks: { alpha: [{ status: "completed", versionCodes: ["7"], name: "1.0" }] } });
    const d = deps(f.play);
    await run(["tracks", ...PKG], d);
    expect(f.names()).toEqual(["edits.insert", "tracks.list", "edits.delete"]);
    expect(d.out).toContain('alpha => completed:vc=7 "1.0"');
  });

  test("write validates and commits; nothing is deleted", async () => {
    const f = fakePlay({ tracks: { alpha: [{ status: "completed", versionCodes: ["7"] }] } });
    await run(["release-notes", ...PKG, "--track", "alpha", "--notes", "en-US=Fixes"], deps(f.play));
    expect(f.names()).toEqual(["edits.insert", "tracks.get", "tracks.update", "edits.validate", "edits.commit"]);
    expect(f.calls[2].args.requestBody.releases[0].releaseNotes).toEqual([{ language: "en-US", text: "Fixes" }]);
  });

  test("--validate-only validates then discards", async () => {
    const f = fakePlay({ tracks: { alpha: [{ status: "completed", versionCodes: ["7"] }] } });
    await run(["release-notes", ...PKG, "--track", "alpha", "--notes-en", "x", "--validate-only"], deps(f.play));
    expect(f.names()).toEqual(["edits.insert", "tracks.get", "tracks.update", "edits.validate", "edits.delete"]);
  });

  test("--dry-run makes no write call", async () => {
    const f = fakePlay({ tracks: { alpha: [{ status: "completed", versionCodes: ["7"] }] } });
    await run(["release-notes", ...PKG, "--track", "alpha", "--notes-en", "x", "--dry-run"], deps(f.play));
    expect(f.names()).toEqual(["edits.insert", "tracks.get", "edits.delete"]);
  });

  test("failed commit deletes the edit and explains managed publishing", async () => {
    const f = fakePlay({ tracks: { alpha: [{ status: "completed", versionCodes: ["7"] }] },
      failCommit: "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true." });
    const d = deps(f.play);
    await expect(run(["release-notes", ...PKG, "--track", "alpha", "--notes-en", "x"], d)).rejects.toThrow();
    expect(f.names().at(-1)).toBe("edits.delete");
    expect(d.out.join("\n")).toContain("--not-sent-for-review");
  });

  test("--not-sent-for-review is passed to commit", async () => {
    const f = fakePlay({ tracks: { alpha: [{ status: "completed", versionCodes: ["7"] }] } });
    await run(["release-notes", ...PKG, "--track", "alpha", "--notes-en", "x", "--not-sent-for-review"], deps(f.play));
    expect(f.calls.find((c) => c.name === "edits.commit")!.args.changesNotSentForReview).toBe(true);
  });
});

describe("upload / promote", () => {
  test("upload: bundle → track → validate → commit, version code from the upload", async () => {
    const f = fakePlay();
    const d = deps(f.play, { "app.aab": "AAB" });
    await run(["upload", ...PKG, "--aab", "app.aab", "--track", "internal", "--notes", "en-US=First"], d);
    expect(f.names()).toEqual(["edits.insert", "bundles.upload", "tracks.update", "edits.validate", "edits.commit"]);
    expect(f.calls[2].args.requestBody).toEqual({ track: "internal",
      releases: [{ versionCodes: ["42"], status: "completed", releaseNotes: [{ language: "en-US", text: "First" }] }] });
  });

  test("upload to production needs --confirm-production", async () => {
    const f = fakePlay();
    await expect(run(["upload", ...PKG, "--aab", "app.aab", "--track", "production"], deps(f.play, { "app.aab": "A" })))
      .rejects.toBeInstanceOf(UsageError);
    expect(f.calls).toEqual([]);
  });

  test("upload rejects a missing or non-aab file before opening an edit", async () => {
    const f = fakePlay();
    await expect(run(["upload", ...PKG, "--aab", "nope.aab", "--track", "alpha"], deps(f.play))).rejects.toThrow("not found");
    await expect(run(["upload", ...PKG, "--aab", "app.apk", "--track", "alpha"], deps(f.play, { "app.apk": "x" }))).rejects.toThrow(".aab");
    expect(f.calls).toEqual([]);
  });

  test("promote with staged rollout", async () => {
    const f = fakePlay();
    await run(["promote", ...PKG, "--vc", "42", "--track", "production", "--fraction", "0.1", "--confirm-production"], deps(f.play));
    expect(f.calls[1].args.requestBody.releases[0]).toEqual({ versionCodes: ["42"], status: "inProgress", userFraction: 0.1 });
  });

  test("promote validates its numbers", async () => {
    const f = fakePlay();
    await expect(run(["promote", ...PKG, "--vc", "abc", "--track", "alpha"], deps(f.play))).rejects.toThrow("positive integer");
    await expect(run(["promote", ...PKG, "--vc", "4", "--track", "alpha", "--fraction", "1.5"], deps(f.play))).rejects.toThrow("between 0 and 1");
  });
});

describe("rollout", () => {
  const prod = { production: [{ status: "inProgress", versionCodes: ["42"], userFraction: 0.1 }] };
  for (const [flags, expected] of [
    [["--fraction", "0.5"], { status: "inProgress", userFraction: 0.5 }],
    [["--halt"], { status: "halted", userFraction: 0.1 }],
    [["--resume"], { status: "inProgress", userFraction: 0.1 }],
    [["--complete"], { status: "completed" }],
  ] as const) {
    test(flags.join(" "), async () => {
      const f = fakePlay({ tracks: prod });
      await run(["rollout", ...PKG, "--track", "production", "--vc", "42", ...flags], deps(f.play));
      expect(f.calls.find((c) => c.name === "tracks.update")!.args.requestBody.releases[0]).toEqual({ versionCodes: ["42"], ...expected });
    });
  }
  test("unknown version code fails and the edit is deleted", async () => {
    const f = fakePlay({ tracks: prod });
    await expect(run(["rollout", ...PKG, "--track", "production", "--vc", "9", "--halt"], deps(f.play))).rejects.toThrow("vc 9");
    expect(f.names().at(-1)).toBe("edits.delete");
  });
  test("conflicting modes are refused", async () => {
    await expect(run(["rollout", ...PKG, "--track", "production", "--vc", "42", "--halt", "--complete"], deps(fakePlay().play)))
      .rejects.toBeInstanceOf(UsageError);
  });
});

describe("store listing & images", () => {
  test("listing-set keeps fields you do not pass and enforces limits", async () => {
    const f = fakePlay();
    await run(["listing-set", ...PKG, "--lang", "en-US", "--short", "New short"], deps(f.play));
    expect(f.calls.find((c) => c.name === "listings.update")!.args.requestBody)
      .toEqual({ language: "en-US", title: "Old title", shortDescription: "New short", fullDescription: "Old full", video: undefined });
    await expect(run(["listing-set", ...PKG, "--lang", "en-US", "--title", "x".repeat(31)], deps(fakePlay().play))).rejects.toThrow("30");
  });

  test("images-batch: all replacements in one edit, files checked up front", async () => {
    const files = { "a.png": "A", "b.png": "B", "fg.jpg": "F", "spec.json": JSON.stringify([
      { lang: "en-US", type: "phoneScreenshots", files: ["a.png", "b.png"] },
      { lang: "tr-TR", type: "featureGraphic", files: ["fg.jpg"] }]) };
    const f = fakePlay();
    await run(["images-batch", ...PKG, "--spec", "spec.json"], deps(f.play, files));
    expect(f.names()).toEqual(["edits.insert", "images.deleteall", "images.upload", "images.upload", "images.deleteall",
      "images.upload", "edits.validate", "edits.commit"]);
    expect(f.calls.filter((c) => c.name === "edits.insert").length).toBe(1);
    expect(f.calls[5].args.media.mimeType).toBe("image/jpeg");
    const bad = fakePlay();
    await expect(run(["images-set", ...PKG, "--lang", "en-US", "--type", "phoneScreenshots", "--files", "a.gif"],
      deps(bad.play, { "a.gif": "G" }))).rejects.toThrow("unsupported image type");
    await expect(run(["images-set", ...PKG, "--lang", "en-US", "--type", "selfies", "--files", "a.png"],
      deps(bad.play, { "a.png": "A" }))).rejects.toThrow("unknown image type");
    expect(bad.calls).toEqual([]);
  });

  test("details: read-only without flags, patch with flags", async () => {
    const r = fakePlay();
    await run(["details", ...PKG], deps(r.play));
    expect(r.names()).toEqual(["edits.insert", "details.get", "edits.delete"]);
    const w = fakePlay();
    await run(["details", ...PKG, "--contact-email", "dev@example.com"], deps(w.play));
    expect(w.calls.find((c) => c.name === "details.patch")!.args.requestBody).toEqual({ contactEmail: "dev@example.com" });
  });
});

describe("not edit-scoped", () => {
  const header = "Question ID (machine readable),Response ID (machine readable),Response value,Answer requirement,Human-friendly question label";
  test("data-safety accepts the Console export header (with BOM) and posts the CSV", async () => {
    const f = fakePlay();
    const d = deps(f.play, { "ds.csv": `﻿${header}\nPSL_X,,FALSE,REQUIRED,q\n` });
    await run(["data-safety", ...PKG, "--csv", "ds.csv"], d);
    expect(f.names()).toEqual(["applications.dataSafety"]);
    expect(d.out).toContain("✓ dataSafety HTTP 204");
  });
  test("data-safety rejects other CSVs", async () => {
    await expect(run(["data-safety", ...PKG, "--csv", "x.csv"], deps(fakePlay().play, { "x.csv": "a,b,c\n1,2,3" }))).rejects.toThrow("header");
  });
  test("reviews and reply limits", async () => {
    const f = fakePlay();
    const d = deps(f.play);
    await run(["reviews", ...PKG, "--max", "5"], d);
    expect(f.calls[0].args.maxResults).toBe(5);
    expect(d.out[0]).toContain("last week");
    await expect(run(["review-reply", ...PKG, "--review-id", "r", "--text", "x".repeat(351)], d)).rejects.toThrow("350");
  });
});

describe("arguments", () => {
  test("release notes: --notes LANG=TEXT, --notes=…, --notes-file and legacy flags", () => {
    const a = parseArgs(["x", "--notes", "de-DE=Fehler behoben", "--notes=fr-FR=Corrections", "--notes-tr", "Düzeltmeler",
      "--notes-file", "es-ES=es.txt"]);
    expect(releaseNotes(a, deps(null, { "es.txt": "Correcciones\n" }))).toEqual([
      { language: "tr-TR", text: "Düzeltmeler" }, { language: "de-DE", text: "Fehler behoben" },
      { language: "fr-FR", text: "Corrections" }, { language: "es-ES", text: "Correcciones" }]);
    expect(() => releaseNotes(parseArgs(["x", "--notes", "Fixes"]), deps(null))).toThrow("LANG=TEXT");
    expect(() => releaseNotes(parseArgs(["x", "--notes", `en-US=${"x".repeat(501)}`]), deps(null))).toThrow("500");
  });
  test("missing values and unknown commands are usage errors", async () => {
    expect(() => parseArgs(["tracks", "--package"])).toThrow("needs a value");
    await expect(run(["tracks"], deps(null))).rejects.toThrow("--package");
    await expect(run(["frobnicate", ...PKG], deps(null))).rejects.toThrow("unknown command");
  });
  test("--help prints usage without touching the API", async () => {
    const d = deps(null);
    await run(["--help"], d);
    expect(d.out[0]).toContain("usage: bun play-api.ts");
  });
});
