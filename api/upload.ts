// POST /api/upload — issue a Vercel Blob client-upload token so the browser writes files straight
// to Blob. This is what keeps multi-MB inputs (up to 9 reference images) off the function's request
// body (Vercel caps bodies at ~4.5 MB).
import { issueUploadToken } from "../lib/blob";

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
  const filename = typeof body.filename === "string" ? body.filename : "";
  if (!filename) {
    res.status(400).json({ error: "filename is required" });
    return;
  }
  try {
    const { token, clientUrl, key } = issueUploadToken(filename);
    res.status(200).json({ token, url: clientUrl, key });
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
}
