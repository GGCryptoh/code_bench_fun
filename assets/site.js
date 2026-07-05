/* Code Bench Fun — shared registry + helpers. Exposes window.CBF. No dependencies. */
(function () {
  "use strict";

  /* ---------- brand logos (simplified flat marks, size px) ---------- */
  function rays(size, color, n, inner, w) {
    // Anthropic-style sunburst: n tapered rays
    let p = "";
    for (let i = 0; i < n; i++) {
      const a = (i * 360) / n;
      p += `<path d="M0 ${-inner} L${w} ${-size / 2 + 2} L${-w} ${-size / 2 + 2} Z" transform="rotate(${a})" fill="${color}"/>`;
    }
    return `<svg width="${size}" height="${size}" viewBox="${-size / 2} ${-size / 2} ${size} ${size}">${p}</svg>`;
  }

  const BRANDS = {
    anthropic: {
      name: "Anthropic", color: "#D97757",
      logo: (s) => rays(s, "#D97757", 12, s * 0.1, s * 0.09),
    },
    openai: {
      name: "OpenAI", color: "#6AC4A8",
      logo: (s) => {
        let petals = "";
        for (let i = 0; i < 6; i++)
          petals += `<rect x="-2.1" y="${-s / 2 + 1.5}" width="4.2" height="${s * 0.42}" rx="2.1" transform="rotate(${i * 60})" fill="none" stroke="#E8E8E8" stroke-width="1.6"/>`;
        return `<svg width="${s}" height="${s}" viewBox="${-s / 2} ${-s / 2} ${s} ${s}">${petals}</svg>`;
      },
    },
    zai: {
      name: "Z.ai", color: "#7AA2FF",
      logo: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="5" fill="#F5F5F5"/><path d="M7 7.6h10l-7.2 8.8H17V19H7v-1.4l7.2-8.6H7z" fill="#0a0a0a"/></svg>`,
    },
    openrouter: {
      name: "OpenRouter", color: "#8B8BF5",
      logo: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M2 12h6l3-5 4 10 3-5h4" fill="none" stroke="#8B8BF5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    },
    google: {
      name: "Google", color: "#7CACF8",
      logo: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 1c.6 6.2 4.8 10.4 11 11-6.2.6-10.4 4.8-11 11-.6-6.2-4.8-10.4-11-11 6.2-.6 10.4-4.8 11-11z" fill="#7CACF8"/></svg>`,
    },
    xai: {
      name: "xAI", color: "#E8E8E8",
      logo: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M4 3l10.5 18H20L9.5 3H4zm12.6 0L13 9.4l1.8 3L20 3h-3.4zM4 21h3.4l3-5.2-1.7-3L4 21z" fill="#E8E8E8"/></svg>`,
    },
    deepseek: {
      name: "DeepSeek", color: "#6E8CFB",
      logo: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M3 14c0-5 4-9 9-9 3 0 5 1 7 3l2-1-1 4c1 4-2 9-8 9-5.5 0-9-2.5-9-6zm9-5a4 4 0 100 8 4 4 0 000-8z" fill="none" stroke="#6E8CFB" stroke-width="1.8"/></svg>`,
    },
    moonshot: {
      name: "Moonshot", color: "#9AE6B4",
      logo: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M20 13.5A8.5 8.5 0 1110.5 4 7 7 0 0020 13.5z" fill="#9AE6B4"/></svg>`,
    },
  };

  /* ---------- model registry ----------
     or_id: OpenRouter model id | null. cli_id: claude CLI model id | null.
     in_per_m / out_per_m: USD per 1M tokens (for live cost ticking + in-browser bench). */
  const MODELS = {
    "fable-5":          { name: "Fable 5",      brand: "anthropic", or_id: "anthropic/claude-fable-5",  cli_id: "claude-fable-5",   in_per_m: 10,   out_per_m: 50 },
    "opus-4.8":         { name: "Opus 4.8",     brand: "anthropic", or_id: "anthropic/claude-opus-4.8", cli_id: "claude-opus-4-8",  in_per_m: 5,    out_per_m: 25 },
    "sonnet-5":         { name: "Sonnet 5",     brand: "anthropic", or_id: "anthropic/claude-sonnet-5", cli_id: "claude-sonnet-5",  in_per_m: 2,    out_per_m: 10 },
    "haiku-4.5":        { name: "Haiku 4.5",    brand: "anthropic", or_id: "anthropic/claude-haiku-4.5",cli_id: "claude-haiku-4-5-20251001", in_per_m: 1, out_per_m: 5 },
    "gpt-5.5":          { name: "GPT 5.5",      brand: "openai",    or_id: "openai/gpt-5.5",            openai_id: "gpt-5.5", cli_id: null, in_per_m: 5,    out_per_m: 30 },
    "gpt-5.1":          { name: "GPT 5.1",      brand: "openai",    or_id: "openai/gpt-5.1",            openai_id: "gpt-5.1", cli_id: null, in_per_m: 1.25, out_per_m: 10 },
    "glm-5.2":          { name: "GLM 5.2",      brand: "zai",       or_id: "z-ai/glm-5.2",              cli_id: null, in_per_m: 0.57, out_per_m: 1.8 },
    "grok-4.20":        { name: "Grok 4.20",    brand: "xai",       or_id: "x-ai/grok-4.20",            cli_id: null, in_per_m: 1.25, out_per_m: 2.5 },
    "gemini-3.5-flash": { name: "Gemini 3.5 Flash", brand: "google", or_id: "google/gemini-3.5-flash",  cli_id: null, in_per_m: 1.5,  out_per_m: 9 },
    "deepseek-v4-pro":  { name: "DeepSeek V4 Pro", brand: "deepseek", or_id: "deepseek/deepseek-v4-pro", cli_id: null, in_per_m: 0.43, out_per_m: 0.87 },
    "kimi-k2.7":        { name: "Kimi K2.7",    brand: "moonshot",  or_id: "moonshotai/kimi-k2.7-code", cli_id: null, in_per_m: 0.74, out_per_m: 3.5 },
  };

  /* ---------- formatters ---------- */
  function fmtUSD(n) {
    if (n == null || isNaN(n)) return "—";
    if (n >= 0.995) return "$" + n.toFixed(2);
    if (n >= 0.01) return "$" + n.toFixed(2);
    return "$" + n.toFixed(3);
  }
  function fmtTok(n) {
    if (n == null || isNaN(n)) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  }

  function logoChip(modelKey, size) {
    size = size || 20;
    const m = MODELS[modelKey] || { name: modelKey, brand: "openrouter" };
    const b = BRANDS[m.brand] || BRANDS.openrouter;
    return `<span class="chip" style="color:${b.color}">${b.logo(size)}<span>${m.name}</span></span>`;
  }

  function siteLogo(size) {
    size = size || 22;
    // controller-ish square: two buttons + dpad, monochrome
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><rect x="1.5" y="4.5" width="21" height="15" rx="4" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M7 9.5v5M4.5 12h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="16" cy="10.5" r="1.3" fill="#fff"/><circle cx="19" cy="13.5" r="1.3" fill="#fff"/></svg>`;
  }

  /* ---------- data loading (relative → works under GH Pages subpath) ---------- */
  const base = location.pathname.replace(/[^/]*$/, "");
  async function loadJSON(p) {
    const r = await fetch(base + p, { cache: "no-cache" });
    if (!r.ok) throw new Error(p + " → " + r.status);
    return r.json();
  }
  const loadIndex = () => loadJSON("data/index.json");
  const loadRun = (id) => loadJSON("data/runs/" + encodeURIComponent(id) + ".json");

  /* ---------- counter replay ----------
     els: {cost, tok?, tps?, bar?}   build: schema build object
     maxMs: slowest build in the run; scaleMs: replay length of the slowest build.
     Relative speeds stay truthful: this build replays in ms * scaleMs / maxMs. */
  function counter(els, build, maxMs, scaleMs, onDone) {
    scaleMs = scaleMs || 20000;
    const m = MODELS[build.model_key] || { in_per_m: 0, out_per_m: 0 };
    const outTok = build.output_tokens || 0;
    const cost = build.cost_usd || 0;
    const inCost = Math.min(cost, ((build.input_tokens || 0) * (m.in_per_m || 0)) / 1e6);
    const outCost = Math.max(0, cost - inCost);
    const dur = maxMs > 0 ? (build.ms / maxMs) * scaleMs : scaleMs;
    const tl = Array.isArray(build.timeline) && build.timeline.length > 1 ? build.timeline : null;

    function tokensAt(frac) {
      if (!tl) return outTok * frac;
      const t = frac * build.ms;
      let lo = tl[0], hi = tl[tl.length - 1];
      for (let i = 1; i < tl.length; i++) if (tl[i][0] >= t) { hi = tl[i]; lo = tl[i - 1]; break; }
      const span = hi[0] - lo[0] || 1;
      const tok = lo[1] + (hi[1] - lo[1]) * ((t - lo[0]) / span);
      return Math.min(outTok, tok * (outTok / Math.max(1, tl[tl.length - 1][1]))); // normalize samples → exact final
    }

    let raf, start, done = false;
    function paint(frac) {
      const tok = tokensAt(frac);
      if (els.cost) els.cost.textContent = fmtUSD(inCost + outCost * (outTok ? tok / outTok : frac));
      if (els.tok) els.tok.textContent = fmtTok(tok) + " tok";
      if (els.tps) els.tps.textContent = (build.tps != null ? build.tps.toFixed(1) : "—") + " tok/s";
      if (els.time) els.time.textContent = fmtMs(frac * build.ms); // ticking timer, true relative speed
      if (els.bar) els.bar.style.width = (frac * 100).toFixed(2) + "%";
    }
    function step(ts) {
      if (!start) start = ts;
      const frac = Math.min(1, (ts - start) / dur);
      paint(frac);
      if (frac < 1) raf = requestAnimationFrame(step);
      else { done = true; if (els.bar) els.bar.style.width = "0%"; if (onDone) onDone(); }
    }
    raf = requestAnimationFrame(step);
    return {
      cancel() { cancelAnimationFrame(raf); },
      finish() { if (!done) { cancelAnimationFrame(raf); paint(1); done = true; if (els.bar) els.bar.style.width = "0%"; if (onDone) onDone(); } },
    };
  }

  /* shared topbar */
  function topbar(active) {
    const links = [
      ["index.html", "Gallery"], ["bench.html", "One-Shot Bench"], ["usage.html", "Usage"], ["privacy.html", "Privacy"],
    ];
    return `<header class="topbar"><a class="brand" href="index.html">${siteLogo(22)}<span>Code Bench Fun</span><span class="sub">— one prompt, every model</span></a><nav>${links
      .map(([h, t]) => `<a href="${h}"${h === active ? ' class="on"' : ""}>${t}</a>`)
      .join("")}</nav></header>`;
  }

  window.CBF = { MODELS, BRANDS, fmtUSD, fmtTok, fmtMs, logoChip, siteLogo, loadIndex, loadRun, counter, topbar };
})();
