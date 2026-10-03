---
title: "Getting Started"
date: 2026-03-13
author: 최진호
updated: 2026-10-03
---

# Getting Started

Memento MCP 온보딩 문서 모음이다. 처음 설치하는 경우 아래 순서로 읽는 것을 권장한다.

> [!TIP]
> 한 번도 직접 설치해 본 적이 없다면 [`../INSTALL.md`의 "AI에게 맡기기"](../INSTALL.md#ai에게-맡기기) 섹션을 먼저 보면 된다. Claude Code·Cursor·Codex 같은 AI 어시스턴트에 한 줄을 던지면 의존성·`.env`·MCP 등록·헬스 체크까지 안내한다.

## 권장 읽기 순서

1. [Quick Start](quickstart.md)
2. [First Memory Flow](first-memory-flow.md)
3. [Troubleshooting](troubleshooting.md)

## 환경별 가이드

- Linux / macOS: [Quick Start](quickstart.md)
- Windows 권장: [Windows WSL2 Setup](windows-wsl2.md)
- Windows 제한 지원: [Windows PowerShell Setup](windows-powershell.md)

## 연동 가이드

- Claude Code 사용 시: [Claude Code Configuration](claude-code.md)
- Claude Code, Codex 훅(세션 시작 주입, 세션 종료 회고): [훅 설정](hooks.md) ([English](hooks.en.md))
- Claude Code, Codex 플러그인(MCP 연결, 훅, 스킬 묶음과 `anchormind init`): [플러그인 설치](plugins.md) ([English](plugins.en.md))

## 문서 목적

- Quick Start: 최소 의존성으로 서버를 띄우는 경로. CLI `--help`, `--format`, `--remote` 기본 사용법 포함
- First Memory Flow: 첫 `remember`, `recall`, `context` 성공 검증. sparse fields 예시 포함
- Troubleshooting: 대표 설치/실행 오류 해결. 기동 종료 코드 78, 세션 404, 준비 확인 503, migration-034-v2.16.0-bundle 관련 항목 포함
- Windows WSL2 Setup: Windows에서 가장 안정적인 설치 경로
- Windows PowerShell Setup: Bash 없이 수동으로 설치하는 제한 경로. 원격 CLI 환경변수 설정 포함
- Claude Code Configuration: Claude Code에서 memento를 MCP 서버로 등록하는 방법. `_meta` 응답 구조 및 dryRun 예시 포함
- 훅 설정: `POST /hooks/{client}/{event}`와 `anchormind hook`으로 Claude Code와 Codex의 SessionStart 주입과 SessionEnd 회고를 거는 방법
- 플러그인 설치: `anchormind init`으로 Claude Code, Codex 플러그인을 만들고 설치하는 방법. 키는 보안 저장소나 환경 변수에만 둔다
