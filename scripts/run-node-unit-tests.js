#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const unitRoot = path.join(root, "tests", "unit");

function collectTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(full);
    }
  }
  return files.sort();
}

const files = collectTestFiles(unitRoot);
const env = {
  ...process.env,
  MEMENTO_METRICS_DEFAULT: "off"
};

const result = spawnSync(process.execPath, [
  "--experimental-test-module-mocks",
  "--test",
  ...files
], {
  cwd: root,
  env,
  stdio: "inherit"
});

process.exit(result.status ?? 1);
