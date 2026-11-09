// GET /api/status — what the header pill and any spend UI need: is generation enabled, the
// credit balance (cached 60 s), today's usage vs cap, and the configured guard limits.
import { getCredits } from "../lib/kie";
import { guardLimits, checkCredits, setCreditsSnapshot, getDailyUsage, ENV_LOW_CREDIT_THRESHOLD } from "../lib/spend";
import { getDb } from "../lib/db";

interface Res {
  status(code: number): Res;
  json(payload: unknown): void;
}
interface Req {
  method?: string;
}

export default async function handler(req: Req, res: Res) {
  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const limits = guardLimits();
  let credits = checkCredits();

  // Refresh the balance when the cache is cold or older than 60 s. Failures (key unset, Kie down)
  // must not break the status pill — report whatever we last had, or null.
  if (credits.ageMs === null || credits.ageMs > 60_000) {
    try {
      const balance = await getCredits();
      setCreditsSnapshot(balance);
      credits = checkCredits();
    } catch {
      // leave credits as-is (possibly null)
    }
  }

  let dailyUsed = 0;
  let dbOk = true;
  try {
    dailyUsed = await getDailyUsage(getDb());
  } catch {
    dbOk = false;
  }

  const lowThreshold = Number(process.env[ENV_LOW_CREDIT_THRESHOLD] ?? 100);

  res.status(200).json({
    ok: true,
    generationEnabled: limits.generationEnabled,
    credits: credits.balance,
    low: credits.low,
    lowThreshold,
    dailyUsed,
    dailyCap: limits.dailyJobCap,
    limits: {
      dailyJobCap: limits.dailyJobCap,
      maxConcurrentJobs: limits.maxConcurrentJobs,
      rateLimitPerMin: limits.rateLimitPerMin,
      maxPromptChars: limits.maxPromptChars,
      lowCreditThreshold: lowThreshold,
    },
    database: dbOk && !!process.env.DATABASE_URL,
    blob: !!process.env.BLOB_READ_WRITE_TOKEN,
    kie: !!process.env.KIE_API_KEY,
  });
}
