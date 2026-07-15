/**
 * 파편 임포트/엑스포트 핸들러
 *
 * 작성자: 최진호
 * 작성일: 2026-03-27
 */
import { getPrimaryPool } from "../tools/db.js";
import { readJsonBody }   from "../utils.js";
import { logError }       from "../logger.js";
import { fetchGroupKeyIds, escapeLike } from "./admin-memory.js";
/* ADMIN_BASE: admin-auth.js에서 사용 가능하나 현재 핸들러는 pathname.endsWith()로 라우팅 */

/**
 * GET /export?key_id=&group_id=&topic=&type= - JSON Lines 스트림
 *
 * key_id 또는 group_id 중 하나가 필수다. 전체 반출은 confirm=full을
 * 명시한 경우에만 허용한다 (무의식적 전 테넌트 dump 차단).
 */
export async function handleExport(req, res, url) {
  if (req.method !== "GET" || !url.pathname.endsWith("/export")) return false;

  try {
    const pool    = getPrimaryPool();
    const keyId   = url.searchParams.get("key_id");
    const groupId = url.searchParams.get("group_id");
    const topic   = url.searchParams.get("topic");
    const type    = url.searchParams.get("type");
    const confirm = url.searchParams.get("confirm");
    const keyIds  = (url.searchParams.get("key_ids") || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    if (!keyId && !groupId && keyIds.length === 0 && confirm !== "full") {
      res.statusCode = 400;
      res.end(JSON.stringify({
        error: "key_id, key_ids, or group_id is required. Pass confirm=full to export all tenants."
      }));
      return true;
    }

    let query = `SELECT id, content, topic, type, keywords, importance,
                        source, agent_id, key_id, is_anchor,
                        created_at, accessed_at, valid_from, valid_to
                   FROM agent_memory.fragments WHERE valid_to IS NULL`;
    const params = [];

    if (keyIds.length > 0) {
      params.push(keyIds);
      query += ` AND key_id = ANY($${params.length}::text[])`;
    } else if (keyId) {
      params.push(keyId);
      query += ` AND key_id = $${params.length}`;
    } else if (groupId) {
      const memberKeyIds = await fetchGroupKeyIds(pool, groupId);
      if (memberKeyIds.length === 0) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.end();
        return true;
      }
      params.push(memberKeyIds);
      query += ` AND key_id = ANY($${params.length})`;
    }
    if (topic) {
      params.push(`%${escapeLike(topic)}%`);
      query += ` AND topic ILIKE $${params.length}`;
    }
    if (type) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }
    query += " ORDER BY created_at";

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=fragments.jsonl");

    const result = await pool.query(query, params);
    for (const row of result.rows) {
      res.write(JSON.stringify(row) + "\n");
    }
    res.end();
  } catch (err) {
    logError("[Admin] /export error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}

/**
 * POST /import - JSON body { fragments: [...] }
 */
export async function handleImport(req, res, url) {
  if (req.method !== "POST" || !url.pathname.endsWith("/import")) return false;

  try {
    const body = await readJsonBody(req, res);
    if (!body || !Array.isArray(body.fragments)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "body.fragments array required" }));
      return true;
    }

    const pool     = getPrimaryPool();
    const required = ["content", "topic", "type"];
    let imported   = 0;
    let skipped    = 0;

    for (const frag of body.fragments) {
      if (!required.every(f => f in frag)) {
        skipped++;
        continue;
      }

      await pool.query(`
        INSERT INTO agent_memory.fragments
          (id, content, topic, type, keywords, importance, source, agent_id, key_id, is_anchor)
        VALUES
          (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING
      `, [
        frag.id ?? null,
        frag.content,
        frag.topic,
        frag.type,
        frag.keywords ?? [],
        frag.importance ?? 0.5,
        frag.source ?? null,
        frag.agent_id ?? "default",
        frag.key_id ?? null,
        frag.is_anchor ?? false
      ]);
      imported++;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ imported, skipped }));
  } catch (err) {
    logError("[Admin] /import error:", err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Internal error" }));
  }
  return true;
}
