import http from "node:http";

export function createHttpServer({ requestHandler, host: _host } = {}) {
  if (typeof requestHandler !== "function") {
    throw new TypeError("requestHandler must be a function");
  }
  return http.createServer(requestHandler);
}
