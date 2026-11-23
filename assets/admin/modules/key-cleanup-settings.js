/**
 * Memento MCP Admin Console — 키 자동 정리 설정(Cleanup Settings) 모달
 *
 * 작성자: 최진호
 * 작성일: 2026-11-23
 *
 * 키 전체나 workspace 하나에서 자동 정리(자동 삭제, 병합, 대체, 강등)를 켜고 끄고, 만료 없음을 정한다.
 * 보존 일수는 보존 정책 카드의 Set Policy가 바꾸고, 이 모달은 적용 중인 기간과 출처만 보여 준다.
 * 자동 정리를 다시 켜거나 만료 없음을 풀면 저장 전에 같은 모달의 본문을 미리보기로 바꿔 다음 주기에 손댈 수를
 * 보여 주고 재개까지 기다릴 일수를 받는다. 자료는 GET/PUT /keys/:id/retention/scopes, GET /keys/:id/retention/preview다.
 */

import { api }                                from "./api.js";
import { state }                              from "./state.js";
import { showModal, closeModal, showToast }   from "./ui.js";

/** 자동 정리를 바꾸는 능력(lib/admin/capabilities.js) */
export const RETENTION_MANAGE_CAP = "retention.manage";

/** 자동 정리를 다시 켤 때 기다리는 기본 일수(lib/admin/RetentionPolicyStore.js RESUME_AFTER_DAYS) */
export const DEFAULT_RESUME_DAYS = 7;

/** 키 인스펙터 입력과 같은 모양(key-lifecycle.js). form-select는 흰 바탕에 밝은 글자로 그려져 쓰지 않는다. */
const CONTROL_CLASS = "w-full bg-surface-container-highest border border-outline-variant/30 rounded-sm px-2 py-1.5 text-xs font-mono text-on-surface placeholder:text-slate-500 focus:border-primary focus:outline-none";

const SOURCE_LABEL = { global: "global setting", key: "whole key", workspace: "this workspace" };

/**
 * 적용 중인 보존 기간 글.
 *
 * @param {{ expiry: number|"none"|null, expirySource: string|null }} e
 * @param {boolean} [workspaceScope] workspace 범위이면 키 전체에서 물려받은 기간을 "inherits"로 쓴다
 * @returns {string}
 */
export function expiryText(e, workspaceScope = false) {
  if (!e || e.expiry === null) return "no retention period";
  if (e.expiry === "none")     return "no expiry";
  return workspaceScope && e.expirySource === "key" ? `inherits ${e.expiry} days` : `${e.expiry} days`;
}

/**
 * 보존 정책 카드에 더하는 범위 한 줄. 자동 정리가 꺼졌거나 재개를 기다리거나 만료 없음인 행만 글을 만든다.
 *
 * @param {{ workspace: string|null, no_expiry: boolean, auto_lifecycle: boolean, auto_resume_at: string|null,
 *           effective?: object }} scope
 * @param {number} [now]
 * @returns {string|null}
 */
export function scopeNote(scope, now = Date.now()) {
  const name    = scope.workspace ?? "All workspaces";
  const resumes = scope.auto_resume_at && new Date(scope.auto_resume_at).getTime() > now;
  const parts   = [];
  if (scope.auto_lifecycle === false) {
    parts.push(`auto cleanup off (expiry: ${expiryText(scope.effective, scope.workspace !== null)})`);
  } else if (resumes) {
    parts.push(`auto cleanup resumes ${String(scope.auto_resume_at).slice(0, 10)}`);
  }
  if (scope.no_expiry && parts.length === 0) parts.push("no expiry");
  return parts.length ? `${name}: ${parts.join(", ")}` : null;
}

/**
 * 로그인 주체에게 능력이 있는지. 능력 목록을 아직 읽지 못했으면 서버 판정에 맡기고 true로 본다.
 *
 * @param {Array<{ cap: string }>|null} caps
 * @param {string} cap
 * @returns {boolean}
 */
export function hasCapability(caps, cap) {
  return !Array.isArray(caps) || caps.some((c) => c?.cap === cap);
}

/**
 * 고른 범위의 저장 값과 적용 값.
 *
 * @param {object} data GET /keys/:id/retention/scopes 응답
 * @param {string|null} workspace
 */
export function scopeState(data, workspace) {
  const row = (data.scopes ?? []).find((s) => (s.workspace ?? null) === workspace) ?? null;
  const ws  = workspace === null ? null : (data.workspaces ?? []).find((w) => w.workspace === workspace) ?? null;
  /** 정책 행도 파편도 없는 workspace는 키 전체 값을 그대로 받는다 */
  const effective = workspace === null ? data.keyEffective : (row?.effective ?? ws?.effective ?? data.keyEffective);
  const fragments = workspace === null
    ? (data.workspaces ?? []).reduce((n, w) => n + (w.fragments ?? 0), 0)
    : (ws?.fragments ?? 0);
  const stored = {
    autoLifecycle: row ? row.auto_lifecycle !== false : true,
    resumeAt     : row?.auto_resume_at ?? null,
    noExpiry     : row?.no_expiry === true
  };
  return { row, effective, fragments, stored };
}

/**
 * 저장할 본문과, 저장 전에 미리보기 확인이 필요한지 정한다. 바뀐 것이 없으면 null이다.
 *
 * @param {{ workspace: string|null, cleanupOn: boolean, noExpiry: boolean }} form
 * @param {{ stored: { autoLifecycle: boolean, resumeAt: string|null, noExpiry: boolean } }} current
 * @param {boolean} canManage retention.manage 유무
 * @returns {{ body: object, needsPreview: boolean }|null}
 */
export function plannedChange(form, current, canManage) {
  /** 재개 대기 중인 범위는 저장 값이 켜짐이다. 꺼짐을 고르면 재개를 취소한다. */
  const storedOn = current.stored.autoLifecycle;
  const body = { workspace: form.workspace };
  if (canManage && form.cleanupOn !== storedOn) body.autoLifecycle = form.cleanupOn;
  if (form.noExpiry !== current.stored.noExpiry) body.noExpiry = form.noExpiry;
  if (body.autoLifecycle === undefined && body.noExpiry === undefined) return null;
  return { body, needsPreview: body.autoLifecycle === true || body.noExpiry === false };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelText, control) {
  const group = el("div", "form-group");
  group.appendChild(el("label", "form-label", labelText));
  group.appendChild(control);
  return group;
}

/** 미리보기 수 표 */
export function previewRows(counts) {
  return [
    ["Expired fragments deleted", counts.expiredDelete],
    ["Permanent fragments demoted to cold", counts.permanentDemote],
    ["session_reflect fragments purged", counts.reflectionPurge],
    ["Pending reviews auto-rejected", counts.reviewExpire],
    ["Exact duplicates closed", counts.exactDuplicates],
    ["Deleted by retention period (either mode)", counts.retentionExpire]
  ];
}

/**
 * Cleanup Settings 모달을 연다.
 *
 * @param {{ id: string, name?: string }} key
 * @param {{ load?: Function, save?: Function, preview?: Function, onSaved?: Function, caps?: Array|null,
 *           modal?: Function, close?: Function, toast?: Function }} [deps]
 * @returns {Promise<void>}
 */
export async function openCleanupSettings(key, {
  load    = (id) => api(`/keys/${id}/retention/scopes`),
  save    = (id, body) => api(`/keys/${id}/retention/scopes`, { method: "PUT", body }),
  /** workspace를 비우면 서버가 키 전체로 읽는다 */
  preview = (id, ws) => api(`/keys/${id}/retention/preview?workspace=${encodeURIComponent(ws ?? "")}`),
  onSaved = () => {},
  caps    = state.capabilities,
  modal   = showModal,
  close   = closeModal,
  toast   = showToast
} = {}) {
  const res = await load(key.id);
  if (!res?.ok) { toast(res?.data?.error ?? "Load failed", "error"); return; }
  const data       = res.data;
  const canManage  = hasCapability(caps, RETENTION_MANAGE_CAP);
  const globalLock = data.global?.effective === "manual";

  const form = el("div", "space-y-3");
  form.id = "cleanup-settings-form";

  if (globalLock) {
    form.appendChild(el("div", "text-[11px] text-amber-300", data.global.mode === "manual"
      ? "Automatic cleanup is off for every key (MEMENTO_RETENTION_MODE=manual). Per-scope cleanup settings cannot turn it on."
      : `Automatic cleanup is off for every key until ${data.global.autoAfter} (MEMENTO_RETENTION_AUTO_AFTER).`));
  }

  /** 범위: 키 전체 또는 workspace 하나. 목록에 없는 이름은 아래 입력에 쓴다. */
  const scopeSel = el("select", CONTROL_CLASS);
  scopeSel.id = "cleanup-scope";
  const names = new Set();
  const addOption = (value, label) => {
    const opt = el("option", "", label);
    opt.value = value;
    scopeSel.appendChild(opt);
  };
  addOption("", "All workspaces");
  for (const w of data.workspaces ?? []) {
    if (w.workspace === null || names.has(w.workspace)) continue;
    names.add(w.workspace);
    addOption(w.workspace, `${w.workspace} (${w.fragments} fragments)`);
  }
  for (const s of data.scopes ?? []) {
    if (s.workspace === null || names.has(s.workspace)) continue;
    names.add(s.workspace);
    addOption(s.workspace, s.workspace);
  }
  scopeSel.value = "";
  const scopeInput = el("input", CONTROL_CLASS);
  scopeInput.id          = "cleanup-scope-other";
  scopeInput.type        = "text";
  scopeInput.placeholder = "or type a workspace name";
  const scopeBox = el("div", "space-y-1");
  scopeBox.appendChild(scopeSel);
  scopeBox.appendChild(scopeInput);
  form.appendChild(field("SCOPE", scopeBox));

  const cleanupSel = el("select", CONTROL_CLASS);
  cleanupSel.id = "cleanup-auto";
  for (const [value, label] of [["on", "On"], ["off", "Off"]]) {
    const opt = el("option", "", label);
    opt.value = value;
    cleanupSel.appendChild(opt);
  }
  const cleanupNote = el("div", "text-[10px] text-slate-400 space-y-1");
  const cleanupBox  = el("div", "space-y-1");
  cleanupBox.appendChild(cleanupSel);
  cleanupBox.appendChild(cleanupNote);
  form.appendChild(field("AUTOMATIC CLEANUP", cleanupBox));

  const expiryLine = el("div", "text-[11px] text-slate-300");
  const noExpiryLabel = el("label", "flex items-center gap-2 text-xs text-slate-300");
  const noExpiryBox   = el("input", "accent-primary");
  noExpiryBox.type = "checkbox";
  noExpiryBox.id   = "cleanup-no-expiry";
  noExpiryLabel.appendChild(noExpiryBox);
  noExpiryLabel.appendChild(document.createTextNode("No expiry (this scope is never deleted by a retention period)"));
  const expiryBox = el("div", "space-y-1");
  expiryBox.appendChild(expiryLine);
  expiryBox.appendChild(noExpiryLabel);
  expiryBox.appendChild(el("div", "text-[10px] text-slate-500", "Days are changed with Set Policy on the retention card."));
  form.appendChild(field("RETENTION PERIOD", expiryBox));

  const statusLine = el("div", "text-[11px] text-slate-400");
  form.appendChild(field("CURRENT STATE", statusLine));

  const selectedWorkspace = () => {
    const typed = String(scopeInput.value ?? "").trim();
    if (typed) return typed;
    return scopeSel.value ? scopeSel.value : null;
  };

  let current = null;
  const updateNote = () => {
    cleanupNote.textContent = "";
    if (cleanupSel.value === "off") {
      cleanupNote.appendChild(el("p", "", "No automatic delete, merge, supersede or demotion in this scope. " +
        "Fragments keep accumulating and may reach the quota sooner."));
      const e = current?.effective;
      if (e && typeof e.expiry === "number" && !noExpiryBox.checked) {
        cleanupNote.appendChild(el("p", "text-amber-300",
          `Fragments are still deleted after the retention period (${e.expiry} days, ${SOURCE_LABEL[e.expirySource] ?? e.expirySource}).`));
      }
    }
    if (current?.stored.resumeAt && new Date(current.stored.resumeAt).getTime() > Date.now()) {
      cleanupNote.appendChild(el("p", "", `Cleanup resumes ${String(current.stored.resumeAt).slice(0, 16).replace("T", " ")} UTC. Choose Off to cancel.`));
    }
    if (!canManage) cleanupNote.appendChild(el("p", "text-slate-500", `Requires the ${RETENTION_MANAGE_CAP} capability.`));
  };
  const fill = () => {
    current = scopeState(data, selectedWorkspace());
    cleanupSel.value    = current.stored.autoLifecycle ? "on" : "off";
    cleanupSel.disabled = globalLock || !canManage;
    noExpiryBox.checked = current.stored.noExpiry;
    const e = current.effective ?? {};
    expiryLine.textContent = e.expiry === null || e.expiry === undefined
      ? "No retention period"
      : `${e.expiry === "none" ? "No expiry" : `${e.expiry} days`} (${SOURCE_LABEL[e.expirySource] ?? e.expirySource})`;
    const quota = data.quota ?? {};
    statusLine.textContent = `${current.fragments} fragments · quota ${quota.used ?? 0}` +
      `${quota.limit !== null && quota.limit !== undefined ? ` / ${quota.limit}` : " (no limit)"} · ` +
      `mode ${e.mode ?? "auto"}${e.modeSource ? ` (${SOURCE_LABEL[e.modeSource] ?? e.modeSource})` : ""}`;
    updateNote();
  };
  scopeSel.addEventListener("change", () => { scopeInput.value = ""; fill(); });
  scopeInput.addEventListener("change", fill);
  cleanupSel.addEventListener("change", updateNote);
  noExpiryBox.addEventListener("change", updateNote);
  fill();

  const commit = async (body) => {
    const out = await save(key.id, body);
    if (out?.ok) {
      close();
      toast("Cleanup settings updated. Without Redis, other servers apply it within a minute.", "success");
      await onSaved();
      return;
    }
    toast(out?.status === 403 ? `Requires the ${RETENTION_MANAGE_CAP} capability` : (out?.data?.error ?? "Update failed"), "error");
  };

  /** 자동 정리를 다시 켜거나 만료 없음을 풀 때: 본문을 미리보기로 바꾸고 재개 일수를 받는다 */
  const confirmStep = async (body) => {
    const p = await preview(key.id, body.workspace);
    if (!p?.ok) { toast(p?.data?.error ?? "Preview failed", "error"); return; }
    const box = el("div", "space-y-3");
    box.id = "cleanup-settings-confirm";
    box.appendChild(el("p", "text-[11px] text-slate-300",
      `${body.workspace ?? "All workspaces"}: the next cycle after cleanup runs would touch these fragments.`));
    const table = el("div", "space-y-1 font-mono text-[11px]");
    for (const [label, n] of previewRows(p.data.counts ?? {})) {
      const row = el("div", "flex justify-between gap-4");
      row.appendChild(el("span", "text-slate-400", label));
      row.appendChild(el("span", "text-slate-200", String(n ?? 0)));
      table.appendChild(row);
    }
    box.appendChild(table);
    box.appendChild(el("p", "text-[10px] text-slate-500",
      `Not counted (decided by embeddings or the LLM): ${(p.data.notCounted ?? []).join(", ")}`));
    let daysInput = null;
    if (body.autoLifecycle === true) {
      daysInput = el("input", CONTROL_CLASS);
      daysInput.id    = "cleanup-resume-days";
      daysInput.type  = "number";
      daysInput.min   = "0";
      daysInput.max   = "90";
      daysInput.value = String(DEFAULT_RESUME_DAYS);
      box.appendChild(field("WAIT BEFORE CLEANUP RESUMES (DAYS, 0 = NOW)", daysInput));
      box.appendChild(el("p", "text-[10px] text-slate-500",
        "Until then the scope stays off. You can preview again and turn it off before cleanup resumes."));
    }
    modal("Confirm Cleanup Change", box, [
      { label: "CONFIRM", cls: "btn-primary", handler: async () => {
        const final = { ...body };
        if (daysInput) {
          const d = Number(daysInput.value);
          if (!Number.isInteger(d) || d < 0 || d > 90) { toast("Enter whole days from 0 to 90", "warning"); return; }
          final.resumeAfterDays = d;
        }
        await commit(final);
      } }
    ]);
  };

  modal("Cleanup Settings", form, [
    { label: "SAVE", cls: "btn-primary", handler: async () => {
      const plan = plannedChange(
        { workspace: selectedWorkspace(), cleanupOn: cleanupSel.value === "on", noExpiry: noExpiryBox.checked === true },
        current, canManage && !globalLock);
      if (!plan) { close(); return; }
      if (plan.needsPreview) await confirmStep(plan.body);
      else await commit(plan.body);
    } }
  ]);
}
