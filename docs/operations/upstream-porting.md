<!-- iron-laws: ignore-file[IL-102] 커밋 해시 자리표시자이며 해시 함수 사용이 아니다 -->
# upstream-porting 운영 가이드

작성자: 최진호
작성일: 2026-05-13

---

## 1. 현 상태 진단

이 저장소는 kunkunGames fork를 경유하여 upstream PR을 수신한다. 커밋 히스토리에서
`Merge pull request #N from kunkunGames/port/upstream-pr<M>-<slug>` 패턴이 반복되며,
port 브랜치 네이밍은 묵시적 합의 수준에만 머물러 있다.

upstream remote가 등록되어 있지 않으므로 `git fetch upstream`으로 직접 추적이
불가하다. 결과적으로 divergence 감지가 수작업에 의존하고, 누적 시 충돌 비용이
예측 불가 수준으로 증가한다.

---

## 2. upstream remote 등록 절차

```sh
git remote add upstream <UPSTREAM_URL>
git fetch upstream main
```

`<UPSTREAM_URL>` 자리는 placeholder이며 사용자가 실 upstream 저장소 URL을 직접
채워야 한다. 등록 후 다음으로 remote 목록을 검증한다.

```sh
git remote -v
```

`upstream` 항목이 보이면 이후 `git fetch upstream main`을 반복 실행할 수 있다.

---

## 3. port 브랜치 네이밍 표준

형식: `port/upstream-pr<N>-<slug>`

| 구성요소 | 설명 |
|-|-|
| `N` | upstream 원본 PR 번호 |
| `slug` | kebab-case의 의미 식별자 (예: `memory-consolidate-async-safeguards`) |

한 브랜치는 한 upstream PR 단위만 대응한다. 복수 upstream PR을 단일 브랜치에 묶으면
되돌리기와 충돌 추적이 동시에 불가능해진다.

---

## 4. cherry-pick 우선 정책

upstream commit을 port할 때 merge commit 대신 cherry-pick을 사용한다.

```sh
git cherry-pick -x <SHA>
```

`-x` 플래그는 커밋 메시지 footer에 `(cherry picked from commit <SHA>)`를 자동
삽입한다. 이로써 원본 SHA 추적, 충돌 분석, 되돌리기가 merge commit 방식보다
현저히 쉬워진다.

한 upstream PR이 여러 커밋으로 구성된 경우 시간 순서대로 cherry-pick한다.

```sh
git cherry-pick -x <SHA-1>
git cherry-pick -x <SHA-2>
```

---

## 5. nightly divergence 감지 (권고)

`scripts/check-upstream-divergence.sh` 성격의 cron job을 권고한다. 실제 스크립트
작성은 이 가이드 범위 밖이지만 핵심 명령은 다음과 같다.

```sh
git fetch upstream main
git log --left-right --oneline HEAD...upstream/main
```

좌측(`<`)이 로컬 전용 커밋, 우측(`>`)이 upstream 미반영 커밋이다. 우측이 일정
임계를 초과하면 알림 채널(Slack, SMS 등)로 전송하도록 구성한다. divergence 누적을
조기에 감지하면 한꺼번에 해소하는 비용을 분산시킬 수 있다.

---

## 6. fork 전용 패치 격리

upstream에 머지되지 않을 fork 전용 변경은 `local/*` 브랜치에 모은다.

```sh
git checkout -b local/my-custom-patch
```

upstream 신규 커밋을 port한 이후에는 `local/*` 브랜치를 rebase하여 정합을 유지한다.

```sh
git rebase main local/my-custom-patch
```

merge vs rebase 트레이드오프: merge는 히스토리가 보존되어 "무엇이 언제 합쳐졌는지"
추적이 쉽지만 비선형 그래프로 인해 bisect 정확도가 떨어진다. rebase는 선형
히스토리를 유지하여 bisect와 cherry-pick이 용이하나, force-push가 수반되어 팀
협업 환경에서 주의가 필요하다. `local/*`처럼 개인 작업 브랜치는 rebase가 적합하고,
공유 브랜치는 merge를 기본으로 한다.

---

## 7. 충돌 발생 시 해결 절차

cherry-pick 또는 rebase 도중 충돌이 발생하면 다음 순서로 해결한다.

1. `git status`로 충돌 파일 목록을 확인한다.
2. 각 파일에서 `<<<<<<<`, `=======`, `>>>>>>>` 마커를 찾아 코드를 정합화한다.
3. `git add <파일>` 으로 해결된 파일을 스테이지한다.
4. `git cherry-pick --continue` 또는 `git rebase --continue`로 진행한다.

해결 자신이 없거나 상태가 복잡하면 안전하게 복귀한다.

```sh
git cherry-pick --abort
git rebase --abort
```

동일 패턴의 충돌이 반복된다면 해당 파일이 fork 전용 변경 범위에 포함되어 있는지
검토한다. `local/*` 분리 기준을 재정의하거나, upstream 기여 가능성을 검토하여
근본 원인을 해소한다.
