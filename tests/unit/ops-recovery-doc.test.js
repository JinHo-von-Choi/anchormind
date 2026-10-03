/**
 * 단일 파편 복구 절차(문서의 스크립트) 시험
 *
 * docs/operations/backup-restore.md 의 단일 파편 복구 스크립트를 문서에서 그대로 꺼내
 * 자리표시자만 바꿔 실제 bash 로 실행한다. psql 은 가짜 실행 파일로 바꿔, 삭제 목록 대조의
 * 모든 분기에서 운영 쓰기(표준 입력으로 SQL 을 받는 호출)가 일어났는지만 본다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert                                       from "node:assert/strict";
import { spawnSync }                                from "node:child_process";
import fs                                           from "node:fs";
import os                                           from "node:os";
import path                                         from "node:path";

const DOC_PATH = path.resolve(import.meta.dirname, "..", "..", "docs", "operations", "backup-restore.md");

/** 문서에서 단일 파편 복구 스크립트 블록을 꺼낸다. */
function extractScript() {
  const doc   = fs.readFileSync(DOC_PATH, "utf8");
  const start = doc.indexOf("```bash\nSCRATCH_DB=");
  assert.ok(start > 0, "문서에서 복구 스크립트를 찾지 못했다");
  const from  = start + "```bash\n".length;
  return doc.slice(from, doc.indexOf("```", from));
}

const SCRIPT = extractScript();

/** 가짜 psql: -c 가 있으면 복구본 질의, 없으면 운영 쓰기로 보고 표준 입력을 기록한다. */
const FAKE_PSQL = String.raw`#!/usr/bin/env bash
if [[ -n "\${FAKE_SCRATCH_FAIL:-}" ]]; then echo "scratch down" >&2; exit 1; fi
sql=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-c" ]]; then sql="$2"; shift 2; else shift; fi
done
if [[ -n "$sql" ]]; then
  if [[ "$sql" == *"SELECT id FROM"* ]]; then printf '%b' "\${FAKE_IDS:-}"; else echo "csv,row"; fi
  exit 0
fi
cat >> "\${PROD_LOG:?}"
`;

describe("문서의 단일 파편 복구 스크립트: 삭제 목록 대조", () => {
  let root;
  let bin;
  let n = 0;

  const run = ({ list, ids = "frag-1\nfrag-2\n", allowEmpty = "no", extraEnv = {}, listMode }) => {
    n += 1;
    const work    = path.join(root, `case-${n}`);
    fs.mkdirSync(work);
    const tmpdir  = path.join(work, "tmp");
    fs.mkdirSync(tmpdir);
    const listPath = path.join(work, "erased.txt");
    if (list !== null && list !== undefined) {
      fs.writeFileSync(listPath, list);
      if (listMode !== undefined) fs.chmodSync(listPath, listMode);
    }
    const script = SCRIPT
      .replace("<복구본 이름>", "dbl_1_aaaaaaaa")
      .replace("'<id1>','<id2>'", "'frag-1','frag-2'")
      .replace("<삭제 목록 파일>", listPath)
      .replace("ALLOW_EMPTY_ERASED_IDS=no", `ALLOW_EMPTY_ERASED_IDS=${allowEmpty}`);
    const scriptPath = path.join(work, "recover.sh");
    fs.writeFileSync(scriptPath, script);
    const prodLog = path.join(work, "prod.log");
    const res = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env     : { PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmpdir, PROD_LOG: prodLog, FAKE_IDS: ids, ...extraEnv }
    });
    return {
      res,
      prodWrote : fs.existsSync(prodLog) && fs.readFileSync(prodLog, "utf8").length > 0,
      leftovers : fs.readdirSync(tmpdir)
    };
  };

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ops-recover-")));
    bin  = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "psql"), FAKE_PSQL.replaceAll("\\${", "${"), { mode: 0o755 });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {});

  it("문서 스크립트는 읽기 전용 점검과 운영 쓰기를 모두 포함한다", () => {
    assert.match(SCRIPT, /ON CONFLICT DO NOTHING/);
    assert.match(SCRIPT, /^trap 'rm -rf "\$WORK"' EXIT$/m);
    assert.doesNotMatch(SCRIPT, /^\s*rm -rf "\$WORK"\s*$/m);
  });

  it("삭제 목록에 대상 id 가 있으면 운영에 쓰지 않고 중단한다", () => {
    const { res, prodWrote, leftovers } = run({ list: "other\nfrag-2\n" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /삭제 목록에 있는 id/);
    assert.equal(prodWrote, false);
    assert.deepEqual(leftovers, []);
  });

  it("목록의 CRLF 줄바꿈은 무시하고 일치로 판정한다", () => {
    const { res, prodWrote } = run({ list: "other\r\nfrag-1\r\n" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /삭제 목록에 있는 id/);
    assert.equal(prodWrote, false);
  });

  it("복구본이 CRLF 로 id 를 돌려줘도 일치로 판정한다", () => {
    const { res, prodWrote } = run({ list: "frag-1\n", ids: "frag-1\\r\\nfrag-2\\r\\n" });
    assert.equal(res.status, 1);
    assert.equal(prodWrote, false);
  });

  it("목록의 id 앞뒤 공백(스페이스, 탭)은 무시하고 일치로 판정한다", () => {
    for (const list of ["other\nfrag-2 \n", "other\n  frag-2\n", "other\n\tfrag-2\t\n", "other\r\n frag-2 \r\n"]) {
      const { res, prodWrote } = run({ list });
      assert.equal(res.status, 1, JSON.stringify(list));
      assert.match(res.stderr, /삭제 목록에 있는 id/);
      assert.equal(prodWrote, false);
    }
  });

  it("복구본이 돌려준 id 의 앞뒤 공백도 무시하고 일치로 판정한다", () => {
    const { res, prodWrote } = run({ list: "frag-2\n", ids: " frag-1\t\nfrag-2  \n" });
    assert.equal(res.status, 1);
    assert.equal(prodWrote, false);
  });

  it("공백만 있는 줄은 빈 줄로 보고, 공백이 낀 다른 id 는 일치로 보지 않는다", () => {
    const { res, prodWrote } = run({ list: "  \n\t\nfrag 2\nunrelated \n" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(prodWrote, true);
  });

  it("목록 파일이 없으면 중단한다", () => {
    const { res, prodWrote, leftovers } = run({ list: null });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /없거나 읽을 수 없다/);
    assert.equal(prodWrote, false);
    assert.deepEqual(leftovers, []);
  });

  it("읽을 수 없는 목록이면(대상 id 가 있어도) 운영에 쓰지 않고 중단한다", { skip: process.getuid && process.getuid() === 0 ? "root 는 권한 검사를 받지 않는다" : false }, () => {
    const { res, prodWrote, leftovers } = run({ list: "frag-1\n", listMode: 0o000 });
    assert.equal(res.status, 1);
    assert.equal(prodWrote, false);
    assert.deepEqual(leftovers, []);
  });

  it("빈 목록은 허용 변수가 없으면 중단한다", () => {
    for (const list of ["", "\n", "\r\n"]) {
      const { res, prodWrote } = run({ list });
      assert.equal(res.status, 1, JSON.stringify(list));
      assert.match(res.stderr, /비어 있어 중단/);
      assert.equal(prodWrote, false);
    }
  });

  it("빈 목록도 ALLOW_EMPTY_ERASED_IDS=yes 이면 진행한다", () => {
    const { res, prodWrote, leftovers } = run({ list: "", allowEmpty: "yes" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(prodWrote, true);
    assert.deepEqual(leftovers, []);
  });

  it("목록에 대상 id 가 없으면 운영에 쓰고 임시 디렉터리를 지운다", () => {
    const { res, prodWrote, leftovers } = run({ list: "unrelated\n" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(prodWrote, true);
    assert.deepEqual(leftovers, []);
  });

  it("복구본에 대상 id 가 없으면 중단한다", () => {
    const { res, prodWrote } = run({ list: "unrelated\n", ids: "" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /복구본에 대상 id 가 없어/);
    assert.equal(prodWrote, false);
  });

  it("복구본 질의가 실패하면 운영에 쓰지 않고 임시 디렉터리를 지운다", () => {
    const { res, prodWrote, leftovers } = run({ list: "unrelated\n", extraEnv: { FAKE_SCRATCH_FAIL: "1" } });
    assert.notEqual(res.status, 0);
    assert.equal(prodWrote, false);
    assert.deepEqual(leftovers, []);
  });

  it("목록 대조 도구(grep)가 실패하면 일치 없음으로 보지 않고 중단한다", () => {
    const failing = path.join(root, "bin-grep");
    fs.mkdirSync(failing, { recursive: true });
    fs.writeFileSync(path.join(failing, "grep"), "#!/usr/bin/env bash\nexit 2\n", { mode: 0o755 });
    const { res, prodWrote, leftovers } = run({ list: "frag-1\n", extraEnv: { PATH: `${failing}:${bin}:${process.env.PATH}` } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /대조에 실패해 중단/);
    assert.equal(prodWrote, false);
    assert.deepEqual(leftovers, []);
  });
});
