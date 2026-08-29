import fs   from "node:fs";
import path from "node:path";
import os   from "node:os";

/** 개명 이전 설치본의 캐시를 그대로 쓴다. 경로를 바꾸면 기존 캐시가 고아가 된다. */
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".memento-mcp");
const CACHE_FILENAME    = "update-check.json";

export class UpdateCache {
  constructor(cacheDir = DEFAULT_CACHE_DIR) {
    this._dir  = cacheDir;
    this._path = path.join(cacheDir, CACHE_FILENAME);
  }

  get() {
    try {
      return JSON.parse(fs.readFileSync(this._path, "utf8"));
    } catch {
      return null;
    }
  }

  set(data) {
    try {
      fs.mkdirSync(this._dir, { recursive: true });
      fs.writeFileSync(this._path, JSON.stringify({ ...data, lastCheck: new Date().toISOString() }, null, 2));
    } catch { /* 쓰기 실패 시 무시 */ }
  }

  isExpired(ttlHours) {
    const cached = this.get();
    if (!cached || !cached.lastCheck) return true;
    return Date.now() - new Date(cached.lastCheck).getTime() > ttlHours * 3_600_000;
  }
}
