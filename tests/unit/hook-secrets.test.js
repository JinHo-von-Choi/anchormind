/**
 * 훅 회고 접수의 비밀 노출 시험(stub 의존성)
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 합성 비밀 표(AWS 키와 비밀 키, PEM 개인 키, JWT, GitHub 토큰, 환경 변수 덤프, DB 접속 URL, 검증 자릿수가 맞는
 * 주민등록번호, 카드 번호 등)를 발췌의 마지막 응답 블록과 앞 블록에 넣어 보내고, 원문이 outbox payload, 응답 본문,
 * 콘솔 로그, 지표 출력 어디에도 나타나지 않는지 본다. 기록 단계가 내용을 담은 오류를 던지는 경우의 로그도 본다.
 */

import { describe, it, before, after } from "node:test";
import assert                          from "node:assert/strict";
import http                            from "node:http";

import { createHookHandler } from "../../lib/handlers/hook-handler.js";
import { RateLimiter }       from "../../lib/rate-limiter.js";
import { register }          from "../../lib/metrics.js";

const rep = (s, n) => s.repeat(n);

/** 앞 12자리로 검증 자릿수를 계산한 주민등록번호 */
function rrn(first12) {
  const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum     = [...first12].reduce((acc, ch, i) => acc + Number(ch) * weights[i], 0);
  const digits  = `${first12}${(11 - (sum % 11)) % 10}`;
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

/** [이름, 본문에 넣을 문장, 어디에도 나타나면 안 되는 원문 조각들] */
const SECRETS = [
  ["AWS 접근 키", `AKIA${rep("Q7", 8)} 를 썼다`, [`AKIA${rep("Q7", 8)}`]],
  ["AWS 비밀 키 대입", `aws_secret_access_key=${rep("wJalrXUt", 5)}`, [rep("wJalrXUt", 5)]],
  ["AWS 자격 증명 파일", `[default]\naws_access_key_id = AKIA${rep("Z3", 8)}\naws_secret_access_key = ${rep("K7MD/ENG", 5)}`,
    [`AKIA${rep("Z3", 8)}`, rep("K7MD/ENG", 5)]],
  ["PEM 개인 키", `-----BEGIN RSA PRIVATE KEY-----\n${rep("MIIEpAIBAAKCAQEA", 4)}\n${rep("q9Zx", 16)}\n-----END RSA PRIVATE KEY-----`,
    [rep("MIIEpAIBAAKCAQEA", 4), rep("q9Zx", 16)]],
  ["OpenSSH 개인 키", `-----BEGIN OPENSSH PRIVATE KEY-----\n${rep("b3BlbnNzaC1rZXk", 4)}\n-----END OPENSSH PRIVATE KEY-----`,
    [rep("b3BlbnNzaC1rZXk", 4)]],
  ["JWT", `토큰 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIn0.${rep("sIgN", 8)}`, [`eyJzdWIiOiJ1c2VyLTQyIn0.${rep("sIgN", 8)}`]],
  ["GitHub 개인 토큰", `ghp_${rep("a1B2c3", 6)}`, [`ghp_${rep("a1B2c3", 6)}`]],
  ["GitHub 세분 토큰", `github_pat_${rep("11AB", 6)}_${rep("cd34", 10)}`, [`github_pat_${rep("11AB", 6)}`]],
  ["환경 변수 덤프", [
    `OPENAI_API_KEY=sk-proj-${rep("Xy12", 10)}`,
    `ANTHROPIC_API_KEY=sk-ant-api03-${rep("Ab9_", 10)}`,
    `STRIPE_SECRET_KEY=sk_live_${rep("4eC3", 6)}`,
    `GITLAB_TOKEN=glpat-${rep("x9Y8", 6)}`,
    `NPM_TOKEN=npm_${rep("a1B2c3", 6)}`,
    `SLACK_BOT_TOKEN=xoxb-${rep("1", 12)}-${rep("aB3", 8)}`,
    "SESSION_SECRET=3f9a8b7c6d5e4f3a2b1c",
    "JWT_SIGNING_KEY_BASE64=TWVtZW50b1NpZ25pbmdLZXkx"
  ].join("\n"), [rep("Xy12", 10), rep("Ab9_", 10), rep("4eC3", 6), rep("x9Y8", 6), rep("a1B2c3", 6), rep("aB3", 8), "3f9a8b7c6d5e4f3a2b1c"]],
  ["DB URL(IP 주소)", "DATABASE_URL=postgresql://app:Sup3rS3cret!@192.0.2.40:5432/prod", ["Sup3rS3cret!"]],
  ["DB URL(비밀번호에 @)", "mysql://root:p@ss#w0rd@db.example.com:3306/app", ["p@ss#w0rd", "ss#w0rd"]],
  ["Redis URL", "redis://default:R3d1sPassw0rd@cache.example.net:6379/0", ["R3d1sPassw0rd"]],
  ["mmcp 키", `MEMENTO_CLI_KEY=mmcp_${rep("k3y", 10)}`, [`mmcp_${rep("k3y", 10)}`]],
  ["Bearer 헤더", `Authorization: Bearer ${rep("t0k3n", 6)}`, [rep("t0k3n", 6)]],
  ["주민등록번호", `주민번호 ${rrn("850315223456")} 확인`, [rrn("850315223456"), rrn("850315223456").replace("-", "")]],
  ["카드 번호(구분자)", "카드 4111 1111 1111 1111 결제", ["4111 1111 1111 1111"]],
  ["카드 번호(연속)", "visa 5555555555554444 로 결제", ["5555555555554444"]],
  ["비밀번호 필드", "password: Tr0ub4dor&3", ["Tr0ub4dor&3"]]
];

let server;
let baseUrl;
let enqueued;
let failEnqueue = false;

before(async () => {
  const handler = createHookHandler({
    enabled              : () => true,
    authenticate         : async () => ({ valid: true, keyId: "key-1", permissions: ["read", "write"] }),
    authUnavailableStatus: () => 401,
    allowedWorkspaces    : async () => null,
    admission            : async () => ({ seen: false, pending: 0 }),
    enqueue              : async (event) => {
      if (failEnqueue) throw new Error(`insert failed: ${JSON.stringify(event)} ${event.payload.summary}`);
      enqueued.push(event);
      return { id: "1" };
    },
    scanMode             : () => "mask",
    limiters             : {
      key    : new RateLimiter({ windowMs: 60_000, maxRequests: 1e6 }),
      failure: new RateLimiter({ windowMs: 60_000, maxRequests: 1e6 })
    }
  });
  server = http.createServer((req, res) => handler(req, res, { pathname: new URL(req.url, "http://localhost").pathname }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

/** 콘솔 출력을 모으며 요청을 보낸다. */
async function postCapturingLogs(path, body) {
  const captured = [];
  const writes   = [process.stdout.write, process.stderr.write];
  process.stdout.write = function capture(chunk, ...rest) { captured.push(String(chunk)); return writes[0].call(this, chunk, ...rest); };
  process.stderr.write = function capture(chunk, ...rest) { captured.push(String(chunk)); return writes[1].call(this, chunk, ...rest); };
  try {
    const res  = await fetch(`${baseUrl}${path}`, {
      method : "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body   : JSON.stringify(body)
    });
    const text = await res.text();
    await new Promise(resolve => setImmediate(resolve));
    return { status: res.status, text, logs: captured.join("") };
  } finally {
    [process.stdout.write, process.stderr.write] = writes;
  }
}

describe("비밀 원문이 outbox payload, 응답, 로그, 지표에 남지 않는다", () => {
  for (const [name, sentence, raws] of SECRETS) {
    for (const where of ["마지막 응답 블록", "앞 블록"]) {
      it(`${name}: ${where}`, async () => {
        enqueued = [];
        const excerpt = where === "마지막 응답 블록"
          ? `[user]\n설정을 정리해 줘\n\n[assistant]\n정리했다.\n${sentence}\n끝.`
          : `[user]\n${sentence}\n\n[assistant]\n설정 정리를 마쳤다`;
        const r = await postCapturingLogs("/hooks/codex/SessionEnd", { session_id: `s-${name.length}-${where.length}`, excerpt });
        assert.equal(r.status, 202, r.text);
        const stored  = JSON.stringify(enqueued);
        const metrics = await register.metrics();
        for (const raw of raws) {
          assert.ok(!stored.includes(raw), `outbox payload에 원문: ${raw.slice(0, 12)}`);
          assert.ok(!r.text.includes(raw), "응답 본문에 원문");
          assert.ok(!r.logs.includes(raw), "로그에 원문");
          assert.ok(!metrics.includes(raw), "지표에 원문");
        }
      });
    }
  }

  it("기록 단계가 내용을 담은 오류를 던져도 로그와 응답에는 원문이 없다", async () => {
    failEnqueue = true;
    try {
      const all     = SECRETS.map(([, sentence]) => sentence).join("\n");
      const r       = await postCapturingLogs("/hooks/codex/Stop", { session_id: "s-error", excerpt: `[assistant]\n${all}` });
      assert.equal(r.status, 500);
      for (const [, , raws] of SECRETS) {
        for (const raw of raws) {
          assert.ok(!r.logs.includes(raw), `로그에 원문: ${raw.slice(0, 12)}`);
          assert.ok(!r.text.includes(raw));
        }
      }
    } finally {
      failEnqueue = false;
    }
  });

  it("저장되는 요약 후보는 마지막 응답 블록의 1000자 이하이고 앞 블록 내용은 저장하지 않는다", async () => {
    enqueued = [];
    const r = await postCapturingLogs("/hooks/codex/Stop", {
      session_id: "s-bound", excerpt: `[user]\n${"앞 블록 내용 ".repeat(2000)}\n\n[assistant]\n${"결과 ".repeat(800)}`
    });
    assert.equal(r.status, 202);
    const payload = enqueued[0].payload;
    assert.ok([...payload.summary].length <= 1000);
    assert.ok(!payload.summary.includes("앞 블록"));
    assert.ok(JSON.stringify(payload).length < 2000);
  });
});
