// POST /api/gallery/register — register a creation made entirely in the browser (e.g. the vertical
// crop) so it appears in the gallery like any generated result. No Kie task involved.
import { insertCreation } from "../lib/spend";
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
  const url = typeof body.url === "string" ? body.url : "";
  if (!kind || !url) {
    res.status(400).json({ error: "kind and url are required" });
    return;
  }
  try {
    const id = await insertCreation(getDb(), {
      jobId: "browser", // no job row: this was made client-side
      kind,
      blobUrl: url,
      meta: { label: typeof body.label === "string" ? body.label : kind },
    });
    res.status(200).json({ ok: true, id });
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
}
