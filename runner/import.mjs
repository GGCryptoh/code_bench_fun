#!/usr/bin/env node
// Code Bench Fun — import a bench.html "run bundle" into data/ + games/.
// Node >= 20, ESM, zero npm dependencies.
//
// Usage:
//   node runner/import.mjs <bundle.json>
//
// The bundle is a run-detail JSON (see docs/SCHEMA.md for data/runs/<id>.json)
// produced by the site's in-browser bench.html page, where each `ok` build
// additionally carries an "html" field holding the generated game's source.
// This script strips that field, writes games/<id>/<key>.html for each ok
// build, writes data/runs/<id>.json, and updates data/index.json exactly the
// way runner/bench.mjs does (dedupe by id, newest run first).

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isValidId, computeSummary, upsertIndex } from "./bench.mjs";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function usage() {
  return "Usage: node runner/import.mjs <bundle.json>";
}

async function readBundle(bundlePath) {
  let raw;
  try {
    raw = await fs.readFile(bundlePath, "utf8");
  } catch (err) {
    fail(`Could not read bundle file "${bundlePath}": ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`Bundle file "${bundlePath}" is not valid JSON: ${err.message}`);
  }
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== "object") fail("Bundle is not a JSON object");
  if (!bundle.id || typeof bundle.id !== "string") fail('Bundle is missing a string "id"');
  if (!isValidId(bundle.id)) {
    fail(`Refusing to import: id "${bundle.id}" contains characters other than [a-z0-9-]`);
  }
  if (!Array.isArray(bundle.builds)) fail('Bundle is missing a "builds" array');
}

async function writeGameFiles(outDir, runId, builds) {
  const gamesDir = path.join(outDir, "games", runId);
  await fs.mkdir(gamesDir, { recursive: true });
  const written = [];
  for (const build of builds) {
    if (build.ok && typeof build.html === "string") {
      const file = path.join(gamesDir, `${build.model_key}.html`);
      await fs.writeFile(file, build.html, "utf8");
      written.push(path.relative(outDir, file));
    }
  }
  return written;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(usage());
    process.exit(argv.length === 1 ? 0 : 1);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(scriptDir, "..");
  const bundlePath = path.resolve(process.cwd(), argv[0]);

  const bundle = await readBundle(bundlePath);
  validateBundle(bundle);

  const runId = bundle.id;
  const title = bundle.title || runId;
  const kind = bundle.kind || "simulation";
  const prompt = bundle.prompt || "";
  const created = bundle.created || new Date().toISOString();

  // Strip the extra "html" field the bench.html page attaches to ok builds,
  // keeping everything else exactly as provided.
  const builds = bundle.builds.map((b) => {
    const { html, ...rest } = b;
    return rest;
  });

  const writtenFiles = await writeGameFiles(outDir, runId, bundle.builds);

  const runDetail = {
    ...bundle,
    id: runId,
    title,
    prompt,
    kind,
    created,
    builds,
  };
  delete runDetail.html; // defensive: no stray top-level html field

  const runsDir = path.join(outDir, "data", "runs");
  await fs.mkdir(runsDir, { recursive: true });
  const runDetailPath = path.join(runsDir, `${runId}.json`);
  await fs.writeFile(runDetailPath, JSON.stringify(runDetail, null, 2) + "\n", "utf8");

  const summary = computeSummary({ id: runId, title, prompt, kind, created, builds });
  const index = await upsertIndex(outDir, summary);

  console.log(`Imported run "${runId}":`);
  for (const f of writtenFiles) console.log(`  wrote ${f}`);
  console.log(`  wrote ${path.relative(outDir, runDetailPath)}`);
  console.log(`  updated ${path.relative(outDir, path.join(outDir, "data", "index.json"))} (${index.runs.length} run${index.runs.length === 1 ? "" : "s"} total)`);
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error(`[import] fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
