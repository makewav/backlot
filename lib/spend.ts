/**
 * lib/spend.ts — spend-protection + persistence layer (Phase 2b).
 *
 * Zero third-party dependencies. This file owns:
 *   (a) a `Db` interface + `createDb()` factory so Phase 2c can inject the real
 *       Postgres driver (`@vercel/postgres` / `pg`) without changing call sites;
 *   (b) `SCHEMA_SQL` — the jobs / creations / daily_usage / rate_events tables
 *       exactly as specified in PORT_PLAN.md §5 (Data model);
 *   (c) async `checkGuards(db, feature)` — kill switch, daily cap, concurrency
 *       cap, rate limit, prompt length cap (each throwing a clear user-facing
 *       Error), returning a `guardToken`;
 *   (d) job CRUD + creation CRUD + daily usage helpers;
 *   (e) an in-memory credits cache with a 60 s TTL (NO network in this file —
 *       the balance fetch lives in lib/kie.ts).
 *
 * Guards protect Kie credits via caps/limits, not identity: this is a
 * single-user personal tool with no app-level login.
 */

// ---------------------------------------------------------------------------
// Db interface + factory
// ---------------------------------------------------------------------------

/** One SQL result row set: array of plain objects keyed by column name. */
export type Row = Record<string, unknown>;

/**
 * Minimal queryable database handle. Phase 2c injects the real driver:
 *
 *   const db = createDb({ query: (sql, params) => pool.query(sql, params) });
 *
 * `query` must accept `$1..$n` placeholders and return `rows`.
 */
export interface Db {
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** Anything that structurally satisfies the query shape (pg Pool, @vercel/postgres sql, …). */
export interface DbLike {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

/** Wrap a driver handle in the `Db` interface. */
export function createDb(driver: DbLike): Db {
  if (!driver || typeof driver.query !== "function") {
    throw new Error("createDb: driver must expose a query(sql, params) function");
  }
  return {
    query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
      return driver.query(sql, params as unknown[]) as Promise<{ rows: T[] }>;
    },
  };
}

// ---------------------------------------------------------------------------
// SCHEMA_SQL — PORT_PLAN.md §5 data model (full SQL in notes/06-spend-db.md)
// ---------------------------------------------------------------------------

export const SCHEMA_SQL = `
-- jobs: one row per generation request (async job contract lives here).
CREATE TABLE IF NOT EXISTS jobs (
  id             uuid PRIMARY KEY,
  feature        text NOT NULL,
  model          text NOT NULL,
  kie_task_id    text UNIQUE,
  status         text NOT NULL,
  prompt         text,
  input          jsonb,
  result         jsonb,
  credits        numeric,
  cost_time      int,
  fail_code      text,
  fail_msg       text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  last_polled_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at);

-- creations: the gallery (one Blob-hosted output per successful job, may be several).
CREATE TABLE IF NOT EXISTS creations (
  id         uuid PRIMARY KEY,
  job_id     uuid REFERENCES jobs (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  blob_url   text NOT NULL,
  poster_url text,
  meta       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- daily_usage: one row per UTC date; drives the daily job cap.
CREATE TABLE IF NOT EXISTS daily_usage (
  day date PRIMARY KEY,
  jobs int NOT NULL DEFAULT 0
);

-- rate_events: one row per accepted request; drives the per-minute rate limit.
CREATE TABLE IF NOT EXISTS rate_events (
  id bigserial PRIMARY KEY,
  at  timestamptz NOT NULL DEFAULT now(),
  route text
);
CREATE INDEX IF NOT EXISTS rate_events_at_idx ON rate_events (at);
`;

// ---------------------------------------------------------------------------
// Guard configuration (env vars + defaults)
// ---------------------------------------------------------------------------

/** Kill switch. Anything other than the exact string "true" fails CLOSED. Default: unset (disabled). */
export const ENV_KILL_SWITCH = "GENERATION_ENABLED";
/** Daily job cap. Default: 50. */
export const ENV_DAILY_JOB_CAP = "DAILY_JOB_CAP";
/** Concurrent running jobs. Default: 2. */
export const ENV_MAX_CONCURRENT_JOBS = "MAX_CONCURRENT_JOBS";
/** Accepted requests per rolling 60 s. Default: 5. */
export const ENV_RATE_LIMIT_PER_MIN = "RATE_LIMIT_PER_MIN";
/** Maximum prompt length in characters. Default: 7000 (Kie H3 documented 1–7000). */
export const ENV_MAX_PROMPT_CHARS = "MAX_PROMPT_CHARS";

const DEFAULT_DAILY_JOB_CAP = 50;
const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const DEFAULT_RATE_LIMIT_PER_MIN = 5;
const DEFAULT_MAX_PROMPT_CHARS = 7000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The five limits, resolved from env with defaults — exported so api/status can echo them. */
export function guardLimits() {
  return {
    generationEnabled: process.env[ENV_KILL_SWITCH] === "true",
    dailyJobCap: envInt(ENV_DAILY_JOB_CAP, DEFAULT_DAILY_JOB_CAP),
    maxConcurrentJobs: envInt(ENV_MAX_CONCURRENT_JOBS, DEFAULT_MAX_CONCURRENT_JOBS),
    rateLimitPerMin: envInt(ENV_RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN),
    maxPromptChars: envInt(ENV_MAX_PROMPT_CHARS, DEFAULT_MAX_PROMPT_CHARS),
  };
}

// ---------------------------------------------------------------------------
// checkGuards — the five spend gates
// ---------------------------------------------------------------------------

/** A caller-supplied request scope: which route/feature is asking, and its prompt. */
export interface GuardRequest {
  /** Route or feature name recorded on the rate event, e.g. "generate" or "image". */
  route: string;
  /** Prompt text checked against MAX_PROMPT_CHARS. */
  prompt?: string;
}

/**
 * Run every spend gate in order (cheap → expensive → input cap). Throws an
 * `Error` with a clear user-facing message the moment one trips. Returns a
 * `guardToken` the caller passes to `recordRateEvent` only AFTER a successful
 * Kie createTask, so refused requests never consume the rate budget.
 *
 * Order:
 *  1. kill switch   GENERATION_ENABLED === "true"
 *  2. daily cap     daily_usage.jobs vs DAILY_JOB_CAP (default 50)
 *  3. concurrency   running jobs vs MAX_CONCURRENT_JOBS (default 2)
 *  4. rate limit    rate_events in last 60 s vs RATE_LIMIT_PER_MIN (default 5)
 *  5. prompt length prompt length vs MAX_PROMPT_CHARS (default 7000)
 */
export async function checkGuards(db: Db, feature: string | GuardRequest): Promise<string> {
  const req: GuardRequest = typeof feature === "string" ? { route: feature } : feature;
  const limits = guardLimits();

  // 1. Kill switch — fails CLOSED. Anything but the exact string "true" refuses.
  if (!limits.generationEnabled) {
    throw new Error("generation is disabled");
  }

  // 2. Daily cap — today's row in daily_usage (UTC day).
  const dayRow = await db.query<{ jobs: number }>(
    "SELECT jobs FROM daily_usage WHERE day = (now() AT TIME ZONE 'utc')::date"
  );
  const usedToday = Number(dayRow.rows[0]?.jobs ?? 0);
  if (usedToday >= limits.dailyJobCap) {
    throw new Error(
      `daily limit reached: ${usedToday}/${limits.dailyJobCap} jobs used today; resets at midnight UTC`
    );
  }

  // 3. Concurrency cap — jobs still running right now.
  const runRow = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM jobs WHERE status IN ('running','queued','waiting','queuing','generating')"
  );
  const running = Number(runRow.rows[0]?.n ?? 0);
  if (running >= limits.maxConcurrentJobs) {
    throw new Error(
      `too many jobs running: ${running}/${limits.maxConcurrentJobs}; wait for one to finish`
    );
  }

  // 4. Rate limit — rate_events in the last 60 seconds.
  const rateRow = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM rate_events WHERE at > now() - interval '60 seconds'"
  );
  const recent = Number(rateRow.rows[0]?.n ?? 0);
  if (recent >= limits.rateLimitPerMin) {
    throw new Error(
      `rate limit: ${recent}/${limits.rateLimitPerMin} requests in the last minute; wait a moment`
    );
  }

  // 5. Prompt length cap — Kie documents 1–7000 characters.
  const prompt = req.prompt ?? "";
  if (prompt.length > limits.maxPromptChars) {
    throw new Error(
      `prompt too long: ${prompt.length} characters (max ${limits.maxPromptChars})`
    );
  }

  // Token the caller records AFTER a successful create (see recordRateEvent).
  return newToken(req.route);
}

/** Opaque guard token: timestamp + random, decodable by recordRateEvent. */
function newToken(route: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}.${r}.${route}`;
}

/** Parse a guard token; returns null when malformed or older than 5 minutes. */
function parseToken(token: string): { at: number; route: string } | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const at = Number.parseInt(parts[0], 36);
  if (!Number.isFinite(at)) return null;
  if (Date.now() - at > 5 * 60 * 1000) return null; // stale token
  return { at, route: parts[2] };
}

/**
 * Record the rate event AFTER the caller successfully created the Kie task.
 * Uses the guardToken from checkGuards so refused requests never consume the
 * rate budget. A stale/malformed token records under the given fallback route.
 */
export async function recordRateEvent(db: Db, token: string, route = "unknown"): Promise<void> {
  const parsed = parseToken(token);
  await db.query("INSERT INTO rate_events (at, route) VALUES (now(), $1)", [
    parsed ? parsed.route : route,
  ]);
}

// ---------------------------------------------------------------------------
// Job CRUD
// ---------------------------------------------------------------------------

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRow extends Row {
  id: string;
  feature: string;
  model: string;
  kie_task_id: string | null;
  status: string;
  prompt: string | null;
  input: unknown;
  result: unknown;
  credits: unknown;
  cost_time: number | null;
  fail_code: string | null;
  fail_msg: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  last_polled_at: string | null;
}

export interface StartJobInput {
  feature: string;
  model: string;
  prompt?: string;
  input?: unknown;
}

/** Insert a new job row (status 'queued') and return its uuid (crypto.randomUUID). */
export async function startJob(db: Db, params: StartJobInput): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO jobs (id, feature, model, status, prompt, input, created_at, updated_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, now(), now())`,
    [id, params.feature, params.model, params.prompt ?? null, JSON.stringify(params.input ?? null)]
  );
  return id;
}

/** Fields a caller may patch when a job finishes or progresses. */
export interface JobPatch {
  status?: JobStatus;
  kie_task_id?: string;
  result?: unknown;
  credits?: number;
  cost_time?: number;
  fail_code?: string;
  fail_msg?: string;
  finished_at?: Date | null;
  last_polled_at?: Date | null;
}

const JOB_PATCH_COLUMNS: ReadonlyArray<keyof JobPatch> = [
  "status",
  "kie_task_id",
  "result",
  "credits",
  "cost_time",
  "fail_code",
  "fail_msg",
  "finished_at",
  "last_polled_at",
];

/** Patch a job by id: sets listed columns + updated_at = now(). No-op if id unknown. */
export async function finishJob(db: Db, id: string, patch: JobPatch): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const col of JOB_PATCH_COLUMNS) {
    if (patch[col] !== undefined) {
      sets.push(`${col} = $${i++}`);
      const v = patch[col];
      params.push(col === "result" && v !== null && v !== undefined ? JSON.stringify(v) : v);
    }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = now()`);
  params.push(id);
  await db.query(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $${i}`, params);
}

/** Read one job by id, or null when unknown. */
export async function getJob(db: Db, id: string): Promise<JobRow | null> {
  const res = await db.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Creation CRUD (gallery)
// ---------------------------------------------------------------------------

export interface CreationRow extends Row {
  id: string;
  job_id: string | null;
  kind: string;
  blob_url: string;
  poster_url: string | null;
  meta: unknown;
  created_at: string;
}

/** Newest creations of one kind (gallery default: 60). */
export async function listCreations(db: Db, kind: string, limit = 60): Promise<CreationRow[]> {
  const res = await db.query<CreationRow>(
    `SELECT * FROM creations WHERE kind = $1 ORDER BY created_at DESC LIMIT $2`,
    [kind, limit]
  );
  return res.rows;
}

/**
 * Delete one creation. The gallery identifies rows by (kind, blob filename):
 * we match the row whose blob_url path ends in `/<name>` and delete it.
 * Returns true when a row was deleted.
 */
export async function deleteCreation(db: Db, kind: string, name: string): Promise<boolean> {
  const res = await db.query<{ id: string }>(
    `DELETE FROM creations
      WHERE kind = $1
        AND (blob_url = $2 OR blob_url LIKE '%/' || $2)
      RETURNING id`,
    [kind, name]
  );
  return (res.rows?.length ?? 0) > 0;
}

/** Insert a gallery row for a finished job. Returns the creation id. */
export async function insertCreation(
  db: Db,
  params: { jobId: string; kind: string; blobUrl: string; posterUrl?: string; meta?: unknown }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO creations (id, job_id, kind, blob_url, poster_url, meta, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      id,
      params.jobId,
      params.kind,
      params.blobUrl,
      params.posterUrl ?? null,
      JSON.stringify(params.meta ?? null),
    ]
  );
  return id;
}

// ---------------------------------------------------------------------------
// Daily usage
// ---------------------------------------------------------------------------

/** Upsert today's row: jobs = jobs + 1 (UTC date key). */
export async function incrementDailyUsage(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO daily_usage (day, jobs)
     VALUES ((now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (day) DO UPDATE SET jobs = daily_usage.jobs + 1`,
    []
  );
}

/** Today's usage count (0 when no row yet) — for api/status's `dailyUsed`. */
export async function getDailyUsage(db: Db): Promise<number> {
  const res = await db.query<{ jobs: number }>(
    "SELECT jobs FROM daily_usage WHERE day = (now() AT TIME ZONE 'utc')::date"
  );
  return Number(res.rows[0]?.jobs ?? 0);
}

// ---------------------------------------------------------------------------
// Credits cache — in-memory, 60 s TTL, NO network in this file
// ---------------------------------------------------------------------------

export interface CreditsSnapshot {
  balance: number;
  fetchedAt: number;
}

const CREDITS_TTL_MS = 60_000;

/**
 * Process-local credits cache. lib/kie.ts performs the actual network fetch;
 * this map only stores the last value with a 60 s TTL so api/status can show a
 * low-credit warning without hammering Kie.
 */
const creditsCache = new Map<string, CreditsSnapshot>();

/** Read the cached balance; null when absent or older than 60 s. */
export function getCreditsSnapshot(key = "default"): CreditsSnapshot | null {
  const hit = creditsCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > CREDITS_TTL_MS) {
    creditsCache.delete(key);
    return null;
  }
  return hit;
}

/** Store a balance fetched by lib/kie.ts (called from the status route). */
export function setCreditsSnapshot(balance: number, key = "default"): CreditsSnapshot {
  const snap: CreditsSnapshot = { balance, fetchedAt: Date.now() };
  creditsCache.set(key, snap);
  return snap;
}

/** Drop the cached balance (forces the next status call to re-fetch). */
export function clearCreditsCache(key = "default"): void {
  creditsCache.delete(key);
}

export interface CheckCreditsResult {
  /** Cached balance, or null when the cache is cold/expired (caller should fetch via lib/kie.ts). */
  balance: number | null;
  /** true when balance is known and below LOW_CREDIT_THRESHOLD. */
  low: boolean;
  /** Age of the cached value in ms, or null when cold. */
  ageMs: number | null;
}

/** Threshold below which api/status flags a low-credit warning. */
export const ENV_LOW_CREDIT_THRESHOLD = "LOW_CREDIT_THRESHOLD";
const DEFAULT_LOW_CREDIT_THRESHOLD = 100;

/**
 * Read-only credits helper: reads the in-memory cache only (60 s TTL).
 * Never performs network I/O. `low` is true when a known balance is below
 * LOW_CREDIT_THRESHOLD (default 100 credits).
 */
export function checkCredits(key = "default"): CheckCreditsResult {
  const snap = getCreditsSnapshot(key);
  const threshold = envInt(ENV_LOW_CREDIT_THRESHOLD, DEFAULT_LOW_CREDIT_THRESHOLD);
  if (!snap) return { balance: null, low: false, ageMs: null };
  return {
    balance: snap.balance,
    low: snap.balance < threshold,
    ageMs: Date.now() - snap.fetchedAt,
  };
}