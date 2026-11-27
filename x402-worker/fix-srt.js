/**
 * fix-srt.js — thin re-export. The implementation now lives in worker.js.
 *
 * WHY THIS FILE STILL EXISTS
 * --------------------------
 * The published page imports `{ fixSrt }` from ./x402-worker/fix-srt.js and
 * build_site.py copies that path into the site. Moving the module would have
 * meant editing the builder, the page and the paid route in one go; re-exporting
 * keeps every import path exactly where it was.
 *
 * WHY THE IMPLEMENTATION MOVED (2026-11-27)
 * -----------------------------------------
 * The paid route needs this rewriter, and this module needs checkSrt() /
 * vttToSrt() / SRT_RULES from worker.js. That two-way static import is a cycle,
 * and ES modules evaluate in dependency order, so this file read SRT_RULES while
 * worker.js's `const` was still in the temporal dead zone:
 *
 *     ReferenceError: Cannot access 'SRT_RULES' before initialization
 *
 * Reproduced in node before it could become a 500 on the live origin. The fix
 * was to keep ONE module: the rule source and the rewriter in one scope with no
 * imports, packaging as a single file for every host. There is still exactly one
 * copy of every threshold — it just lives one file up.
 *
 * The original module is kept byte-for-byte at fix-srt.js.bak-20261127-1220.
 */

export {
  fixSrt,
  scoreLine,
  NOTE,
  MAX_CHARS,
  MAX_LINES,
  MAX_DUR,
  MIN_DUR,
  MIN_GAP,
} from "./worker.js";
