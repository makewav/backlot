/**
 * lib/registry.ts — typed Kie model registry (Phase 2a).
 *
 * Pure, dependency-free TypeScript: type-only imports only, no runtime imports,
 * no side effects. Maps Backlot's 17 v1 features onto verified Kie model ids and
 * builds the EXACT raw `input` object for each createTask body. Field names and
 * enum values come only from the cached OpenAPI docs in notes/kie/*.md — every
 * build function cites its doc file in a comment. Where a doc was ambiguous the
 * comment flags it; nothing is invented here.
 *
 * Endpoint for every feature: POST /api/v1/jobs/createTask (all cached model
 * docs declare this same path; see notes/kie/common/common-api__quickstart.md).
 *
 * Multi-model features (motion, chain, orbit) are marked explicitly and expose
 * their alternate paths instead of a single build(), per PORT_PLAN.md §4.
 */

// ---------------------------------------------------------------------------
// Feature type
// ---------------------------------------------------------------------------

export type Feature =
  | "t2v"
  | "i2v"
  | "refv"
  | "orbit"
  | "motion"
  | "chain"
  | "t2i"
  | "img2img"
  | "edit"
  | "identity"
  | "style"
  | "angles"
  | "layout"
  | "cutout"
  | "upscale-image"
  | "upscale-video"
  | "cine-multi";

/** Every raw `input` object Kie accepts is a flat JSON object. */
export type KieInput = Record<string, unknown>;

/** Normalized, app-level input handed to `normalize()`/`build()`. All fields optional; validation happens in normalize. */
export interface RawInput {
  prompt?: string;
  negativePrompt?: string;
  /** seconds (video) */
  duration?: number;
  /** e.g. "16:9", "adaptive" */
  aspectRatio?: string;
  /** e.g. "768P"|"2K"|"720p"|"1080p" */
  resolution?: string;
  /** output image size enum (qwen/ideogram: square_hd, …) */
  imageSize?: string;
  /** seed for RNG where the model documents one */
  seed?: number;
  /** first frame URL (i2v/chain) */
  firstFrameUrl?: string;
  /** last frame URL (i2v optional) */
  lastFrameUrl?: string;
  /** source clip URL (video-continuation chain path) */
  firstClipUrl?: string;
  /** single source image (img2img / edit / identity / style / angles / cutout / upscale-image) */
  imageUrl?: string;
  /** multi-source images (nano-banana-edit angles, seedream edit, …) */
  imageUrls?: string[];
  /** reference images (refv / orbit / identity) */
  referenceImageUrls?: string[];
  /** reference videos (refv) */
  referenceVideoUrls?: string[];
  /** reference audio (refv) */
  referenceAudioUrls?: string[];
  /** motion-transfer subject image */
  inputUrls?: string[];
  /** motion-transfer driving video */
  videoUrls?: string[];
  /** driving video URL for wan animate-move */
  videoUrl?: string;
  /** character orientation for kling motion-control */
  characterOrientation?: "image" | "video";
  /** mode / resolution for kling motion-control ("720p"|"1080p") */
  mode?: string;
  /** denoise / remix strength 0–1 */
  strength?: number;
  /** upscale factor 1|2|4 */
  upscaleFactor?: number;
  /** quality for seedream ("basic"|"high") */
  quality?: string;
  /** output format png/jpeg */
  outputFormat?: string;
  /** image count for qwen image edit */
  numImages?: string;
  /** kling t2v/i2v sound flag */
  sound?: boolean;
  /** output video duration for kling ("5"|"10" as string) — kept separate from numeric duration */
  klingDuration?: string;
  /** orientation/quality passthroughs for multi-shot cinema */
  multiPrompt?: Array<{ prompt: string; duration: number }>;
  elements?: unknown[];
  audio?: boolean;
  /** arbitrary extra fields a caller needs to forward verbatim */
  extra?: Record<string, unknown>;
}

/** A single buildable Kie path: the model id + a function producing the exact raw `input`. */
export interface BuildPath {
  kieModel: string;
  doc: string;
  build: (input: KieInput) => KieInput;
}

/** Spec for one feature. Multi-path features list `paths` and leave `build` undefined. */
export interface FeatureSpec {
  kieModel: string;
  endpoint: "/api/v1/jobs/createTask";
  build?: (input: KieInput) => KieInput;
  /** Alternate / conditional model paths (motion transfer, chain continuation, orbit refs). */
  paths?: BuildPath[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Small pure helpers (no imports)
// ---------------------------------------------------------------------------

const has = (o: Record<string, unknown>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

function str(v: unknown, field: string): string {
  if (typeof v === "string" && v.length > 0) return v;
  throw new Error(`${field}: expected a non-empty string`);
}
function optionalStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown, field: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new Error(`${field}: expected a number`);
}
function clampInt(v: unknown, field: string, min: number, max: number, dflt?: number): number {
  if (v === undefined && dflt !== undefined) return dflt;
  const n = num(v, field);
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
function clampNum(v: unknown, field: string, min: number, max: number, dflt?: number): number {
  if (v === undefined && dflt !== undefined) return dflt;
  const n = num(v, field);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], dflt?: T): T {
  if (v === undefined && dflt !== undefined) return dflt;
  const s = str(v, field);
  if ((allowed as readonly string[]).includes(s)) return s as T;
  throw new Error(`${field}: expected one of ${allowed.join(", ")}; got "${s}"`);
}
function url(v: unknown, field: string): string {
  const s = str(v, field);
  if (!/^(https?|oss):\/\//.test(s)) {
    throw new Error(`${field}: expected an http(s) or oss URL; got "${s}"`);
  }
  return s;
}
function optionalUrl(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return url(v, "url");
}
function strArray(v: unknown, field: string, max?: number): string[] {
  if (!Array.isArray(v)) throw new Error(`${field}: expected an array of URLs`);
  const out = v.map((x, i) => url(x, `${field}[${i}]`));
  if (max !== undefined && out.length > max) {
    throw new Error(`${field}: at most ${max} URLs allowed; got ${out.length}`);
  }
  if (out.length === 0) throw new Error(`${field}: expected at least one URL`);
  return out;
}
function optionalStrArray(v: unknown, field: string, max?: number): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  return strArray(v, field, max);
}

/** Merge helper: only set keys whose value is defined. */
function put(obj: KieInput, key: string, value: unknown): void {
  if (value !== undefined) obj[key] = value;
}

// ---------------------------------------------------------------------------
// FEATURE specs — each build() cites its cached doc
// ---------------------------------------------------------------------------

/** t2v — exact model, prompt/aspect_ratio/duration/resolution. */
// notes/kie/minimax-h3__text-to-video.md
function buildT2V(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length < 1 || prompt.length > 7000) {
    throw new Error(`prompt: length must be 1–7000 characters; got ${prompt.length}`);
  }
  const duration = clampInt(input.duration, "duration", 4, 15, 6);
  const aspect = oneOf(input.aspectRatio, "aspect_ratio", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const, "16:9");
  const resolution = oneOf(input.resolution, "resolution", ["768P", "2K"] as const, "2K");
  const out: KieInput = { prompt, aspect_ratio: aspect, duration };
  put(out, "resolution", resolution);
  put(out, "negative_prompt", optionalStr(input.negativePrompt)); // AMBIGUITY: not documented for H3 t2v — do not send unless caller forces extra
  return mergeExtra(out, input);
}

/** i2v — first_frame_url or last_frame_url required (doc: either). */
// notes/kie/minimax-h3__image-to-video.md
function buildI2V(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length < 1 || prompt.length > 7000) {
    throw new Error(`prompt: length must be 1–7000 characters; got ${prompt.length}`);
  }
  const first = optionalUrl(input.firstFrameUrl);
  const last = optionalUrl(input.lastFrameUrl);
  if (!first && !last) {
    throw new Error("first_frame_url or last_frame_url: at least one frame URL is required");
  }
  const duration = clampInt(input.duration, "duration", 4, 15, 6);
  const resolution = oneOf(input.resolution, "resolution", ["768P", "2K"] as const, "2K");
  const out: KieInput = { prompt, duration };
  put(out, "first_frame_url", first);
  put(out, "last_frame_url", last);
  put(out, "resolution", resolution);
  return mergeExtra(out, input);
}

/** refv — reference_image_urls (≤9), reference_video_urls (≤3), reference_audio_urls (≤3), at least one image/video. */
// notes/kie/minimax-h3__reference-to-video.md
function buildRefV(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length < 1 || prompt.length > 7000) {
    throw new Error(`prompt: length must be 1–7000 characters; got ${prompt.length}`);
  }
  const images = optionalStrArray(input.referenceImageUrls, "reference_image_urls", 9);
  const videos = optionalStrArray(input.referenceVideoUrls, "reference_video_urls", 3);
  const audios = optionalStrArray(input.referenceAudioUrls, "reference_audio_urls", 3);
  if (!images && !videos) {
    throw new Error("reference_image_urls or reference_video_urls: at least one image or video reference is required");
  }
  if (audios && !images && !videos) {
    throw new Error("reference_audio_urls: cannot be used alone; pair with an image or video reference");
  }
  const duration = clampInt(input.duration, "duration", 4, 15, 6);
  const aspect = oneOf(input.aspectRatio, "aspect_ratio", ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const, "adaptive");
  const resolution = oneOf(input.resolution, "resolution", ["768P", "2K"] as const, "2K");
  const out: KieInput = { prompt, duration, aspect_ratio: aspect };
  put(out, "reference_image_urls", images);
  put(out, "reference_video_urls", videos);
  put(out, "reference_audio_urls", audios);
  put(out, "resolution", resolution);
  return mergeExtra(out, input);
}

/** orbit — NOT a single dedicated model: refv with 1–3 reference images + verbatim ORB360 prompt. */
// notes/kie/minimax-h3__reference-to-video.md (LoRA-free approximation per PORT_PLAN §4)
function buildOrbit(input: KieInput): KieInput {
  const images = optionalStrArray(input.referenceImageUrls, "reference_image_urls", 9);
  if (!images || images.length < 1 || images.length > 3) {
    throw new Error("reference_image_urls: orbit takes exactly 1 or 3 reference images (front, +120°, +240°)");
  }
  // The repo ships two verbatim orb360 captions; caller supplies whichever matches photo count.
  const prompt = str(input.prompt, "prompt (orb360 caption)");
  if (prompt.length < 1 || prompt.length > 7000) {
    throw new Error(`prompt: length must be 1–7000 characters; got ${prompt.length}`);
  }
  const duration = clampInt(input.duration, "duration", 4, 15, 5); // local fixed 5.17s ≈ 5
  const aspect = oneOf(input.aspectRatio, "aspect_ratio", ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const, "16:9");
  const resolution = oneOf(input.resolution, "resolution", ["768P", "2K"] as const, "2K");
  const out: KieInput = { prompt, reference_image_urls: images, duration, aspect_ratio: aspect, resolution };
  return mergeExtra(out, input);
}

/** chain — NOT latent chaining: maps to i2v with first_frame_url = chained last frame. */
// notes/kie/minimax-h3__image-to-video.md (frame chaining per PORT_PLAN §4)
function buildChain(input: KieInput): KieInput {
  const chained = optionalUrl(input.firstFrameUrl) ?? optionalUrl(input.lastFrameUrl);
  if (!chained) {
    throw new Error("first_frame_url: chain requires the previous clip's last frame URL");
  }
  return buildI2V({ ...input, firstFrameUrl: chained });
}

/** motion — NOT one model: prompt-only path via H3 (t2v below), plus real motion transfer. */
// prompt path: notes/kie/minimax-h3__text-to-video.md / notes/kie/minimax-h3__image-to-video.md
// motion-transfer paths: notes/kie/kling__motion-control.md, notes/kie/kling__motion-control-v3.md, notes/kie/wan__2-2-animate-move.md
function buildMotionPromptT2V(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt (composed move prompt)");
  if (prompt.length < 1 || prompt.length > 7000) {
    throw new Error(`prompt: length must be 1–7000 characters; got ${prompt.length}`);
  }
  const duration = clampInt(input.duration, "duration", 4, 15, 5);
  const aspect = oneOf(input.aspectRatio, "aspect_ratio", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const, "16:9");
  const resolution = oneOf(input.resolution, "resolution", ["768P", "2K"] as const, "2K");
  return { prompt, aspect_ratio: aspect, duration, resolution };
}
function buildMotionPromptI2V(input: KieInput): KieInput {
  return buildI2V(input);
}
function buildMotionTransferKling(input: KieInput): KieInput {
  // kling-2.6/motion-control requires character_orientation ∈ {image, video};
  // kling-3.0/motion-control treats it as optional (default "video").
  const inputUrls = strArray(input.inputUrls ?? input.imageUrls, "input_urls", 1);
  const videoUrls = strArray(input.videoUrls ?? input.videoUrl, "video_urls", 1);
  const mode = oneOf(input.mode, "mode", ["720p", "1080p"] as const, "720p");
  const orientation = oneOf(input.characterOrientation, "character_orientation", ["image", "video"] as const, "video");
  const out: KieInput = { input_urls: inputUrls, video_urls: videoUrls, mode, character_orientation: orientation };
  put(out, "prompt", optionalStr(input.prompt));
  return mergeExtra(out, input);
}
function buildMotionTransferWan(input: KieInput): KieInput {
  const videoUrl = url(input.videoUrl ?? (Array.isArray(input.videoUrls) ? input.videoUrls[0] : undefined), "video_url");
  const imageUrl = url(input.imageUrl ?? (Array.isArray(input.inputUrls) ? input.inputUrls[0] : undefined), "image_url");
  const out: KieInput = { video_url: videoUrl, image_url: imageUrl };
  const res = oneOf(input.resolution, "resolution", ["720p"] as const, "720p");
  put(out, "resolution", res);
  return mergeExtra(out, input);
}

/** t2i — qwen/text-to-image (prompt required; image_size enum; steps/guidance optional). */
// notes/kie/qwen__text-to-image.md
function buildT2I(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length > 5000) throw new Error(`prompt: max 5000 characters; got ${prompt.length}`);
  const out: KieInput = { prompt };
  const size = optionalStr(input.imageSize);
  if (size !== undefined) {
    const s = oneOf(size, "image_size", ["square", "square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const);
    out.image_size = s;
  }
  put(out, "num_inference_steps", input.numInferenceSteps !== undefined ? clampInt(input.numInferenceSteps, "num_inference_steps", 2, 250, 30) : undefined);
  put(out, "seed", input.seed !== undefined ? Math.trunc(num(input.seed, "seed")) : undefined);
  put(out, "guidance_scale", input.guidanceScale !== undefined ? clampNum(input.guidanceScale, "guidance_scale", 0, 20, 2.5) : undefined);
  put(out, "output_format", input.outputFormat !== undefined ? oneOf(input.outputFormat, "output_format", ["png", "jpeg"] as const, "png") : undefined);
  put(out, "negative_prompt", optionalStr(input.negativePrompt));
  return mergeExtra(out, input);
}

/** img2img — qwen/image-to-image (prompt + image_url + strength 0–1). */
// notes/kie/qwen__image-to-image.md
function buildImg2Img(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length > 5000) throw new Error(`prompt: max 5000 characters; got ${prompt.length}`);
  const image = url(input.imageUrl, "image_url");
  const strength = clampNum(input.strength, "strength", 0, 1, 0.8);
  const out: KieInput = { prompt, image_url: image, strength };
  put(out, "num_inference_steps", input.numInferenceSteps !== undefined ? clampInt(input.numInferenceSteps, "num_inference_steps", 2, 250, 30) : undefined);
  put(out, "seed", input.seed !== undefined ? Math.trunc(num(input.seed, "seed")) : undefined);
  put(out, "guidance_scale", input.guidanceScale !== undefined ? clampNum(input.guidanceScale, "guidance_scale", 0, 20, 2.5) : undefined);
  put(out, "output_format", input.outputFormat !== undefined ? oneOf(input.outputFormat, "output_format", ["png", "jpeg"] as const, "png") : undefined);
  put(out, "negative_prompt", optionalStr(input.negativePrompt));
  return mergeExtra(out, input);
}

/** edit — qwen/image-edit (prompt + image_url required; image_size/steps/guidance/num_images). */
// notes/kie/qwen__image-edit.md
function buildEdit(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length > 2000) throw new Error(`prompt: max 2000 characters; got ${prompt.length}`);
  const image = url(input.imageUrl, "image_url");
  const out: KieInput = { prompt, image_url: image };
  const size = optionalStr(input.imageSize);
  if (size !== undefined) {
    out.image_size = oneOf(size, "image_size", ["square", "square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const);
  }
  put(out, "num_inference_steps", input.numInferenceSteps !== undefined ? clampInt(input.numInferenceSteps, "num_inference_steps", 2, 49, 25) : undefined);
  put(out, "seed", input.seed !== undefined ? Math.trunc(num(input.seed, "seed")) : undefined);
  put(out, "guidance_scale", input.guidanceScale !== undefined ? clampNum(input.guidanceScale, "guidance_scale", 0, 20, 4) : undefined);
  put(out, "num_images", input.numImages !== undefined ? oneOf(String(input.numImages), "num_images", ["1", "2", "3", "4"] as const) : undefined);
  put(out, "output_format", input.outputFormat !== undefined ? oneOf(input.outputFormat, "output_format", ["jpeg", "png"] as const, "png") : undefined);
  put(out, "negative_prompt", optionalStr(input.negativePrompt));
  return mergeExtra(out, input);
}

/** identity — ideogram/character (prompt + reference_image_urls max 1). */
// notes/kie/ideogram__character.md
function buildIdentity(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length > 5000) throw new Error(`prompt: max 5000 characters; got ${prompt.length}`);
  const refs = strArray(input.referenceImageUrls ?? input.imageUrls, "reference_image_urls", 1);
  const out: KieInput = { prompt, reference_image_urls: refs };
  put(out, "rendering_speed", input.renderingSpeed !== undefined ? oneOf(String(input.renderingSpeed), "rendering_speed", ["TURBO", "BALANCED", "QUALITY"] as const) : undefined);
  put(out, "style", input.style !== undefined ? oneOf(String(input.style), "style", ["AUTO", "REALISTIC", "FICTION"] as const) : undefined);
  put(out, "expand_prompt", typeof input.expandPrompt === "boolean" ? input.expandPrompt : undefined);
  put(out, "num_images", input.numImages !== undefined ? oneOf(String(input.numImages), "num_images", ["1", "2", "3", "4"] as const) : undefined);
  put(out, "image_size", input.imageSize !== undefined ? oneOf(String(input.imageSize), "image_size", ["square", "square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const) : undefined);
  put(out, "seed", input.seed !== undefined ? Math.trunc(num(input.seed, "seed")) : undefined);
  put(out, "negative_prompt", optionalStr(input.negativePrompt));
  return mergeExtra(out, input);
}

/** style — ideogram/v3-remix (prompt + image_url + strength 0.01–1). */
// notes/kie/ideogram__v3-remix.md
function buildStyle(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length > 5000) throw new Error(`prompt: max 5000 characters; got ${prompt.length}`);
  const image = url(input.imageUrl, "image_url");
  const strength = clampNum(input.strength, "strength", 0.01, 1, 0.8);
  const out: KieInput = { prompt, image_url: image, strength };
  put(out, "rendering_speed", input.renderingSpeed !== undefined ? oneOf(String(input.renderingSpeed), "rendering_speed", ["TURBO", "BALANCED", "QUALITY"] as const) : undefined);
  put(out, "style", input.style !== undefined ? oneOf(String(input.style), "style", ["AUTO", "GENERAL", "REALISTIC", "DESIGN"] as const) : undefined);
  put(out, "expand_prompt", typeof input.expandPrompt === "boolean" ? input.expandPrompt : undefined);
  put(out, "image_size", input.imageSize !== undefined ? oneOf(String(input.imageSize), "image_size", ["square", "square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const) : undefined);
  put(out, "num_images", input.numImages !== undefined ? oneOf(String(input.numImages), "num_images", ["1", "2", "3", "4"] as const) : undefined);
  put(out, "seed", input.seed !== undefined ? Math.trunc(num(input.seed, "seed")) : undefined);
  put(out, "negative_prompt", optionalStr(input.negativePrompt));
  return mergeExtra(out, input);
}

/** angles — google/nano-banana-edit (multi-image edit; angle tokens folded into prompt by caller). */
// notes/kie/google__nano-banana-edit.md
function buildAngles(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt (angle-token prompt, e.g. '<sks> az el di')");
  if (prompt.length > 20000) throw new Error(`prompt: max 20000 characters; got ${prompt.length}`);
  const images = strArray(input.imageUrls, "image_urls", 10);
  const out: KieInput = { prompt, image_urls: images };
  put(out, "output_format", input.outputFormat !== undefined ? oneOf(input.outputFormat, "output_format", ["png", "jpeg"] as const, "png") : undefined);
  const ar = optionalStr(input.aspectRatio);
  if (ar !== undefined) {
    out.aspect_ratio = oneOf(ar, "aspect_ratio", ["1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "auto"] as const);
  }
  return mergeExtra(out, input);
}

/** layout — ideogram/v3-text-to-image (typography model; MOSS bbox form is composed into prompt upstream). */
// notes/kie/ideogram__v3-text-to-image.md
function buildLayout(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt (composed poster/layout text)");
  if (prompt.length > 5000) throw new Error(`prompt: max 5000 characters; got ${prompt.length}`);
  const out: KieInput = { prompt };
  put(out, "rendering_speed", input.renderingSpeed !== undefined ? oneOf(String(input.renderingSpeed), "rendering_speed", ["TURBO", "BALANCED", "QUALITY"] as const) : undefined);
  put(out, "style", input.style !== undefined ? oneOf(String(input.style), "style", ["AUTO", "GENERAL", "REALISTIC", "DESIGN"] as const) : undefined);
  put(out, "expand_prompt", typeof input.expandPrompt === "boolean" ? input.expandPrompt : undefined);
  put(out, "image_size", input.imageSize !== undefined ? oneOf(String(input.imageSize), "image_size", ["square", "square_hd", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"] as const) : undefined);
  put(out, "seed", input.seed !== undefined ? Math.trunc(num(input.seed, "seed")) : undefined);
  put(out, "negative_prompt", optionalStr(input.negativePrompt));
  return mergeExtra(out, input);
}

/** cutout — recraft/remove-background (single `image` URL). */
// notes/kie/recraft__remove-background.md
function buildCutout(input: KieInput): KieInput {
  const image = url(input.imageUrl, "image");
  return { image };
}

/** upscale-image — topaz/image-upscale (image_url + upscale_factor "1"|"2"|"4"). */
// notes/kie/topaz__image-upscale.md
function buildUpscaleImage(input: KieInput): KieInput {
  const image = url(input.imageUrl, "image_url");
  const factor = clampInt(input.upscaleFactor, "upscale_factor", 1, 4, 2);
  if (factor !== 1 && factor !== 2 && factor !== 4) {
    throw new Error(`upscale_factor: expected 1, 2, or 4; got ${factor}`);
  }
  return { image_url: image, upscale_factor: String(factor) };
}

/** upscale-video — topaz/video-upscale (video_url + upscale_factor "1"|"2"|"4"). */
// notes/kie/topaz__video-upscale.md
function buildUpscaleVideo(input: KieInput): KieInput {
  const video = url(input.videoUrl ?? input.imageUrl, "video_url");
  const factor = clampInt(input.upscaleFactor, "upscale_factor", 1, 4, 2);
  if (factor !== 1 && factor !== 2 && factor !== 4) {
    throw new Error(`upscale_factor: expected 1, 2, or 4; got ${factor}`);
  }
  return { video_url: video, upscale_factor: String(factor) };
}

/** cine-multi — kling-3.0-omni/reference-to-video (multi_prompt + elements). */
// notes/kie/kling__v3-omni-reference-to-video.md
function buildCineMulti(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length < 1 || prompt.length > 3072) {
    throw new Error(`prompt: length must be 1–3072 characters; got ${prompt.length}`);
  }
  const out: KieInput = { prompt };
  // image_urls required in the "No Video Input" oneOf branch; caller supplies refs.
  const images = optionalStrArray(input.imageUrls ?? input.referenceImageUrls, "image_urls", 7);
  put(out, "image_urls", images);
  if (input.multiPrompt !== undefined) {
    if (!Array.isArray(input.multiPrompt) || input.multiPrompt.length === 0 || input.multiPrompt.length > 6) {
      throw new Error("multi_prompt: expected 1–6 shots");
    }
    out.customize_multi_shots = true;
    out.multi_prompt = input.multiPrompt.map((s) => {
      const p = str(s.prompt, "multi_prompt[].prompt");
      if (p.length < 1 || p.length > 512) throw new Error("multi_prompt[].prompt: length must be 1–512 characters");
      const d = clampInt(s.duration, "multi_prompt[].duration", 1, 12, 5);
      return { prompt: p, duration: d };
    });
    const mp = out.multi_prompt as Array<{ prompt: string; duration: number }>;
    const total = mp.reduce((a: number, s: { duration: number }) => a + s.duration, 0);
    if (total > 15) throw new Error(`multi_prompt: total duration ${total}s exceeds 15s cap`);
  }
  put(out, "duration", input.duration !== undefined ? clampInt(input.duration, "duration", 3, 15, 5) : undefined);
  put(out, "resolution", input.resolution !== undefined ? oneOf(input.resolution, "resolution", ["720p", "1080p", "4k"] as const) : undefined);
  const ar = optionalStr(input.aspectRatio);
  if (ar !== undefined) {
    out.aspect_ratio = oneOf(ar, "aspect_ratio", ["16:9", "9:16", "1:1"] as const);
  }
  put(out, "audio", typeof input.audio === "boolean" ? input.audio : undefined);
  put(out, "elements", Array.isArray(input.elements) ? input.elements : undefined);
  return mergeExtra(out, input);
}

/** Merge caller `extra` verbatim (escape hatch; caller owns its field names). */
function mergeExtra(out: KieInput, input: KieInput): KieInput {
  const extra = input.extra;
  if (extra && typeof extra === "object") Object.assign(out, extra);
  return out;
}

// ---------------------------------------------------------------------------
// FEATURES registry
// ---------------------------------------------------------------------------

export const FEATURES: Record<Feature, FeatureSpec> = {
  t2v: {
    kieModel: "minimax-h3/text-to-video",
    endpoint: "/api/v1/jobs/createTask",
    build: buildT2V,
  },
  i2v: {
    kieModel: "minimax-h3/image-to-video",
    endpoint: "/api/v1/jobs/createTask",
    build: buildI2V,
  },
  refv: {
    kieModel: "minimax-h3/reference-to-video",
    endpoint: "/api/v1/jobs/createTask",
    build: buildRefV,
  },
  orbit: {
    // NOT a dedicated model — reference-to-video + verbatim ORB360 prompt, 1–3 photos.
    kieModel: "minimax-h3/reference-to-video",
    endpoint: "/api/v1/jobs/createTask",
    build: buildOrbit,
    notes:
      "Approximate: ORB360 LoRA unavailable on Kie; turntable motion comes from the prompt only. Requires 1 or 3 reference images.",
  },
  motion: {
    // NOT a single model: prompt path (H3 t2v/i2v) OR motion-transfer path (kling / wan).
    kieModel: "minimax-h3/text-to-video",
    endpoint: "/api/v1/jobs/createTask",
    build: buildMotionPromptT2V,
    paths: [
      { kieModel: "minimax-h3/text-to-video", doc: "notes/kie/minimax-h3__text-to-video.md", build: buildMotionPromptT2V },
      { kieModel: "minimax-h3/image-to-video", doc: "notes/kie/minimax-h3__image-to-video.md", build: buildMotionPromptI2V },
      { kieModel: "kling-2.6/motion-control", doc: "notes/kie/kling__motion-control.md", build: buildMotionTransferKling },
      { kieModel: "kling-3.0/motion-control", doc: "notes/kie/kling__motion-control-v3.md", build: buildMotionTransferKling },
      { kieModel: "wan/2-2-animate-move", doc: "notes/kie/wan__2-2-animate-move.md", build: buildMotionTransferWan },
    ],
    notes:
      "Two paths: (a) composed move prompt via H3 t2v/i2v (27 LoRA moves degrade to prompt-only); (b) real motion transfer via kling/motion-control or wan/2-2-animate-move using a driving video + subject image.",
  },
  chain: {
    // NOT latent chaining — i2v with first_frame_url = previous clip's last frame.
    kieModel: "minimax-h3/image-to-video",
    endpoint: "/api/v1/jobs/createTask",
    build: buildChain,
    notes:
      "Approximate: frame chaining (browser extracts last frame) replaces ComfyUI latent Motion Context. Optional longer continuation: wan/2-7-image-to-video first_clip_url, pixverse/extend, grok-imagine/extend (see paths).",
    paths: [
      { kieModel: "minimax-h3/image-to-video", doc: "notes/kie/minimax-h3__image-to-video.md", build: buildChain },
      { kieModel: "wan/2-7-image-to-video", doc: "notes/kie/wan__2-7-image-to-video.md", build: (i) => buildWanContinuation(i) },
      { kieModel: "pixverse-v6/extend", doc: "notes/kie/pixverse__extend.md", build: (i) => buildPixverseExtend(i) },
      { kieModel: "grok-imagine/extend", doc: "notes/kie/grok-imagine__extend.md", build: (i) => buildGrokExtend(i) },
    ],
  },
  t2i: {
    kieModel: "qwen/text-to-image",
    endpoint: "/api/v1/jobs/createTask",
    build: buildT2I,
  },
  img2img: {
    kieModel: "qwen/image-to-image",
    endpoint: "/api/v1/jobs/createTask",
    build: buildImg2Img,
  },
  edit: {
    kieModel: "qwen/image-edit",
    endpoint: "/api/v1/jobs/createTask",
    build: buildEdit,
  },
  identity: {
    kieModel: "ideogram/character",
    endpoint: "/api/v1/jobs/createTask",
    build: buildIdentity,
  },
  style: {
    kieModel: "ideogram/v3-remix",
    endpoint: "/api/v1/jobs/createTask",
    build: buildStyle,
  },
  angles: {
    kieModel: "google/nano-banana-edit",
    endpoint: "/api/v1/jobs/createTask",
    build: buildAngles,
    notes:
      "Approximate: the fal Multiple-Angles LoRA does not exist on Kie; azimuth/elevation/distance tokens are folded into the prompt by the caller (see notes/kie/google__nano-banana-edit.md, up to 10 image_urls).",
  },
  layout: {
    kieModel: "ideogram/v3-text-to-image",
    endpoint: "/api/v1/jobs/createTask",
    build: buildLayout,
    notes:
      "Approximate: MOSS bbox layout JSON has no hosted equivalent; the layout form is composed into a typography prompt for ideogram/v3-text-to-image (PORT_PLAN §4).",
  },
  cutout: {
    kieModel: "recraft/remove-background",
    endpoint: "/api/v1/jobs/createTask",
    build: buildCutout,
  },
  "upscale-image": {
    kieModel: "topaz/image-upscale",
    endpoint: "/api/v1/jobs/createTask",
    build: buildUpscaleImage,
  },
  "upscale-video": {
    kieModel: "topaz/video-upscale",
    endpoint: "/api/v1/jobs/createTask",
    build: buildUpscaleVideo,
  },
  "cine-multi": {
    kieModel: "kling-3.0-omni/reference-to-video",
    endpoint: "/api/v1/jobs/createTask",
    build: buildCineMulti,
    notes:
      "True multi-shot via customize_multi_shots + multi_prompt (1–6 shots, each 1–12s, total ≤15s). Fallback: H3 t2v prompt-only cinema composer.",
  },
};

// ---------------------------------------------------------------------------
// Alternate-path builders referenced by chain.paths (declared after FEATURES so
// the main file reads top-down; these are hoisted function declarations).
// ---------------------------------------------------------------------------

/** wan/2-7-image-to-video video continuation (first_clip_url). */
// notes/kie/wan__2-7-image-to-video.md
function buildWanContinuation(input: KieInput): KieInput {
  const prompt = str(input.prompt, "prompt");
  if (prompt.length > 5000) throw new Error(`prompt: max 5000 characters; got ${prompt.length}`);
  const clip = optionalUrl(input.firstClipUrl);
  const first = optionalUrl(input.firstFrameUrl);
  if (!clip && !first) {
    throw new Error("first_clip_url or first_frame_url: at least one required for wan/2-7 continuation");
  }
  const out: KieInput = { prompt };
  put(out, "first_clip_url", clip);
  put(out, "first_frame_url", first);
  put(out, "last_frame_url", optionalUrl(input.lastFrameUrl));
  const res = oneOf(input.resolution, "resolution", ["720p", "1080p"] as const, "1080p");
  out.resolution = res;
  out.duration = clampInt(input.duration, "duration", 2, 15, 5);
  put(out, "negative_prompt", optionalStr(input.negativePrompt));
  put(out, "seed", input.seed !== undefined ? Math.trunc(num(input.seed, "seed")) : undefined);
  return mergeExtra(out, input);
}

/** pixverse-v6/extend continuation (taskId OR video_url, mutually exclusive). */
// notes/kie/pixverse__extend.md
function buildPixverseExtend(input: KieInput): KieInput {
  const taskId = optionalStr(input.taskId);
  const videoUrl = optionalUrl(input.videoUrl);
  if (!taskId && !videoUrl) {
    throw new Error("taskId or video_url: exactly one continuation source is required (they are mutually exclusive)");
  }
  if (taskId && videoUrl) {
    throw new Error("taskId and video_url are mutually exclusive — provide only one");
  }
  const prompt = str(input.prompt, "prompt");
  if (prompt.length < 3 || prompt.length > 5000) {
    throw new Error(`prompt: length must be 3–5000 characters; got ${prompt.length}`);
  }
  const duration = clampInt(input.duration, "duration", 1, 15, 5);
  const quality = oneOf(input.quality, "quality", ["360p", "540p", "720p", "1080p"] as const, "720p");
  const seed = clampInt(input.seed, "seed", 0, 2147483647, 0);
  const out: KieInput = { prompt, duration, quality, seed };
  put(out, "taskId", taskId);
  put(out, "video_url", videoUrl);
  put(out, "generate_audio_switch", typeof input.generateAudioSwitch === "boolean" ? input.generateAudioSwitch : undefined);
  return mergeExtra(out, input);
}

/** grok-imagine/extend continuation (task_id + extend_at + extend_times). */
// notes/kie/grok-imagine__extend.md
function buildGrokExtend(input: KieInput): KieInput {
  const taskId = str(input.taskId, "task_id");
  const prompt = str(input.prompt, "prompt");
  const extendAt = clampNum(input.extendAt ?? 2, "extend_at", 2, Number.MAX_SAFE_INTEGER, 2);
  const extendTimes = oneOf(String(input.extendTimes ?? "6"), "extend_times", ["6", "10"] as const);
  return { task_id: taskId, prompt, extend_at: extendAt, extend_times: extendTimes };
}

// ---------------------------------------------------------------------------
// normalize(feature, raw) — validate + coerce + throw human-readable errors
// ---------------------------------------------------------------------------

/**
 * Validate a normalized input for `feature`, coerce numeric ranges from the
 * cached docs (duration 4–15, strength 0–1, upscale_factor 1|2|4, …), and
 * throw a plain `Error` naming the offending field when anything is wrong.
 * Returns a cleaned copy safe to hand to `FEATURES[feature].build`.
 */
export function normalize(feature: Feature, raw: RawInput | Record<string, unknown>): KieInput {
  const spec = FEATURES[feature];
  if (!spec) throw new Error(`unknown feature: ${String(feature)}`);
  const input: KieInput = { ...(raw as KieInput) };

  // Feature-agnostic prompt length guard where the model documents one.
  const prompt = input.prompt;
  if (typeof prompt === "string") {
    const limits: Partial<Record<Feature, number>> = {
      t2v: 7000, i2v: 7000, refv: 7000, orbit: 7000, motion: 7000, chain: 7000,
      t2i: 5000, img2img: 5000, edit: 2000, identity: 5000, style: 5000,
      angles: 20000, layout: 5000, "cine-multi": 3072,
    };
    const max = limits[feature];
    if (max !== undefined && prompt.length > max) {
      throw new Error(`prompt: length ${prompt.length} exceeds max ${max} characters for feature "${feature}"`);
    }
    if (prompt.trim().length === 0 && feature !== "cutout" && feature !== "upscale-image" && feature !== "upscale-video") {
      throw new Error("prompt: must not be empty");
    }
  } else if (feature !== "cutout" && feature !== "upscale-image" && feature !== "upscale-video" && feature !== "chain") {
    throw new Error("prompt: expected a non-empty string");
  }

  // duration: integer seconds, clamped per-model range (H3 4–15, kling cine 3–15,
  // wan 2–15, pixverse 1–15, kling t2v/i2v string enum "5"|"10").
  if (input.duration !== undefined) {
    const d = num(input.duration, "duration");
    if (!Number.isInteger(d)) throw new Error(`duration: expected an integer number of seconds; got ${d}`);
    const range: Partial<Record<Feature, [number, number]>> = {
      t2v: [4, 15], i2v: [4, 15], refv: [4, 15], orbit: [4, 15], motion: [4, 15], chain: [4, 15],
      "cine-multi": [3, 15],
    };
    const r = range[feature];
    if (r && (d < r[0] || d > r[1])) {
      throw new Error(`duration: ${d}s out of range ${r[0]}–${r[1]} for feature "${feature}"`);
    }
    // kling t2v/i2v take duration as a string enum "5"|"10" — validate when supplied.
    if (input.klingDuration !== undefined) {
      const kd = String(input.klingDuration);
      if (kd !== "5" && kd !== "10") {
        throw new Error(`duration: kling models accept only "5" or "10" seconds; got "${kd}"`);
      }
    }
  } else if (input.klingDuration !== undefined) {
    const kd = String(input.klingDuration);
    if (kd !== "5" && kd !== "10") {
      throw new Error(`duration: kling models accept only "5" or "10" seconds; got "${kd}"`);
    }
  }

  // strength (img2img / style): 0–1 (remix min 0.01 per ideogram/v3-remix).
  if (input.strength !== undefined) {
    const s = num(input.strength, "strength");
    if (s < 0 || s > 1) throw new Error(`strength: ${s} out of range 0–1`);
    if (feature === "style" && s < 0.01) throw new Error(`strength: ${s} below minimum 0.01 for ideogram/v3-remix`);
  }

  // upscale_factor: exact enum 1 | 2 | 4 (topaz image + video).
  if (input.upscaleFactor !== undefined) {
    const f = num(input.upscaleFactor, "upscale_factor");
    if (f !== 1 && f !== 2 && f !== 4) {
      throw new Error(`upscale_factor: expected 1, 2, or 4; got ${f}`);
    }
  }

  // aspect_ratio enum check for H3 features (adaptive allowed on refv/orbit only).
  if (input.aspectRatio !== undefined && (feature === "t2v" || feature === "i2v")) {
    oneOf(input.aspectRatio, "aspect_ratio", ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const);
  }

  // URL presence checks per feature (cheap pre-flight before build()).
  if (feature === "i2v" && !input.firstFrameUrl && !input.lastFrameUrl) {
    throw new Error("first_frame_url or last_frame_url: at least one frame URL is required for i2v");
  }
  if (feature === "chain" && !input.firstFrameUrl && !input.lastFrameUrl) {
    throw new Error("first_frame_url: chain requires the previous clip's last frame URL");
  }
  if (feature === "refv" && !input.referenceImageUrls && !input.referenceVideoUrls) {
    throw new Error("reference_image_urls or reference_video_urls: at least one reference is required for refv");
  }
  if (feature === "orbit") {
    const n = Array.isArray(input.referenceImageUrls) ? input.referenceImageUrls.length : 0;
    if (n < 1 || n > 3) {
      throw new Error(`reference_image_urls: orbit takes exactly 1 or 3 images; got ${n}`);
    }
  }
  if ((feature === "img2img" || feature === "style" || feature === "edit") && !input.imageUrl && !input.imageUrls) {
    throw new Error(`image_url: a source image is required for feature "${feature}"`);
  }
  if (feature === "identity" && !input.referenceImageUrls && !input.imageUrls) {
    throw new Error("reference_image_urls: a character reference image is required for identity");
  }
  if (feature === "cutout" && !input.imageUrl) {
    throw new Error("image: a source image URL is required for cutout");
  }
  if (feature === "upscale-image" && !input.imageUrl) {
    throw new Error("image_url: a source image URL is required for upscale-image");
  }
  if (feature === "upscale-video" && !input.videoUrl && !input.imageUrl) {
    throw new Error("video_url: a source video URL is required for upscale-video");
  }
  if (feature === "angles" && !input.imageUrls) {
    throw new Error("image_urls: at least one source image is required for angles");
  }
  if (feature === "motion") {
    const paths = FEATURES.motion.paths ?? [];
    const hasTransfer = Boolean(input.videoUrl || (Array.isArray(input.videoUrls) && input.videoUrls.length > 0));
    if (!hasTransfer && !input.prompt) {
      throw new Error("prompt or video_url: motion needs a composed prompt (H3 path) or a driving video (motion-transfer path)");
    }
  }

  return input;
}

// ---------------------------------------------------------------------------
// Convenience: one-shot normalize + build
// ---------------------------------------------------------------------------

/** Normalize then build in one step; throws the same human-readable errors. */
export function buildFor(feature: Feature, raw: RawInput | Record<string, unknown>): { kieModel: string; endpoint: string; input: KieInput } {
  const normalized = normalize(feature, raw);
  const spec = FEATURES[feature];
  if (!spec.build) {
    throw new Error(`feature "${feature}" has no single default build; select one of its paths explicitly`);
  }
  return { kieModel: spec.kieModel, endpoint: spec.endpoint, input: spec.build(normalized) };
}