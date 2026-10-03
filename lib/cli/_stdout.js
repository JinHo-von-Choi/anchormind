/**
 * 닫힌 표준 출력에 견디는 출력기
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 출력을 받는 쪽이 먼저 닫히면(`anchormind init ... | head`) 쓰기는 EPIPE 'error' 이벤트로 끝난다. 처리기가 없으면
 * 프로세스가 스택 트레이스와 종료 코드 1로 끝나 명령 자체의 결과(예: 파일을 모두 썼다)를 가린다. 이 출력기는
 * EPIPE와 닫힌 스트림을 "더 쓰지 않음"으로 다루고, 그 밖의 출력 오류는 다음 쓰기에서 던지며 onError로 알린다.
 */

/** 받는 쪽이 닫혔음을 뜻하는 오류 코드 */
const CLOSED_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

/**
 * @param {import("node:stream").Writable} stream
 * @param {{ onError?: (err: Error) => void }} [options] EPIPE가 아닌 출력 오류 알림(기본: 종료 코드 1로 표시)
 * @returns {{ write: (text: string) => void, isClosed: () => boolean }}
 */
export function createOutput(stream, { onError = () => { process.exitCode = 1; } } = {}) {
  let closed  = false;
  let failure = null;
  stream.on("error", (err) => {
    if (CLOSED_CODES.has(err?.code)) {
      closed = true;
      return;
    }
    failure = err;
    onError(err);
  });
  return {
    write(text) {
      if (failure) throw failure;
      if (!closed) stream.write(text);
    },
    isClosed: () => closed
  };
}
