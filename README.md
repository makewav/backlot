# Backlot

A one-window video and image studio. Generation runs on **Kie AI**; the app runs on **Vercel**.

This is the Vercel + Kie AI port of [the original Backlot](https://github.com/Arfolomew/backlot), which was a
local ComfyUI studio. The original is MIT-licensed; the licence and copyright notice are kept in
[LICENSE](LICENSE). This fork is not affiliated with, endorsed by, or sponsored by Higgsfield or Comfy Org.

**Status: v1 port in progress.** The local engine is stripped (Phase 1) and every feature is kept; each one
is being re-pointed at a hosted Kie model. The Kie layer, screens, spend protection and the preview
deployment follow in Phases 2–6. See [PORT_PLAN.md](PORT_PLAN.md) for the audit, the feature → model
conversion map and the parity notes.

## What it does

Six tabs, all converted from the local build to hosted models:

- **Video** — text to video, image to video, reference mode (up to 9 images and 3 audio clips),
  360 orbit, camera-motion moves, latent-style chaining (continue from a captured last frame).
- **Image** — text to image, image to image, style reference, identity edit, instruction edit,
  camera angles, poster layout, transparent PNG, token weighting, vertical crops, upscale.
- **Moves** — the 30 one-click camera moves and effects; LoRA-driven moves use a rendered motion
  reference where the hosted model supports motion transfer.
- **Cinema** — pickers compose a multi-shot prompt; renders as one clip.
- **Apps** — Angles, Relight, Cutout, 4K Upscale, 360 Orbit, Character Swap.
- **Audio** — song and sound-effect panels (hosted audio path not yet verified).

Where a local LoRA or custom node has no hosted equivalent, the feature still ships and is marked
approximate in the port report; frame interpolation is the one capability with no hosted path.

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
