#!/usr/bin/env node
// Test runner for the LLM Auto-Confirm Claude hook installer + hook script.
// No external test framework -- keeps the dev dependency surface zero beyond
// what's already used to ship the extension (esbuild for bundling).
//
// Usage: npm test  (from vscode-extension/)

const fs = require("fs");
const path = require("path");
const os = require("os");
const esbuild = require("esbuild");

const TEST_DIR = __dirname;
const PROJECT = path.resolve(TEST_DIR, "..");
const BUNDLE = path.join(TEST_DIR, ".installer-bundle.js");
const TEST_HOME = path.join(os.tmpdir(), `llmac-test-${process.pid}`);
const HOOK_SCRIPT = path.join(PROJECT, "resources", "claude-hook.js");

let totalPass = 0;
let totalFail = 0;
const failures = [];

function buildContext(suiteName, testName) {
  const claudeDir = path.join(TEST_HOME, ".claude");
  const hookDir = path.join(claudeDir, "llm-auto-confirm");
  const sessionsDir = path.join(hookDir, "sessions");
  const windowsDir = path.join(hookDir, "windows");
  const sanitize = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    TEST_HOME,
    BUNDLE,
    PROJECT,
    HOOK_SCRIPT,
    paths: {
      claudeDir,
      hookDir,
      sessionsDir,
      windowsDir,
      settingsPath: path.join(claudeDir, "settings.json"),
      scriptPath: path.join(hookDir, "hook.js"),
      configPath: path.join(hookDir, "config.json"), // kept for migration tests
      windowConfigFile: (id) => path.join(hookDir, `config-${sanitize(id)}.json`),
      sessionFile: (id) => path.join(sessionsDir, sanitize(id)),
      windowFile: (id) => path.join(windowsDir, sanitize(id)),
    },
    helpers: {
      reset() {
        if (fs.existsSync(TEST_HOME))
          fs.rmSync(TEST_HOME, { recursive: true, force: true });
        fs.mkdirSync(TEST_HOME, { recursive: true });
      },
      ageOut(filePath, minutes = 11) {
        const past = new Date(Date.now() - minutes * 60 * 1000);
        fs.utimesSync(filePath, past, past);
      },
    },
    assert(label, cond, detail = "") {
      if (cond) {
        totalPass++;
      } else {
        totalFail++;
        failures.push({ suite: suiteName, test: testName, label, detail });
      }
    },
  };
}

async function runSuite(file) {
  const suite = require(file);
  console.log(`\n## ${suite.name}`);
  for (const t of suite.tests) {
    const ctx = buildContext(suite.name, t.name);
    const before = totalFail;
    try {
      ctx.helpers.reset();
      await t.fn(ctx);
      const failed = totalFail - before;
      if (failed === 0) {
        console.log(`  ok   ${t.name}`);
      } else {
        console.log(`  FAIL ${t.name} -- ${failed} assertion(s) failed`);
      }
    } catch (err) {
      totalFail++;
      failures.push({
        suite: suite.name,
        test: t.name,
        label: "threw",
        detail: err && err.stack ? err.stack.split("\n")[0] : String(err),
      });
      console.log(`  FAIL ${t.name} -- threw: ${err && err.message ? err.message : err}`);
    }
  }
}

async function main() {
  // Build the installer to a CJS bundle so suites can require() it. Pure-JS
  // alternative would be ts-node, but that's another dep. esbuild is already
  // used to ship the extension itself.
  await esbuild.build({
    entryPoints: [path.join(PROJECT, "src/claude-hook-installer.ts")],
    bundle: true,
    outfile: BUNDLE,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });

  // Patch os.homedir() so the in-process installer code writes inside
  // TEST_HOME instead of the real user dir. Each test's reset() clears it.
  os.homedir = () => TEST_HOME;
  process.env.USERPROFILE = TEST_HOME; // for any child node processes
  process.env.HOME = TEST_HOME;

  try {
    await runSuite(path.join(TEST_DIR, "installer.test.js"));
    await runSuite(path.join(TEST_DIR, "hook.test.js"));
    await runSuite(path.join(TEST_DIR, "state-matrix.test.js"));
    await runSuite(path.join(TEST_DIR, "encoding.test.js"));
  } finally {
    if (fs.existsSync(TEST_HOME))
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    if (fs.existsSync(BUNDLE)) fs.unlinkSync(BUNDLE);
    if (fs.existsSync(BUNDLE + ".map")) fs.unlinkSync(BUNDLE + ".map");
  }

  console.log(
    `\n========================================\nTotal: ${totalPass + totalFail} | Pass: ${totalPass} | Fail: ${totalFail}`
  );
  if (totalFail > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(
        `  [${f.suite}] ${f.test} -- ${f.label}${f.detail ? ` (${f.detail})` : ""}`
      );
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
