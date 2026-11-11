/**
 * Memento MCP Admin Console: API 키 수명 카드
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 *
 * 키 상세의 LIFECYCLE 카드: 만료 시각, 소유자, 종류, 설명, 허용 주소 대역 편집(PATCH /keys/:id), 회전
 * (POST /keys/:id/rotate, 새 원시 키를 한 번만 표시), 폐기(POST /keys/:id/revoke, 사유 필수, 두 번 눌러 확정),
 * 접근 검토 서명(POST /keys/:id/access-review).
 */

import { api }                              from "./api.js";
import { showToast, showModal, closeModal } from "./ui.js";
import { fmtDate }                          from "./format.js";

/** 서버 검증과 같은 한도 */
export const KEY_LIFECYCLE_LIMITS = { cidrs: 64, owner: 128, description: 500, reason: 500 };

const INPUT_CLASS = "w-full bg-surface-container-highest border border-outline-variant/30 rounded-sm px-2 py-1 text-xs font-mono text-on-surface focus:border-primary focus:outline-none";

/** 회전 결과 안내. 서버의 회전 동작과 같은 문구다(api-reference의 키 수명 절). */
export const ROTATE_NOTE = "The previous key authenticates new requests until {until}. At that time every session and OAuth token "
  + "of this key created before it ends at its next use (sessions at the next key state recheck); clients sign in again with the new key.";

/** 만료 시각 입력 규칙: Z 또는 +hh:mm/-hh:mm 오프셋이 있는 ISO 8601 */
export const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 회전 확인 단추 문구. 겹침 0은 이전 키와 열린 세션을 바로 끝낸다.
 *
 * @param {string} graceText 입력한 겹침 시간(빈 문자열은 서버 기본값)
 * @returns {string}
 */
export function rotateConfirmLabel(graceText) {
  if (graceText === "0") return "CONFIRM ROTATE: OLD KEY AND OPEN SESSIONS END NOW";
  return `CONFIRM ROTATE: OLD KEY ENDS IN ${graceText === "" ? "THE DEFAULT" : graceText} HOURS`;
}

/** 빈 문자열은 null */
function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

/** 줄마다 한 항목인 대역 목록 */
export function parseCidrLines(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

/** 같은 시각인지(둘 다 비었거나 같은 ms) */
function sameInstant(a, b) {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? a === b : ta === tb;
}

/** 같은 목록인지 */
function sameList(a, b) {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 입력 상태에서 PATCH /keys/:id 본문을 만든다. 바뀐 필드만 담는다.
 *
 * @param {object} key
 * @param {{ expiresAt: string, owner: string, kind: string, description: string, restrictAddresses: boolean, cidrsText: string }} form
 * @returns {object}
 */
export function buildKeyLifecyclePatch(key, form) {
  const patch   = {};
  const expires = textOrNull(form.expiresAt);
  if (!sameInstant(expires, key.expires_at ?? null)) patch.expires_at = expires;

  for (const [field, value] of [["owner", form.owner], ["kind", form.kind], ["description", form.description]]) {
    const next = textOrNull(value);
    if (next !== (key[field] ?? null)) patch[field] = next;
  }

  const cidrs = form.restrictAddresses ? parseCidrLines(form.cidrsText) : null;
  if (!sameList(cidrs, key.allowed_cidrs ?? null)) patch.allowed_cidrs = cidrs;
  return patch;
}

/**
 * 원시 키를 한 번 보여 주는 내용(복사 단추 포함).
 *
 * @param {string} rawKey
 * @returns {HTMLElement}
 */
export function secretOnceDisplay(rawKey) {
  const keyDisplay = document.createElement("div");
  const note = document.createElement("p");
  note.className = "text-xs text-primary leading-relaxed mb-4";
  note.textContent = "This secret key will only be displayed once. Store it in a secure vault.";
  keyDisplay.appendChild(note);

  const copyWrap = document.createElement("div");
  copyWrap.className = "copy-wrap";
  const copyVal = document.createElement("span");
  copyVal.className = "copy-value";
  copyVal.textContent = rawKey;
  copyWrap.appendChild(copyVal);
  const copyBtn = document.createElement("button");
  copyBtn.className = "copy-btn";
  copyBtn.textContent = "COPY";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(rawKey).then(() => showToast("Copied", "success"));
  });
  copyWrap.appendChild(copyBtn);
  keyDisplay.appendChild(copyWrap);
  return keyDisplay;
}

/** 라벨과 입력 한 줄 */
function field(labelText, control) {
  const row = document.createElement("label");
  row.className = "flex flex-col gap-1";
  const label = document.createElement("span");
  label.className = "text-[10px] font-bold text-slate-500 uppercase tracking-wider";
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(control);
  return row;
}

/** 입력 요소 */
function input(id, value, placeholder, tag = "input") {
  const el = document.createElement(tag);
  el.id = id;
  el.className = INPUT_CLASS;
  el.value = value ?? "";
  if (placeholder) el.placeholder = placeholder;
  return el;
}

/** 단추 */
function button(id, text, cls) {
  const el = document.createElement("button");
  el.id = id;
  el.className = cls ? `btn ${cls} w-full` : "btn w-full";
  el.textContent = text;
  return el;
}

/** 상태 한 줄 */
function statusLine(text, cls = "text-slate-400") {
  const line = document.createElement("p");
  line.className = `text-[10px] ${cls}`;
  line.textContent = text;
  return line;
}

/**
 * 키 수명 카드.
 *
 * @param {object} key
 * @param {() => void} rerender 저장 뒤 목록을 다시 그린다
 * @returns {HTMLElement}
 */
export function renderKeyLifecycleCard(key, rerender) {
  const card = document.createElement("div");
  card.className = "bg-surface-container-highest p-4 rounded-sm border-l-2 border-tertiary space-y-3";
  card.id = "key-lifecycle-card";

  const title = document.createElement("h4");
  title.className = "text-[10px] font-bold text-slate-400 tracking-widest uppercase font-label";
  title.textContent = "LIFECYCLE";
  card.appendChild(title);

  const revoked = Boolean(key.revoked_at);
  if (revoked) {
    card.appendChild(statusLine(`REVOKED ${fmtDate(key.revoked_at)} by ${key.revoked_by ?? "-"}: ${key.revoke_reason ?? ""}`, "text-error"));
  }
  if (key.rotation_overlap_until) {
    card.appendChild(statusLine(`Previous key valid until ${fmtDate(key.rotation_overlap_until)}`));
  }
  card.appendChild(statusLine(key.access_reviewed_at
    ? `Access reviewed ${fmtDate(key.access_reviewed_at)} by ${key.access_reviewed_by ?? "-"}`
    : "Access not reviewed"));

  const expires     = input("key-lifecycle-expires", key.expires_at ? new Date(key.expires_at).toISOString() : "", "2027-01-01T00:00:00Z (empty: no expiry)");
  const owner       = input("key-lifecycle-owner", key.owner, "owner");
  const kind        = input("key-lifecycle-kind", key.kind, "service");
  const description = input("key-lifecycle-description", key.description, "description", "textarea");
  description.rows  = 2;

  const restrict = document.createElement("input");
  restrict.type = "checkbox";
  restrict.id = "key-lifecycle-restrict-addresses";
  restrict.className = "accent-primary";
  restrict.checked = Array.isArray(key.allowed_cidrs);
  const cidrs = input("key-lifecycle-cidrs", Array.isArray(key.allowed_cidrs) ? key.allowed_cidrs.join("\n") : "", "one CIDR per line, e.g. 192.0.2.0/24", "textarea");
  cidrs.rows     = 3;
  cidrs.disabled = !restrict.checked;
  restrict.addEventListener("change", () => { cidrs.disabled = !restrict.checked; });

  card.appendChild(field("EXPIRES AT (UTC)", expires));
  card.appendChild(field("OWNER", owner));
  card.appendChild(field("KIND", kind));
  card.appendChild(field("DESCRIPTION", description));
  card.appendChild(field("RESTRICT ADDRESSES", restrict));
  card.appendChild(cidrs);
  card.appendChild(statusLine("Unchecked allows every address. An empty list refuses every address. Up to "
    + KEY_LIFECYCLE_LIMITS.cidrs + " IPv4 or IPv6 blocks. The client address is taken after TRUST_PROXY_HOPS; the server refuses a list while TRUST_PROXY_HOPS is unset."));

  const save = button("key-lifecycle-save", "SAVE LIFECYCLE", "btn-primary");
  save.addEventListener("click", async () => {
    const patch = buildKeyLifecyclePatch(key, {
      expiresAt: expires.value, owner: owner.value, kind: kind.value, description: description.value,
      restrictAddresses: restrict.checked, cidrsText: cidrs.value
    });
    if (Object.keys(patch).length === 0) { showToast("No lifecycle changes", "warning"); return; }
    if (typeof patch.expires_at === "string" && !EXPIRY_PATTERN.test(patch.expires_at)) {
      showToast("EXPIRES AT must be ISO 8601 with Z or an offset, e.g. 2027-01-01T00:00:00Z", "warning");
      return;
    }
    const r = await api("/keys/" + key.id, { method: "PATCH", body: patch });
    if (r.ok) { showToast("Lifecycle updated", "success"); rerender(); }
    else showToast(r.data?.message ?? r.data?.error ?? "Update failed", "error");
  });
  card.appendChild(save);

  const grace  = input("key-lifecycle-grace-hours", "", "grace hours (default 24)");
  grace.type   = "number";
  grace.min    = "0";
  grace.max    = "720";
  const ROTATE_LABEL = "ROTATE KEY";
  const rotate = button("key-lifecycle-rotate", ROTATE_LABEL, null);
  let confirmingRotate = false;
  grace.addEventListener("input", () => { confirmingRotate = false; rotate.textContent = ROTATE_LABEL; });
  rotate.addEventListener("click", async () => {
    const raw  = String(grace.value ?? "").trim();
    const body = raw === "" ? {} : { graceHours: Number(raw) };
    if (!confirmingRotate) {
      confirmingRotate   = true;
      rotate.textContent = rotateConfirmLabel(raw);
      return;
    }
    confirmingRotate   = false;
    rotate.textContent = ROTATE_LABEL;
    const r    = await api("/keys/" + key.id + "/rotate", { method: "POST", body });
    if (!r.ok || !r.data?.raw_key) { showToast(r.data?.message ?? r.data?.error ?? "Rotation failed", "error"); return; }
    const content = secretOnceDisplay(r.data.raw_key);
    content.appendChild(statusLine(ROTATE_NOTE.replace("{until}", fmtDate(r.data.previous_valid_until))));
    if (r.data.warning) content.appendChild(statusLine("Closing the open sessions failed; they end at the next key state recheck.", "text-error"));
    showModal("Key Rotated", content, [
      { id: "done", label: "DONE", cls: "btn-primary", handler: () => { closeModal(); rerender(); } }
    ]);
  });

  const reason = input("key-lifecycle-revoke-reason", "", "revoke reason (required)");
  const REVOKE_LABEL = "REVOKE PERMANENTLY";
  const revoke = button("key-lifecycle-revoke", REVOKE_LABEL, "btn-danger");
  let confirming = false;
  reason.addEventListener("input", () => { confirming = false; revoke.textContent = REVOKE_LABEL; });
  revoke.addEventListener("click", async () => {
    if (String(reason.value ?? "").trim() === "") { showToast("Revoke reason required", "warning"); return; }
    if (!confirming) {
      confirming = true;
      revoke.textContent = "CONFIRM REVOKE: CANNOT BE UNDONE";
      return;
    }
    confirming = false;
    revoke.textContent = REVOKE_LABEL;
    const r = await api("/keys/" + key.id + "/revoke", { method: "POST", body: { reason: reason.value.trim() } });
    if (r.ok) { showToast("Key revoked", "success"); rerender(); }
    else showToast(r.data?.error ?? "Revoke failed", "error");
  });

  if (!revoked) {
    card.appendChild(field("ROTATION OVERLAP", grace));
    card.appendChild(rotate);
    card.appendChild(field("PERMANENT REVOCATION", reason));
    card.appendChild(revoke);
  }

  const review = button("key-lifecycle-review", "SIGN ACCESS REVIEW", null);
  review.addEventListener("click", async () => {
    const r = await api("/keys/" + key.id + "/access-review", { method: "POST" });
    if (r.ok) { showToast("Access review recorded", "success"); rerender(); }
    else showToast(r.data?.error ?? "Review failed", "error");
  });
  card.appendChild(review);

  return card;
}
