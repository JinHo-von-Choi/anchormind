/** content를 노출하지 않고 anchor inventory 분류만 수행한다. */
export function classifyAnchors(rows, classifications) {
  for (const id of classifications.shared) {
    if (classifications.private.has(id)) {
      throw new Error(`anchor classification conflict: ${id}`);
    }
  }
  return rows.map(row => ({
    id        : row.id,
    agentId   : row.agent_id,
    workspace : row.workspace ?? null,
    keyId     : row.key_id ?? null,
    isAnchor  : row.is_anchor === true,
    category  : classifications.shared.has(row.id)
      ? "shared"
      : (classifications.private.has(row.id) ? "private" : "unconfirmed")
  }));
}
