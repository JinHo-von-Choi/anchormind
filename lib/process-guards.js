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
