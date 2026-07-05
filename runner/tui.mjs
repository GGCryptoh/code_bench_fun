#!/usr/bin/env node
// Code Bench Fun — interactive terminal helper for making a game bench run.
// Zero dependencies. Wraps runner/bench.mjs.
//
//   node runner/tui.mjs

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MODELS } from "./bench.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BENCH = path.join(SCRIPT_DIR, "bench.mjs");
const RUNS_DIR = path.join(REPO_ROOT, "data", "runs");

/* ---------- tiny ANSI kit ---------- */
const ESC = "\x1b[";
const reset = `${ESC}0m`;
const bold = (s) => `${ESC}1m${s}${reset}`;
const dim = (s) => `${ESC}2m${s}${reset}`;
const fg = (n, s) => `${ESC}38;5;${n}m${s}${reset}`;
const BRAND_ANSI = { anthropic: 209, openai: 79, zai: 75, xai: 255, google: 111, deepseek: 69, moonshot: 121 };
const ok = (s) => fg(79, s);
const warn = (s) => fg(214, s);
const bad = (s) => fg(203, s);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();

function banner() {
  console.log("");
  console.log(bold("  ▐▛ CODE BENCH FUN") + dim("  — make a game, one prompt, every model"));
  console.log(dim("  ─".repeat(31)));
  console.log("");
}

/* ---------- helpers ---------- */
function slugify(s, max = 42) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "") || "my-game";
}

function estCost(keys) {
  // same heuristic as the web bench: ~600 in / ~8000 out tokens per build
  let sum = 0;
  for (const k of keys) {
    const m = MODELS[k];
    sum += (m.in_per_m * 600 + m.out_per_m * 8000) / 1e6;
  }
  return sum;
}

function providerLabel(m) {
  if (m.cli_id) return "claude cli (subscription)";
  if (m.openai_id) return "openai direct";
  return "openrouter";
}

function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return JSON.parse(readFileSync(path.join(RUNS_DIR, f), "utf8")); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

function buildStatus(b) {
  if (!b.ok) return bad(`FAIL  ${String(b.error || "").slice(0, 40)}`);
  const s = b.judge && typeof b.judge.score === "number" ? b.judge.score : null;
  if (s == null) return warn("ok · unjudged");
  if (s < 5) return warn(`★ ${s}  (rough)`);
  return ok(`★ ${s}`);
}

/* ---------- model picker ---------- */
async function pickModels(preselected) {
  const keys = Object.keys(MODELS);
  const sel = new Set(preselected || ["fable-5", "glm-5.2", "gpt-5.5", "opus-4.8"]);
  for (;;) {
    console.log("\n" + bold("  Pick your builders") + dim("  (numbers toggle · a=all · n=none · Enter=done)"));
    keys.forEach((k, i) => {
      const m = MODELS[k];
      const mark = sel.has(k) ? ok("[x]") : dim("[ ]");
      const name = fg(BRAND_ANSI[m.brand] || 250, m.name.padEnd(17));
      console.log(`   ${mark} ${String(i + 1).padStart(2)}. ${name} ${dim(providerLabel(m).padEnd(26))} ${dim(`$${m.in_per_m}/$${m.out_per_m} per 1M`)}`);
    });
    console.log(dim(`\n   selected: ${sel.size}  ·  est ≈ $${estCost([...sel]).toFixed(2)} (claude-cli models bill your subscription, not cash)`));
    const a = await ask(bold("  toggle> "));
    if (a === "") {
      if (sel.size) return [...sel];
      console.log(warn("  pick at least one model"));
      continue;
    }
    if (a === "a") { keys.forEach((k) => sel.add(k)); continue; }
    if (a === "n") { sel.clear(); continue; }
    for (const tok of a.split(/[\s,]+/)) {
      const idx = parseInt(tok, 10) - 1;
      if (idx >= 0 && idx < keys.length) sel.has(keys[idx]) ? sel.delete(keys[idx]) : sel.add(keys[idx]);
    }
  }
}

/* ---------- multi-line prompt ---------- */
async function askPrompt() {
  console.log(bold("  Describe your game.") + dim("  (finish with an empty line — think: what would look sick in a screen recording?)"));
  console.log(dim("  e.g. two cars jump a canyon · trains race over a collapsing bridge · a volcano erupts over a tiny town\n"));
  const lines = [];
  for (;;) {
    const line = await rl.question(dim("  │ "));
    if (!line.trim() && lines.length) break;
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join(" ");
}

/* ---------- run the bench ---------- */
function runBench(args) {
  return new Promise((resolve) => {
    console.log(dim(`\n  $ node runner/bench.mjs ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`));
    const child = spawn(process.execPath, [BENCH, ...args], { stdio: "inherit", cwd: REPO_ROOT });
    child.on("close", (code) => resolve(code));
  });
}

function sh(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: REPO_ROOT });
    child.on("close", (code) => resolve(code));
  });
}

async function afterRun(id) {
  const url = `http://127.0.0.1:8619/run.html?id=${id}`;
  console.log("\n" + bold("  Done.") + `  ${url}`);
  if ((await ask(dim("  open it in the browser? [y/N] "))).toLowerCase() === "y") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    console.log(dim("  (needs a local server: python3 -m http.server 8619)"));
  }
  if ((await ask(dim("  publish to the live site (git add+commit+push)? [y/N] "))).toLowerCase() === "y") {
    await sh("git", ["add", "-A"]);
    await sh("git", ["commit", "-m", `bench: ${id}`]);
    const code = await sh("git", ["push"]);
    console.log(code === 0 ? ok(`  live → https://ggcryptoh.github.io/code_bench_fun/run.html?id=${id}`) : bad("  push failed"));
  }
}

/* ---------- flows ---------- */
async function newBench() {
  const prompt = await askPrompt();

  const kindAns = await ask("\n" + bold("  Kind?") + dim("  1 = simulation (autoplays, loops — best for reels)   2 = interactive (playable)  [1] "));
  const kind = kindAns === "2" ? "interactive" : "simulation";

  const models = await pickModels();

  const suggestedTitle = prompt.split(/\s+/).slice(0, 5).join(" ").replace(/[.,;:!?]+$/, "");
  const title = (await ask("\n" + bold("  Title") + dim(` [${suggestedTitle}] `))) || suggestedTitle;
  let id = slugify((await ask(bold("  Run id") + dim(` [${slugify(title)}] `))) || slugify(title));

  let merge = false;
  if (existsSync(path.join(RUNS_DIR, `${id}.json`))) {
    console.log(warn(`\n  a run named "${id}" already exists`));
    const c = await ask(dim("  [m]erge these models into it · [o]verwrite it · [c]hange id  [c] "));
    if (c.toLowerCase() === "m") merge = true;
    else if (c.toLowerCase() !== "o") id = slugify(await ask(bold("  new id> ")));
  }

  console.log("\n" + bold("  Ready:"));
  console.log(`   ${dim("game  ")} ${prompt.slice(0, 100)}${prompt.length > 100 ? "…" : ""}`);
  console.log(`   ${dim("kind  ")} ${kind}    ${dim("id")} ${id}    ${dim("title")} ${title}`);
  console.log(`   ${dim("models")} ${models.map((k) => fg(BRAND_ANSI[MODELS[k].brand] || 250, MODELS[k].name)).join(dim(" · "))}`);
  console.log(`   ${dim("est   ")} ≈ $${estCost(models).toFixed(2)} + Opus 4.8 judging${merge ? "    " + warn("(merge)") : ""}`);
  if ((await ask("\n" + bold("  Build it? [Y/n] "))).toLowerCase() === "n") return console.log(dim("  aborted"));

  const args = ["--id", id, "--title", title, "--kind", kind, "--models", models.join(","), "--prompt", prompt];
  if (merge) args.push("--merge");
  const code = await runBench(args);
  if (code === 0) await afterRun(id);
  else console.log(bad(`\n  bench exited with code ${code}`));
}

async function fixRun() {
  const runs = listRuns();
  if (!runs.length) return console.log(warn("  no runs yet — make one first"));
  console.log("\n" + bold("  Which run?"));
  runs.forEach((r, i) => {
    const fails = (r.builds || []).filter((b) => !b.ok).length;
    console.log(`   ${String(i + 1).padStart(2)}. ${r.title || r.id}  ${dim(r.id)}  ${fails ? bad(`${fails} failed`) : ok("all ok")}`);
  });
  const idx = parseInt(await ask(bold("  run> ")), 10) - 1;
  const run = runs[idx];
  if (!run) return console.log(warn("  never mind"));

  console.log("\n" + bold(`  ${run.title || run.id}`) + dim("  — current builds:"));
  (run.builds || []).forEach((b) => {
    const m = MODELS[b.model_key] || { name: b.model_key, brand: "" };
    console.log(`   ${fg(BRAND_ANSI[m.brand] || 250, m.name.padEnd(17))} ${buildStatus(b)}`);
  });

  const preselect = (run.builds || []).filter((b) => !b.ok).map((b) => b.model_key);
  console.log(dim("\n  pick which models to RE-RUN (failed ones preselected — re-rolling a bad score is a mulligan, your call):"));
  const models = await pickModels(preselect.length ? preselect : undefined);

  console.log(`\n  re-running ${models.length} model(s) into ${bold(run.id)} ${dim("(everything else kept)")}`);
  if ((await ask(bold("  Go? [Y/n] "))).toLowerCase() === "n") return console.log(dim("  aborted"));

  const code = await runBench(["--id", run.id, "--models", models.join(","), "--merge"]);
  if (code === 0) await afterRun(run.id);
  else console.log(bad(`\n  bench exited with code ${code}`));
}

/* ---------- main ---------- */
async function main() {
  banner();
  console.log(`   1. ${bold("New game bench")}   ${dim("prompt → models → build → judge → gallery")}`);
  console.log(`   2. Fix / re-roll models in an existing run`);
  console.log(`   3. Quit\n`);
  const choice = await ask(bold("  > "));
  if (choice === "1" || choice === "") await newBench();
  else if (choice === "2") await fixRun();
  rl.close();
}

main().catch((err) => {
  console.error(bad(`fatal: ${err.message}`));
  process.exit(1);
});
