/**
 * Winston Logger 설정
 *
 * 작성자: 최진호
 * 작성일: 2026-02-12
 *
 * 기능:
 * - 로그 레벨별 파일 분리
 * - 일별 로그 로테이션
 * - 파일 크기 제한 (20MB)
 * - 최대 보관 기간 (30일)
 * - 개발/프로덕션 환경별 설정
 */

import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import { mkdirSync } from "fs";
import { LOG_DIR, logToStderr } from "./config.js";
import { patternsFor } from "./security/sensitivePatterns.js";

// ---------------------------------------------------------------------------
// 민감 데이터 패턴 정의
// ---------------------------------------------------------------------------

/**
 * 로그 마스킹 패턴. 저장 경로 마스킹과 같은 표(lib/security/sensitivePatterns.js)에서 로그용 항목을 가져온다.
 * Authorization 헤더, 값만 있는 Bearer, mmcp_session 쿠키, mmcp_ 키, OAuth 파라미터 항목이 표의 앞쪽에
 * 같은 순서로 있고, 그 뒤에 저장 경로와 공용인 토큰 항목이 이어진다.
 */
export const REDACT_PATTERNS = patternsFor("log").map(({ pattern, log }) => ({ pattern, replacement: log }));

const CONTENT_MAX_LEN  = 200;
const CONTENT_HEAD_LEN = 50;
const CONTENT_TAIL_LEN = 50;

/**
 * 문자열에서 민감 패턴을 마스킹한다.
 * @param {string} str
 * @returns {string}
 */
export function redactString(str) {
  let result = str;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * 긴 content 필드를 head + ...[REDACTED]... + tail 형태로 트리밍한다.
 * @param {string} content
 * @returns {string}
 */
function truncateContent(content) {
  if (typeof content !== "string" || content.length <= CONTENT_MAX_LEN) return content;
  const head = content.slice(0, CONTENT_HEAD_LEN);
  const tail = content.slice(-CONTENT_TAIL_LEN);
  return `${head}...[REDACTED]...${tail}`;
}

/**
 * 임의 값(객체/배열/원시)을 재귀적으로 순회하며 민감 데이터를 마스킹한다.
 * 원본 객체를 변경하지 않고 새 객체를 반환한다.
 *
 * @param {*} value
 * @param {number} [depth=0]
 * @returns {*}
 */
function redactValue(value, depth = 0) {
  if (depth > 8) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      /** content 필드는 길이 초과 시 트리밍 후 마스킹 */
      if (key === "content" && typeof val === "string") {
        result[key] = redactString(truncateContent(val));
      } else {
        result[key] = redactValue(val, depth + 1);
      }
    }
    return result;
  }

  return value;
}

/**
 * Winston custom format: 로그 메타데이터와 메시지에서 민감 데이터를 마스킹한다.
 */
export const redactorFormat = winston.format((info) => {
  /** message 필드 마스킹 */
  if (typeof info.message === "string") {
    info.message = redactString(info.message);
  }

  /** 나머지 메타 필드 마스킹 (level, timestamp, stack 등 제외) */
  const skipKeys = new Set(["level", "timestamp", "stack", "message", Symbol.for("level"), Symbol.for("splat")]);

  for (const key of Object.keys(info)) {
    if (skipKeys.has(key)) continue;
    /** content 최상위 필드: 길이 초과 시 트리밍 후 마스킹 */
    if (key === "content" && typeof info[key] === "string") {
      info[key] = redactString(truncateContent(info[key]));
    } else {
      info[key] = redactValue(info[key]);
    }
  }

  return info;
});

let fileTransportsAvailable = true;
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  fileTransportsAvailable = false;
  console.warn(`[Logger] Log directory "${LOG_DIR}" unavailable (${err.code}), file logging disabled`);
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

/** 로그 포맷 */
const logFormat = printf(({ level, message, timestamp, stack }) => {
  if (stack) {
    return `${timestamp} [${level}]: ${message}\n${stack}`;
  }
  return `${timestamp} [${level}]: ${message}`;
});

/** 환경 감지 */
const isDevelopment = process.env.NODE_ENV !== "production";

/** 로그 레벨 */
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info");

/**
 * 콘솔 transport가 표준 오류로 보낼 수준 목록. toStderr이면 모든 수준을 표준 오류로 보낸다.
 *
 * @param {boolean} toStderr
 * @returns {string[]}
 */
export function consoleStderrLevels(toStderr) {
  return toStderr ? Object.keys(winston.config.npm.levels) : [];
}

/** Winston Logger 생성 */
export const logger = winston.createLogger({
  level: logLevel,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    redactorFormat()
  ),
  transports: [
    /** 콘솔 출력 (항상 활성화, 개발 환경에서 colorize) */
    new winston.transports.Console({
      format: isDevelopment
        ? combine(colorize(), logFormat)
        : logFormat,
      stderrLevels: consoleStderrLevels(logToStderr())
    }),

    /** Error 로그 (일별 로테이션) */
    ...(fileTransportsAvailable ? [new DailyRotateFile({
      filename: path.join(LOG_DIR, "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      level: "error",
      format: logFormat,
      maxSize: "20m",
      maxFiles: "30d",
      zippedArchive: true
    })] : []),

    /** Combined 로그 (일별 로테이션) */
    ...(fileTransportsAvailable ? [new DailyRotateFile({
      filename: path.join(LOG_DIR, "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      format: logFormat,
      maxSize: "20m",
      maxFiles: "30d",
      zippedArchive: true
    })] : []),

    /** Agent 로그 (일별 로테이션) */
    ...(fileTransportsAvailable ? [new DailyRotateFile({
      filename: path.join(LOG_DIR, "agent-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      format: logFormat,
      maxSize: "20m",
      maxFiles: "30d",
      zippedArchive: true,
      level: "info"
    })] : [])
  ],
  exceptionHandlers: [
    ...(fileTransportsAvailable ? [new DailyRotateFile({
      filename: path.join(LOG_DIR, "exceptions-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "30d"
    })] : [])
  ],
  rejectionHandlers: [
    ...(fileTransportsAvailable ? [new DailyRotateFile({
      filename: path.join(LOG_DIR, "rejections-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "30d"
    })] : [])
  ]
});

/** 로그 디렉토리 생성 확인 */
logger.on("error", (error) => {
  console.error("Logger error:", error);
});

/** 로거 초기화 메시지 */
logger.info("Winston logger initialized", {
  level: logLevel,
  environment: isDevelopment ? "development" : "production",
  logDir: LOG_DIR
});

/** 로그 헬퍼 함수 */
export function logInfo(message, meta = {}) {
  logger.info(message, meta);
}

export function logWarn(message, meta = {}) {
  logger.warn(message, meta);
}

export function logError(message, error = null, meta = {}) {
  if (error) {
    logger.error(message, {
      error  : error.name,
      message: error.message,
      stack  : error.stack,
      ...meta
    });
  } else {
    logger.error(message, meta);
  }
}

export function logDebug(message, meta = {}) {
  logger.debug(message, meta);
}

/** 도구 실행 로깅 */
export function logToolExecution(toolName, params, result, duration) {
  logger.info("Tool Execution", {
    tool    : toolName,
    params  : sanitizeParams(params),
    success : !result.error,
    duration: `${duration}ms`
  });
}

/** 민감 정보 제거 */
function sanitizeParams(params) {
  const sanitized      = { ...params };

  // 민감한 필드 마스킹
  const sensitiveFields = ["password", "accessKey", "token", "secret"];

  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = "***REDACTED***";
    }
  }

  return sanitized;
}

/** 종료 시 로그 플러시 */
export async function closeLogger() {
  return new Promise((resolve) => {
    logger.end(() => {
      console.log("Logger closed");
      resolve();
    });
  });
}

export default logger;
