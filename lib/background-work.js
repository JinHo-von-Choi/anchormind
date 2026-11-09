/**
 * 응답을 돌려준 뒤에도 계속 도는 DB 작업을 추적한다.
 * 종료 절차는 DB 풀을 닫기 전에 drainBackgroundWork()로 이 작업들이 끝나기를 기다린다.
 */

const pending = new Set();

/**
 * 기다리지 않고 띄운 작업을 종료 대기 목록에 넣는다. 작업의 실패 처리는 호출자가 맡는다.
 *
 * @template T
 * @param {Promise<T>|T} work
 * @returns {Promise<T>|T} 받은 값을 그대로 돌려준다
 */
export function trackBackgroundWork(work) {
  const finish = () => { pending.delete(entry); };
  const entry  = Promise.resolve(work).then(finish, finish);
  pending.add(entry);
  return work;
}

/**
 * 추적 중인 작업이 모두 끝날 때까지 기다린다. 작업이 끝나면서 새로 띄운 작업도 함께 기다린다.
 *
 * @returns {Promise<void>}
 */
export async function drainBackgroundWork() {
  while (pending.size > 0) {
    await Promise.all(pending);
  }
}
