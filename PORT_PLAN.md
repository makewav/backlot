# PORT_PLAN.md — Backlot → Vercel + Kie AI

**Phase 0 (read and report).** Read-only audit of the upstream repo; no app code changed yet.
Written 2026-11-06 by the agent for @DO. **Waiting for your go-ahead before Phase 1.**

- Snapshot audited: `github.com/Arfolomew/backlot` @ `main` = `c28a493` ("Audio: takes queue as background jobs…", 2026-10-28), clean tree, 116 files / ~83 MB.
- **No fork URL was supplied**, so I read the upstream tree (identical content) into `src_upstream/`. Phase 1 will work in your fork — see question 1.
- Full raw inventories (line-cited) are in `notes/`: `01-server-routes.md` (564 lines), `02-ui-inventory.md` (354), `03-engine-inventory.md` (693). Cached Kie OpenAPI docs: `notes/kie/`.

---

## 1. What the repo is today (one paragraph)

A single-user, local **ComfyUI studio**: one plain-HTML page (`app/index.html`, 2,115 lines, no build step) with six tabs — **Video, Image, Moves, Cinema, Apps, Audio** — talking to one Python stdlib `ThreadingHTTPServer` (`app/server.py`, 1,971 lines, 25 route patterns, no framework). Every render is a ComfyUI graph built by `app/comfy_backend.py` + `app/workflows/` and run on a 16 GB RTX 4070 Ti SUPER through `comfy-api-proxy`; outputs land in a local `output/` folder and are served by filename. There are **14 model families across 17 render graphs** (MiniMax H3 t2v/i2v, H3 Ref2VA, ORB360, Camera-Motion LoRA, Character Swap/SAM3, LTX-2.5, Krea 2 + style/identity LoRAs, Qwen Image 2.1, Qwen-Edit-2511 + angle LoRA, MOSS-Image, SeedVR2, RealESRGAN+RIFE, YuE2, Stable Audio 3) and ~100 GB of weights. It already has an async job contract (`X-Backlot-Async: 1` → `202 {job}` → poll `/api/jobs/<id>`), which the browser persists in `localStorage` so a reload survives a 7-minute render.

**The audit in the brief is right about the shape and wrong about the size**: `app/server.py`, `app/index.html` and `app/workflows/` were never opened by the auditor (GitHub folder listings are blocked). The real surface is ~25 routes and 6 tabs, not "a route per feature" — the brief's v1 list of 8 features touches roughly two of the six tabs.

---

## 2. Every route and what it does

Dispatched by literal string compare in `H._dispatch` (`server.py:896-1957`); `Async` = can run through the `X-Backlot-Async` job wrapper. "Port" = what happens in v1.

| # | Method | Path | Purpose (today) | Async | Port v1 |
|---|---|---|---|---|---|
| 1 | GET | `/`, `/index.html` | serve the UI | – | **static** `public/index.html` |
| 2 | GET | `/favicon.ico` | 32×32 PNG | – | static |
| 3 | GET | `/api/jobs/<id>` | poll a job: 202 `{job,state,elapsed,progress}` while running, replay final response when done, 404 if lost | – | **keep contract**, backed by Postgres + Kie `recordInfo` |
| 4 | GET | `/api/jobs` | list all jobs | – | drop (unused by UI) |
| 5 | GET | `/api/cinema` | Cinema picker catalog (`cinema.json`) | – | static JSON / drop with tab (v2) |
| 6 | GET | `/api/moves` | Moves catalog + preview/poster URLs (`moves.json`, 30 moves) | – | static JSON / drop with tab (v2) |
| 7 | GET | `/previews/<rel>` | serve committed preview mp4/jpg (moves, cinema, apps) | – | static assets (if kept) |
| 8 | GET | `/api/heartbeat` | "a window is open", feeds the VRAM idle watchdog | – | **delete** |
| 9 | GET | `/api/status` | `{comfy: bool, idle:{…}}` for the header dot | – | **replace**: `{kie, credits, killSwitch, dailyUsed, cap}` |
| 10 | GET | `/api/chains` | latent-chain project folders in ComfyUI's output dir | – | **delete** (no equivalent) |
| 11 | GET | `/api/gallery?kind=` | newest 60 files + tag metadata | – | **rebuild** on Postgres + Blob |
| 12–15 | GET | `/images/*`, `/audio/*`, `/outputs/*`, `/previews/*` | serve generated media by filename | – | Blob URLs instead |
| 16 | GET | `/api/audio/loras` | YuE2 LoRA catalog | – | drop with Audio tab |
| 17 | POST | `/api/closing` | pagehide beacon → hand GPU back in ~8 s | – | **delete** |
| 18 | POST | `/api/delete` | delete one creation + meta + mastered-song siblings | – | **rebuild** (DB row + Blob delete) |
| 19 | POST | `/api/cinema/compose` | pure text: pickers → one H3 multi-shot prompt | – | **keep** (cheap, no model) if Cinema returns in v2 |
| 20 | POST | `/api/video` | H3 **t2v / i2v / ref / orbit / swap**, Moves, Cinema, camera LoRA; LTX-2.5 via `model:"ltx25"` | yes | **replace** with `/api/generate` (Kie) |
| 21 | POST | `/api/free` | unload ComfyUI weights, report MiB freed | – | **delete** |
| 22 | POST | `/api/audio` | YuE2 song or Stable Audio 3 SFX → mastered MP3 | yes | drop (v2 at best) |
| 23 | POST | `/api/image` (`model:"moss"`) | MOSS text / **layout JSON** / img2img | yes | drop |
| 24 | POST | `/api/image` (`model:"qwen21"`) | Qwen Image 2.1 text/edit, RGBA transparent | yes | **replace** with `/api/generate` |
| 25 | POST | `/api/image` (catch-all) | Krea 2 text/img2img/style-ref/identity + Qwen-Edit + **Angles** (96 positions) | yes | **replace** with `/api/generate` |
| 26 | POST | `/api/vertical` | PIL crop to 9:16 / 4:5 then SeedVR2 upscale | yes | **browser canvas** + optional Topaz |
| 27 | POST | `/api/image-upscale` | SeedVR2 4K / 2× | yes | **Topaz** `topaz/image-upscale` |
| 28 | POST | `/api/upscale` | video upscale: SeedVR2, or RealESRGAN "fast" + optional RIFE | yes | **Topaz** `topaz/video-upscale` |
| 29 | POST | `/api/slowmo` | RIFE ×2 + `atempo=0.5` → 2× longer clip | yes | drop (no ffmpeg) |

Quirks worth knowing: no `do_OPTIONS` (CORS preflight 501 but `ACAO:*` on everything), HTTP/1.0, no `Range` support, malformed JSON tears the connection, unknown `mode` on `/api/video` silently runs H3 t2v, unknown `model` on `/api/image` silently runs Krea, `/api/image` is three handlers on one path, and job bodies live in a process-local `JOBS` dict (lost on restart). All of this disappears with real function routes.

---

## 3. Kie facts verified today (not guessed)

I pulled the OpenAPI spec of each candidate model from `docs.kie.ai/market/<slug>.md` (saved to `notes/kie/`). Endpoints are the ones the brief specifies: `POST https://api.kie.ai/api/v1/jobs/createTask`, `GET …/api/v1/jobs/recordInfo?taskId=`, Bearer auth, errors in the **body** (`code` 200/401/402/422/429/433/455/500/501/505) with HTTP 200, callback `code:200|501`.

| Feature | Verified model id | Required input (as documented) |
|---|---|---|
| text → video | `minimax-h3/text-to-video` | `prompt` (1–7000), `aspect_ratio` 21:9/16:9/4:3/1:1/3:4/9:16, `duration` **4–15 integer**, `resolution` 768P/2K |
| image → video | `minimax-h3/image-to-video` | `prompt`, `first_frame_url` (+ optional `last_frame_url`), `duration`, `resolution` |
| reference → video | `minimax-h3/reference-to-video` | `prompt`, `reference_image_urls[]`, `reference_video_urls[]`, `reference_audio_urls[]`, `aspect_ratio`, `duration`, `resolution` |
| text → image | `qwen/text-to-image` **or** `seedream/4.5-text-to-image` **or** `google/nano-banana` | (schema in `notes/kie/`, parse in Phase 2) |
| image → image / edit | `qwen/image-edit` **or** `seedream/4.5-edit` **or** `google/nano-banana-edit` | ditto |
| upscale (image) | `topaz/image-upscale` | image URL + target |
| upscale (video) | `topaz/video-upscale` | video URL + target |
| transparent PNG | `recraft/remove-background` | image URL → PNG with alpha |
| credits | Kie Common API account-credits endpoint | balance for the header |

Kie H3 **always generates audio** (cannot be turned off) and returns `resultJson` containing `resultUrls`; the task record also exposes `failMsg`, `progress`, `creditsConsumed` — exactly what the brief asks us to read. Two retention facts from the docs matter more than the brief suggests: **`resultUrls` download links are valid for only 20 minutes** (some model pages say 1 hour), while generated media is kept 14 days and Kie's own uploaded files are deleted after 24 h. The Blob copy must therefore happen on the first successful status check or callback — a job that finished while the browser was closed for an hour may no longer be downloadable.

---

## 4. Feature-by-feature fate

"Kie model" is the verified id above; "—" means no verified hosted equivalent. This table covers **everything in the repo**, not only the brief's v1 list, because the repo has more features than the audit knew.

### 4.1 v1 (must work before Phase 6)

| Feature | Today | Fate | Kie model | Notes |
|---|---|---|---|---|
| Text to video (MiniMax H3) | Video→Text, LTX alternative | **keep** | `minimax-h3/text-to-video` | width/height/seconds/steps/seed → `aspect_ratio` + integer `duration` + `resolution` |
| Image to video (MiniMax H3) | Video→Image, first frame center-cropped server-side | **keep** | `minimax-h3/image-to-video` | crop in browser (canvas), upload to Blob, pass `first_frame_url` |
| Text to image | Image→Text (Krea 2 / Qwen / MOSS) | **keep** | `qwen/text-to-image` (or Seedream 4.5 / Nano Banana — your call) | |
| Image to image / instruction edit | Image→Image/Edit (Krea img2img, Qwen edit) | **keep** | `qwen/image-edit` (or Seedream 4.5 edit / Nano Banana edit) | one unified "edit" screen in v1 |
| Upscale to 4K (image) | SeedVR2 (or ESRGAN "fast") | **keep** | `topaz/image-upscale` | |
| Upscale (video) | SeedVR2 video / ESRGAN | **keep** (cheap) | `topaz/video-upscale` | Topaz is in the brief's triage |
| Transparent PNG / cutout | Qwen 2.1 `transparent` flag, or Apps→Cutout | **keep** | `recraft/remove-background` | generate still → remove background → PNG with alpha |
| Vertical crops for phones | server-side PIL crop + SeedVR2 | **keep** | — (browser canvas; optional `topaz/image-upscale` after) | brief says "do in browser" |

### 4.2 Later (v2 — worth doing, not v1)

| Feature | Today | Fate | Kie model / path | Why later |
|---|---|---|---|---|
| Reference mode (≤9 images + ≤3 audio) | Video→Reference (H3 Ref2VA) | **later** | `minimax-h3/reference-to-video` | model exists and is a cheap v2; the UI (9-image reorder, 3 audio) is real work |
| Latent chaining (Motion Context) | ref mode + ComfyUI latent files | **later** | approximate: i2v `last_frame_url` → next clip `first_frame_url` | brief allows "continue from a captured last frame"; no latent access |
| Cinema Studio (multi-shot prompt composer) | 7 pickers + `/api/cinema/compose` | **later** | H3 t2v (prompt-only) | pure text logic, no model — cheap to re-enable; multi-shot behaviour unverified on Kie H3 |
| Apps → Relight | Qwen-Edit instruction | **later** | `qwen/image-edit` | one prompt change |
| Audio: song / SFX | YuE2 3B / Stable Audio 3 + mastering chain | **later** | unverified (Kie has audio models; needs its own survey) | no verified model in this pass; whole third engine stack |
| Moves prompt-effect presets (3 of 30: disintegration, freeze, clone-burst) | prompt-only effects on H3 | **later** | H3 t2v/t2i | the 27 LoRA moves die; 3 prompt moves are portable if Moves returns |

### 4.3 Drop (delete in Phase 1)

| Feature | Today | Why it dies |
|---|---|---|
| 360 Orbit (Video + Apps) | ORB360 LoRA, 124 frames | requires the local LoRA + fixed timing |
| Camera Motion LoRA (27 of 30 Moves) | Camera-motion LoRA, trigger word | requires the local LoRA |
| Moves tab as a whole | 30 presets, 60 preview files | only 3 presets survive; tab goes with them in v1 |
| Apps tab: Angles (96 positions) | Qwen-Edit + fal Multiple-Angles LoRA | LoRA not on Kie |
| Apps tab: Character Swap | SAM 3.1 + h3-relay + 124-frame windows | no hosted equivalent |
| Apps tab: 360 Orbit | ORB360 LoRA | as above |
| Style reference (Krea) | Krea style LoRA | approximate only; keep as v2 idea |
| Identity edit (Krea 2 Identity v1.2) | Krea identity LoRA + custom nodes | no hosted equivalent |
| MOSS-Image text/layout/img2img | local model + layout-JSON contract | no hosted layout equivalent |
| LTX-2.5 second video model | local 22B distilled | no verified Kie model in this pass |
| Video upscale "fast" (RealESRGAN) + RIFE | local binaries | needs ffmpeg/GPU models; Topaz replaces |
| 2× slow motion | RIFE + `atempo=0.5` | needs ffmpeg; no hosted equivalent |
| Free VRAM / GPU hand-back / idle watchdog | `/api/free`, `/api/heartbeat`, `/api/closing`, 20 s watchdog, `nvidia-smi` | no GPU |
| Latent chaining server side (`/api/chains`, `chain_index`, `chain_project`) | reads ComfyUI output dir | no filesystem |
| Local job registry, output folders, meta sidecars | `JOBS`, `output/{videos,images,…}` | replaced by Postgres + Blob |
| `BACKLOT_PASSWORD` Basic auth | optional local auth | replaced by Vercel deployment protection |

---

## 5. Target design (v1)

**Stack: TypeScript Vercel Functions in `api/` + the plain-HTML front end as static files** — as the brief prefers (Blob/Postgres helpers are JS-first). No Python functions: nothing in the v1 surface needs Python once ffmpeg/PIL/comfy are gone (browser does the crops). This is the one place the brief asks for a justification, so: recorded here.

```
api/generate.ts        POST  validate → spend gates → Kie createTask → jobs row → {job}
api/jobs/[id].ts       GET   DB row; if running & stale, re-read Kie recordInfo, update; 202 while running
api/upload.ts          POST  Vercel Blob client-upload token (browser → Blob direct, bypasses 4.5 MB body cap)
api/status.ts          GET   {kie, credits, killSwitch, dailyUsed, dailyCap, concurrency}
api/gallery.ts         GET   creations from Postgres + Blob URLs (replaces /api/gallery)
api/delete.ts          POST  DB row + Blob delete
api/callback.ts        POST  optional: ignore body, re-fetch task from Kie, idempotent finish
lib/kie.ts             server-only Kie client: createTask, recordInfo, credits, error-body parsing
lib/registry.ts        typed registry: feature → model id + zod input schema + result normaliser
lib/db.ts              Postgres (jobs, creations, daily_usage, rate_events)
lib/spend.ts           kill switch, daily cap, concurrency cap, rate limit, prompt/size caps
lib/blob.ts            copy result URLs into Blob on success (Kie expiry), delete helpers
public/index.html      the existing UI (edited: tabs, wording, upload, crop, polling, gallery)
public/previews/…      only the media we keep (see question 6)
```

**Data model (Postgres):**

```sql
jobs(id uuid pk, feature text, model text, kie_task_id text unique, status text,
     prompt text, input jsonb, result jsonb, credits numeric, cost_time int,
     fail_code text, fail_msg text, created_at timestamptz, updated_at timestamptz,
     finished_at timestamptz, last_polled_at timestamptz)
creations(id uuid pk, job_id uuid, kind text, blob_url text, poster_url text,
          meta jsonb, created_at timestamptz)         -- the gallery
daily_usage(day date pk, jobs int)                      -- the daily cap
rate_events(id bigserial pk, at timestamptz, route text) -- rate limiting
```

**Request flow:** browser → `POST /api/upload` (Blob token) → upload file → `POST /api/generate {feature, prompt, …}` → gates (kill switch, daily cap, concurrency, rate limit, input caps) → `createTask` → `jobs` row → `{job}` → browser polls `/api/jobs/<id>` every 3 s with backoff → function checks the row, and if stale re-reads Kie `recordInfo`; on `success` it downloads `resultUrls` into Blob, writes `creations`, marks done → browser shows the Blob URL. Kie callbacks stay optional (a protected preview URL cannot receive them — the brief says rely on polling).

**Env vars:** `KIE_API_KEY` (server only), `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `PUBLIC_BASE_URL`, `DAILY_JOB_CAP`, `GENERATION_ENABLED` (+ new: `MAX_CONCURRENT_JOBS`, `MAX_PROMPT_CHARS`, `RATE_LIMIT_PER_MIN`).

**Security:** no app login (per brief). Key never leaves the server; no Kie call from the browser. Access control = Vercel Deployment Protection (Standard/All Deployments, Hobby caveat noted in §7 of the brief). Kill switch fails closed; every generate refuses when `GENERATION_ENABLED !== "true"`.

---

## 6. Surprises that change the plan

1. **The app is ~4× the surface the audit assumed.** 6 tabs, 25 routes, 14 model families, 30 moves, 6 apps, 2 audio engines. The brief's v1 list (8 features) covers Video (2 modes) and Image (2 modes + upscale + transparent + crop) only. Everything else has to be explicitly hidden or deleted — I need your call on whether the Moves/Cinema/Apps/Audio tabs disappear or show as "coming in v2" (§7 Q2).
2. **There is no "Free VRAM button".** It is an automatic `POST /api/free` on every tab switch, a 5 s heartbeat, a `pagehide` beacon and a 20 s idle watchdog that unloads ComfyUI via `nvidia-smi`. "Remove the button" = delete the whole lifecycle subsystem + the header status pill's backend semantics, and decide what the pill says instead.
3. **The async job contract already exists and maps 1:1 onto Kie.** `jfetch()` adds `X-Backlot-Async: 1`, gets `202 {job}`, polls `/api/jobs/<id>` every 1 s, resumes from `localStorage` after reload. Keeping that contract (submit → `{job}` → poll) means the browser's render call sites barely change; only the payload fields and the progress semantics change (Kie gives task states, not `step 9/21 · node A/B`).
4. **Kie's inputs are not the repo's inputs.** H3 t2v takes `aspect_ratio` + integer `duration` 4–15 + `resolution` 768P/2K — no width/height, no steps, no seed, no camera-LoRA toggle. The Video screen's duration slider (2–10 s, 17n+5 frames), seed field, steps, and camera toggle have to be replaced with the Kie option set; that is a real UI change, not just a URL swap.
5. **Kie result links expire in ~20 minutes** (verified in the common API docs: download links valid 20 minutes; some model pages say 1 hour; generated media kept 14 days; Kie's own uploads deleted after 24 h). Every result must be copied into Blob **immediately** on the first success observation — not "eventually". The status handler therefore does the copy before marking a job `done` (idempotent, safe to run twice), and the optional callback does the same. A job that finished while nobody polled for over 20 minutes may be unrecoverable; the UI must say so instead of showing a dead URL.
6. **Base64 request bodies vs Vercel's ~4.5 MB cap is the single biggest server change.** The UI sends up to 9 images + 3 audio clips in one JSON body today, and every file goes through `FileReader.readAsDataURL`. Direct-to-Blob upload is mandatory, not optional.
7. **Nine of the repo's sixteen render capabilities have no verified hosted equivalent** (ORB360, camera-motion, SAM3 character swap, Krea style/identity, MOSS layout, LTX-2.5, SeedVR2, RealESRGAN/RIFE, YuE2/SA3). The port is therefore a *much smaller* app than the repo. That is expected by the brief's triage, but the repo made it look like a thin wrapper.
8. **Progress semantics change.** Today's bar is sampler-step based (`step X/Y · node A/B`) from SDK events. Kie exposes coarse states (`waiting`, `queuing`, `generating`, `success`, `fail`) plus a numeric `progress`. The bar becomes progress/queue-based, and the "estimated time" copy has to go.
9. **Hallucination risk in the UI copy.** The page carries local-hardware claims ("on this card", "16 GB card", "local", "first run loads a 10 GB model", "ComfyUI 0.42"). All of it must be rewritten; the brief's "keep the look and feel" means styling, not claims.
10. **The four H3 prompt dialects are load-bearing.** FL2VA wants an alignment line first, Ref2VA a six-section 350–500-word prompt, Cinema an `integrated_multimodal_description / overall_soundscape / non_diegetic_music` block, Moves a comma list with a LoRA trigger. If Cinema/Moves come back, the composers are portable text, but the *model behaviour* behind Kie's H3 is unverified.
11. **Reference mode is cheaper than the brief implies.** The audit marks it "Later (v2)", but Kie exposes `minimax-h3/reference-to-video` with `reference_image_urls[]`, `reference_video_urls[]`, `reference_audio_urls[]` today. It is a strong v2 (or v1.1) candidate.
12. **`docs/models.md` is stale** (no LTX-2.5, MOSS, YuE2, SA3 entries) — do not use it as the model source of truth; the workflow builders and `setup/download-models.sh` disagree with it.
13. **Repo weight:** ~83 MB working tree, almost all committed media (~51 MB of previews — 27 MB of them the 30 move clips — plus a 28 MB demo video). Vercel can serve it, but shipping it all to the first preview is unnecessary (question 6).
14. **Local/network note:** this Windows box needs `git -c http.sslBackend=openssl` for GitHub (schannel is blocked) and the repo is slow to fetch (83 MB). Not a product issue, but it shapes the Phase 1 workflow.
15. **No tests, no CI.** The only "tests" are GPU-dependent shell smoke scripts. Verification must be the preview deployment + one cheap job per feature (Phase 5), which requires your spending approval.

---

## 7. Decisions I need from you

1. **Fork.** No fork URL was in the brief. `gh` is logged in here as **`makewav`** with `repo` scope. May I create `makewav/backlot` (public fork of `Arfolomew/backlot`) and work/push there, or will you paste your fork URL? I will never push to the original.
2. **Which tabs survive v1.** Plan A (recommended): ship **Video** and **Image** tabs only; hide Moves / Cinema / Apps / Audio behind a "v2" note (keeps the shell visibly intact). Plan B: delete the four panels and their JS outright. Plan C: keep Cinema in v1 (it is prompt-only and cheap) — say so and I will include it.
3. **Stills model choice** (all three verified on Kie): `qwen/text-to-image` + `qwen/image-edit` (closest to today's Qwen lineage, one provider), `seedream/4.5-*` (newer, likely stronger), or `google/nano-banana*` (edit-first). I will run one cheap job per family in Phase 5 if you allow the spend, then lock it.
4. **Keys and accounts.** I need (a) a Kie API key, (b) a Vercel project connected to the fork (the Vercel CLI is **not** installed here and there is no Vercel session — connecting the repo in the Vercel dashboard is the simplest path; previews then build on push), (c) a Blob store and a Postgres database (Vercel Blob + Neon/Vercel Postgres). Until (b)/(c) exist, Phase 1–2 code can still be written and reviewed. What is the **test-spend ceiling** (e.g. USD 2–5) and may I run one cheap job per feature?
5. **Video option mapping** (forced by Kie): aspect-ratio pills (21:9/16:9/4:3/1:1/3:4/9:16) + integer duration 4–15 s + resolution 768P/2K, replacing width/height + 2–10 s slider + steps/seed/camera toggle. Confirm that is acceptable, and whether 2K should be the default (Kie's default) or 768P (cheaper).
6. **Media assets.** Keep the ~51 MB of committed previews (27 MB are the 30 move clips, 8.7 MB the cinema sample, 0.9 MB the apps sample) and the 28 MB demo video in the deploy? My recommendation: drop all of it in v1; keep only `public/index.html` + the icons.
7. **Audio.** Confirm it is out of v1 (I have no verified Kie audio model yet; a separate survey would be needed).

---

## 8. Phase plan (what I will do after your go-ahead)

| Phase | Work | Gate |
|---|---|---|
| **1 — Strip** | Create the fork working tree; delete `app/comfy_backend.py`, `app/workflows/`, `setup/` (incl. the mastering venv chain), `tools/`, `start.sh`, `stop.sh`, `requirements.txt`, `docs/models.md`, `PARITY-PLAN.md`; move the UI to `public/`; remove the dropped features/wording from `index.html`; new `README.md` skeleton. **Keep `LICENSE` unchanged** — MIT, "Copyright (c) 2026 Jake Taylor"; the notice must travel with any copied `moves.json` / `cinema.json` / prompt text | preview loads with the shell |
| **2 — Kie layer** | `lib/kie.ts`, `lib/registry.ts` (typed, zod-validated, built from the cached OpenAPI docs), `api/generate`, `api/jobs/[id]`, `api/upload`, Postgres schema, Blob copy-on-success | unit-testable registry; no model call yet |
| **3 — Screens** | Rewire `index.html`: Blob uploads, `/api/generate` + poll, Kie option sets, browser crop, DB gallery, kill-switch/credits UI; delete free-VRAM/heartbeat/closing/chains | preview loads, no console errors |
| **4 — Spend protection** | Daily cap, concurrency cap, rate limit, input/prompt caps, low-credit warning, kill switch, callback route (idempotent) | cap refuses the N+1th job |
| **5 — Preview + test** | Set env vars (Preview + Production), deploy preview, one cheap job per v1 feature, log credits, verify Blob copy | every v1 feature produced a Blob-hosted result |
| **6 — Report** | `PORT_REPORT.md`: what works, what was cut and why, env vars, cost per job, exact Deployment Protection steps, gaps + v2 order | — |

Per the brief I will stop and check in after every phase, and never promote to production without your approval.

---

## 9. Open risks carried into the phases

- Kie's H3 may not accept the composed Cinema/Moves prompt formats identically (untested until an actual job).
- Exact per-model credit costs are not fully documented in the model pages; the report will quote `creditsConsumed` from real jobs rather than guess.
- `topaz/*-upscale`, `recraft/remove-background`, `qwen/*` input schemas are cached but not yet parsed field-by-field; Phase 2 parses them before writing the registry (no guessing).
- Vercel Hobby limits (function duration, body size, deployment protection on production) may force a paid plan for a fully protected production URL — the brief already flags this; I will report what the project actually offers at Phase 5.
