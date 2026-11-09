// GET /api/jobs/[id] — the polling endpoint. Contract preserved from the original app so the
// browser's jfetch() survives: 202 while running (with {job,state,elapsed,progress}), and the
// final result object when done. On first success it copies every Kie result into Blob (Kie
// links expire in ~20 min) before returning, so the URL the UI shows is durable.
import { getTask, parseStates, type KieState } from "../../lib/kie";
import { copyResultsToBlob } from "../../lib/blob";
import { getJob, finishJob, insertCreation } from "../../lib/spend";
import { getDb } from "../../lib/db";

interface Req {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  json(payload: unknown): void;
}

// Poll cadence: only ask Kie if the row is older than this (keeps polls cheap + respects limits).
const KIE_STALE_MS = 3000;

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function handler(req: Req, res: Res) {
  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const id = first(req.query.id);
  if (!id) {
    res.status(400).json({ error: "missing job id" });
    return;
  }

  let db;
  try {
    db = getDb();
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
    return;
  }

  const job = await getJob(db, id);
  if (!job) {
    res.status(404).json({ error: "no such job" });
    return;
  }

  const created = new Date(job.created_at as string | number | Date).getTime();
  const elapsed = Math.max(0, Math.round((Date.now() - created) / 1000));

  // Terminal rows replay their stored result directly (idempotent — no re-poll, no re-copy).
  if (job.status === "done") {
    res.status(200).json(job.result);
    return;
  }
  if (job.status === "failed") {
    res.status(500).json({ error: job.fail_msg || "generation failed", kieCode: job.fail_code });
    return;
  }

  // Running: re-read from Kie only if the row is stale, otherwise answer from the DB.
  const lastPolled = job.last_polled_at ? new Date(job.last_polled_at as string | number | Date).getTime() : 0;
  const stale = Date.now() - lastPolled >= KIE_STALE_MS;

  if (stale) {
    const taskId = job.kie_task_id as string | null;
    if (!taskId) {
      // Row exists but Kie id not yet written (very short window) — keep waiting.
      res.status(202).json({ job: id, state: "queued", elapsed, progress: { state: "queued" } });
      return;
    }
    let task;
    try {
      task = await getTask(taskId);
    } catch (e) {
      // Transient Kie/network error: do not fail the job; answer 202 and let the next poll retry.
      res.status(202).json({ job: id, state: "running", elapsed, progress: { state: "retrying" } });
      return;
    }

    const info = parseStates(task.state as KieState);

    if (info.active) {
      await finishJob(db, id, { status: "running", last_polled_at: new Date() });
      res.status(202).json({
        job: id,
        state: task.state,
        elapsed,
        progress: { state: task.state, progress: task.progress ?? 0 },
      });
      return;
    }

    if (info.ok && task.result?.resultUrls?.length) {
      // Copy to Blob NOW (20-minute link expiry), then finish the job idempotently.
      let stored: string[];
      try {
        stored = await copyResultsToBlob(id, task.result.resultUrls);
      } catch (e) {
        // Copy failed (e.g. link already expired because nobody polled) — fail loudly.
        await finishJob(db, id, {
          status: "failed",
          fail_msg: "result link expired before it could be saved: " + (e as Error).message,
          last_polled_at: new Date(),
        });
        res.status(500).json({ error: "result expired before it could be saved" });
        return;
      }
      const result = {
        url: stored[0],
        urls: stored,
        taskId: id,
        credits: task.creditsConsumed ?? undefined,
        took: task.costTime ?? undefined,
        feature: job.feature,
        model: job.model,
      };
      await finishJob(db, id, {
        status: "done",
        result,
        credits: task.creditsConsumed ?? undefined,
        cost_time: task.costTime ?? undefined,
        finished_at: new Date(),
        last_polled_at: new Date(),
      });
      await insertCreation(db, {
        jobId: id,
        kind: kindOf(job.feature as string),
        blobUrl: stored[0],
        meta: { label: job.feature, prompt: job.prompt, credits: task.creditsConsumed },
      }).catch(() => undefined); // gallery insert is best-effort; job already done
      res.status(200).json(result);
      return;
    }

    // Terminal failure (or success with no URLs).
    const msg = task.failMsg || (info.ok ? "task finished with no result" : "generation failed");
    await finishJob(db, id, {
      status: "failed",
      fail_code: task.failCode ?? undefined,
      fail_msg: msg,
      credits: task.creditsConsumed ?? undefined,
      finished_at: new Date(),
      last_polled_at: new Date(),
    });
    res.status(500).json({ error: msg, kieCode: task.failCode ?? undefined });
    return;
  }

  // Not stale: answer 202 from the stored row.
  res.status(202).json({ job: id, state: job.status, elapsed, progress: { state: job.status } });
}

function kindOf(feature: string): string {
  if (feature === "t2v" || feature === "i2v" || feature === "refv" || feature === "orbit" ||
      feature === "motion" || feature === "chain" || feature === "upscale-video" || feature === "cine-multi") {
    return "video";
  }
  if (feature === "cutout" || feature === "upscale-image" || feature === "t2i" ||
      feature === "img2img" || feature === "edit" || feature === "identity" ||
      feature === "style" || feature === "angles" || feature === "layout") {
    return "image";
  }
  return "image";
}
