/* MMM-NetworkStatus - scripts/lint.js
 *
 * Dependency free sanity checks so the module can be validated even on a
 * Raspberry Pi without dev dependencies installed:
 *
 *   - every .js file parses
 *   - every translation file is valid JSON with the same key set as en.json
 *   - every language declared in getTranslations() has a file
 *   - no leftover debugging statements
 *
 * MIT Licensed.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const errors = [];
const checked = { js: 0, json: 0 };

function walk (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

const files = walk(ROOT);

/* ---------- JavaScript syntax ---------- */

for (const file of files.filter((f) => f.endsWith(".js"))) {
  const rel = path.relative(ROOT, file);
  const source = fs.readFileSync(file, "utf8");
  try {
    new vm.Script(source, { filename: rel });
    checked.js += 1;
  } catch (err) {
    errors.push(`${rel}: syntax error - ${err.message}`);
    continue;
  }
  if (/^\s*console\.(log|debug)\(/m.test(source) && !rel.startsWith("scripts/")) {
    errors.push(`${rel}: leftover console.log/debug statement`);
  }
  // MagicMirror guideline: the current timestamp should be overridable for
  // debugging, so `new Date(Date.now())` is preferred over a bare constructor.
  if (!rel.startsWith("scripts/") && new RegExp(`new\\s+Date\\s*\\(\\s*\\)`).test(source)) {
    errors.push(`${rel}: use "new Date(Date.now())" instead of a bare Date constructor`);
  }
}

/* ---------- translations ---------- */

const translationsDir = path.join(ROOT, "translations");
const englishPath = path.join(translationsDir, "en.json");
if (!fs.existsSync(englishPath)) {
  errors.push("translations/en.json is missing");
} else {
  const english = JSON.parse(fs.readFileSync(englishPath, "utf8"));
  const englishKeys = Object.keys(english).sort();

  for (const file of fs.readdirSync(translationsDir).filter((f) => f.endsWith(".json"))) {
    const abs = path.join(translationsDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(abs, "utf8"));
      checked.json += 1;
    } catch (err) {
      errors.push(`translations/${file}: invalid JSON - ${err.message}`);
      continue;
    }
    const keys = Object.keys(data).sort();
    const missing = englishKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !englishKeys.includes(k));
    if (missing.length) errors.push(`translations/${file}: missing keys ${missing.join(", ")}`);
    if (extra.length) errors.push(`translations/${file}: unknown keys ${extra.join(", ")}`);
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "string" || !value.trim()) {
        errors.push(`translations/${file}: ${key} must be a non empty string`);
      }
    }
  }

  /* ---------- declared languages exist ---------- */

  const moduleSource = fs.readFileSync(path.join(ROOT, "MMM-NetworkStatus.js"), "utf8");
  const declared = [...moduleSource.matchAll(/"?([a-z]{2}(?:[_-][a-z]{2})?)"?\s*:\s*"(translations\/[^"]+)"/gi)];
  if (declared.length < 2) errors.push("MMM-NetworkStatus.js: getTranslations() looks empty");
  for (const [, lang, rel] of declared) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      errors.push(`MMM-NetworkStatus.js: ${lang} points to missing ${rel}`);
    }
  }
}

/* ---------- required files ---------- */

for (const required of [
  "MMM-NetworkStatus.js",
  "MMM-NetworkStatus.css",
  "node_helper.js",
  "lib/format.js",
  "lib/parsers.js",
  "lib/probes.js",
  "README.md",
  "LICENSE",
  "package.json"
]) {
  if (!fs.existsSync(path.join(ROOT, required))) errors.push(`missing required file: ${required}`);
}

/* ---------- report ---------- */

if (errors.length) {
  console.error("Lint failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`Lint OK (${checked.js} js files, ${checked.json} translation files).`);
