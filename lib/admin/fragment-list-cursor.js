import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ACCESS_KEY } from "../config.js";

const MAX_CURSOR_BYTES = 8192;

export const fragmentListCursorEnabled = Boolean(ACCESS_KEY);
const sign = value => createHmac("sha256", ACCESS_KEY).update("admin-fragment-list-v1\0").update(value).digest();

/** 원래 요청의 실효 필터 및 권한 범위를 커서에 묶는다. */
export function fragmentListContext(filters, params, scope) {
  return createHash("sha256").update(JSON.stringify([filters, params, scope])).digest("base64url");
}

export function encodeFragmentListCursor(createdAt, id, context) {
  const payload = Buffer.from(JSON.stringify([createdAt, id, context])).toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}

export function decodeFragmentListCursor(cursor, context) {
  if (Buffer.byteLength(cursor) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) return null;
  const [payload, signature] = cursor.split(".");
  const expected = sign(payload);
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || supplied.toString("base64url") !== signature ||
      !timingSafeEqual(supplied, expected)) return null;
  try {
    const [createdAt, id, originalContext] = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (originalContext !== context || typeof id !== "string" || !id ||
        (createdAt !== null && typeof createdAt !== "string")) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** PostgreSQL DESC의 NULLS FIRST와 동일 시간의 id ASC를 보존한다. */
export function fragmentListAfter(params, position) {
  if (!position) return "";
  params.push(position.id);
  const id = `$${params.length}`;
  if (position.createdAt === null) return ` AND (created_at IS NOT NULL OR (created_at IS NULL AND id > ${id}))`;
  params.push(position.createdAt);
  const time = `$${params.length}::timestamptz`;
  return ` AND created_at <= ${time} AND (created_at < ${time} OR id > ${id})`;
}
