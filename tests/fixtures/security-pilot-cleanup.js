export const SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP = "SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP";
export const SYNTHETIC_API_KEY_IDS = [
  "00000000-0000-0000-0000-00000000aaaa",
  "00000000-0000-0000-0000-00000000bbbb"
];

export function shouldDeferSyntheticCleanup(env = process.env) {
  return env[SECURITY_PILOT_DEFER_SYNTHETIC_CLEANUP] === "true";
}

export function syntheticApiKeyIds() {
  return [...SYNTHETIC_API_KEY_IDS];
}

export async function deleteSyntheticFixture(pool) {
  await pool.query("DELETE FROM agent_memory.fragments WHERE topic = $1", ["security-pilot-synthetic"]);
  await pool.query("DELETE FROM agent_memory.api_keys WHERE id = ANY($1::text[])", [syntheticApiKeyIds()]);
}
