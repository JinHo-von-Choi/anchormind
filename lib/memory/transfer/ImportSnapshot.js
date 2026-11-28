import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { classifyRecord } from "./exportFormat.js";

async function* fileLines(file, start) {
  let pending = [];
  for await (const chunk of createReadStream(file, { start })) {
    let offset = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, offset)) {
      pending.push(chunk.subarray(offset, end));
      const line = Buffer.concat(pending);
      yield { line, bytes: line.length + 1 };
      pending = [];
      offset = end + 1;
    }
    if (offset < chunk.length) pending.push(chunk.subarray(offset));
  }
  if (pending.length) {
    const line = Buffer.concat(pending);
    yield { line, bytes: line.length };
  }
}

async function* snapshotRecords(file, afterLine, afterByte) {
  let byteEnd = afterByte ?? 0;
  let lineNo = afterByte === undefined ? 0 : afterLine;
  for await (const { line, bytes } of fileLines(file, byteEnd)) {
    byteEnd += bytes;
    lineNo++;
    if (lineNo <= afterLine) continue;
    const text = line.toString("utf8").trim();
    if (text) yield { lineNo, byteEnd, ...classifyRecord(text) };
  }
}

/** 해시를 계산한 바이트 그대로 가져온다. 복사 이후 원본이 바뀌어도 영향을 받지 않는다. */
export async function withImportSnapshot(source, run, { maxBytes = Infinity } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "memento-import-"));
  const file = path.join(dir, "input.jsonl");
  const hash = createHash("sha256");
  try {
    await pipeline(source, async function* (chunks) {
      let size = 0;
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(file, { mode: 0o600 }));
    return await run({ records: (line = 0, byte) => snapshotRecords(file, line, byte), digest: hash.digest("hex") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
