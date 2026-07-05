# Code Bench Fun

One prompt. Every model. One shot. — A benchmark where AI models each build the same game in a single completion. Time, tokens, cost, and turns are counted; Opus 4.8 judges the results.

**Live:** https://ggcryptoh.github.io/code_bench_fun/

## How It Works

- **Gallery** — Browse all runs. Leaderboard strip ranks models by aggregate score. Click any game to view all four builds side-by-side.
- **Run Viewer** — Watch each model build in real-time with animated cost counters (relative replay speeds are accurate). Reel mode captures a clean 2x2 video grid for vertical recording.
- **One-Shot Bench** — Build your own benchmarks. Bring your OpenRouter API key, type a game prompt, pick your models, and watch. Full stats and judge verdicts appear instantly in the browser.

## Running a Bench Locally

```bash
node runner/bench.mjs \
  --id my-run \
  --title "My Run" \
  --kind simulation \
  --models fable-5,glm-5.2,gpt-5.5,opus-4.8 \
  --prompt "Make a space shooter where the player dodges asteroids"
```

**Note:** Claude models (fable-5, sonnet-5, haiku-4.5, opus-4.8) use the local `claude` CLI (requires Claude subscription). All others use the `OPENROUTER_API_KEY` environment variable or macOS keychain service.

## Importing a Browser Bundle

```bash
node runner/import.mjs cbf-run-*.json
```

This imports a run bundle (exported from bench.html) into the data/ and games/ directories.

## Local Preview

```bash
python3 -m http.server 8080
```

Then visit http://localhost:8080.

## Data Layout

See [docs/SCHEMA.md](docs/SCHEMA.md) for full specification of run files, build stats, judge verdicts, and game file rules.

## Cost Warning

Running benchmarks spends real API money. Depending on model size and prompt complexity, a single benchmark run can cost $1 or more per game. Start small.

## License

MIT — Copyright Geoff Hopkins.

Note: Games in the gallery are AI-generated outputs. See privacy policy for details on data handling.
