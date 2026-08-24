const TOKENS = new Map([["pilot-key-a", "key-a"], ["pilot-key-b", "key-b"]]);

function exactRows(fixture, scope) {
  return fixture.fragments.filter(row => row.key_id === scope.keyId && row.workspace === scope.workspace);
}

function toolResult(fixture, name, args, tokenKeyId) {
  const rows = exactRows(fixture, { keyId: tokenKeyId, workspace: args.workspace });
  if (name === "recall") return { fragments: rows.filter(row => (args.keywords || []).includes(row.topic)) };
  if (name === "memory_stats") return { stats: { total: rows.length } };
  if (name === "fragment_history") {
    const row = rows.find(candidate => candidate.id === args.id);
    return row ? { success: true, fragment: row } : { success: false, reason: "not_found" };
  }
  throw new Error(`FAKE_TOOL_NOT_IMPLEMENTED:${name}`);
}

function tokenFromRequest(req) {
  const header = req.headers.authorization || "";
  return /^Bearer\s+(.+)$/i.exec(header)?.[1] || req.headers["memento-access-key"];
}

/**
 * Fake adapters implement only authentication and dispatch contracts. The
 * HTTP handler remains the production handleMcpPost entrypoint.
 */
export function createSecurityPilotFakeAdapters(fixture) {
  const authenticate = async req => {
    const keyId = TOKENS.get(tokenFromRequest(req));
    if (!keyId) return { valid: false, error: "unauthorized" };
    return {
      valid: true,
      keyId,
      groupKeyIds: [keyId],
      permissions: [],
      defaultWorkspace: "ws-a"
    };
  };

  const dispatch = async (msg, sessionData = {}) => {
    if (msg.method === "initialize") {
      return {
        kind: "result",
        response: {
          jsonrpc: "2.0", id: msg.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "security-pilot" } }
        }
      };
    }
    if (msg.method !== "tools/call") {
      return { kind: "result", response: { jsonrpc: "2.0", id: msg.id, result: {} } };
    }
    const args = msg.params?.arguments || {};
    if (args._keyId !== sessionData.keyId || args._defaultWorkspace !== "ws-a") {
      throw new Error("AUTHENTICATED_SCOPE_NOT_INJECTED");
    }
    return {
      kind: "result",
      response: { jsonrpc: "2.0", id: msg.id, result: toolResult(fixture, msg.params.name, args, sessionData.keyId) }
    };
  };

  return { authenticate, dispatch };
}
