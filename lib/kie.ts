/**
 * lib/kie.ts — zero-dependency Kie API client (Phase 2b).
 *
 * Implements the three Common/Market endpoints verified in the cached docs under
 * `notes/kie/` (paths and response shapes are documented line-by-line in
 * `notes/05-kie-client.md`):
 *
 *   - `createTask`  POST /api/v1/jobs/createTask
 *   - `getTask`     GET  /api/v1/jobs/recordInfo?taskId=...
 *   - `getCredits`  GET  /api/v1/chat/credit
 *
 * Kie's documented behavior: HTTP status is often 200 even when the request
 * failed — the real result is `body.code` (200 = success, anything else is an
 * error described by `body.msg`). Every response is therefore parsed and checked
 * regardless of HTTP status. On failure we throw an `Error` carrying `.kieCode`
 * and `.kieMsg` so callers (api/generate, api/status) can map codes to user copy.
 *
 * Env: `KIE_API_KEY` only, read from `process.env` with no default. If it is
 * missing (or blank), every exported function throws `KIE_API_KEY is not set`
 * *before* any network I/O.
 *
 * No third-party dependencies (global `fetch`, Node 18+ / Vercel Edge).
 */

export const KIE_BASE = "https://api.kie.ai";

/** Error thrown for every Kie failure. `.kieCode` is body.code, `.kieMsg` is body.msg. */
export class KieError extends Error {
  kieCode: number;
  kieMsg: string;
  constructor(message: string, kieCode: number, kieMsg: string) {
    super(message);
    this.name = "KieError";
    this.kieCode = kieCode;
    this.kieMsg = kieMsg;
  }
}

function requireApiKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error("KIE_API_KEY is not set");
  }
  return key;
}

/** Shared JSON request. Parses the body; throws KieError when body.code !== 200. */
async function kieFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${KIE_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new KieError(`kie: non-JSON response (HTTP ${res.status})`, res.status, await textOrEmpty(res));
  }

  if (typeof body?.code === "number" && body.code !== 200) {
    throw new KieError(body.msg || `kie error ${body.code}`, body.code, body.msg || "");
  }
  // Some proxies return HTTP-level errors without a numeric code.
  if (!res.ok && typeof body?.code !== "number") {
    throw new KieError(`kie: HTTP ${res.status}`, res.status, await textOrEmpty(res));
  }
  return body;
}

async function textOrEmpty(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------

export interface CreateTaskParams {
  model: string;
  input: Record<string, unknown>;
  callBackUrl?: string;
}

export interface CreateTaskResult {
  taskId: string;
}

/**
 * POST /api/v1/jobs/createTask
 * Body: { model, input, callBackUrl? }
 * Success: { code: 200, msg, data: { taskId } }
 * Failure: { code: 401|402|422|429|433|455|500|501|505, msg, ... }
 */
export async function createTask(params: CreateTaskParams): Promise<CreateTaskResult> {
  const body = await kieFetch("/api/v1/jobs/createTask", {
    method: "POST",
    body: JSON.stringify({
      model: params.model,
      input: params.input,
      ...(params.callBackUrl ? { callBackUrl: params.callBackUrl } : {}),
    }),
  });

  const taskId = body?.data?.taskId;
  if (!taskId || typeof taskId !== "string") {
    throw new KieError("kie: createTask returned no taskId", body?.code ?? 500, body?.msg ?? "");
  }
  return { taskId };
}

// ---------------------------------------------------------------------------
// getTask
// ---------------------------------------------------------------------------

/** Kie task states. */
export type KieState = "waiting" | "queuing" | "generating" | "success" | "fail";

/** Parsed shape of `data.resultJson` (itself a JSON string inside the record). */
export interface TaskResult {
  resultUrls?: string[];
  lastFrameUrl?: string[];
  resultObject?: Record<string, unknown>;
}

export interface GetTaskResult {
  taskId: string;
  model: string;
  state: KieState;
  /** Raw resultJson string as returned by Kie (null/empty on failure). */
  resultJson: string | null;
  /** Parsed resultJson — null when absent or unparseable. */
  result: TaskResult | null;
  failCode: string | null;
  failMsg: string | null;
  progress: number | null;
  creditsConsumed: number | null;
  costTime: number | null;
  createTime: number | null;
  completeTime: number | null;
}

/**
 * GET /api/v1/jobs/recordInfo?taskId=...
 * Returns { code, msg, data: { taskId, model, state, param, resultJson, failCode,
 *   failMsg, costTime, completeTime, createTime, creditsConsumed, progress, ... } }
 * `resultJson` is a JSON STRING holding e.g. { resultUrls: [...] } — parse once here.
 */
export async function getTask(taskId: string): Promise<GetTaskResult> {
  const body = await kieFetch(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    method: "GET",
  });

  const data = body?.data;
  if (!data || typeof data !== "object") {
    throw new KieError("kie: recordInfo returned no data", body?.code ?? 500, body?.msg ?? "");
  }

  const rawResultJson: string | null =
    typeof data.resultJson === "string" && data.resultJson !== "" ? data.resultJson : null;
  let parsed: TaskResult | null = null;
  if (rawResultJson) {
    try {
      parsed = JSON.parse(rawResultJson) as TaskResult;
    } catch {
      parsed = null; // leave unparseable resultJson as null result
    }
  }

  return {
    taskId: data.taskId ?? taskId,
    model: data.model ?? "",
    state: (data.state ?? "waiting") as KieState,
    resultJson: rawResultJson,
    result: parsed,
    failCode: typeof data.failCode === "string" ? data.failCode : null,
    failMsg: typeof data.failMsg === "string" && data.failMsg !== "" ? data.failMsg : null,
    progress: typeof data.progress === "number" ? data.progress : null,
    creditsConsumed: typeof data.creditsConsumed === "number" ? data.creditsConsumed : null,
    costTime: typeof data.costTime === "number" ? data.costTime : null,
    createTime: typeof data.createTime === "number" ? data.createTime : null,
    completeTime: typeof data.completeTime === "number" ? data.completeTime : null,
  };
}

// ---------------------------------------------------------------------------
// getCredits
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/chat/credit
 * Returns { code: 200, msg: "success", data: 100.5 } — `data` is a plain number.
 *
 * Path found in `notes/kie/common/common-api__get-account-credits.md` line 12
 * (`/api/v1/chat/credit`) and confirmed in `notes/kie/common/common-api__quickstart.md`
 * lines 48/55/71 and `notes/kie/common/market__quickstart.md` line 159.
 */
export async function getCredits(): Promise<number> {
  const body = await kieFetch("/api/v1/chat/credit", { method: "GET" });
  const data = body?.data;
  if (typeof data !== "number") {
    throw new KieError("kie: credits response missing numeric data", body?.code ?? 500, body?.msg ?? "");
  }
  return data;
}

// ---------------------------------------------------------------------------
// States helper
// ---------------------------------------------------------------------------

export interface StateInfo {
  state: KieState;
  /** True when the task is still in flight (keep polling). */
  active: boolean;
  /** True when the task reached a terminal state (success or fail). */
  done: boolean;
  /** True only for "success" — safe to read `result.resultUrls` and copy to Blob. */
  ok: boolean;
  /** Short human description for UI/status copy. */
  description: string;
}

const STATE_DESCRIPTIONS: Record<KieState, string> = {
  waiting: "Task queued and waiting to be processed",
  queuing: "Task in the processing queue",
  generating: "Task is currently being generated",
  success: "Task completed successfully",
  fail: "Task failed — check failMsg",
};

/**
 * Map a Kie task state to caller-facing flags and copy.
 *
 * waiting/queuing/generating → keep polling (active).
 * success                    → terminal, result.resultUrls available (copy to Blob NOW — links expire ~20 min).
 * fail                       → terminal, read failCode/failMsg for the error copy.
 *
 * The recordInfo response may also include a numeric `progress` (0-100) alongside
 * the coarse state — use it for the bar, but always branch on `state` first.
 */
export function parseStates(state: KieState): StateInfo {
  const terminal = state === "success" || state === "fail";
  return {
    state,
    active: !terminal,
    done: terminal,
    ok: state === "success",
    description: STATE_DESCRIPTIONS[state] ?? "Unknown state",
  };
}