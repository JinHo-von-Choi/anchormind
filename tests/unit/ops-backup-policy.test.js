/**
 * 백업 보관 정책 순수 함수 시험
 *
 * 파일 이름 해석, 보관 일수에 따른 삭제 대상 선정, 저장소 안쪽 경로 거부를
 * DB와 pg_dump 없이 확인한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import fs                              from "node:fs";
import os                              from "node:os";
import path                            from "node:path";

import {
  BackupPolicyError, parseBackupFile, selectExpired, assertOutsideRepo, resolveReal, backupSet, main
} from "../../scripts/ops/backup-policy.mjs";

/** 한 번의 백업이 만드는 파일 묶음. */
const setOf = (stamp, kinds = ["dump", "dump.sha256", "counts.json", "roles.sql"]) =>
  kinds.map(kind => `memento-${stamp}.${kind}`);

describe("백업 파일 이름 해석", () => {
  it("관리 대상 파일은 시각과 종류를 돌려준다", () => {
    assert.deepEqual(parseBackupFile("memento-20261003T031500Z.dump"), {
      stamp: "20261003T031500Z", day: "20261003", kind: "dump"
    });
    assert.equal(parseBackupFile("memento-20261003T031500Z.dump.sha256").kind, "dump.sha256");
    assert.equal(parseBackupFile("memento-20261003T031500Z.counts.json").kind, "counts.json");
    assert.equal(parseBackupFile("memento-20261003T031500Z.roles.sql").kind, "roles.sql");
  });

  for (const name of [
    "notes.txt", ".backup.lock", "memento-20261003T031500Z.dump.partial", "memento-2026.dump",
    "memento-20261003T031500Z.dump.gpg", "x/memento-20261003T031500Z.dump", "memento-20261003T031500Z.dump\n"
  ]) {
    it(`관리 대상이 아닌 이름 ${JSON.stringify(name)} 은 null이다`, () => {
      assert.equal(parseBackupFile(name), null);
    });
  }
});

describe("보관 일수에 따른 삭제 대상", () => {
  it("보관 일수 안의 묶음은 지우지 않는다", () => {
    const names = [...setOf("20261001T030000Z"), ...setOf("20261002T030000Z"), ...setOf("20261003T030000Z")];
    assert.deepEqual(selectExpired(names, 3), []);
  });

  it("보관 일수를 넘긴 가장 오래된 날의 묶음 전체를 지운다", () => {
    const names = [...setOf("20261001T030000Z"), ...setOf("20261002T030000Z"), ...setOf("20261003T030000Z")];
    assert.deepEqual(selectExpired(names, 2), setOf("20261001T030000Z").sort());
  });

  it("같은 날 여러 번 만든 묶음은 그날 가장 늦은 것만 남긴다", () => {
    const names = [...setOf("20261003T010000Z"), ...setOf("20261003T150000Z"), ...setOf("20261002T030000Z")];
    assert.deepEqual(selectExpired(names, 2), setOf("20261003T010000Z").sort());
  });

  it("서로 떨어진 날짜도 날짜 수로 센다", () => {
    const names = [...setOf("20260901T030000Z"), ...setOf("20261003T030000Z")];
    assert.deepEqual(selectExpired(names, 2), []);
    assert.deepEqual(selectExpired(names, 1), setOf("20260901T030000Z").sort());
  });

  it("덤프 파일이 없는 묶음은 보관 일수에 들지 않고 삭제 대상이다", () => {
    const orphan = setOf("20261003T030000Z", ["dump.sha256", "counts.json"]);
    const names  = [...setOf("20261002T030000Z"), ...orphan];
    assert.deepEqual(selectExpired(names, 1), orphan.sort());
  });

  it("관리 대상이 아닌 이름은 결과에 나타나지 않는다", () => {
    const names = [...setOf("20261001T030000Z"), ...setOf("20261003T030000Z"), "notes.txt", ".backup.lock", "keep.dump"];
    const out   = selectExpired(names, 1);
    assert.deepEqual(out, setOf("20261001T030000Z").sort());
  });

  it("입력 순서와 무관하게 정렬된 같은 결과를 돌려준다", () => {
    const names = [...setOf("20261001T030000Z"), ...setOf("20261002T030000Z"), ...setOf("20261003T030000Z")];
    assert.deepEqual(selectExpired([...names].reverse(), 1), selectExpired(names, 1));
  });

  it("입력 배열을 바꾸지 않는다", () => {
    const names = setOf("20261001T030000Z");
    const copy  = [...names];
    selectExpired(names, 1);
    assert.deepEqual(names, copy);
  });

  for (const bad of [0, -1, 1.5, "7", NaN, undefined, null]) {
    it(`보관 일수 ${String(bad)} 는 거부한다`, () => {
      assert.throws(() => selectExpired(setOf("20261003T030000Z"), bad), BackupPolicyError);
    });
  }
});

describe("한 번의 백업 묶음 파일 이름", () => {
  it("시각에서 네 파일 이름을 만든다", () => {
    assert.deepEqual(backupSet("20261003T031500Z"), {
      dump  : "memento-20261003T031500Z.dump",
      sha256: "memento-20261003T031500Z.dump.sha256",
      counts: "memento-20261003T031500Z.counts.json",
      roles : "memento-20261003T031500Z.roles.sql"
    });
  });

  it("형식이 아닌 시각은 거부한다", () => {
    assert.throws(() => backupSet("2026-10-03"), BackupPolicyError);
    assert.throws(() => backupSet("20261003T031500Z/../x"), BackupPolicyError);
  });

  it("만든 이름은 모두 관리 대상으로 해석된다", () => {
    for (const name of Object.values(backupSet("20261003T031500Z"))) {
      assert.equal(parseBackupFile(name).stamp, "20261003T031500Z");
    }
  });
});

describe("저장소 안쪽 경로 거부", () => {
  const repo = "/srv/work/repo";
  const same = (p) => p;

  it("저장소 밖 경로는 그대로 돌려준다", () => {
    assert.equal(assertOutsideRepo("/var/backups/memento", repo, same), "/var/backups/memento");
    assert.equal(assertOutsideRepo("/srv/work/repo-backups", repo, same), "/srv/work/repo-backups");
    assert.equal(assertOutsideRepo("/srv/work", repo, same), "/srv/work");
  });

  for (const dest of ["/srv/work/repo", "/srv/work/repo/", "/srv/work/repo/backups", "/srv/work/repo/a/b/c", "/srv/work/repo/../repo/x"]) {
    it(`저장소 안쪽 ${dest} 는 경로를 담아 거부한다`, () => {
      assert.throws(
        () => assertOutsideRepo(dest, repo, path.resolve),
        (err) => err instanceof BackupPolicyError && err.message.includes("/srv/work/repo")
      );
    });
  }

  it("빈 경로와 상대 경로가 아닌 값은 거부한다", () => {
    assert.throws(() => assertOutsideRepo("", repo, same), BackupPolicyError);
    assert.throws(() => assertOutsideRepo(undefined, repo, same), BackupPolicyError);
  });
});

describe("저장소 안쪽 경로 거부의 실제 경로 해석", () => {
  let tmp;
  let repo;

  before(() => {
    tmp  = fs.mkdtempSync(path.join(os.tmpdir(), "ops-policy-"));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "inner"), { recursive: true });
    fs.symlinkSync(path.join(repo, "inner"), path.join(tmp, "link-to-inner"));
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("저장소 안쪽을 가리키는 심볼릭 링크 경유 경로는 거부한다", () => {
    assert.throws(() => assertOutsideRepo(path.join(tmp, "link-to-inner", "out"), repo), BackupPolicyError);
  });

  it("아직 없는 하위 경로도 존재하는 상위 경로 기준으로 판정한다", () => {
    assert.throws(() => assertOutsideRepo(path.join(repo, "not", "yet", "there"), repo), BackupPolicyError);
    assert.equal(
      assertOutsideRepo(path.join(tmp, "elsewhere", "dumps"), repo),
      path.join(fs.realpathSync(tmp), "elsewhere", "dumps")
    );
  });

  it("resolveReal은 존재하지 않는 꼬리를 그대로 붙인다", () => {
    assert.equal(resolveReal(path.join(tmp, "a", "b")), path.join(fs.realpathSync(tmp), "a", "b"));
  });
});

describe("명령줄 진입점", () => {
  let tmp;
  const collect = () => {
    const lines = [];
    return { lines, io: { out: (line) => lines.push(line) } };
  };

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-policy-main-"));
    for (const name of [...setOf("20261001T030000Z"), ...setOf("20261002T030000Z")]) fs.writeFileSync(path.join(tmp, name), "x");
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("expire는 삭제 대상 이름만 한 줄씩 낸다", () => {
    const { lines, io } = collect();
    main(["expire", tmp, "1"], io);
    assert.deepEqual(lines, setOf("20261001T030000Z").sort());
  });

  it("expire에 시각을 주면 그 시각의 새 벌을 포함해 고르고 새 벌의 이름은 내지 않는다", () => {
    const { lines, io } = collect();
    main(["expire", tmp, "1", "20261003T030000Z"], io);
    assert.deepEqual(lines, [...setOf("20261001T030000Z"), ...setOf("20261002T030000Z")].sort());
  });

  it("없는 저장 위치는 삭제 대상 없음이다", () => {
    const { lines, io } = collect();
    main(["expire", path.join(tmp, "missing"), "3"], io);
    assert.deepEqual(lines, []);
  });

  it("보관 일수가 정수가 아니거나 명령이 틀리면 거부한다", () => {
    assert.throws(() => main(["expire", tmp, "x"], collect().io), BackupPolicyError);
    assert.throws(() => main(["expire", tmp, "1.5"], collect().io), BackupPolicyError);
    assert.throws(() => main(["unknown"], collect().io), BackupPolicyError);
  });

  it("set은 네 파일 이름을 낸다", () => {
    const { lines, io } = collect();
    main(["set", "20261003T031500Z"], io);
    assert.deepEqual(lines, Object.values(backupSet("20261003T031500Z")));
  });

  it("guard는 저장소 안쪽 경로를 거부하고 밖의 경로는 해석된 경로를 낸다", () => {
    assert.throws(() => main(["guard", path.join(process.cwd(), "backups")], collect().io), BackupPolicyError);
    const { lines, io } = collect();
    main(["guard", path.join(tmp, "dumps")], io);
    assert.deepEqual(lines, [path.join(fs.realpathSync(tmp), "dumps")]);
  });
});
