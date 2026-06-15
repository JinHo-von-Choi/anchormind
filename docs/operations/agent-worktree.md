# agent-worktree

작성자: 최진호
작성일: 2026-05-13

에이전트 도구가 isolation worktree를 생성한 뒤 회수하지 않아 워크트리가 누적되는 문제의 원인, 운영 정책, 점검 명령, cron 설정을 정리한다.

---

## 1. 문제 정의

Claude Code 등 에이전트 도구는 병렬 작업 격리를 위해 `git worktree add`로 임시 워크트리를 자동 생성한다. 작업이 비정상 종료되거나 cleanup 훅이 누락되면 워크트리가 회수되지 않고 잔존한다. memento-mcp 저장소에서는 `.claude/worktrees/agent-*` 패턴으로 25개가 누적된 사례가 있었다. 메타 등록 경로가 실제 디스크와 달라 stale 상태가 된 경우도 포함됐다.

누적 시 영향은 세 가지다. 첫째, `.git/worktrees/` 아래 메타 디렉토리가 증가해 `git status`·`git log` 등 기본 명령의 overhead가 늘어난다. 둘째, 워크트리당 체크아웃된 파일이 남아 디스크를 소비한다. 셋째, `git worktree list` 출력이 길어져 실제 작업 중인 워크트리의 가시성이 떨어진다.

---

## 2. 운영 정책

### 에이전트 종료 시 자동 회수

에이전트 도구의 종료(finalize) 훅에 워크트리 제거 명령을 등록한다. 훅 위치와 명칭은 도구마다 다르므로 아래는 의사 코드 형태의 일반 원칙이다.

```
# 훅 파일 예시 위치: .claude/agent-hooks/post-finalize.sh

REPO=/path/to/memento-mcp
WORKTREE_PATH="$1"   # 에이전트가 생성한 워크트리 절대 경로

if git -C "$REPO" worktree list --porcelain \
     | grep -q "worktree $WORKTREE_PATH"; then
  git -C "$REPO" worktree unlock "$WORKTREE_PATH" 2>/dev/null || true
  git -C "$REPO" worktree remove --force "$WORKTREE_PATH"
fi
rm -rf "$WORKTREE_PATH"
```

훅 실행이 실패해도 주 프로세스가 중단되지 않도록 `|| true`로 방어한다.

### 동시 워크트리 상한

에이전트가 생성하는 워크트리(패턴: `worktree-agent-<hex>` 또는 `.claude/worktrees/agent-<hex>`)는 동시에 5개를 초과하지 않는다. 초과 시 가장 오래된 워크트리는 브랜치를 로컬에 보존한 채 워크트리만 제거한다. 브랜치 보존이 필요 없는 경우에는 브랜치도 함께 삭제한다.

일반 작업 브랜치와 구분하기 위해 GC 스크립트는 다음 패턴에만 적용한다.

| 대상 패턴 | 예시 |
|-|-|
| `.claude/worktrees/agent-[0-9a-f]+` | `.claude/worktrees/agent-3a7f` |
| `worktree-agent-[0-9a-f]+` (브랜치명) | `worktree-agent-3a7f` |

이 패턴 외 워크트리와 브랜치는 GC 대상에서 제외한다.

### 로컬 cron GC 정책

매일 새벽 3시에 워크트리 목록을 스캔하여 아래 조건 중 하나에 해당하는 워크트리를 자동 제거한다.

- 마지막 파일 수정 시각이 7일 이상 경과
- `git worktree list --porcelain` 출력에서 `prunable` 표시

---

## 3. 점검 명령어

### 현황 파악

```bash
REPO=/path/to/memento-mcp

# 현재 등록된 워크트리 전체 목록 (상태 포함)
git -C "$REPO" worktree list --porcelain

# 더 이상 유효하지 않은 워크트리 메타 정리 (실제 디렉토리가 없는 경우)
git -C "$REPO" worktree prune -v
```

### 일괄 정리 절차

아래 4단계를 순서대로 실행한다.

```bash
REPO=/path/to/memento-mcp
PATTERN=".claude/worktrees/agent-"

# (a) lock 해제 — prune/remove가 lock된 워크트리를 건너뛰므로 선행 필수
git -C "$REPO" worktree list --porcelain \
  | grep "^worktree $REPO/$PATTERN" \
  | awk '{print $2}' \
  | xargs -I{} git -C "$REPO" worktree unlock {} 2>/dev/null || true

# (b) git 메타 + 디렉토리 동시 제거
git -C "$REPO" worktree list --porcelain \
  | grep "^worktree $REPO/$PATTERN" \
  | awk '{print $2}' \
  | xargs -I{} git -C "$REPO" worktree remove --force {}

# (c) git이 인식하지 못한 잔여 디렉토리 물리 삭제
rm -rf "$REPO/.claude/worktrees/agent-"*

# (d) 불필요한 브랜치 삭제 (보존이 필요 없는 경우에만)
git -C "$REPO" branch \
  | grep "worktree-agent-" \
  | xargs -I{} git -C "$REPO" branch -D {}
```

### stale 메타(경로 불일치) 처리

`git worktree list --porcelain`에서 경로는 존재하지만 실제 디스크에 디렉토리가 없는 경우 stale 상태다.

```bash
REPO=/path/to/memento-mcp

# stale 메타만 정리 (디스크 디렉토리가 없어도 메타는 삭제)
git -C "$REPO" worktree prune -v

# prune 후에도 남는 경우 remove --force 로 강제 제거 (메타만 정리됨, rm은 불필요)
git -C "$REPO" worktree remove --force <path>
```

---

## 4. cron 예시

```crontab
# 매일 03:00 에이전트 워크트리 GC
0 3 * * * /path/to/memento-mcp/.claude/scripts/gc-worktrees.sh >> /var/log/memento-gc.log 2>&1
```

스크립트 흐름(`gc-worktrees.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO=/path/to/memento-mcp
STALE_DAYS=7
COUNT_LIMIT=5

# 1. stale 메타 prune
git -C "$REPO" worktree prune -v

# 2. agent 패턴 워크트리만 추출
mapfile -t WORKTREES < <(
  git -C "$REPO" worktree list --porcelain \
    | grep "^worktree " \
    | awk '{print $2}' \
    | grep "agent-"
)

# 3. 7일 초과 또는 상한 초과 워크트리 제거
REMOVED=0
for WT in "${WORKTREES[@]}"; do
  if [ ! -d "$WT" ]; then
    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
    ((REMOVED++))
    continue
  fi
  AGE=$(find "$WT" -maxdepth 1 -newer /proc/1 -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
  MTIME=$(stat -c %Y "$WT" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if (( NOW - MTIME > STALE_DAYS * 86400 )); then
    git -C "$REPO" worktree unlock "$WT" 2>/dev/null || true
    git -C "$REPO" worktree remove --force "$WT"
    rm -rf "$WT"
    ((REMOVED++))
  fi
done

# 4. 상한 초과 시 가장 오래된 순으로 추가 제거
REMAINING=$(git -C "$REPO" worktree list --porcelain | grep "agent-" | wc -l)
if (( REMAINING > COUNT_LIMIT )); then
  EXCESS=$(( REMAINING - COUNT_LIMIT ))
  git -C "$REPO" worktree list --porcelain \
    | grep "^worktree .*agent-" \
    | awk '{print $2}' \
    | head -n "$EXCESS" \
    | while read -r WT; do
        git -C "$REPO" worktree unlock "$WT" 2>/dev/null || true
        git -C "$REPO" worktree remove --force "$WT"
        rm -rf "$WT"
      done
fi

echo "[$(date -Iseconds)] GC 완료. 제거: $REMOVED"
```

---

## 5. 에이전트 도구 hook 설정

각 에이전트 도구의 종료 훅(post-run, finalize, cleanup 등 명칭은 도구마다 다름)에 아래 원칙을 적용한다.

일반 원칙: 에이전트가 워크트리를 생성했다면 종료 시 반드시 `git worktree remove --force <path>`를 실행한다. 훅 실패가 주 작업 실패로 이어지지 않도록 별도 프로세스 또는 `|| true` 방어를 적용한다.

의사 코드:

```
on agent.finalize(context):
  worktree_path = context.get("worktree_path")
  if worktree_path:
    run_safe("git worktree unlock " + worktree_path)
    run_safe("git worktree remove --force " + worktree_path)
    run_safe("rm -rf " + worktree_path)
```

Claude Code의 경우 `.claude/settings.json`의 `hooks` 필드에 `PostToolUse` 또는 `Stop` 이벤트를 사용해 등록할 수 있다. 정확한 필드명은 도구 버전 문서를 확인한다.

---

## 6. 트러블슈팅

| 증상 | 원인 | 해결 명령 |
|-|-|-|
| `prune`이 아무것도 지우지 않음 | 워크트리가 lock 상태 | `git worktree unlock <path>` 후 `prune` 재실행 |
| `remove --force`가 "not a worktree" 오류 | stale 메타 — 경로와 메타 불일치 | `git worktree prune -v` 로 메타 단독 삭제 |
| 디렉토리는 없는데 브랜치만 남음 | 워크트리 제거 후 브랜치 미삭제 | `git branch -D worktree-agent-<hex>` |
| 디렉토리는 있는데 git이 인식 못함 | `rm -rf`로 디렉토리만 삭제한 경우 | `git worktree prune -v` 로 메타 정리 |
| `worktree list`에 정상 워크트리가 섞임 | 패턴 필터 누락 | GC 명령에 `grep "agent-"` 필터 반드시 적용 |
