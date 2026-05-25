---
title: "Getting Started"
date: 2026-03-13
author: 최진호
updated: 2026-05-26
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

## 문서 목적

- Quick Start: 최소 의존성으로 서버를 띄우는 경로. CLI `--help`, `--format`, `--remote` 기본 사용법 포함
- First Memory Flow: 첫 `remember`, `recall`, `context` 성공 검증. sparse fields 예시 포함
- Troubleshooting: 대표 설치/실행 오류 해결. v2.10.1 / v2.11.0 / migration-034-v2.16.0-bundle 관련 항목 포함
- Windows WSL2 Setup: Windows에서 가장 안정적인 설치 경로
- Windows PowerShell Setup: Bash 없이 수동으로 설치하는 제한 경로. 원격 CLI 환경변수 설정 포함
- Claude Code Configuration: Claude Code에서 memento를 MCP 서버로 등록하는 방법. `_meta` 응답 구조 및 dryRun 예시 포함
