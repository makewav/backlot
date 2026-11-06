# Backlot

A one-window video and image studio. Generation runs on **Kie AI**; the app runs on **Vercel**.

This is the Vercel + Kie AI port of [the original Backlot](https://github.com/Arfolomew/backlot), which was a
local ComfyUI studio. The original is MIT-licensed; the licence and copyright notice are kept in
[LICENSE](LICENSE). This fork is not affiliated with, endorsed by, or sponsored by Higgsfield or Comfy Org.

**Status: v1 port in progress.** The local engine is stripped (Phase 1); the Kie layer, screens, spend
protection and the preview deployment follow in Phases 2–6. See [PORT_PLAN.md](PORT_PLAN.md) for the full
audit, feature fate table and phase plan.

## What v1 will do

- **Video** — text to video and image to video with MiniMax H3 (with generated audio).
- **Image** — text to image, image to image and instruction edits.
- **Upscale** — image and video upscaling.
- **Cutout** — transparent PNGs via background removal.
- **Vertical crops** — crop a still to 9:16 or 4:5 in the browser.

Dropped in the port because they need a local model or GPU tool (LoRAs, SAM 3.1, ffmpeg, local checkpoints):
360 Orbit, the Camera Motion LoRA moves, Character Swap, Krea style/identity edit, MOSS layout posters,
LTX-2.5, SeedVR2/RealESRGAN upscalers, RIFE slow motion, YuE2 / Stable Audio music, latent chaining.
Reference-to-video (Kie has it) is a v2 candidate.

## How it is built

```
public/index.html   the UI: plain HTML and JavaScript, no build step
api/                Vercel Functions (TypeScript) — to be added in Phase 2
lib/                server-only modules: Kie client, model registry, db, blob, spend guards
```

Generation never happens in the browser and the Kie API key never reaches the browser: the front end calls
only this app's own `/api/*` routes. Results and inputs live in Vercel Blob; job history and the daily
usage cap live in Postgres.

## Configuration (planned, Phase 2–5)

| Variable | Meaning |
|---|---|
| `KIE_API_KEY` | Kie API key — server-side only |
| `DATABASE_URL` | Postgres connection string (jobs, gallery, daily usage) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token (inputs and results) |
| `PUBLIC_BASE_URL` | public origin of the deployment |
| `DAILY_JOB_CAP` | maximum generation jobs per day |
| `GENERATION_ENABLED` | kill switch: generation is refused unless this is `"true"` |

## Local development

Phase 2 adds `vercel dev` and the required environment variables. Until then the UI can be previewed as
static files: serve `public/` with any static server.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Jake Taylor.
