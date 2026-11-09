// GET /api/gallery?kind=video|image|audio — newest creations for the strip. Backed by the
// creations table (Postgres) rather than a local output folder, so it survives serverless.
import { listCreations } from "../lib/spend";
import { getDb } from "../lib/db";

interface Req {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  json(payload: unknown): void;
}

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function handler(req: Req, res: Res) {
  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const kind = first(req.query.kind) || "video";

  let rows;
  try {
    rows = await listCreations(getDb(), kind, 60);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
    return;
  }

  // Same shape the original app served: { files: [name], tags: {name: {...}} }.
  const files: string[] = [];
  const tags: Record<string, Record<string, unknown>> = {};
  for (const r of rows) {
    const url = String(r.blob_url ?? "");
    const name = url.split("/").pop() || String(r.id);
    files.push(name);
    tags[name] = {
      label: (r.meta as Record<string, unknown> | null)?.label ?? name,
      url,
      prompt: (r.meta as Record<string, unknown> | null)?.prompt ?? null,
      credits: (r.meta as Record<string, unknown> | null)?.credits ?? null,
    };
  }
  res.status(200).json({ files, tags });
}
