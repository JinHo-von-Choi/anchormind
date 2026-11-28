import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";

const PROBLEM = "application/problem+json";

function acceptsProblem(accept = "") {
  return String(accept).split(",").some(entry => {
    const [type, ...params] = entry.trim().toLowerCase().split(";");
    if (type.trim() !== PROBLEM) return false;
    const quality = params.map(value => value.trim()).find(value => value.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

function problemExtensions(chunk) {
  try {
    const body = JSON.parse(chunk);
    if (typeof body?.error !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(body.error)) return {};
    const extensions = { code: body.error };
    if (body.error === "unsupported_format_version") {
      if (Number.isInteger(body.version)) extensions.version = body.version;
      if (Array.isArray(body.supported) && body.supported.every(Number.isInteger)) extensions.supported = body.supported;
    }
    return extensions;
  } catch {
    return {};
  }
}

/** 기존 JSON 오류를 유지하고 명시적으로 요청한 경우에만 Problem Details로 응답한다. */
export function prepareAdminResponse(req, res) {
  const requestId = randomUUID();
  res.setHeader("X-Request-ID", requestId);
  res.appendHeader?.("Vary", "Accept");
  if (acceptsProblem(req.headers.accept)) {
    const end = res.end;
    res.end = function (chunk, ...args) {
      if (!this.headersSent && this.statusCode >= 400 &&
          String(this.getHeader?.("Content-Type") ?? "").startsWith("application/json")) {
        this.setHeader("Content-Type", PROBLEM);
        this.removeHeader?.("Content-Length");
        const problem = {
          type: "about:blank",
          title: STATUS_CODES[this.statusCode] ?? "Request failed",
          status: this.statusCode,
          requestId,
          ...problemExtensions(chunk)
        };
        return end.call(this, JSON.stringify(problem), ...args);
      }
      return end.call(this, chunk, ...args);
    };
  }
  return requestId;
}
