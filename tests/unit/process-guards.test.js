/**
 * process-guards 단위 테스트
 *
 * 작성자: 최진호
 * 작성일: 2026-07-14
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installProcessGuards } from "../../lib/process-guards.js";

test("unhandledRejection은 logError만 호출하고 onFatal은 호출하지 않는다", () => {
  const proc = new EventEmitter();
  const logs = [];
  let   fatalCalls = 0;
  installProcessGuards({
    proc,
    logError: (msg, meta) => logs.push({ msg, meta }),
    onFatal:  () => { fatalCalls++; }
  });

  proc.emit("unhandledRejection", new Error("boom"), Promise.resolve());

  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /Unhandled promise rejection/);
  assert.equal(logs[0].meta.error, "boom");
  assert.equal(fatalCalls, 0);
});

test("unhandledRejection의 non-Error reason도 문자열로 기록한다", () => {
  const proc = new EventEmitter();
  const logs = [];
  installProcessGuards({
    proc,
    logError: (msg, meta) => logs.push({ msg, meta }),
    onFatal:  () => {}
  });

  proc.emit("unhandledRejection", "plain string reason", Promise.resolve());

  assert.equal(logs.length, 1);
  assert.equal(logs[0].meta.error, "plain string reason");
});

test("uncaughtException은 logError 후 onFatal을 1회 호출한다", () => {
  const proc = new EventEmitter();
  const logs = [];
  const fatalErrors = [];
  installProcessGuards({
    proc,
    logError: (msg, meta) => logs.push({ msg, meta }),
    onFatal:  (err) => fatalErrors.push(err)
  });

  const err = new Error("fatal");
  proc.emit("uncaughtException", err);

  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /Uncaught exception/);
  assert.equal(fatalErrors.length, 1);
  assert.equal(fatalErrors[0], err);
});

test("두 번째 uncaughtException은 로그만 남기고 onFatal을 재호출하지 않는다", () => {
  const proc = new EventEmitter();
  const logs = [];
  let   fatalCalls = 0;
  installProcessGuards({
    proc,
    logError: (msg, meta) => logs.push({ msg, meta }),
    onFatal:  () => { fatalCalls++; }
  });

  proc.emit("uncaughtException", new Error("first"));
  proc.emit("uncaughtException", new Error("second"));

  assert.equal(logs.length, 2);
  assert.equal(fatalCalls, 1);
});
