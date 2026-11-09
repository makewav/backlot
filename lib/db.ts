// Postgres access for the Vercel Functions. Injected into lib/spend.ts's Db interface so the
// guard/CRUD logic stays transport-free.
//
// The driver is resolved lazily at call time. Until Phase 5 provisions a database (installs
// @vercel/postgres and sets DATABASE_URL) every call throws a clear, actionable Error instead of
// failing silently — so /api/status reports the real state rather than a generic 500.
import { createDb, SCHEMA_SQL, type Db } from "./spend";

type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

let cached: Db | null = null;

function loadDriver(): QueryFn {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Provision a Postgres database and add DATABASE_URL to the Vercel project (Phase 5).",
    );
  }
  let mod: { query?: QueryFn } & Record<string, unknown>;
  try {
    // Deferred require: the package is installed during Phase 5 provisioning.
    mod = require("@vercel/postgres") as { query?: QueryFn };
  } catch {
    throw new Error(
      "@vercel/postgres is not installed. Run the Phase 5 provisioning step (npm i @vercel/postgres) before using the database routes.",
    );
  }
  if (typeof mod.query === "function") return mod.query.bind(mod);
  throw new Error("@vercel/postgres does not export query(); cannot reach Postgres.");
}

/** Lazily build the shared Db singleton. */
export function getDb(): Db {
  if (cached) return cached;
  const query = loadDriver();
  cached = createDb({ query });
  return cached;
}

/** Run SCHEMA_SQL once (idempotent). Called by a one-off provision step, not per request. */
export async function ensureSchema(): Promise<void> {
  await getDb().query(SCHEMA_SQL);
}

export type { Db };
