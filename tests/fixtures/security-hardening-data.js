export const fixture = {
  keys: [
    { id: "key-a", allowed_workspaces: ["ws-a"] },
    { id: "key-b", allowed_workspaces: ["ws-a"] }
  ],
  fragments: [
    { id: "a-a", key_id: "key-a", workspace: "ws-a", topic: "pilot", case_id: "case-a", session_id: "s-a", content: "A workspace A" },
    { id: "a-b", key_id: "key-a", workspace: "ws-b", topic: "pilot", case_id: "case-a", session_id: "s-a", content: "A workspace B" },
    { id: "b-a", key_id: "key-b", workspace: "ws-a", topic: "pilot", case_id: "case-a", session_id: "s-b", content: "B workspace A" },
    { id: "global", key_id: null, workspace: null, topic: "pilot", case_id: "case-a", session_id: "s-global", content: "Global pilot must remain hidden" }
  ],
  links: [
    { from_id: "a-a", to_id: "a-b", relation_type: "related" },
    { from_id: "a-a", to_id: "global", relation_type: "related" }
  ]
};

export const scopeA = {
  keyId: "key-a",
  groupKeyIds: ["key-a"],
  workspace: "ws-a"
};
