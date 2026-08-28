/**
 * 워커 레지스트리
 *
 * 작성자: 최진호
 * 작성일: 2026-08-28
 *
 * 종료 경로가 워커를 하나씩 이름으로 알고 있으면, 워커를 추가할 때마다 종료
 * 경로도 함께 고쳐야 한다. 고치는 것을 잊으면 그 워커는 배수되지 않고, 진행
 * 중이던 작업이 조용히 사라진다.
 *
 * 기동한 워커가 스스로 등록하고, 종료 경로는 등록된 것을 일괄 배수한다.
 */

import { logWarn } from "../../logger.js";

/** 기동 중인 워커 집합. 같은 인스턴스를 두 번 등록해도 하나로 센다. */
const registered = new Set();

/**
 * 워커를 등록한다. PollingWorker.start가 기동에 성공했을 때 호출한다.
 *
 * @param {{stop: Function, name?: string}} worker
 */
export function registerWorker(worker) {
  if (worker && typeof worker.stop === "function") registered.add(worker);
}

/**
 * 등록을 해제한다. 배수가 끝난 워커는 목록에서 빠진다.
 *
 * @param {Object} worker
 */
export function unregisterWorker(worker) {
  registered.delete(worker);
}

/**
 * 현재 등록된 워커 이름 목록.
 *
 * @returns {string[]}
 */
export function listWorkers() {
  return [...registered].map(w => w.name ?? "unnamed");
}

/**
 * 등록된 워커를 모두 멈추고 배수를 기다린다.
 *
 * 한 워커의 배수 실패가 나머지를 막지 않도록 개별 예외를 삼킨다. 종료 경로에서
 * 예외를 전파해봐야 할 수 있는 일이 없다.
 *
 * @returns {Promise<Array<Promise<void>>>} 배수 프라미스 목록
 */
export function drainAllWorkers() {
  const promises = [];
  for (const worker of [...registered]) {
    try {
      const p = worker.stop();
      if (p) promises.push(Promise.resolve(p).catch(err =>
        logWarn(`[WorkerRegistry] ${worker.name ?? "unnamed"} 배수 실패: ${err.message}`)));
    } catch (err) {
      logWarn(`[WorkerRegistry] ${worker.name ?? "unnamed"} 정지 호출 실패: ${err.message}`);
    }
    registered.delete(worker);
  }
  return promises;
}

/** 시험용 초기화. */
export function _resetRegistry() {
  registered.clear();
}
