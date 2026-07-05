# Code Bench Fun — Data Contract

Static site (GitHub Pages). No build step. All pages are vanilla HTML/CSS/JS and load
`assets/site.css` + `assets/site.js` (which defines `window.CBF` — model registry, brand
logos, formatters, data loaders).

## File layout

```
index.html                  gallery (all runs, leaderboard strip up top)
run.html?id=<runId>         run viewer — all builds at once, animated cost counters, reel mode
bench.html                  one-shot chat builder (BYO OpenRouter key, in-browser)
privacy.html                privacy policy
assets/site.css             design tokens + shared components
assets/site.js              window.CBF registry + helpers
data/index.json             run summaries
data/runs/<runId>.json      run detail
games/<runId>/<modelKey>.html   self-contained game (iframe sandbox="allow-scripts")
runner/bench.mjs            local Node runner (claude-cli + openrouter providers)
runner/import.mjs           imports a bench.html "run bundle" JSON into data/ + games/
```

## data/index.json

```json
{
  "updated": "2026-07-05T00:00:00Z",
  "runs": [
    {
      "id": "cars-canyon",
      "title": "Cars vs Canyon",
      "prompt": "full user prompt…",
      "kind": "simulation",            // "simulation" (autoplay, no input) | "interactive"
      "created": "2026-07-05T00:00:00Z",
      "models": ["fable-5", "glm-5.2", "gpt-5.5", "opus-4.8"],  // panel order
      "cover": "games/cars-canyon/opus-4.8.html",               // best build, used as gallery preview
      "best": "opus-4.8",                                        // highest judge score
      "totals": { "cost_usd": 1.70, "output_tokens": 41234, "ms": 412345 }
    }
  ]
}
```

## data/runs/<runId>.json

```json
{
  "id": "cars-canyon",
  "title": "Cars vs Canyon",
  "prompt": "full user prompt…",
  "system_prompt": "the exact shared system prompt…",
  "kind": "simulation",
  "created": "2026-07-05T00:00:00Z",
  "judge": { "model_key": "opus-4.8", "provider": "claude-cli" },
  "builds": [
    {
      "model_key": "fable-5",           // key into CBF.MODELS
      "provider": "claude-cli",          // "claude-cli" | "openrouter"
      "provider_model_id": "claude-fable-5",
      "file": "games/cars-canyon/fable-5.html",
      "ok": true,
      "error": null,
      "ms": 183000,                      // wall-clock generation time
      "turns": 1,
      "input_tokens": 1420,
      "output_tokens": 9120,
      "cost_usd": 0.47,
      "tps": 49.8,                       // output tokens / second
      "timeline": [[0,0],[500,22],[1000,51]],  // [ms, output_tokens] samples, or null
      "judge": {
        "works": 9, "fidelity": 8, "polish": 9, "creativity": 7,   // each 0-10
        "score": 8.4,                                              // weighted 0-10
        "verdict": "one-liner from the judge"
      }
    }
  ]
}
```

Failed builds keep their stats, `ok:false`, `error` string, no `file`/`judge`.

## Game file rules (enforced by the shared system prompt)

- ONE self-contained .html file. No external requests of any kind (no CDN, fonts, images).
- Must run inside `<iframe sandbox="allow-scripts">` — no localStorage, no alerts.
- Fill the viewport (`html,body{margin:0;height:100%}`), scale to any square-ish size.
- kind=simulation → starts automatically, runs/loops forever, zero user input needed.

## window.CBF (assets/site.js)

- `CBF.MODELS` — `{ [modelKey]: { name, brand, or_id, cli_id|null, in_per_m, out_per_m } }`
- `CBF.BRANDS` — `{ [brand]: { name, color, logo(size) → svg string } }`
- `CBF.logoChip(modelKey, size)` → HTML string: logo + model name, brand-colored
- `CBF.fmtUSD(n)` (`$1.10`, sub-cent → `$0.003`), `CBF.fmtTok(n)` (`9.1k`), `CBF.fmtMs(ms)` (`3m 04s`)
- `CBF.loadIndex()`, `CBF.loadRun(id)` → fetch the JSON (relative paths, work under a subpath)
- `CBF.counter(el, build, scaleMs)` — animates a header counter: starts at input cost,
  ticks output cost/tokens along `timeline` (or linearly over `ms` if no timeline),
  total replay duration = `build.ms / (maxMsInRun / scaleMs)` so RELATIVE SPEEDS ARE REAL.
```
