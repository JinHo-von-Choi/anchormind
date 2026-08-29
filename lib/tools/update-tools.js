// lib/tools/update-tools.js
import { checkForUpdate } from "../updater/version-checker.js";
import { UpdateCache }      from "../updater/cache.js";
import { detectInstallType } from "../updater/install-detector.js";
import { UpdateExecutor }   from "../updater/update-executor.js";

const cache = new UpdateCache();

export const checkUpdateDefinition = {
  name:        "check_update",
  description: "현재 버전과 최신 GitHub 태그를 비교하여 업데이트 가용 여부를 확인합니다. master key 전용.",
  inputSchema: {
    type: "object",
    properties: {
      force: { type: "boolean", description: "true면 캐시 무시", default: false }
    }
  }
};

export const applyUpdateDefinition = {
  name:        "apply_update",
  description: "지정된 단계의 업데이트를 실행합니다. 사용자 동의 후 AI가 호출. master key 전용.",
  inputSchema: {
    type: "object",
    properties: {
      step:   { type: "string", enum: ["fetch", "install", "migrate"], description: "실행할 업데이트 단계" },
      dryRun: { type: "boolean", description: "true(기본)면 명령어 미리보기만", default: true }
    },
    required: ["step"]
  }
};

export async function tool_checkUpdate(args) {
  const force = args.force === true;
  if (!force) {
    const cached = cache.get();
    if (cached && !cache.isExpired(Number(process.env.UPDATE_CHECK_INTERVAL_HOURS || 24))) {
      return { ...cached, installType: cached.installType || await detectInstallType(), fromCache: true };
    }
  }
  const result      = await checkForUpdate({ githubToken: process.env.GITHUB_TOKEN });
  const installType = await detectInstallType();
  const updateCmd   = _getManualCommand(installType);
  const cacheData   = { ...result, installType, updateCommand: updateCmd };
  cache.set(cacheData);
  return { ...cacheData, fromCache: false };
}

export async function tool_applyUpdate(args) {
  const dryRun = args.dryRun !== false;
  const cached = cache.get();
  if (!cached?.latestVersion) return { success: false, error: "check_update를 먼저 실행하세요." };
  const installType = await detectInstallType();
  const executor    = new UpdateExecutor({ installType, targetVersion: `v${cached.latestVersion}` });
  return executor.executeStep(args.step, { dryRun });
}

function _getManualCommand(type) {
  return ({
    git:          "git pull && npm install",
    "npm-local":  "npm update anchormind-mcp",
    "npm-global": "npm install -g anchormind-mcp@latest",
    docker:       "docker pull jinhovonchoi/anchormind:latest",
    unknown:      "https://github.com/JinHo-von-Choi/anchormind/releases"
  })[type] || "https://github.com/JinHo-von-Choi/anchormind/releases";
}
