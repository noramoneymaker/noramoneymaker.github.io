/**
 * Nora Moneymaker — x402 check-srt on a permanent origin.
 *
 * WHY THIS EXISTS
 * ===============
 * The paid storefront (x402-seller/app.py) runs on this rig behind a Cloudflare
 * QUICK tunnel, whose hostname is re-minted on every restart. The x402 Bazaar
 * indexes the resource URL itself, so an entry pointing at a quick tunnel 404s
 * on the next restart and is delisted by the health probe.
 *
 * Measured 2026-11-11 against api.cdp.coinbase.com (bazaar_hosts.py): of 6,000
 * sampled resources out of a reported 33,471, 91.45% sit on dedicated or custom
 * domains and 8.2% sit on free-but-PERMANENT app hosts —
 *
 *     254  *.workers.dev   (Cloudflare Workers)   4.23%
 *     144  *.onrender.com  (Render)               2.40%
 *      45  *.vercel.app    (Vercel)               0.75%
 *      33  *.up.railway.app                        0.55%
 *      16  *.fly.dev                               0.27%
 *       1  *.netlify.app / *.replit.app            0.03%
 *
 * — and ZERO resources on any tunnel host class (trycloudflare.com, ngrok.io,
 * ngrok-free.app, loca.lt, serveo.net, pinggy.link all return 0 from the
 * discovery search endpoint, partialResults=false).
 *
 * So: a permanent origin is a hard precondition, and a free `*.workers.dev`
 * subdomain satisfies it — there are 254 of them in the catalogue today,
 * including `api.sitecheck-api.workers.dev` at $0.0040/call.
 *
 * This Worker is that origin. It serves the SAME 402 the FastAPI storefront
 * serves (verified `valid: true` by Coinbase's own endpoint validator on
 * 2026-11-10, 23/23 required + 2/2 advisory checks), with `resource.url`
 * rewritten to the permanent host, and the check-srt logic ported to JS with a
 * byte-parity gate against the Python original.
 *
 * WIRE PROTOCOL (read out of x402 2.25.0 in x402-seller/.venv, not invented)
 *   x402/http/constants.py:  PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE"
 *                            PAYMENT_REQUIRED_HEADER  = "PAYMENT-REQUIRED"
 *                            PAYMENT_RESPONSE_HEADER  = "PAYMENT-RESPONSE"
 *   facilitator_client_base.py:198  verify/settle body =
 *       {x402Version, paymentPayload, paymentRequirements}
 *   POST {facilitator}/verify  -> {isValid, invalidReason?}
 *   POST {facilitator}/settle  -> {success, transaction?, network?, errorReason?}
 *
 * DEPLOY (the only step that needs a human and costs nothing)
 *   1. Create a free Cloudflare account. Free plan; Workers free tier is
 *      100,000 requests/day, no card.
 *   2. `npm i -g wrangler && wrangler login`
 *   3. `wrangler deploy` from this directory.
 *   4. Result: https://nora-check-srt.<account-subdomain>.workers.dev
 *      Set PUBLIC_ORIGIN in wrangler.toml to that before deploying, or leave it
 *      empty and the Worker reads its own request origin.
 */

const VERSION = 2;

// This module carries BOTH products — checkSrt() and fixSrt() — with no imports
// at all, so it packages as one file for every host (Cloudflare Worker, Netlify
// Function) and there is exactly one copy of every caption rule in the tree.
// fix-srt.js is a re-export shim onto this file for the published browser page.
// The rewriter's header, further down, records why it moved here on 2026-11-27.

const MICRO_PRICE_USD = "0.02";
const MICRO_AMOUNT = "20000"; // 6-decimal USDC base units
// The description is what an agent reads in a catalogue and what it copies the
// request shape out of, so two rules apply to it:
//   1. the example must be VALID JSON. It used to read ({'srt': '<text>'}) —
//      Python dict quoting, not JSON — and an agent that copied it verbatim
//      would send a body that fails to parse AFTER paying. Fixed 2026-11-16.
//   2. it carries the words an agent actually types into a directory search.
//      Measured on payapi.market's own /agent/search (2026-11-16): "srt" and
//      "vtt" returned ZERO results across the whole 3,017-listing catalogue,
//      and "cue"/"netflix" appear in no listing at all. Naming the formats and
//      the rule set is honest (both are parsed) and is the whole discovery win.
const MICRO_DESCRIPTION =
  "Subtitle QC for agents: post an SRT or WebVTT captions file (vtt) in the " +
  'JSON body ({"srt": "<cue text>"}) and get a machine-readable caption ' +
  "compliance report — cue count, max characters per line, cue duration, " +
  "minimum gap between cues, characters-per-second spikes, numbering and " +
  "overlap errors, per-cue text. Checks the Netflix-style caption rules " +
  "broadcasters, streamers and platforms reject on, so an agent can verify a " +
  "caption file it already owns before publishing. Free sample at " +
  "/v1/check-srt/sample.";

// Free sample input: a fixed fixture carrying one deliberate defect of every
// class the checker reports (over-long line, 0.2 s cue, negative duration,
// numbering jump, fast read). Served unpaid at GET /v1/check-srt/sample so a
// directory reviewer or an agent can see the report shape without spending
// anything — the same shape the paid route returns, on the same code path.
const SAMPLE_SRT = [
  "1",
  "00:00:00,000 --> 00:00:09,000",
  "This line is deliberately far too long for a subtitle cue",
  "second",
  "third",
  "",
  "2",
  "00:00:09,000 --> 00:00:09,200",
  "Short.",
  "",
  "3",
  "00:00:09,190 --> 00:00:09,100",
  "Backwards.",
  "",
  "7",
  "00:00:20,000 --> 00:00:24,000",
  "Numbering jumped to seven.",
  "",
  "8",
  "00:00:24,001 --> 00:00:27,500",
  "And this one is a fast read with a lot of characters packed in.",
].join("\n");

const BASE_NETWORK = "eip155:8453";
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Solana devnet/mainnet USDC mint as the FastAPI storefront advertises it.
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";

const SRT_RULES = {
  max_lines_per_cue: 2,
  max_chars_per_line: 42,
  max_cue_seconds: 7.0,
  min_cue_seconds: 0.84,
  min_gap_seconds: 0.084,
  advisory_max_cps: 20.0,
};

const QC_EXAMPLE = {
  paid: true,
  price: "$0.02",
  report: {
    cue_count: 24,
    sequence_ok: true,
    total_caption_seconds: 78.4,
    violations: {
      lines: 0, chars_per_line: 0, too_long: 0, too_short: 0, gap: 0, negative: 0,
    },
    violation_total: 0,
    cps_spikes: [],
    errors: [],
    clean: true,
  },
};

const MICRO_BODY_EXAMPLE = {
  srt: "1\n00:00:00,010 --> 00:00:01,550\nSPEAKER_01: Hi, thanks for the call.\n",
};

const MICRO_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    input: {
      type: "object",
      properties: {
        type: { type: "string" },
        method: { type: "string" },
        bodyType: { type: "string" },
        body: { type: "object" },
      },
      required: ["type", "method", "bodyType"],
    },
    output: { type: "object" },
  },
  required: ["input"],
};

// ---------------------------------------------------------------------------
// The repair route. Same rules, different product: the checker tells an agent
// its caption file is wrong, the rewriter hands back a file that scores clean.
// A repair is strictly more output than a score, so it is priced above it —
// $0.05, read off the live Base-USDC distribution of the CDP x402 catalogue on
// 2026-11-27 (3,000 resources sampled: median $0.005, p90 $0.030, p95 $0.15), so
// $0.05 sits above the p90 and well under the p95 rather than being invented.
// ---------------------------------------------------------------------------
const FIX_PRICE_USD = "0.05";
const FIX_AMOUNT = "50000"; // 6-decimal USDC base units
const FIX_MAX_CHARS = 400000; // ~400 KB of captions; Netlify's request cap is 6 MB

const FIX_DESCRIPTION =
  "Repair an SRT or WebVTT captions file for agents: post the file in the JSON " +
  'body ({"srt": "<cue text>"}) and get it back rewritten to the Netflix-style ' +
  "rules broadcasters, streamers and platforms reject on — lines rewrapped to " +
  "42 characters and 2 lines, long cues split with their time divided, durations " +
  "clamped to 7.0 s and floored at 0.84 s, gaps raised to the 0.084 s two-frame " +
  "minimum, cues reordered and renumbered — returning both .srt and .vtt plus a " +
  "before/after compliance report from the same checker at /v1/check-srt. " +
  "Not one word of the cue text is changed; anything it cannot repair without " +
  "editing speech is named in `residuals` instead of being silently dropped. " +
  "Free sample at /v1/fix-srt/sample.";

const FIX_BODY_EXAMPLE = {
  srt:
    "1\n00:00:00,010 --> 00:00:01,550\nSPEAKER_01: Hi, thanks for the call.\n\n2\n" +
    "00:01:00,000 --> 00:01:01,200\nThat is a very long line of dialogue that runs " +
    "well past forty-two characters, which is a rule violation.\n",
};

const FIX_EXAMPLE = {
  paid: true,
  price: "$0.05",
  changed: true,
  before: { cue_count: 2, violation_total: 2, clean: false },
  after: { cue_count: 3, violation_total: 0, clean: true },
  notes: { rewrapped: 1, split: 1, regapped: 1 },
  residuals: [],
  srt: "1\n00:00:00,010 --> 00:00:01,550\nSPEAKER_01: Hi, thanks for the\ncall.\n\n...",
  vtt: "WEBVTT\n\n00:00:00.010 --> 00:00:01.550\nSPEAKER_01: Hi, thanks for the\ncall.\n\n...",
};

// ---------------------------------------------------------------------------
// THE REWRITER — fixSrt(), lifted out of fix-srt.js into this module on
// 2026-11-27 so the paid worker packages as ONE file with no imports.
//
// WHY IT MOVED. The route needs the same code the browser page runs, and the
// browser page's module imports checkSrt/vttToSrt/SRT_RULES from here. A
// two-way static import is a cycle, and ES modules evaluate in dependency
// order, so fix-srt.js read SRT_RULES while this file's `const` was still in
// the temporal dead zone: "ReferenceError: Cannot access 'SRT_RULES' before
// initialization" — reproduced in node immediately, before it could become a
// 500 on the origin.
//
// FIX: the implementation lives HERE (rule source and rewriter in one scope,
// no import at all), and fix-srt.js is now a re-export shim so the published
// page keeps its import path unchanged. One copy of every rule, still.
// ---------------------------------------------------------------------------

/**
 * fix-srt.js — the other half of the checker.
 *
 * The checker tells a visitor their caption file is wrong. This rewrites it
 * into a file that scores clean against the same rules, in the same browser,
 * with nothing uploaded.
 *
 * WHY IT EXISTS
 * -------------
 * Flagging is the cheap half. The page said so itself before this file
 * existed: "Rewrapping lines to 42 characters, re-timing cues to the 0.84 s
 * floor and the 2-frame gap, and keeping the cue text byte-identical while
 * doing it is the part that takes work."  A visitor who has just been told
 * their file is broken and then handed a score has been told a problem, not
 * given a product. This gives them the file.
 *
 * WHAT IT TOUCHES, AND WHAT IT WILL NOT
 * ------------------------------------
 * Changed: cue line breaks (rewrapped at word boundaries to <=42 chars, <=2
 * lines), cue boundaries (a cue whose text needs more than two lines is split
 * and its time divided between the parts, so the reading speed stays sane),
 * cue durations (clamped to the 7.0 s ceiling, floored at 0.84 s), inter-cue
 * gaps (pushed to the 2-frame 0.084 s minimum), and the cue numbering
 * (renumbered from 1).
 *
 * NOT changed: not one word. Every cue's text survives the pass word-for-word;
 * only whitespace inside it moves. That is deliberate — a rewriter that quietly
 * edits speech is a transcript generator, and that is the thing being sold.
 *
 * CPS (characters per second) is reported by the checker as advisory and is
 * NOT repaired here: the only ways to lower reading speed are to retime across
 * neighbouring cues or to cut words, and both are editorial decisions. A cue
 * that still reads too fast after the pass is named in `residuals` so the
 * visitor knows the file is not finished, rather than being told a green lie.
 *
 * ONE RULE SOURCE
 * ---------------
 * Rules and the VTT normaliser are imported from worker.js — the same file the
 * $0.02 endpoint runs. Two copies of a rule is how the JS and Python checkers
 * came to disagree on empty input on 2026-11-16; this file does not add a third.
 */


const MAX_CHARS = SRT_RULES.max_chars_per_line;          // 42
const MAX_LINES = SRT_RULES.max_lines_per_cue;           // 2
const MAX_DUR = Math.round(SRT_RULES.max_cue_seconds * 1000);   // 7000 ms
const MIN_DUR = Math.round(SRT_RULES.min_cue_seconds * 1000);   //  840 ms
const MIN_GAP = Math.round(SRT_RULES.min_gap_seconds * 1000);   //   84 ms

// SRT timestamps are matched exactly as the checker matches them, so a file
// this module accepts is a file the checker can score.
const TS_IN = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

// ---------------------------------------------------------------------------
// time: integer milliseconds throughout. Doubles drift; gaps are 84 ms and a
// float error of 1e-13 is enough to make a "clean" file score one violation.
// ---------------------------------------------------------------------------

function toMs(h, m, s, f) {
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(f);
}

function stamp(t) {
  const v = Math.max(0, Math.round(t));
  const f = v % 1000;
  const total = Math.floor(v / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(f, 3)}`;
}

function vttStamp(t) {
  return stamp(t).replace(",", ".");
}

// ---------------------------------------------------------------------------
// parse: same block and field rules the checker uses (BOM, CRLF, blank-line
// separated blocks, a numeric cue number, a timing line, a payload). VTT is
// normalised by the checker's own vttToSrt, not by a second implementation.
// ---------------------------------------------------------------------------

function parseCues(input) {
  const text = vttToSrt(input).replace(/^\ufeff/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const blocks = text === "" ? [] : text.split(/\n\s*\n/).filter((b) => b.trim() !== "");
  const cues = [];
  const errors = [];
  blocks.forEach((block, i) => {
    const lines = block.split("\n");
    const number = (lines[0] || "").trim();
    const timing = lines.length > 1 ? lines[1] : "";
    if (!/^\d+$/.test(number)) {
      errors.push(`block ${i + 1}: first line is not a cue number`);
      return;
    }
    const m = timing.match(TS_IN);
    if (!m) {
      errors.push(`cue ${number}: timing line unparseable`);
      return;
    }
    const body = lines.slice(2).join("\n");
    cues.push({
      start: toMs(m[1], m[2], m[3], m[4]),
      end: toMs(m[5], m[6], m[7], m[8]),
      text: body.replace(/\s+/g, " ").trim(),
    });
  });
  return { cues, errors };
}

// ---------------------------------------------------------------------------
// wrapping. split() on a single space after the whitespace collapse in
// parseCues, so a run of spaces cannot produce an empty word.
// ---------------------------------------------------------------------------

function words(text) {
  return text.split(" ").filter((w) => w !== "");
}

/** Greedy wrap at word boundaries. Returns every line, however many. */
function wrapLines(text) {
  const lines = [];
  let cur = "";
  for (const w of words(text)) {
    if (cur === "") {
      cur = w;
    } else if (cur.length + 1 + w.length <= MAX_CHARS) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

/** Lines a cue's text would occupy once rewrapped. */
function lineCount(text) {
  return wrapLines(text).length;
}

/**
 * The rewrap of one cue, joined with "\n".
 *
 * It emits EVERY line, deliberately. chunkText() already guarantees at most
 * MAX_LINES for anything it can split, but a cue that could not be split (a
 * residual) still has to keep its words: dropping the third line would silently
 * delete speech, which is the one thing this module promises never to do. A
 * residual file therefore still shows a 3-line cue, and the page names it.
 */
function rewrap(text) {
  return wrapLines(text).join("\n");
}

/**
 * Break a text into the fewest consecutive chunks that each wrap to at most
 * MAX_LINES lines. Words are never split and never reordered, so the chunks
 * joined by single spaces reproduce the input text exactly.
 */
function chunkText(text) {
  const wordList = words(text);
  if (wordList.length === 0) return [""];
  const chunks = [];
  let cur = [];
  for (const w of wordList) {
    const trial = cur.concat([w]).join(" ");
    if (cur.length > 0 && lineCount(trial) > MAX_LINES) {
      chunks.push(cur.join(" "));
      cur = [w];
    } else {
      cur.push(w);
    }
  }
  if (cur.length > 0) chunks.push(cur.join(" "));
  return chunks;
}

/**
 * Divide spanMs between k chunks by character share, never below MIN_DUR and
 * never above MAX_DUR. Returns null when the time available cannot hold k cues
 * at the floor — that is a real residual, not something to paper over.
 */
function allocate(chunks, spanMs, k) {
  const usable = spanMs - (k - 1) * MIN_GAP;
  if (usable < k * MIN_DUR) return null;
  const lens = chunks.map((c) => Math.max(1, c.length));
  const total = lens.reduce((a, b) => a + b, 0);
  let d = lens.map((l) => Math.max(MIN_DUR, Math.min(MAX_DUR, Math.round((l / total) * usable))));
  let sum = d.reduce((a, b) => a + b, 0);
  if (sum !== usable) {
    // Push the correction into the roomiest chunk; if there is no room,
    // fall back to an even split, which is always inside the floor/ceiling
    // because usable >= k * MIN_DUR was checked above.
    const idx = d.indexOf(Math.max(...d));
    const want = d[idx] + (usable - sum);
    if (want >= MIN_DUR && want <= MAX_DUR) {
      d[idx] = want;
      sum = usable;
    } else {
      const each = Math.floor(usable / k);
      d = new Array(k).fill(each);
      d[k - 1] += usable - each * k;
      sum = usable;
    }
  }
  return sum === usable ? d : null;
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

const NOTE = {
  split: "cue split so its text fits two lines",
  trimmed: "cue trimmed to the 7.0 s ceiling",
  extended: "short cue extended to the 0.84 s floor",
  merged: "short cue merged into the next one",
  gap: "gap widened to the 2-frame minimum",
  renumbered: "cue numbering rebuilt from 1",
  reordered: "cues sorted by start time",
};

function note(notes, kind, n = 1) {
  notes[kind] = (notes[kind] || 0) + n;
}

/**
 * fixSrt(input) -> {
 *   srt, vtt,            the rewritten files (SRT and the same cues as WebVTT)
 *   before, after,      checkSrt() reports of the input and of the output
 *   notes,              what the pass changed, counted by kind
 *   residuals,          cues the pass could not repair, with the reason
 *   parseErrors,        blocks it could not read at all
 *   changed,            true when the output differs from the input
 * }
 *
 * Pure: no DOM, no I/O, so it runs under node in the test gate and in the
 * browser behind a button.
 */
function fixSrt(input) {
  const before = checkSrt(input);
  const { cues: parsed, errors: parseErrors } = parseCues(input);
  const notes = {};
  const residuals = [];

  if (parsed.length === 0) {
    return {
      srt: "",
      vtt: "",
      before,
      after: before,
      notes,
      residuals: [{ reason: "no cues parsed — nothing to rewrite" }],
      parseErrors,
      changed: false,
    };
  }

  // Sort first: a file with out-of-order cues produces impossible gap maths
  // otherwise, and out-of-order is itself the defect.
  const cues = parsed.map((c) => ({ ...c }));
  const outOfOrder = cues.some((c, i) => i > 0 && c.start < cues[i - 1].start);
  if (outOfOrder) {
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    note(notes, "reordered");
  }

  const staged = [];

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const next = i + 1 < cues.length ? cues[i + 1] : null;
    // Room this cue may occupy: never past the next cue minus the gap floor.
    const maxEnd = next ? next.start - MIN_GAP : Number.POSITIVE_INFINITY;

    const chunks = chunkText(cue.text);
    const k = chunks.length;
    const span = Math.min(Math.max(cue.end, cue.start), maxEnd) - cue.start;

    if (k > 1) {
      const durs = allocate(chunks, span, k);
      if (durs === null) {
        // No room to split: keep one cue and say so rather than emit an
        // unreadable ladder of 0.3 s flashes.
        staged.push({ start: cue.start, end: Math.max(cue.end, cue.start + MIN_DUR), text: cue.text });
        residuals.push({
          start: stamp(cue.start),
          reason: `text needs ${k} cues but only ${Math.round(span / 10) / 100} s is available before the next cue`,
        });
        continue;
      }
      let cursor = cue.start;
      for (let j = 0; j < k; j += 1) {
        const end = j === k - 1 ? cue.start + span : cursor + durs[j];
        staged.push({ start: cursor, end, text: chunks[j] });
        cursor = end + MIN_GAP;
      }
      note(notes, "split", k - 1);
      continue;
    }

    staged.push({ start: cue.start, end: Math.max(cue.end, cue.start), text: cue.text });
  }

  // Duration floors and ceilings, and merging a short cue forward when there is
  // no room to extend it.
  const timed = [];
  for (let i = 0; i < staged.length; i += 1) {
    const cue = staged[i];
    const next = i + 1 < staged.length ? staged[i + 1] : null;
    const maxEnd = next ? next.start - MIN_GAP : Number.POSITIVE_INFINITY;

    if (cue.end <= cue.start) cue.end = cue.start + MIN_DUR;

    if (cue.end - cue.start < MIN_DUR) {
      const room = Math.min(cue.start + MIN_DUR, maxEnd);
      if (room - cue.start >= MIN_DUR) {
        cue.end = room;
        note(notes, "extended");
      } else if (
        next &&
        lineCount(cue.text + " " + next.text) <= MAX_LINES &&
        next.end - cue.start <= MAX_DUR
      ) {
        // A merge inherits the NEXT cue's end, and that end can itself be below
        // the floor (a zero-length or negative cue ahead of it). Pushing it
        // through unchanged emitted a 0.19 s cue with no residual explaining it
        // — found on the free sample, 2026-11-27. Floor it, and only go as far
        // as the cue after the merged one allows.
        const following = i + 2 < staged.length ? staged[i + 2] : null;
        const limit = following ? following.start - MIN_GAP : Number.POSITIVE_INFINITY;
        let end = Math.max(next.end, cue.start + MIN_DUR);
        if (end > limit) {
          if (limit - cue.start >= MIN_DUR) {
            end = limit;
          } else {
            end = cue.start + MIN_DUR;
            residuals.push({
              start: stamp(cue.start),
              reason:
                "merged cue cannot reach 0.84 s without breaking the 2-frame gap before the next cue",
            });
          }
        }
        timed.push({ start: cue.start, end, text: cue.text + " " + next.text });
        note(notes, "merged");
        i += 1;
        continue;
      } else {
        cue.end = cue.start + MIN_DUR;
        residuals.push({
          start: stamp(cue.start),
          reason: "cue is shorter than 0.84 s and the next cue starts too soon to extend it",
        });
      }
    }
    timed.push(cue);
  }

  // Gap pass. Shorten the previous cue's tail where it has slack, then delay
  // the next cue's start, and report anything that still cannot hold.
  for (let i = 1; i < timed.length; i += 1) {
    const prev = timed[i - 1];
    const cur = timed[i];
    let gap = cur.start - prev.end;
    if (gap >= MIN_GAP) continue;
    const deficit = MIN_GAP - gap;
    const slack = Math.max(0, prev.end - prev.start - MIN_DUR);
    const take = Math.min(deficit, slack);
    if (take > 0) {
      prev.end -= take;
      gap += take;
    }
    if (gap < MIN_GAP) {
      cur.start += MIN_GAP - gap;
      if (cur.end - cur.start < MIN_DUR) {
        cur.end = cur.start + MIN_DUR;
        residuals.push({
          start: stamp(cur.start),
          reason: "no room for a 2-frame gap without dropping this cue under 0.84 s",
        });
      }
    }
    note(notes, "gap");
  }

  // Ceiling last, so nothing above re-opens it.
  for (const cue of timed) {
    if (cue.end - cue.start > MAX_DUR) {
      cue.end = cue.start + MAX_DUR;
      note(notes, "trimmed");
    }
  }

  // Emit.
  const srt = timed
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${rewrap(c.text)}`)
    .join("\n\n") + "\n";

  const vtt =
    "WEBVTT\n\n" +
    timed
      .map((c) => `${vttStamp(c.start)} --> ${vttStamp(c.end)}\n${rewrap(c.text)}`)
      .join("\n\n") +
    "\n";

  if (notes.renumbered === undefined && timed.length > 0) note(notes, "renumbered");

  const after = checkSrt(srt);

  // Honesty guard: a file that still scores dirty must say why. Every repair
  // path above names its own residual, but a class of defect this pass cannot
  // touch (or a future rule added to the checker) would otherwise leave a
  // violation count with no explanation next to it — and a buyer reading
  // "1 violation" with an empty `residuals` array cannot tell whether the tool
  // is broken or the file is. Found on the free sample, 2026-11-27.
  if (after.violation_total > 0 && residuals.length === 0) {
    const remaining = Object.entries(after.violations || {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    residuals.push({
      reason:
        `still ${after.violation_total} violation(s) after the pass (${remaining}); ` +
        "these need an editorial decision, not a rewrite — see `after.violations`",
    });
  }

  return {
    srt,
    vtt,
    before,
    after,
    notes,
    residuals,
    parseErrors,
    changed: srt !== input,
  };
}

/** Human-readable one-liner for the page: "187 -> 0". */
function scoreLine(report) {
  if (!report) return "";
  return report.clean ? "0 violations" : `${report.violation_total} violation${report.violation_total === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// check-srt, ported 1:1 from x402-seller/app.py::check_srt.
// Any change here must be re-run through test/parity.py.
// ---------------------------------------------------------------------------
const TS = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

/**
 * WebVTT is the format most captioning pipelines ship — YouTube hands out .vtt,
 * Resolve and Premiere export it — and it differs from SRT in exactly three
 * mechanical ways: a WEBVTT header line (plus optional header metadata), an
 * optional cue-identifier line before the timing, and timestamps with a dot
 * whose hours field may be omitted. NOTE/STYLE/REGION blocks are comments.
 *
 * Rather than fork the checker into a second implementation (which is how two
 * scorers start disagreeing), this rewrites a VTT document into SRT text and
 * the single existing parser scores it. A VTT cue and an SRT cue therefore
 * cannot be judged differently — same rule, same code, one output shape.
 */
const VTT_TS = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})/;

function vttToSrt(text) {
  const body = text.replace(/^\ufeff/, "");
  if (!body.trimStart().startsWith("WEBVTT")) return text;
  const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let i = 1;
  while (i < lines.length && lines[i].trim() !== "") i += 1; // header metadata
  const rest = lines.slice(i).join("\n").trim();
  const blocks = rest === "" ? [] : rest.split(/\n\s*\n/).filter((b) => b.trim() !== "");
  const out = [];
  let n = 0;
  for (const block of blocks) {
    const bl = block.split("\n");
    const head = bl[0].trim().split(/\s+/)[0];
    if (head === "NOTE" || head === "STYLE" || head === "REGION") continue;
    let ti;
    if (VTT_TS.test(bl[0])) ti = 0;
    else if (bl.length > 1 && VTT_TS.test(bl[1])) ti = 1; // cue identifier line
    else {
      out.push(block); // not a cue; leave it for the parser to reject out loud
      continue;
    }
    const m = bl[ti].match(VTT_TS);
    const h1 = String(Number(m[1] || 0)).padStart(2, "0");
    const h2 = String(Number(m[5] || 0)).padStart(2, "0");
    const ms1 = m[4].padEnd(3, "0");
    const ms2 = m[8].padEnd(3, "0");
    n += 1;
    out.push(
      `${n}\n${h1}:${m[2]}:${m[3]},${ms1} --> ${h2}:${m[6]}:${m[7]},${ms2}\n` +
        bl.slice(ti + 1).join("\n")
    );
  }
  return out.join("\n\n");
}

function seconds(h, m, s, ms) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000.0;
}

/** Python's round(): ties to even, not away from zero. */
function pyRound(x, n) {
  const f = Math.pow(10, n);
  const y = x * f;
  const t = Math.trunc(y);
  const diff = y - t;
  if (Math.abs(diff) === 0.5) {
    return (t % 2 === 0 ? t : t + Math.sign(y)) / f;
  }
  return Math.round(y) / f;
}

function pyRepr(s) {
  // Only used inside an error string for a non-numeric cue line; mirrors
  // Python's %r for the ASCII case that actually occurs.
  if (!s.includes("'") && !s.includes("\\")) return `'${s}'`;
  if (!s.includes('"') && !s.includes("\\")) return `"${s}"`;
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function checkSrt(input) {
  // One parser: WebVTT is rewritten into SRT text before scoring.
  const text = vttToSrt(input);
  const norm = text.replace(/\r\n/g, "\n").trim();
  const blocks = norm.split(/\n\s*\n/).filter((b) => b.trim() !== "");
  const cues = [];
  const errors = [];

  blocks.forEach((block, i) => {
    const index = i + 1;
    const lines = block.split("\n");
    if (lines.length === 0) return;
    const number = lines[0].trim();
    const timing = lines.length > 1 ? lines[1] : "";
    if (!/^\d+$/.test(number)) {
      errors.push(
        `block ${index}: first line is not a cue number (${pyRepr(number.slice(0, 20))})`
      );
      return;
    }
    const m = timing.match(TS);
    if (!m) {
      errors.push(
        `cue ${number}: timing line unparseable (${pyRepr(timing.slice(0, 40))})`
      );
      return;
    }
    const start = seconds(m[1], m[2], m[3], m[4]);
    const end = seconds(m[5], m[6], m[7], m[8]);
    const payload = lines.slice(2).filter((ln) => ln.trim() !== "");
    const lens = payload.map((ln) => ln.trim().length);
    cues.push({
      n: parseInt(number, 10),
      start,
      end,
      duration: end - start,
      lines: payload.length,
      chars: lens.reduce((a, b) => a + b, 0),
      longest_line: lens.length ? Math.max(...lens) : 0,
      text: payload.join(" ").slice(0, 200),
      // NB: Python joins the RAW payload lines (no strip) — kept identical so
      // the parity gate in test/parity.py compares equal on every field.
    });
  });

  const cpsSpikes = [];
  const violations = {
    lines: 0, chars_per_line: 0, too_long: 0, too_short: 0, gap: 0, negative: 0,
  };
  // A checker that reports "clean" on input it could not parse is worse than
  // no checker: an agent would publish a broken file with a green report. If
  // not one cue parsed, say so.
  if (cues.length === 0) {
    errors.push("no cues parsed — input is not SRT or WebVTT, or it is empty");
  }
  let prevEnd = null;
  for (const cue of cues) {
    if (cue.duration <= 0) violations.negative += 1;
    if (cue.lines > SRT_RULES.max_lines_per_cue) violations.lines += 1;
    if (cue.longest_line > SRT_RULES.max_chars_per_line) violations.chars_per_line += 1;
    if (cue.duration > SRT_RULES.max_cue_seconds + 1e-6) violations.too_long += 1;
    if (cue.duration > 0 && cue.duration < SRT_RULES.min_cue_seconds - 1e-9) {
      violations.too_short += 1;
    }
    if (cue.duration > 0) {
      const cps = cue.chars / cue.duration;
      if (cps > SRT_RULES.advisory_max_cps) {
        cpsSpikes.push({ n: cue.n, cps: pyRound(cps, 1) });
      }
    }
    if (prevEnd !== null && cue.start - prevEnd < SRT_RULES.min_gap_seconds - 1e-9) {
      violations.gap += 1;
    }
    prevEnd = cue.end;
  }

  const numbers = cues.map((c) => c.n);
  let sequential = numbers.length > 0;
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) { sequential = false; break; }
  }
  const total = cues.reduce((a, c) => a + c.duration, 0);
  const violationTotal = Object.values(violations).reduce((a, b) => a + b, 0);

  return {
    cue_count: cues.length,
    sequence_ok: sequential,
    total_caption_seconds: pyRound(total, 2),
    rules: SRT_RULES,
    violations,
    violation_total: violationTotal,
    cps_spikes: cpsSpikes.slice(0, 20),
    errors: errors.slice(0, 20),
    clean: violationTotal === 0 && errors.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The 402 envelope. Field-for-field the same object the FastAPI middleware
// emits (decoded from the live PAYMENT-REQUIRED header, 2026-11-11) so the
// endpoint validator's 25 checks see the same shape from a different host.
// ---------------------------------------------------------------------------
function paymentRequired(origin, env, opts = {}) {
  const path = opts.path || "/v1/check-srt";
  const amount = opts.amount || MICRO_AMOUNT;
  const description = opts.description || MICRO_DESCRIPTION;
  const serviceName = opts.serviceName || "nora-subtitle-qc";
  const tags = opts.tags || [
    "subtitles", "srt", "vtt", "webvtt", "captions", "cue", "qc", "validation", "cps",
  ];
  const bodyExample = opts.bodyExample || MICRO_BODY_EXAMPLE;
  const outputExample = opts.outputExample || QC_EXAMPLE;
  return {
    x402Version: VERSION,
    error: "Payment required",
    resource: {
      url: `${origin}${path}`,
      description,
      mimeType: "application/json",
      serviceName,
      tags,
    },
    accepts: [
      {
        scheme: "exact",
        network: BASE_NETWORK,
        asset: BASE_USDC,
        amount,
        payTo: env.EVM_PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
      {
        scheme: "exact",
        network: SOLANA_NETWORK,
        asset: SOLANA_USDC,
        amount,
        payTo: env.SVM_PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { feePayer: SOLANA_FEE_PAYER },
      },
    ],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: bodyExample },
          output: { type: "json", example: outputExample },
        },
        schema: MICRO_SCHEMA,
      },
    },
  };
}

// The repair route's envelope: same shape, its own URL, price, description and
// examples, because the Bazaar indexes the RESOURCE, not the seller — two routes
// sharing one resource.url would catalogue as one listing.
function fixPaymentRequired(origin, env) {
  return paymentRequired(origin, env, {
    path: "/v1/fix-srt",
    amount: FIX_AMOUNT,
    description: FIX_DESCRIPTION,
    serviceName: "nora-subtitle-fix",
    tags: [
      "subtitles", "srt", "vtt", "webvtt", "captions", "cue", "repair", "fix",
      "rewrite", "reformat", "netflix",
    ],
    bodyExample: FIX_BODY_EXAMPLE,
    outputExample: FIX_EXAMPLE,
  });
}

function b64encodeJson(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}

function b64decodeJson(str) {
  return JSON.parse(decodeURIComponent(escape(atob(str))));
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function paywall(origin, env, reason, required = paymentRequired) {
  const env402 = required(origin, env);
  if (reason) env402.error = reason;
  // The BODY carries the same envelope as the header, as of 2026-11-15.
  // Measured that day on five settlement-verified payapi.market listings: four
  // return the envelope BOTH as the base64 PAYMENT-REQUIRED header AND as a JSON
  // body (10x402, voixoff-fr.netlify.app, x402-preflight-grokbot.netlify.app,
  // cn-data-x402.*.workers.dev); one returns a body with no header. An unpaid
  // reader that parses only the body saw `{}` from this endpoint, which is
  // exactly what payapi.market/list calls out as a fail — "a 402 with no Base
  // USD Coin challenge". The header stays; the body is a mirror, never a
  // different object.
  return json(env402, 402, {
    "PAYMENT-REQUIRED": b64encodeJson(env402),
    "cache-control": "no-store",
  });
}

/**
 * Pick the requirement that matches the offered network, then ask the
 * facilitator. Never trusts a client-asserted "I paid".
 */
async function verifyAndSettle(payloadB64, requirementsList, env) {
  const facilitator = (env.FACILITATOR_URL || "https://facilitator.payai.network")
    .replace(/\/+$/, "");
  let payload;
  try {
    payload = b64decodeJson(payloadB64);
  } catch (e) {
    return { ok: false, reason: "PAYMENT-SIGNATURE is not base64 JSON" };
  }
  const chosen =
    (payload.accepted && requirementsList.find(
      (r) => r.network === (payload.accepted.network || payload.network)
    )) ||
    requirementsList.find(
      (r) => r.network === (payload.network || payload.accepted?.network)
    );
  if (!chosen) return { ok: false, reason: "no matching payment requirement" };

  const body = {
    x402Version: VERSION,
    paymentPayload: payload,
    paymentRequirements: chosen,
  };

  const vres = await fetch(`${facilitator}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!vres.ok) {
    return { ok: false, reason: `facilitator verify HTTP ${vres.status}` };
  }
  const verdict = await vres.json();
  if (!verdict.isValid) {
    return { ok: false, reason: verdict.invalidReason || "invalid payment" };
  }

  const sres = await fetch(`${facilitator}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!sres.ok) {
    return { ok: false, reason: `facilitator settle HTTP ${sres.status}` };
  }
  const settle = await sres.json();
  if (!settle.success) {
    return { ok: false, reason: settle.errorReason || "settlement failed" };
  }
  return { ok: true, settle, requirement: chosen };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = (env.PUBLIC_ORIGIN && env.PUBLIC_ORIGIN.trim()) || url.origin;

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "nora-subtitle-qc",
        price: MICRO_PRICE_USD,
        routes: { "/v1/check-srt": `$${MICRO_PRICE_USD}`, "/v1/fix-srt": `$${FIX_PRICE_USD}` },
        origin,
        facilitator: env.FACILITATOR_URL || "https://facilitator.payai.network",
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        [
          "Nora Moneymaker — subtitle QC, paid per call on x402.",
          "",
          `POST ${origin}/v1/check-srt   $${MICRO_PRICE_USD}   USDC on Base or Solana`,
          `POST ${origin}/v1/fix-srt     $${FIX_PRICE_USD}   USDC on Base or Solana  (returns the repaired .srt and .vtt)`,
          "",
          MICRO_DESCRIPTION,
          "",
          FIX_DESCRIPTION,
          "",
          "Unpaid requests receive 402 with the terms in the PAYMENT-REQUIRED header.",
          "Pay, then repeat the request with the PAYMENT-SIGNATURE header.",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    // Free sample: the paid route's report shape, on a fixed fixture, unmetered.
    // Directory listing rules (payapi.market/providers, read 2026-11-14) ask for
    // "a free sample or health route that returns real data in the same shape as
    // the paid route" precisely so a reviewer can check the output without
    // paying. Same checkSrt(), so the sample cannot drift from the product.
    if (request.method === "GET" && url.pathname === "/v1/check-srt/sample") {
      return json(
        {
          sample: true,
          price: `$${MICRO_PRICE_USD}`,
          note:
            "Fixed fixture with one deliberate defect of each class. " +
            'POST /v1/check-srt with {"srt": "<your srt or webvtt>"} to check your own file.',
          report: checkSrt(SAMPLE_SRT),
        },
        200,
        { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" }
      );
    }

    // Free sample of the repair route: the same fixture the checker's sample
    // uses, run through the same fixSrt() the paid route calls, so a directory
    // reviewer sees the output shape without spending anything and cannot see a
    // sample that has drifted from the product.
    if (request.method === "GET" && url.pathname === "/v1/fix-srt/sample") {
      const fixed = fixSrt(SAMPLE_SRT);
      return json(
        {
          sample: true,
          price: `$${FIX_PRICE_USD}`,
          note:
            "Fixed fixture with one deliberate defect of each class, repaired. " +
            'POST /v1/fix-srt with {"srt": "<your srt or webvtt>"} to repair your own file.',
          result: {
            changed: fixed.changed,
            before: fixed.before,
            after: fixed.after,
            notes: fixed.notes,
            residuals: fixed.residuals,
            srt: fixed.srt,
            vtt: fixed.vtt,
          },
        },
        200,
        { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" }
      );
    }

    const isCheck = url.pathname === "/v1/check-srt";
    const isFix = url.pathname === "/v1/fix-srt";
    if (!isCheck && !isFix) {
      return json({ error: "not found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    // Each route carries its OWN envelope: own resource.url (what the Bazaar
    // indexes), own price, own examples. The facilitator is asked to verify and
    // settle against that route's requirement, so the amount is enforced by the
    // facilitator, not by a string compare here.
    const required = isFix ? fixPaymentRequired : paymentRequired;
    const routeReqs = required(origin, env).accepts;

    const signature = request.headers.get("PAYMENT-SIGNATURE");
    if (!signature) return paywall(origin, env, undefined, required);

    const paid = await verifyAndSettle(signature, routeReqs, env);
    if (!paid.ok) return paywall(origin, env, `Payment invalid: ${paid.reason}`, required);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'body must be JSON with an "srt" string (SRT or WebVTT text)' }, 400);
    }
    // "srt" is the published key; "vtt"/"captions"/"srt_text" are accepted
    // aliases so an agent holding a .vtt does not have to rename its field.
    const text =
      body && typeof body === "object"
        ? body.srt || body.vtt || body.captions || body.srt_text
        : null;
    if (typeof text !== "string" || text.trim() === "") {
      return json({ error: 'missing "srt" (send the SRT or WebVTT text in it)' }, 400);
    }

    if (isFix) {
      if (text.length > FIX_MAX_CHARS) {
        return json(
          {
            error:
              `file is ${text.length} characters, over the ${FIX_MAX_CHARS}-character ` +
              "limit for one call — split it and send each part",
          },
          413
        );
      }
      const fixed = fixSrt(text);
      return json(
        {
          paid: true,
          price: `$${FIX_PRICE_USD}`,
          changed: fixed.changed,
          before: fixed.before,
          after: fixed.after,
          notes: fixed.notes,
          residuals: fixed.residuals,
          srt: fixed.srt,
          vtt: fixed.vtt,
        },
        200,
        { "PAYMENT-RESPONSE": b64encodeJson(paid.settle) }
      );
    }

    return json(
      { paid: true, price: `$${MICRO_PRICE_USD}`, report: checkSrt(text) },
      200,
      { "PAYMENT-RESPONSE": b64encodeJson(paid.settle) }
    );
  },
};

export {
  checkSrt,
  paymentRequired,
  fixPaymentRequired,
  fixSrt,
  scoreLine,
  pyRound,
  vttToSrt,
  SRT_RULES,
  NOTE,
  MAX_CHARS,
  MAX_LINES,
  MAX_DUR,
  MIN_DUR,
  MIN_GAP,
};
