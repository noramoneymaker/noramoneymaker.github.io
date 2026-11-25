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
function paymentRequired(origin, env) {
  return {
    x402Version: VERSION,
    error: "Payment required",
    resource: {
      url: `${origin}/v1/check-srt`,
      description: MICRO_DESCRIPTION,
      mimeType: "application/json",
      serviceName: "nora-subtitle-qc",
      tags: ["subtitles", "srt", "vtt", "webvtt", "captions", "cue", "qc", "validation", "cps"],
    },
    accepts: [
      {
        scheme: "exact",
        network: BASE_NETWORK,
        asset: BASE_USDC,
        amount: MICRO_AMOUNT,
        payTo: env.EVM_PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      },
      {
        scheme: "exact",
        network: SOLANA_NETWORK,
        asset: SOLANA_USDC,
        amount: MICRO_AMOUNT,
        payTo: env.SVM_PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { feePayer: SOLANA_FEE_PAYER },
      },
    ],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: MICRO_BODY_EXAMPLE },
          output: { type: "json", example: QC_EXAMPLE },
        },
        schema: MICRO_SCHEMA,
      },
    },
  };
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

function paywall(origin, env, reason) {
  const env402 = paymentRequired(origin, env);
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
    const reqs = paymentRequired(origin, env).accepts;

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "nora-subtitle-qc",
        price: MICRO_PRICE_USD,
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
          "",
          MICRO_DESCRIPTION,
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

    if (url.pathname !== "/v1/check-srt") {
      return json({ error: "not found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    const signature = request.headers.get("PAYMENT-SIGNATURE");
    if (!signature) return paywall(origin, env);

    const paid = await verifyAndSettle(signature, reqs, env);
    if (!paid.ok) return paywall(origin, env, `Payment invalid: ${paid.reason}`);

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

    return json(
      { paid: true, price: `$${MICRO_PRICE_USD}`, report: checkSrt(text) },
      200,
      { "PAYMENT-RESPONSE": b64encodeJson(paid.settle) }
    );
  },
};

export { checkSrt, paymentRequired, pyRound };
