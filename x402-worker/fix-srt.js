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

import { checkSrt, vttToSrt, SRT_RULES } from "./worker.js";

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
export function fixSrt(input) {
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
        timed.push({ start: cue.start, end: next.end, text: cue.text + " " + next.text });
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
export function scoreLine(report) {
  if (!report) return "";
  return report.clean ? "0 violations" : `${report.violation_total} violation${report.violation_total === 1 ? "" : "s"}`;
}

export { NOTE, MAX_CHARS, MAX_LINES, MAX_DUR, MIN_DUR, MIN_GAP };
