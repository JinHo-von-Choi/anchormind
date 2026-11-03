/**
 * 프로세스 레벨 에러 가드
 *
 * unhandledRejection / uncaughtException을 로깅하고, uncaught 경로는
 * onFatal 콜백으로 종료 절차를 위임한다. onFatal은 최초 1회만 호출되어
 * shutdown 도중 발생하는 2차 예외로 인한 재진입을 차단한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-07-14
 */

/**
 * reason 값을 로깅 가능한 error/stack 쌍으로 정규화한다.
 */
function describeError(reason) {
  if (reason instanceof Error) {
    return { error: reason.message, stack: reason.stack };
  }
  return { error: String(reason), stack: undefined };
}

/**
 * 프로세스(또는 주입된 EventEmitter)에 전역 에러 가드를 설치한다.
 *
 * @param {Object}   options
 * @param {Object}   [options.proc=process] - 리스너를 등록할 대상
 * @param {Function} options.logError       - (message, meta) 로거
 * @param {Function} options.onFatal        - uncaughtException 시 1회 호출
 */
export function installProcessGuards({ proc = process, logError, onFatal }) {
  let fatalHandled = false;

  proc.on("unhandledRejection", (reason) => {
    logError("[Process] Unhandled promise rejection", describeError(reason));
  });

  proc.on("uncaughtException", (err) => {
    logError("[Process] Uncaught exception", describeError(err));
    if (fatalHandled) return;
    fatalHandled = true;
    onFatal(err);
  });
}

/**
 * 종료 절차를 한 번만 실행하고, 전체 소요 시간에 상한을 건다.
 *
 * 두 번째 이후 신호는 기록만 한다. deadlineMs 안에 run이 끝나지 않으면
 * exit(1)을 부른다. deadlineMs가 0이면 상한을 걸지 않는다.
 *
 * @param {Object}   options
 * @param {number}   options.deadlineMs
 * @param {Function} options.run        - (signal, opts) => Promise<void>
 * @param {Function} options.exit       - (code) => void
 * @param {Function} options.logError   - (message, meta) => void
 * @param {Function} [options.setTimer=setTimeout]
 * @returns {(signal: string, opts?: object) => Promise<void>|undefined}
 */
export function createShutdownGuard({ deadlineMs, run, exit, logError, setTimer = setTimeout }) {
  let started = false;
  return (signal, opts = {}) => {
    if (started) {
      logError("[Shutdown] Shutdown already in progress, ignoring signal", { signal });
      return undefined;
    }
    started = true;
    if (deadlineMs > 0) {
      const timer = setTimer(() => {
        logError("[Shutdown] Deadline exceeded, forcing exit", { signal, deadlineMs });
        exit(1);
      }, deadlineMs);
      timer?.unref?.();
    }
    return run(signal, opts);
  };
}

/**
 * 처리 중인 HTTP 요청 수를 센다. 종료 절차가 DB 풀을 닫기 전에 이 요청들이 끝나기를 기다린다.
 *
 * SSE 구독(응답 Content-Type이 text/event-stream)은 연결이 끊길 때까지 열려 있으므로 세지 않는다.
 *
 * @returns {{ track: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
 *             wrap: (handler: Function, onError?: Function) => Function, inFlight: () => number, waitIdle: (timeoutMs: number) => Promise<boolean> }}
 */
export function createRequestTracker() {
  const open    = new Set();
  let   waiters = [];

  const isStream = (res) => String(res.getHeader?.("content-type") ?? "").startsWith("text/event-stream");
  const inFlight = () => {
    let n = 0;
    for (const res of open) if (!isStream(res)) n += 1;
    return n;
  };
  const settle = () => {
    if (waiters.length === 0 || inFlight() !== 0) return;
    const pending = waiters;
    waiters = [];
    for (const finish of pending) finish(true);
  };

  return {
    track(_req, res) {
      open.add(res);
      res.once("close", () => {
        open.delete(res);
        settle();
      });
    },
    /**
     * 요청 처리기를 감싸 모든 요청을 센다. 처리기가 던진 오류는 여기서 받아 기록하고, 응답을 아직 쓰지 않았으면
     * 500으로 끝낸다. 받지 않으면 처리되지 않은 거부가 되어 프로세스 전체가 종료될 수 있다.
     *
     * @param {Function} handler
     * @param {(message: string, err: unknown) => void} [onError]
     */
    wrap(handler, onError = () => {}) {
      return (req, res) => {
        this.track(req, res);
        return Promise.resolve()
          .then(() => handler(req, res))
          .catch((err) => {
            onError(`[HTTP] request handler failed: ${req.method} ${String(req.url ?? "").split("?")[0]}`, err);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader?.("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Internal error" }));
            } else if (!res.writableEnded) {
              res.end();
            }
          });
      };
    },
    inFlight,
    /** timeoutMs 안에 처리 중인 요청이 0이 되면 true, 시간이 다 되면 false */
    waitIdle(timeoutMs) {
      if (inFlight() === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const finish = (value) => { clearTimeout(timer); resolve(value); };
        const timer  = setTimeout(() => {
          waiters = waiters.filter((w) => w !== finish);
          resolve(false);
        }, timeoutMs);
        waiters.push(finish);
      });
    }
  };
}
