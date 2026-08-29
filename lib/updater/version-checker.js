import { createRequire } from "node:module";
import path from "node:path";

const REPO_OWNER = "JinHo-von-Choi";
const REPO_NAME  = "anchormind";
const API_BASE   = "https://api.github.com";

export function parseVersion(version) {
  if (!version) return null;
  const m = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

export function compareSemver(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  return 0;
}

export function findLatestTag(tags) {
  let latest = null;
  for (const t of tags) {
    if (!parseVersion(t.name)) continue;
    if (!latest || compareSemver(t.name, latest) > 0) latest = t.name;
  }
  return latest;
}

export function getCurrentVersion() {
  const require = createRequire(import.meta.url);
  return require(path.resolve(import.meta.dirname, "../../package.json")).version;
}

export async function checkForUpdate(options = {}) {
  const { githubToken, fetchFn = globalThis.fetch } = options;
  const currentVersion = getCurrentVersion();
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "anchormind-mcp" };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const tagsRes = await fetchFn(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/tags?per_page=30`, { headers });
  if (!tagsRes.ok) throw new Error(`GitHub API error: ${tagsRes.status}`);

  const latestTag = findLatestTag(await tagsRes.json());
  if (!latestTag) return { currentVersion, latestVersion: currentVersion, updateAvailable: false, changes: [] };

  const latestVersion   = latestTag.replace(/^v/, "");
  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

  let changes = [];
  if (updateAvailable) {
    try {
      const cmpRes = await fetchFn(`${API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/compare/v${currentVersion}...${latestTag}`, { headers });
      if (cmpRes.ok) {
        const data = await cmpRes.json();
        changes = (data.commits || []).map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0] }));
      }
    } catch { /* 변경사항 조회 실패 시 빈 배열 */ }
  }
  return { currentVersion, latestVersion, updateAvailable, changes };
}
