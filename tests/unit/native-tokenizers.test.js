import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const nativeBuilt = existsSync(new URL("native/tokenizers.node", root));

function inProcess(code, tokenCounter = "native", garuBackend = "native") {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: {
      ...process.env,
      MEMENTO_TOKEN_COUNTER: tokenCounter,
      MEMENTO_GARU_BACKEND: garuBackend,
      MEMENTO_LOG_STDERR: "true"
    },
    encoding: "utf8",
    timeout: 60_000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const SHARED = `
  import assert from 'node:assert/strict';
  import { encodingForModel } from 'js-tiktoken';
  import { register } from './lib/metrics.js';
  import { countTokens, countTokenPieces, fragmentTokens } from './lib/memory/write/FragmentFactory.js';
  import { tokenizeLocal, extractProperNounTokens } from './lib/memory/embedding/MorphemeTokenizer.js';
  const encoder = encodingForModel('gpt-4');
  const jsCount = text => encoder.encode(text, [], []).length;
  const active = async () => Object.fromEntries(
    (await register.getSingleMetric('memento_tokenizer_native_active').get())
      .values.map(({ labels, value }) => [labels.tokenizer, value]));
  const fallback = async () => (await register.getSingleMetric('memento_tokenizer_fallback_total').get()).values;
`;

test("기본 경로는 네이티브 모듈을 적재하지 않는다", () => {
  inProcess(`${SHARED}
    assert.equal(countTokens('hello world'), 2);
    assert.ok((await tokenizeLocal('한국어 형태소 분석')).includes('한국어'));
    assert.deepEqual(await active(), { cl100k: 0, garu: 0 });
    assert.deepEqual(await fallback(), []);
  `, "js", "wasm");
});

test("네이티브 모듈이 없으면 프로세스마다 한 번 폴백을 집계한다", () => {
  inProcess(`${SHARED}
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('/tokenizers.node')) {
        throw Object.assign(new Error('missing test addon'), { code: 'MODULE_NOT_FOUND' });
      }
      return nextResolve(specifier, context);
    }});
    for (let i = 0; i < 2; i++) {
      assert.equal(countTokens('한글 <|endoftext|>'), jsCount('한글 <|endoftext|>'));
      assert.ok((await tokenizeLocal('한국어 형태소 분석')).includes('한국어'));
    }
    assert.deepEqual(await active(), { cl100k: 0, garu: 0 });
    for (const tokenizer of ['cl100k', 'garu']) {
      assert.equal((await fallback()).find(x => x.labels.tokenizer === tokenizer && x.labels.reason === 'missing')?.value, 1);
    }
  `);
});

test("선택과 입력별 호출 실패를 구분해 집계한다", () => {
  inProcess(`${SHARED}
    import { selectNativeTokenizer, runNativeTokenizer } from './lib/native-tokenizers.js';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('/tokenizers.node')) {
        return nextResolve('node:assert', context);
      }
      return nextResolve(specifier, context);
    }});
    assert.equal(selectNativeTokenizer('cl100k', () => null), null);
    assert.equal(selectNativeTokenizer('cl100k', () => { throw new Error(); }), null);
    const run = selectNativeTokenizer('cl100k', () => text => {
      if (!text) throw new Error();
      return 3;
    });
    assert.equal(runNativeTokenizer('cl100k', run, ''), undefined);
    assert.equal(runNativeTokenizer('cl100k', run, '다음 요청'), 3);
    assert.deepEqual(await active(), { cl100k: 1, garu: 0 });
    assert.deepEqual((await fallback()).map(({ labels, value }) => [labels.reason, value]),
      [['mismatch', 1], ['initialize', 1], ['call', 1]]);
  `);
});

test("실제 네이티브 모듈의 토큰 수, 저장된 값, 토큰 순서가 기존과 일치한다", { skip: !nativeBuilt }, () => {
  inProcess(`${SHARED}
    import { readFileSync } from 'node:fs';
    import { createRequire } from 'node:module';
    import { Garu } from 'garu-ko';
    const addon = createRequire(import.meta.url)('./native/tokenizers.node');
    const baseline = await Garu.load();
    const native = new addon.GaruTokenizer(readFileSync('./node_modules/garu-ko/models/base.gmdl'));
    const fixture = readFileSync('./tests/fixtures/recall-goldset.jsonl', 'utf8').trim().split('\\n');
    const corpus = fixture.map(line => JSON.parse(line)).flatMap(row => [row.store, row.query]);
    const edge = ['', '👩🏻‍💻', '\\n\\r\\r   x', 'x\\u0085\\uFEFFx', '한글\\ud800끝', '\\udc00', 'ㅎㅏㄴㄱㅡㄹ',
      '<|endoftext|> <|fim_prefix|>', '日本語かな SQL', '한글 é é', "it's WE'LL",
      ' \\u0085x', ' \\uFEFF𐀀', '\\t\\t\\u0085'];
    for (const [i, piece] of edge.entries()) {
      corpus.push(piece, edge.slice(i).join(piece));
    }
    corpus.push(edge.join(' ').repeat(25), 'x'.repeat(4_000));
    for (const text of corpus) {
      const expected = jsCount(text);
      assert.equal(countTokens(text), expected);
      assert.ok(countTokenPieces(text) <= expected);
      assert.equal(fragmentTokens({ content: text, estimated_tokens: 0 }), expected);
      assert.equal(fragmentTokens({ content: text, estimated_tokens: null }), expected);
      assert.equal(fragmentTokens({ content: text, estimated_tokens: 12345 }), 12345);
      if (text.length <= 300) assert.deepEqual(native.tokenize(text), baseline.tokenize(text));
    }
    assert.ok((await tokenizeLocal('한국어 형태소 분석')).includes('한국어'));
    const proper = baseline.analyze('최민수는 서울에서 일한다.').tokens
      .filter(t => ['NNP', 'SL', 'SH'].includes(t.pos)).map(t => t.text);
    assert.deepEqual(await extractProperNounTokens('최민수는 서울에서 일한다.'), proper);
    assert.deepEqual(await active(), { cl100k: 1, garu: 1 });
    assert.deepEqual(await fallback(), []);
  `);
});

test("예산 경계에서 고른 파편과 답변 팩 크기가 기존 경로와 일치한다", { skip: !nativeBuilt }, () => {
  const fixture = `${SHARED}
    import { selectForRecall } from './lib/memory/read/BudgetSelector.js';
    import { buildAnswerPack } from './lib/memory/read/AnswerPack.js';
    const pool = [
      { id: 'a', content: '한글 보고서 👩🏻‍💻 <|endoftext|>', type: 'fact', estimated_tokens: null },
      { id: 'b', content: 'readFileSync를 써서 설정을 읽는다.', type: 'procedure', estimated_tokens: 10 },
      { id: 'c', content: '한국어 검색\\n\\n설정', type: 'decision', estimated_tokens: 0 },
    ];
    const utilityOf = f => ({ a: 3, b: 2, c: 1 })[f.id];
    const results = [5, 10, 18, 24, 60].map(budget => {
      const { selectedIds, tokens } = selectForRecall(pool, { budget, utilityOf, baselineIds: new Set(['a']) });
      return [[...selectedIds], tokens];
    });
    const pack = buildAnswerPack(pool, { countTokens });
    console.log(JSON.stringify({ results, pack: pack.estimatedTokens }));
  `;
  assert.equal(inProcess(fixture, "js", "wasm"), inProcess(fixture, "native", "wasm"));
});
