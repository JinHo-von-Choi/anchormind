/** Shared fail-closed policy for the synthetic security pilot. */

export function isSecurityPilotAutomationOff(value = process.env.MEMENTO_SECURITY_PILOT_AUTOMATION) {
  return String(value ?? "").trim().toLowerCase() === "off";
}

export function isOfflineModelMode(env = process.env) {
  return isSecurityPilotAutomationOff(env.MEMENTO_SECURITY_PILOT_AUTOMATION)
    || env.HF_HUB_OFFLINE === "1"
    || env.HF_HUB_OFFLINE === "true"
    || env.TRANSFORMERS_OFFLINE === "1"
    || env.TRANSFORMERS_OFFLINE === "true";
}
