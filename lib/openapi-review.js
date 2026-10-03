/**
 * OpenAPI 문서의 검토 대기열 관리 경로
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * lib/admin/admin-review.js의 세 라우트(GET /review, POST /review/:id/approve, /reject)를 OpenAPI 경로 객체로
 * 만든다. lib/openapi.js가 관리 경로에 합친다.
 */

/** 결정 요청 본문 */
const DECISION_BODY = {
  required: false,
  content : {
    "application/json": {
      schema: {
        type      : "object",
        properties: {
          note          : { type: "string", maxLength: 500 },
          idempotencyKey: { type: "string", maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
          applyAnchor   : { type: "boolean", description: "보류한 앵커 지정 요청의 적용 여부. 무권한 앵커 요청은 true일 때만 적용" }
        },
        additionalProperties: false
      }
    }
  }
};

/** 결정 응답 */
const DECISION_RESPONSES = {
  200: { description: "결정 결과(decisionId, fragmentId, decision, reviewer, keyId, decidedAt, replayed, anchorApplied, anchorReason)" },
  400: { description: "잘못된 본문(field)" },
  404: { description: "Fragment not found" },
  409: { description: "검토 대기가 아니거나(state) 다른 결정에 쓰인 멱등 키(field: idempotencyKey)" }
};

/**
 * @param {string} b - 관리 API 기준 경로
 * @param {{bearerAuth: Array}} bearer - 보안 요구 객체
 * @returns {Object}
 */
export function buildAdminReviewPaths(b, bearer) {
  const idParam  = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
  const decision = (summary, operationId) => ({
    post: { summary, operationId, security: [bearer], parameters: idParam, requestBody: DECISION_BODY, responses: DECISION_RESPONSES }
  });
  return {
    [`${b}/review`]: {
      get: {
        summary    : "검토 대기 파편 목록(오래된 순)",
        operationId: "adminListReviewQueue",
        security   : [bearer],
        parameters : [
          { name: "key_id", in: "query", required: false, schema: { type: "string" }, description: "키 id 또는 master" },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "앞 응답의 nextCursor" }
        ],
        responses  : { 200: { description: "items, count, nextCursor" }, 400: { description: "잘못된 질의(field)" } }
      }
    },
    [`${b}/review/{id}/approve`]: decision("검토 대기 파편 승인", "adminApproveReview"),
    [`${b}/review/{id}/reject`] : decision("검토 대기 파편 거절", "adminRejectReview")
  };
}
