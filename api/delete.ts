// POST /api/delete — remove one creation (DB row + Blob object). Single-user tool; no auth in the
// app (access control is Vercel deployment protection).
import { deleteCreation } from "../lib/spend";
import { deleteBlob } from "../lib/blob";
import { getDb } from "../lib/db";

interface Req {
  method?: string;
  body: unknown;
}
interface Res {
  status(code: number): Res;
  json(payload: unknown): void;
}

export default async function handler(req: Req, res: Res) {
  if (req.method && req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = typeof body.kind === "string" ? body.kind : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!kind || !name) {
    res.status(400).json({ error: "bad kind or name" });
    return;
  }

  try {
    const db = getDb();
    // Resolve the blob URL first so we can delete the object too.
    const row = await db.query(
      `SELECT blob_url FROM creations WHERE kind = $1 AND (blob_url ILIKE '%' || $2) LIMIT 1`,
      [kind, name],
    );
    const url = (row.rows[0]?.blob_url as string | undefined) ?? null;
    const removed = await deleteCreation(db, kind, name);
    if (!removed) {
      res.status(404).json({ error: "no such creation" });
      return;
    }
    if (url) {
      try {
        await deleteBlob(url);
      } catch {
        // Blob delete is best-effort; the row is already gone.
      }
    }
    res.status(200).json({ ok: true, deleted: name });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
