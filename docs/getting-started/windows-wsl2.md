---
title: "Windows WSL2 Setup"
date: 2026-03-13
author: 최진호
updated: 2026-10-03
---

# Windows WSL2 Setup

Windows 환경에서는 WSL2 Ubuntu 경로를 권장한다.

- 권장: Windows 11 + WSL2 Ubuntu
- 제한 지원: 순수 PowerShell 수동 설치
- 비권장: `setup.sh`를 PowerShell에서 직접 실행하는 방식

이 프로젝트의 `setup.sh`는 Bash, `cp`, `date`, `python3`, Unix 경로를 전제로 작성되어 있다. Windows에서는 WSL2가 가장 안정적이다.

## 1. WSL2 준비

관리자 PowerShell에서 WSL2를 설치한다.

```powershell
wsl --install -d Ubuntu
```

설치 후 Windows를 재부팅하고 Ubuntu를 한 번 실행해 사용자 계정을 만든다.

## 2. Ubuntu 안에서 기본 패키지 설치

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg postgresql-client redis-tools
```

Node.js는 20 이상을 사용한다. 설치 방법은 팀 표준 방식에 맞추면 된다.

## 3. 프로젝트 위치

권장 경로:

```bash
cd ~
git clone <repository-url>
cd memento-mcp
```

WSL 파일 시스템 내부 경로를 권장한다. `/mnt/c/...` 아래에서 개발하면 I/O 성능이 떨어질 수 있다.

## 4. 환경 파일 생성

```bash
cp .env.example.minimal .env
```

필수 값:

```env
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=memento
POSTGRES_USER=postgres
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql://postgres:change-me@localhost:5432/memento
MEMENTO_ACCESS_KEY=change-me
```

Windows 호스트의 PostgreSQL을 사용할 수도 있고, WSL 내부 PostgreSQL을 사용할 수도 있다.

## 5. 의존성 설치 및 schema 적용

```bash
npm install
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql "$DATABASE_URL" -f lib/memory/memory-schema.sql
npm run migrate
```

## 6. 서버 실행

```bash
node server.js
```

기본 포트는 `57332`다.

## 7. Windows와 WSL의 경계

- memento 서버는 WSL 안에서 실행된다.
- Claude Code 설정 파일은 Windows 사용자 홈에 있을 수 있다.
- 일반적으로 `http://localhost:57332/mcp`로 연결 가능하다.

Claude Code 연동은 [Claude Code Configuration](claude-code.md) 문서를 따른다.

## 8. 실행 확인

WSL 터미널에서:

```bash
curl -s http://localhost:57332/health
```

Windows PowerShell에서도 같은 포트로 접근 가능한지 확인한다.

```powershell
Invoke-RestMethod -Method Get -Uri "http://localhost:57332/health"
```

오류가 나면 [Troubleshooting](troubleshooting.md)을 확인한다.

## 9. CLI 원격 접속 설정

WSL 환경에서는 Bash 문법으로 환경변수를 설정한다.

```bash
# 환경변수 설정 (현재 셸)
export MEMENTO_CLI_REMOTE=https://memento.example.com/mcp
export MEMENTO_CLI_KEY=mmcp_xxx

# 설정 후 CLI 사용
node bin/memento.js stats
node bin/memento.js recall "검색어"

# 일회성 실행
MEMENTO_CLI_REMOTE=https://memento.example.com/mcp MEMENTO_CLI_KEY=mmcp_xxx \
  node bin/memento.js stats --format json
```

WSL 안에서 실행하는 CLI는 Linux Bash 문법을 그대로 사용한다. Windows PowerShell 문법(`$env:`)은 WSL 터미널에서 사용하지 않는다.
