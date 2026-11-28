import { spawnSync } from "node:child_process";
import { copyFileSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const library = {
  darwin: "libanchormind_tokenizers.dylib",
  linux: "libanchormind_tokenizers.so",
  win32: "anchormind_tokenizers.dll"
}[process.platform];

if (!library) throw new Error(`Unsupported native tokenizer build platform: ${process.platform}`);

const nativeDir = new URL("../native/", import.meta.url);
const targetDir = new URL("target/", nativeDir);
const build = spawnSync("cargo", ["build", "--locked", "--release", "--target-dir", fileURLToPath(targetDir)], {
  cwd: nativeDir,
  stdio: "inherit"
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const temporary = new URL(`tokenizers.node.${process.pid}.tmp`, nativeDir);
try {
  copyFileSync(new URL(`release/${library}`, targetDir), temporary);
  renameSync(temporary, new URL("tokenizers.node", nativeDir));
} finally {
  rmSync(temporary, { force: true });
}
