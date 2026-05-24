// Encoding hygiene regression tests.
//
// Source files and docs must not contain mojibake-prone typographic chars
// (em/en dashes, smart quotes, ellipsis, arrows). When such chars are read
// by tools that interpret UTF-8 bytes as CP1252/Latin-1 (some diff viewers,
// older terminals, certain review pipelines), they render as garbage like
// 'a-tilde euro dash' and confuse human readers. ASCII fallbacks (--, ->,
// straight quotes, ...) survive every encoding round-trip.
//
// IMPORTANT: this file MUST keep all the forbidden codepoints below as
// `\uXXXX` escape sequences rather than literal characters, so that when
// this test scans its own source it doesn't trip its own check.

const fs = require("fs");
const path = require("path");

/** Codepoint -> recommended ASCII replacement. Keys built via String.fromCharCode
 *  so the source bytes of THIS file do not contain the forbidden codepoints. */
const FORBIDDEN = (() => {
  const m = {};
  m[String.fromCharCode(0x2013)] = "- (en dash, replace with hyphen)";
  m[String.fromCharCode(0x2014)] = "-- (em dash, replace with double hyphen)";
  m[String.fromCharCode(0x2018)] = "' (left single quote)";
  m[String.fromCharCode(0x2019)] = "' (right single quote)";
  m[String.fromCharCode(0x201C)] = '" (left double quote)';
  m[String.fromCharCode(0x201D)] = '" (right double quote)';
  m[String.fromCharCode(0x2026)] = "... (ellipsis)";
  m[String.fromCharCode(0x2190)] = "<- (left arrow)";
  m[String.fromCharCode(0x2192)] = "-> (right arrow)";
  m[String.fromCharCode(0x2194)] = "<-> (left-right arrow)";
  m[String.fromCharCode(0x21D0)] = "<= (double left)";
  m[String.fromCharCode(0x21D2)] = "=> (double right)";
  return m;
})();

/**
 * Files that must stay encoding-clean. Paths are resolved against
 * ctx.PROJECT (the vscode-extension directory). Root README lives one level
 * up. Deliberately NOT scanned:
 *   - src/webview-monitor.ts: intentionally uses U+2500-family box-drawing
 *     chars to match real TUI output that draws those characters.
 *   - vscode-extension/README.md: ASCII tree diagram uses the same box-drawing
 *     chars (U+2500/U+251C/U+2514/U+2502) which are NOT in the FORBIDDEN set
 *     anyway, but we keep the file out for clarity.
 */
const FILES = [
  "src/extension.ts",
  "src/claude-hook-installer.ts",
  "src/terminal-monitor.ts",
  "resources/claude-hook.js",
  "test/run.js",
  "test/installer.test.js",
  "test/hook.test.js",
  "test/state-matrix.test.js",
  "test/encoding.test.js",
  "README.md",
  "../README.md",
  "package.json",
];

function locate(text, idx) {
  const before = text.slice(0, idx);
  const line = before.split("\n").length;
  const lastNl = before.lastIndexOf("\n");
  const col = lastNl < 0 ? idx + 1 : idx - lastNl;
  return `${line}:${col}`;
}

module.exports = {
  name: "encoding hygiene (no mojibake-prone typographic chars in source)",
  tests: FILES.map((rel) => ({
    name: `no forbidden chars in ${rel}`,
    fn: async (ctx) => {
      const full = path.resolve(ctx.PROJECT, rel);
      if (!fs.existsSync(full)) {
        ctx.assert(`file exists: ${rel}`, false, `missing: ${full}`);
        return;
      }
      const text = fs.readFileSync(full, "utf8");
      const findings = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (Object.prototype.hasOwnProperty.call(FORBIDDEN, ch)) {
          findings.push({
            cp: ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"),
            at: locate(text, i),
            replacement: FORBIDDEN[ch],
          });
          if (findings.length >= 5) break; // cap detail noise
        }
      }
      ctx.assert(
        `${rel}: zero mojibake-prone chars`,
        findings.length === 0,
        findings.length > 0
          ? findings
              .map((f) => `U+${f.cp}@${f.at} use:${f.replacement}`)
              .join(" | ")
          : ""
      );
    },
  })),
};
