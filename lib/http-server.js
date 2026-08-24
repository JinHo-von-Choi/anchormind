import http from "node:http";

export function createHttpServer({ requestHandler, host } = {}) {
  if (typeof requestHandler !== "function") {
    throw new TypeError("requestHandler must be a function");
  }
  const server = http.createServer(requestHandler);
  if (!host) return server;

  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    if (args[0] && typeof args[0] === "object") {
      const options = { ...args[0] };
      if (options.host === undefined) options.host = host;
      return listen(options, ...args.slice(1));
    }
    if (args.length === 1 || typeof args[1] === "function") {
      return typeof args[1] === "function"
        ? listen(args[0], host, args[1])
        : listen(args[0], host);
    }
    return listen(...args);
  };
  return server;
}
