// Vercel Blob helpers — server-only. Inputs and results live in Blob, never on disk.
// Kie result links expire in ~20 minutes (see notes/kie/common/*.md), so every result is copied
// into Blob on the first success observation. Copies are idempotent: running finish twice keeps
// the same stored URL because the blob key is derived from the job id + index.
//
// Transport: zero dependencies. Vercel Blob exposes a small HTTP API; we call it directly with
// the BLOB_READ_WRITE_TOKEN so this phase needs no package.json. If the token is absent every
// function throws a clear Error before any network call.

export const BLOB_BASE = 'https://blob.vercel-storage.com';

function token(): string {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  return t;
}

/** Copy a public URL into Blob. Returns the durable Blob URL. */
export async function copyUrlToBlob(
  sourceUrl: string,
  key: string,
  contentType?: string,
): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(`could not download result (${res.status}) for ${sourceUrl}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = contentType || res.headers.get('content-type') || 'application/octet-stream';
  const url = new URL(BLOB_BASE);
  url.pathname = `/${encodeURIComponent(key)}`;
  url.searchParams.set('addRandomSuffix', '0');
  url.searchParams.set('cacheControlMaxAge', '31536000');

  const put = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      'x-api-token': token(),
      'x-content-type': ct,
      'x-add-random-suffix': '0',
      'x-overwrite': '1',
    },
    body: buf,
  });
  if (!put.ok) {
    const text = await put.text().catch(() => '');
    throw new Error(`blob upload failed (${put.status}): ${text.slice(0, 200)}`);
  }
  const data = (await put.json().catch(() => ({}))) as { url?: string };
  if (!data.url) throw new Error('blob upload did not return a url');
  return data.url;
}

/** Copy every result URL in order. Keys are stable per job so retries reuse the same blob. */
export async function copyResultsToBlob(
  jobId: string,
  urls: string[],
  contentType?: string,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const ext = extensionOf(urls[i]);
    const key = `backlot/${jobId}/${i}${ext}`;
    out.push(await copyUrlToBlob(urls[i], key, contentType));
  }
  return out;
}

function extensionOf(url: string): string {
  try {
    const p = new URL(url).pathname;
    const m = /\.[a-z0-9]{2,5}$/i.exec(p);
    return m ? m[0] : '';
  } catch {
    return '';
  }
}

/**
 * Issue a client-upload token so the browser writes straight to Blob and never posts a multi-MB
 * base64 body to the function (Vercel caps request bodies at ~4.5 MB).
 */
export function issueUploadToken(filename: string): { token: string; clientUrl: string; key: string } {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'upload';
  const key = `backlot/uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  const clientUrl = `${BLOB_BASE}/${encodeURIComponent(key)}`;
  return { token: token(), clientUrl, key };
}

export async function deleteBlob(url: string): Promise<void> {
  const res = await fetch(`${url}`, {
    method: 'DELETE',
    headers: { 'x-api-token': token() },
  });
  // 404 is fine: already gone.
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`blob delete failed (${res.status}): ${text.slice(0, 200)}`);
  }
}
