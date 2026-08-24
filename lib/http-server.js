import http from "node:http";

export function createHttpServer({ requestHandler, host } = {}) {
  if (typeof requestHandler !== "function") {
    throw new TypeError("requestHandler must be a function");
  }
  const server = http.createServer(requestHandler);
  if (!host) return server;

  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    const first = args[0];
    if (first && typeof first === "object") {
      const options = { ...args[0] };
      if (options.host === undefined) options.host = host;
      return listen(options, ...args.slice(1));
    }
    if (typeof first !== "number") {
      /* A string first argument is a Unix socket path; never inject TCP host. */
      return listen(...args);
    }

    const second = args[1];
    if (typeof second === "string") {
      /* Explicit TCP host wins over the factory default. */
      return listen(...args);
    }
    if (typeof second === "function") {
      return listen(first, host, second);
    }
    if (second === undefined) {
      if (typeof args[2] === "function") return listen(first, host, args[2]);
      if (typeof args[2] === "number") return listen(first, host, args[2], args[3]);
      return listen(first, host);
    }
    if (typeof second === "number") {
      return typeof args[2] === "function"
        ? listen(first, host, second, args[2])
        : listen(first, host, second, ...args.slice(3));
    }
    return listen(...args);
  };
  return server;
}
