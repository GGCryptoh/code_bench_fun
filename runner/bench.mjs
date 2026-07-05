#!/usr/bin/env node
// Code Bench Fun — local benchmark runner.
// Node >= 20, ESM, zero npm dependencies (node: builtins + global fetch only).
//
// Usage:
//   node runner/bench.mjs --id cars-canyon --title "Cars vs Canyon" --kind simulation \
//     --models fable-5,glm-5.2,gpt-5.5,opus-4.8 --prompt "..." [--prompt-file p.txt] \
//     [--judge-provider claude-cli|openrouter] [--force-openrouter] [--out-dir <repo root>]
//
// See docs/SCHEMA.md for the exact JSON shapes this script writes.

import { spawn, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import fs from "node:fs/promises";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ============================================================================
 * MODEL REGISTRY
 * MUST stay in sync with the `MODELS` object in assets/site.js — same keys,
 * same or_id/cli_id, same pricing. Update both places together.
 * ========================================================================== */
export const MODELS = {
  "fable-5":          { name: "Fable 5",         brand: "anthropic", or_id: "anthropic/claude-fable-5",   cli_id: "claude-fable-5",            in_per_m: 10,   out_per_m: 50 },
  "opus-4.8":         { name: "Opus 4.8",         brand: "anthropic", or_id: "anthropic/claude-opus-4.8",  cli_id: "claude-opus-4-8",           in_per_m: 5,    out_per_m: 25 },
  "sonnet-5":         { name: "Sonnet 5",         brand: "anthropic", or_id: "anthropic/claude-sonnet-5",  cli_id: "claude-sonnet-5",           in_per_m: 2,    out_per_m: 10 },
  "haiku-4.5":        { name: "Haiku 4.5",        brand: "anthropic", or_id: "anthropic/claude-haiku-4.5", cli_id: "claude-haiku-4-5-20251001", in_per_m: 1,    out_per_m: 5 },
  "gpt-5.5":          { name: "GPT 5.5",          brand: "openai",    or_id: "openai/gpt-5.5",             openai_id: "gpt-5.5", cli_id: null, in_per_m: 5,    out_per_m: 30 },
  "gpt-5.1":          { name: "GPT 5.1",          brand: "openai",    or_id: "openai/gpt-5.1",             openai_id: "gpt-5.1", cli_id: null, in_per_m: 1.25, out_per_m: 10 },
  "glm-5.2":          { name: "GLM 5.2",          brand: "zai",       or_id: "z-ai/glm-5.2",               cli_id: null, in_per_m: 0.57, out_per_m: 1.8 },
  "grok-4.20":        { name: "Grok 4.20",        brand: "xai",       or_id: "x-ai/grok-4.20",             cli_id: null, in_per_m: 1.25, out_per_m: 2.5 },
  "gemini-3.5-flash": { name: "Gemini 3.5 Flash", brand: "google",    or_id: "google/gemini-3.5-flash",    cli_id: null, in_per_m: 1.5,  out_per_m: 9 },
  "deepseek-v4-pro":  { name: "DeepSeek V4 Pro",  brand: "deepseek",  or_id: "deepseek/deepseek-v4-pro",   cli_id: null, in_per_m: 0.43, out_per_m: 0.87 },
  "kimi-k2.7":        { name: "Kimi K2.7",        brand: "moonshot",  or_id: "moonshotai/kimi-k2.7-code",  cli_id: null, in_per_m: 0.74, out_per_m: 3.5 },
};

/* Registry key for the fixed judge model (see JUDGE below). */
const JUDGE_MODEL_KEY = "opus-4.8";

/* ============================================================================
 * CONSTANTS
 * ========================================================================== */
export const SYSTEM_PROMPT = 'You are competing in a one-shot game-building benchmark. Reply with ONE complete self-contained HTML file and nothing else — no markdown fences, no commentary before or after. Hard rules: no external requests of any kind (no CDNs, fonts, images, analytics); everything inline. The file runs inside a sandboxed iframe (sandbox="allow-scripts"): never use localStorage, sessionStorage, cookies, alert, prompt or confirm. Fill the whole viewport (html,body{margin:0;height:100%;overflow:hidden}) and look good in a SQUARE frame. If the request is a simulation: start automatically, run and loop forever, zero user input. If interactive: show minimal on-screen instructions and support both touch and keyboard. Push visual polish: cohesive palette, smooth motion, particles, depth — it will be judged on looks in a screen recording.';

const JUDGE_SYSTEM_PROMPT = 'You are the judge of a one-shot AI game-building benchmark. Score strictly. Reply ONLY with minified JSON, no fences.';

function buildJudgeUserPrompt(prompt, kind, html) {
  return `GAME PROMPT:\n${prompt}\n\nKIND: ${kind}\n\nHTML SOURCE:\n${html}\n\nScore integers 0-10: works (will it actually run and animate as intended — inspect the code for bugs), fidelity (does what was asked), polish (visual quality/motion/detail), creativity (flair beyond the ask). JSON shape: {"works":n,"fidelity":n,"polish":n,"creativity":n,"verdict":"<=90 chars"}`;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_HEADERS_EXTRA = {
  "HTTP-Referer": "https://ggcryptoh.github.io/code_bench_fun",
  "X-Title": "Code Bench Fun",
};
const OPENROUTER_MAX_TOKENS = 48000; // thinking models burn reasoning tokens from this same budget

const CLI_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes — big one-shot games via claude CLI can run long
const PROGRESS_INTERVAL_MS = 5000;
const TIMELINE_SAMPLE_MS = 400;

/* Track spawned children + in-flight fetches so SIGINT can kill them. */
const activeChildren = new Set();
const globalAbort = new AbortController();
let sigintHandlerInstalled = false;
function installSigintHandler() {
  if (sigintHandlerInstalled) return;
  sigintHandlerInstalled = true;
  process.on("SIGINT", () => {
    process.stderr.write("\n[bench] SIGINT — killing active processes…\n");
    globalAbort.abort();
    for (const child of activeChildren) {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }
    process.exit(130);
  });
}

/* ============================================================================
 * SMALL FORMATTERS (console progress + result table only)
 * ========================================================================== */
function fmtTok(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}
function fmtUSD(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 0.01) return "$" + n.toFixed(2);
  return "$" + n.toFixed(3);
}
function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
}
function round(n, decimals = 6) {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/* ============================================================================
 * ARG PARSING
 * ========================================================================== */
const FLAG_SPECS = {
  "--id": "value",
  "--title": "value",
  "--kind": "value",
  "--models": "value",
  "--prompt": "value",
  "--prompt-file": "value",
  "--judge-provider": "value",
  "--force-openrouter": "boolean",
  "--merge": "boolean",
  "--out-dir": "value",
  "--help": "boolean",
};

class UsageError extends Error {}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const spec = FLAG_SPECS[tok];
    if (!spec) throw new UsageError(`Unknown argument: ${tok}`);
    if (spec === "boolean") { out[tok] = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new UsageError(`${tok} requires a value`);
    out[tok] = val;
  }
  return out;
}

function usage() {
  return `Usage:
  node runner/bench.mjs --id <kebab-case-id> --title "<Title>" --kind simulation|interactive \\
    --models fable-5,glm-5.2,gpt-5.5,opus-4.8 --prompt "..." [--prompt-file p.txt] \\
    [--judge-provider claude-cli|openrouter] [--force-openrouter] [--out-dir <repo root>]

Required:
  --id            kebab-case run id (also the games/ and data/runs/ filename)
  --models        comma-separated model keys (see MODELS in this file / assets/site.js)
  --prompt        the game prompt (or use --prompt-file)

Optional:
  --title             defaults to a prettified --id
  --kind              simulation (default) | interactive
  --prompt-file       read the prompt from a file instead of --prompt
  --judge-provider    claude-cli (default) | openrouter
  --force-openrouter  route every model through OpenRouter, even ones with a cli_id
  --merge             re-run ONLY --models into an existing run (prompt/title/kind reused
                      from data/runs/<id>.json; other builds kept as-is)
  --out-dir           repo root to write into (default: parent of this script's directory)

Known model keys: ${Object.keys(MODELS).join(", ")}`;
}

function prettifyId(id) {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function parseArgs(argv) {
  let raw;
  try {
    raw = parseArgv(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message + "\n");
      console.error(usage());
      process.exit(1);
    }
    throw err;
  }

  if (raw["--help"]) {
    console.log(usage());
    process.exit(0);
  }

  const id = raw["--id"];
  if (!id) fail("Missing required --id");
  if (!isValidId(id)) fail(`--id must be kebab-case ([a-z0-9-]+), got: ${id}`);

  const kind = raw["--kind"] || "simulation";
  if (kind !== "simulation" && kind !== "interactive") {
    fail(`--kind must be "simulation" or "interactive", got: ${kind}`);
  }

  const modelsRaw = raw["--models"];
  if (!modelsRaw) fail("Missing required --models (comma-separated model keys)");
  const models = modelsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!models.length) fail("--models resolved to an empty list");
  for (const key of models) {
    if (!MODELS[key]) fail(`Unknown model key "${key}". Known keys: ${Object.keys(MODELS).join(", ")}`);
  }

  let prompt = raw["--prompt"];
  if (!prompt && raw["--prompt-file"]) {
    try {
      prompt = readPromptFile(raw["--prompt-file"]);
    } catch (err) {
      fail(`Could not read --prompt-file: ${err.message}`);
    }
  }
  if ((!prompt || !prompt.trim()) && !raw["--merge"]) fail("Missing --prompt or --prompt-file (with non-empty content)");

  const judgeProvider = raw["--judge-provider"] || "claude-cli";
  if (judgeProvider !== "claude-cli" && judgeProvider !== "openrouter") {
    fail(`--judge-provider must be "claude-cli" or "openrouter", got: ${judgeProvider}`);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outDir = raw["--out-dir"] ? path.resolve(process.cwd(), raw["--out-dir"]) : path.resolve(scriptDir, "..");

  return {
    id,
    title: raw["--title"] || prettifyId(id),
    kind,
    models,
    prompt,
    judgeProvider,
    forceOpenrouter: !!raw["--force-openrouter"],
    merge: !!raw["--merge"],
    rawTitle: raw["--title"] || null,
    rawKind: raw["--kind"] || null,
    outDir,
  };
}

function fail(msg) {
  console.error(msg + "\n");
  console.error(usage());
  process.exit(1);
}

function readPromptFile(p) {
  return readFileSync(path.resolve(process.cwd(), p), "utf8");
}

/* ============================================================================
 * OPENROUTER KEY
 * ========================================================================== */
let cachedOpenRouterKey = null;
function getOpenRouterKey() {
  if (cachedOpenRouterKey) return cachedOpenRouterKey;
  if (process.env.OPENROUTER_API_KEY) {
    cachedOpenRouterKey = process.env.OPENROUTER_API_KEY;
    return cachedOpenRouterKey;
  }
  // .env.local / .env at the repo root (gitignored) — OPENROUTER_API_KEY=sk-or-...
  for (const envFile of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(path.join(REPO_ROOT, envFile), "utf8");
      const m = txt.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^\s"'#]+)/m);
      if (m && m[1]) {
        cachedOpenRouterKey = m[1];
        return cachedOpenRouterKey;
      }
    } catch {
      /* file missing — try next source */
    }
  }
  try {
    const key = execSync("security find-generic-password -s OPENROUTER_API_KEY -w", { encoding: "utf8" }).trim();
    if (key) {
      cachedOpenRouterKey = key;
      return cachedOpenRouterKey;
    }
  } catch {
    /* fall through to error below */
  }
  throw new Error(
    "Missing OpenRouter API key: set OPENROUTER_API_KEY in the environment, put it in .env.local at the repo root, " +
      'or add it to macOS Keychain (service "OPENROUTER_API_KEY").'
  );
}

/* Direct OpenAI key: env → .env.local/.env → keychain (service OPENAI_KEY).
   When present, OpenAI models run against api.openai.com instead of OpenRouter. */
let cachedOpenAIKey = null;
function getOpenAIKey() {
  if (cachedOpenAIKey) return cachedOpenAIKey;
  if (process.env.OPENAI_API_KEY) {
    cachedOpenAIKey = process.env.OPENAI_API_KEY;
    return cachedOpenAIKey;
  }
  for (const envFile of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(path.join(REPO_ROOT, envFile), "utf8");
      const m = txt.match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^\s"'#]+)/m);
      if (m && m[1]) {
        cachedOpenAIKey = m[1];
        return cachedOpenAIKey;
      }
    } catch { /* try next source */ }
  }
  try {
    const key = execSync("security find-generic-password -s OPENAI_KEY -w", { encoding: "utf8" }).trim();
    if (key) {
      cachedOpenAIKey = key;
      return cachedOpenAIKey;
    }
  } catch { /* fall through */ }
  throw new Error("Missing OpenAI API key: set OPENAI_API_KEY (env or .env.local) or keychain service OPENAI_KEY.");
}

function hasOpenAIKey() {
  try { return !!getOpenAIKey(); } catch { return false; }
}

/* ============================================================================
 * HTML EXTRACTION (shared by both providers)
 * ========================================================================== */
export function extractHtml(raw, modelKey) {
  let text = String(raw ?? "");
  // Strip markdown code fences (``` or ```html etc.) without touching content between them.
  text = text.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, "");

  const lower = text.toLowerCase();
  const doctypeIdx = lower.search(/<!doctype/);
  const htmlTagIdx = lower.search(/<html[\s>]/);
  let startIdx = -1;
  if (doctypeIdx !== -1 && htmlTagIdx !== -1) startIdx = Math.min(doctypeIdx, htmlTagIdx);
  else startIdx = doctypeIdx !== -1 ? doctypeIdx : htmlTagIdx;

  const endIdx = lower.lastIndexOf("</html>");

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { ok: false, html: null, error: "no html in response", warning: null };
  }

  const html = text.slice(startIdx, endIdx + "</html>".length);

  let warning = null;
  if (/https?:\/\/[^"'\s]*\.(js|css|woff2?|png|jpg)/i.test(html)) {
    warning = "possible external resource reference in output";
    process.stderr.write(`[${modelKey}] warning: ${warning}\n`);
  }

  return { ok: true, html, error: null, warning };
}

/* ============================================================================
 * CLAUDE CLI PROVIDER
 *
 * Verified against `claude` 2.1.201 via `claude --help`:
 *   -p / --print                 print mode, non-interactive
 *   --model <model>              full model id (e.g. claude-opus-4-8) or alias
 *   --output-format json         single JSON result on stdout
 *   --append-system-prompt <s>   append to (not replace) the default system prompt
 *   --tools <list>               "" disables all tools (no Bash/Edit/etc, so the
 *                                 model can't take extra agentic turns)
 * There is NO --max-turns flag in this CLI version — disabling tools already
 * forces a single response turn, so no turn cap is needed.
 * The user prompt is passed on stdin with no positional prompt argument;
 * verified this works (`printf '...' | claude -p --model ... --tools ""`
 * returns the expected single JSON result on stdout).
 * ========================================================================== */
function spawnClaudeCli(args, stdinInput, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.on("error", () => { /* ignore EPIPE if the process died early */ });
    child.stdin.write(stdinInput);
    child.stdin.end();
  });
}

async function runClaudeCliBuild({ runId, modelKey, entry, prompt }) {
  const providerModelId = entry.cli_id;
  const startedAt = Date.now();
  const progressTimer = setInterval(() => {
    process.stderr.write(`[${modelKey}] running… ${fmtDuration(Date.now() - startedAt)} elapsed\n`);
  }, PROGRESS_INTERVAL_MS);

  let result;
  try {
    result = await spawnClaudeCli(
      ["-p", "--model", providerModelId, "--output-format", "json", "--append-system-prompt", SYSTEM_PROMPT, "--tools", ""],
      prompt,
      CLI_TIMEOUT_MS
    );
  } catch (err) {
    clearInterval(progressTimer);
    return {
      build: makeFailedBuild(modelKey, "claude-cli", providerModelId, Date.now() - startedAt, `spawn error: ${err.message}`),
      html: null,
    };
  }
  clearInterval(progressTimer);
  const ms = Date.now() - startedAt;

  if (result.timedOut) {
    return {
      build: makeFailedBuild(modelKey, "claude-cli", providerModelId, ms, `timed out after ${fmtDuration(CLI_TIMEOUT_MS)}`),
      html: null,
    };
  }
  if (result.code !== 0) {
    return {
      build: makeFailedBuild(
        modelKey, "claude-cli", providerModelId, ms,
        `claude exited ${result.code}: ${(result.stderr || "").slice(0, 300).trim()}`
      ),
      html: null,
    };
  }

  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (err) {
    return {
      build: makeFailedBuild(modelKey, "claude-cli", providerModelId, ms, `unparseable claude output: ${err.message}`),
      html: null,
    };
  }
  if (json.is_error) {
    return {
      build: makeFailedBuild(modelKey, "claude-cli", providerModelId, ms, `claude error: ${String(json.result || "").slice(0, 300)}`),
      html: null,
    };
  }

  const usage = json.usage || {};
  const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;
  const costUsd = typeof json.total_cost_usd === "number" ? json.total_cost_usd : 0;
  const turns = typeof json.num_turns === "number" ? json.num_turns : 1;
  const tps = outputTokens > 0 && ms > 0 ? round((outputTokens / (ms / 1000)), 1) : 0;

  const extraction = extractHtml(json.result, modelKey);

  const build = {
    model_key: modelKey,
    provider: "claude-cli",
    provider_model_id: providerModelId,
    ok: extraction.ok,
    error: extraction.ok ? null : extraction.error,
    ms,
    turns,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    tps,
    timeline: null,
  };
  if (extraction.ok) {
    build.file = `games/${runId}/${modelKey}.html`;
    build.judge = null;
  }

  if (extraction.ok) {
    process.stderr.write(`[${modelKey}] done ${fmtDuration(ms)} · ${fmtTok(outputTokens)} tok · ${fmtUSD(costUsd)}\n`);
  } else {
    process.stderr.write(`[${modelKey}] failed: ${build.error}\n`);
  }

  return { build, html: extraction.ok ? extraction.html : null };
}

/* ============================================================================
 * OPENROUTER PROVIDER (streaming SSE)
 * ========================================================================== */
async function runOpenRouterBuild({ runId, modelKey, entry, prompt, api = "openrouter" }) {
  const isOpenAI = api === "openai";
  const providerName = isOpenAI ? "openai" : "openrouter";
  const providerModelId = isOpenAI ? entry.openai_id : entry.or_id;
  const endpoint = isOpenAI ? "https://api.openai.com/v1/chat/completions" : OPENROUTER_URL;
  const startedAt = Date.now();

  const body = {
    model: providerModelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  };
  if (isOpenAI) {
    body.max_completion_tokens = OPENROUTER_MAX_TOKENS; // GPT-5 family rejects max_tokens
    body.reasoning_effort = "medium";
  } else {
    body.usage = { include: true };
    body.max_tokens = OPENROUTER_MAX_TOKENS;
    // Cap thinking so reasoning models don't spend the whole token budget before writing HTML.
    // OpenRouter drops this for models without reasoning support.
    body.reasoning = { effort: "medium" };
  }

  let apiKey;
  try {
    apiKey = isOpenAI ? getOpenAIKey() : getOpenRouterKey();
  } catch (err) {
    return { build: makeFailedBuild(modelKey, providerName, providerModelId, 0, err.message), html: null };
  }

  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(endpoint, {
        method: "POST",
        signal: globalAbort.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(isOpenAI ? {} : OPENROUTER_HEADERS_EXTRA),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        build: makeFailedBuild(modelKey, providerName, providerModelId, Date.now() - startedAt, `network error: ${err.message}`),
        html: null,
      };
    }

    if (res.ok && res.body) break;

    const text = await res.text().catch(() => "");

    // OpenRouter 402 = the key's spend limit can't pre-authorize max_tokens; clamp and retry.
    const afford = !isOpenAI && res.status === 402 && text.match(/can only afford (\d+)/);
    if (afford && Number(afford[1]) > 4000) {
      body.max_tokens = Number(afford[1]) - 500;
      process.stderr.write(`[${modelKey}] 402 spend-limit — retrying with max_tokens=${body.max_tokens}\n`);
      continue;
    }
    // Some providers/models reject the reasoning params outright — drop and retry once.
    if (res.status === 400 && /reasoning/i.test(text) && (body.reasoning || body.reasoning_effort)) {
      delete body.reasoning;
      delete body.reasoning_effort;
      process.stderr.write(`[${modelKey}] rejected reasoning param — retrying without it\n`);
      continue;
    }
    // Older OpenAI models want max_tokens instead of max_completion_tokens.
    if (isOpenAI && res.status === 400 && /max_completion_tokens/i.test(text) && body.max_completion_tokens) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
      process.stderr.write(`[${modelKey}] swapping to max_tokens — retrying\n`);
      continue;
    }
    return {
      build: makeFailedBuild(
        modelKey, providerName, providerModelId, Date.now() - startedAt,
        `HTTP ${res.status}: ${text.slice(0, 300)}`
      ),
      html: null,
    };
  }
  if (!res || !res.ok || !res.body) {
    return {
      build: makeFailedBuild(modelKey, providerName, providerModelId, Date.now() - startedAt, "request failed after retries"),
      html: null,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let usage = null;
  const timeline = [[0, 0]];
  let lastSampleMs = 0;
  let lastProgressMs = 0;

  function pushSample(force) {
    const now = Date.now() - startedAt;
    if (!force && now - lastSampleMs < TIMELINE_SAMPLE_MS) return;
    lastSampleMs = now;
    timeline.push([now, Math.round(content.length / 4)]);
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          const choice = parsed.choices && parsed.choices[0];
          const delta = choice && choice.delta && choice.delta.content;
          if (typeof delta === "string" && delta.length) {
            content += delta;
            pushSample(false);
          }
          if (parsed.usage) usage = parsed.usage;
        }
      }
      const nowMs = Date.now() - startedAt;
      if (nowMs - lastProgressMs > PROGRESS_INTERVAL_MS) {
        lastProgressMs = nowMs;
        const estTok = content.length / 4;
        const estCost = (estTok * (entry.out_per_m || 0)) / 1e6;
        process.stderr.write(`[${modelKey}] streaming… ${fmtTok(estTok)} tok ${fmtUSD(estCost)}\n`);
      }
    }
  } catch (err) {
    return {
      build: makeFailedBuild(modelKey, providerName, providerModelId, Date.now() - startedAt, `stream error: ${err.message}`),
      html: null,
    };
  }

  pushSample(true);
  const ms = Date.now() - startedAt;
  const completionTokens = usage && typeof usage.completion_tokens === "number" ? usage.completion_tokens : Math.round(content.length / 4);
  const promptTokens = usage && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;

  // Rescale timeline samples so the last one lands exactly on completionTokens.
  const lastSampleTok = timeline[timeline.length - 1][1] || 1;
  for (const sample of timeline) {
    sample[1] = Math.round((sample[1] * completionTokens) / lastSampleTok);
  }

  let costUsd;
  if (usage && typeof usage.cost === "number") {
    costUsd = usage.cost;
  } else {
    costUsd = (promptTokens * (entry.in_per_m || 0) + completionTokens * (entry.out_per_m || 0)) / 1e6;
  }
  const tps = completionTokens > 0 && ms > 0 ? round(completionTokens / (ms / 1000), 1) : 0;

  const extraction = extractHtml(content, modelKey);

  const build = {
    model_key: modelKey,
    provider: providerName,
    provider_model_id: providerModelId,
    ok: extraction.ok,
    error: extraction.ok ? null : extraction.error,
    ms,
    turns: 1,
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    cost_usd: costUsd,
    tps,
    timeline,
  };
  if (extraction.ok) {
    build.file = `games/${runId}/${modelKey}.html`;
    build.judge = null;
  }

  if (extraction.ok) {
    process.stderr.write(`[${modelKey}] done ${fmtDuration(ms)} · ${fmtTok(completionTokens)} tok · ${fmtUSD(costUsd)}\n`);
  } else {
    process.stderr.write(`[${modelKey}] failed: ${build.error}\n`);
  }

  return { build, html: extraction.ok ? extraction.html : null };
}

function makeFailedBuild(modelKey, provider, providerModelId, ms, error) {
  return {
    model_key: modelKey,
    provider,
    provider_model_id: providerModelId,
    ok: false,
    error,
    ms: ms || 0,
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    tps: 0,
    timeline: null,
  };
}

/* ============================================================================
 * BUILD DISPATCH
 * ========================================================================== */
async function runOneModel({ runId, modelKey, prompt, forceOpenrouter }) {
  const entry = MODELS[modelKey];
  const useCli = !!entry.cli_id && !forceOpenrouter;
  if (useCli) {
    return runClaudeCliBuild({ runId, modelKey, entry, prompt });
  }
  // OpenAI models go direct to api.openai.com when a key is available (exact first-party
  // billing, no OpenRouter spend-limit preauth); --force-openrouter overrides.
  if (entry.openai_id && !forceOpenrouter && hasOpenAIKey()) {
    return runOpenRouterBuild({ runId, modelKey, entry, prompt, api: "openai" });
  }
  if (!entry.or_id) {
    return { build: makeFailedBuild(modelKey, "openrouter", null, 0, "model has no or_id configured"), html: null };
  }
  return runOpenRouterBuild({ runId, modelKey, entry, prompt });
}

/* ============================================================================
 * JUDGE
 * ========================================================================== */
async function judgeViaClaudeCli(userPrompt) {
  const result = await spawnClaudeCli(
    ["-p", "--model", MODELS[JUDGE_MODEL_KEY].cli_id, "--output-format", "json", "--append-system-prompt", JUDGE_SYSTEM_PROMPT, "--tools", ""],
    userPrompt,
    CLI_TIMEOUT_MS
  );
  if (result.timedOut) throw new Error("judge timed out");
  if (result.code !== 0) throw new Error(`claude judge exited ${result.code}: ${(result.stderr || "").slice(0, 300).trim()}`);
  const json = JSON.parse(result.stdout);
  if (json.is_error) throw new Error(`claude judge error: ${String(json.result || "").slice(0, 300)}`);
  return json.result;
}

async function judgeViaOpenRouter(userPrompt) {
  const apiKey = getOpenRouterKey();
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: globalAbort.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...OPENROUTER_HEADERS_EXTRA,
    },
    body: JSON.stringify({
      model: MODELS[JUDGE_MODEL_KEY].or_id,
      stream: false,
      max_tokens: 2000,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`judge HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("empty judge response");
  return content;
}

function parseJudgeJson(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object in judge response");
  const parsed = JSON.parse(text.slice(start, end + 1));
  for (const key of ["works", "fidelity", "polish", "creativity"]) {
    if (typeof parsed[key] !== "number") throw new Error(`judge response missing numeric "${key}"`);
  }
  if (typeof parsed.verdict !== "string") throw new Error('judge response missing "verdict"');
  return parsed;
}

async function judgeBuild({ html, prompt, kind, provider }) {
  const userPrompt = buildJudgeUserPrompt(prompt, kind, html);
  const raw = provider === "openrouter" ? await judgeViaOpenRouter(userPrompt) : await judgeViaClaudeCli(userPrompt);
  const parsed = parseJudgeJson(raw);
  const score = round(parsed.works * 0.35 + parsed.fidelity * 0.3 + parsed.polish * 0.25 + parsed.creativity * 0.1, 1);
  return {
    works: parsed.works,
    fidelity: parsed.fidelity,
    polish: parsed.polish,
    creativity: parsed.creativity,
    score,
    verdict: parsed.verdict,
  };
}

/* ============================================================================
 * INDEX / RUN OUTPUT HELPERS (exported so import.mjs can reuse them verbatim)
 * ========================================================================== */
export function computeSummary({ id, title, prompt, kind, created, builds }) {
  const okBuilds = builds.filter((b) => b.ok);
  const totals = {
    cost_usd: round(builds.reduce((s, b) => s + (b.cost_usd || 0), 0), 6),
    output_tokens: builds.reduce((s, b) => s + (b.output_tokens || 0), 0),
    ms: builds.reduce((s, b) => Math.max(s, b.ms || 0), 0),
  };

  let best = null;
  if (okBuilds.length) {
    const judged = okBuilds.filter((b) => b.judge && typeof b.judge.score === "number");
    best = judged.length ? judged.reduce((a, b) => (b.judge.score > a.judge.score ? b : a)) : okBuilds[0];
  }

  return {
    id,
    title,
    prompt,
    kind,
    created,
    models: builds.map((b) => b.model_key),
    cover: best ? `games/${id}/${best.model_key}.html` : null,
    best: best ? best.model_key : null,
    totals,
  };
}

export async function upsertIndex(outDir, summary) {
  const indexPath = path.join(outDir, "data", "index.json");
  let index = { updated: summary.created, runs: [] };
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.runs)) index = parsed;
  } catch {
    /* file missing or unreadable → start fresh */
  }

  const existingIdx = index.runs.findIndex((r) => r.id === summary.id);
  if (existingIdx !== -1) index.runs.splice(existingIdx, 1);
  index.runs.unshift(summary);
  index.updated = new Date().toISOString();

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  return index;
}

async function writeGameFiles(outDir, runId, entries) {
  const gamesDir = path.join(outDir, "games", runId);
  await fs.mkdir(gamesDir, { recursive: true });
  for (const e of entries) {
    if (e.build.ok && e.html) {
      await fs.writeFile(path.join(gamesDir, `${e.build.model_key}.html`), e.html, "utf8");
    }
  }
}

async function writeRunDetail(outDir, runDetail) {
  const runsDir = path.join(outDir, "data", "runs");
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(path.join(runsDir, `${runDetail.id}.json`), JSON.stringify(runDetail, null, 2) + "\n", "utf8");
}

/* ============================================================================
 * RESULT TABLE
 * ========================================================================== */
function printTable(builds) {
  const header = ["model", "ms", "in", "out", "cost", "score"];
  const rows = builds.map((b) => [
    b.model_key,
    fmtDuration(b.ms),
    fmtTok(b.input_tokens),
    fmtTok(b.output_tokens),
    fmtUSD(b.cost_usd),
    b.judge && typeof b.judge.score === "number" ? String(b.judge.score) : b.ok ? "—" : "FAIL",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

/* ============================================================================
 * MAIN
 * ========================================================================== */
async function main() {
  installSigintHandler();
  const opts = parseArgs(process.argv.slice(2));

  // --merge: re-run a subset of models into an existing run, reusing its prompt/title/kind.
  let existingRun = null;
  if (opts.merge) {
    const runPath = path.join(opts.outDir, "data", "runs", `${opts.id}.json`);
    try {
      existingRun = JSON.parse(await fs.readFile(runPath, "utf8"));
    } catch {
      console.error(`--merge: could not read existing run at ${runPath}`);
      process.exit(1);
    }
    if (!opts.prompt) opts.prompt = existingRun.prompt;
    if (!opts.rawTitle) opts.title = existingRun.title || opts.title;
    if (!opts.rawKind) opts.kind = existingRun.kind || opts.kind;
    if (!opts.prompt || !opts.prompt.trim()) {
      console.error("--merge: existing run has no prompt and none was given");
      process.exit(1);
    }
  }

  process.stderr.write(
    `[bench] id=${opts.id} kind=${opts.kind} models=${opts.models.join(",")} judge=${opts.judgeProvider}` +
      (opts.forceOpenrouter ? " (forced openrouter)" : "") + (opts.merge ? " (merge)" : "") + "\n"
  );

  const settled = await Promise.allSettled(
    opts.models.map((modelKey) =>
      runOneModel({ runId: opts.id, modelKey, prompt: opts.prompt, forceOpenrouter: opts.forceOpenrouter })
    )
  );

  const entries = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const modelKey = opts.models[i];
    process.stderr.write(`[${modelKey}] failed: ${r.reason}\n`);
    return { build: makeFailedBuild(modelKey, "unknown", null, 0, `unexpected error: ${r.reason}`), html: null };
  });

  // Judge every successful build in parallel.
  await Promise.allSettled(
    entries.map(async (e) => {
      if (!e.build.ok) return;
      try {
        const judge = await judgeBuild({ html: e.html, prompt: opts.prompt, kind: opts.kind, provider: opts.judgeProvider });
        e.build.judge = judge;
        process.stderr.write(`[judge] ${e.build.model_key} → ${judge.score}/10 "${judge.verdict}"\n`);
      } catch (err) {
        e.build.judge = null;
        process.stderr.write(`[judge] ${e.build.model_key} failed: ${err.message}\n`);
      }
    })
  );

  let builds = entries.map((e) => e.build);
  let created = new Date().toISOString();

  if (existingRun) {
    // Keep untouched builds in their original order; replace re-run ones in place, append new keys.
    const rerun = new Map(builds.map((b) => [b.model_key, b]));
    const merged = (existingRun.builds || []).map((b) => (rerun.has(b.model_key) ? rerun.get(b.model_key) : b));
    for (const b of builds) if (!(existingRun.builds || []).some((x) => x.model_key === b.model_key)) merged.push(b);
    builds = merged;
    created = existingRun.created || created;
  }

  await writeGameFiles(opts.outDir, opts.id, entries);

  const runDetail = {
    id: opts.id,
    title: opts.title,
    prompt: opts.prompt,
    system_prompt: SYSTEM_PROMPT,
    kind: opts.kind,
    created,
    judge: { model_key: JUDGE_MODEL_KEY, provider: opts.judgeProvider },
    builds,
  };
  await writeRunDetail(opts.outDir, runDetail);

  const summary = computeSummary({ id: opts.id, title: opts.title, prompt: opts.prompt, kind: opts.kind, created, builds });
  await upsertIndex(opts.outDir, summary);

  console.log("");
  printTable(builds);
  console.log(`\n→ run.html?id=${opts.id}`);
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
    console.error(`[bench] fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
