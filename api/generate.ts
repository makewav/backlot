// POST /api/generate — the single generation entry point for every feature.
// Flow (PORT_PLAN §5): validate + spend guards -> Kie createTask -> jobs row -> {job} at once.
// The browser polls /api/jobs/<id>; this route never renders a result itself.
import { FEATURES, normalize, buildFor, type Feature } from "../lib/registry";
import { createTask } from "../lib/kie";
import { checkGuards, recordRateEvent, startJob, incrementDailyUsage } from "../lib/spend";
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
  const feature = String(body.feature ?? "") as Feature;

  // 1. Guards: kill switch, daily cap, concurrency, rate limit, prompt cap.
  let guardToken: string;
  try {
    const db = getDb();
    guardToken = await checkGuards(db, {
      route: "generate",
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }

  // 2. Validate + build the exact Kie `input` against the typed registry.
  let built: ReturnType<typeof buildFor>;
  try {
    if (!FEATURES[feature]) throw new Error(`unknown feature: ${feature || "(missing)"}`);
    built = buildFor(feature, (body.input ?? body) as Record<string, unknown>);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  const prompt = typeof body.prompt === "string" ? body.prompt
    : (built.input as Record<string, unknown>).prompt as string | undefined;

  // 3. Create the Kie task (server-side only; the key never reaches the browser).
  let taskId: string;
  try {
    const task = await createTask({
      model: built.kieModel,
      input: built.input,
      callBackUrl: undefined, // protected preview URL cannot receive callbacks — rely on polling
    });
    taskId = task.taskId;
  } catch (e) {
    const err = e as Error & { kieCode?: number };
    res.status(400).json({ error: err.message, kieCode: err.kieCode });
    return;
  }

  // 4. Persist the job + consume rate/daily budget, then hand the job id back immediately.
  try {
    const db = getDb();
    const jobId = await startJob(db, { feature, model: built.kieModel, prompt, input: built.input });
    await db.query(
      `UPDATE jobs SET kie_task_id = $1, status = 'queued', updated_at = now() WHERE id = $2`,
      [taskId, jobId],
    );
    await recordRateEvent(db, guardToken, "generate");
    await incrementDailyUsage(db);
    res.status(202).json({ job: jobId, taskId });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
