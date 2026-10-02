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
