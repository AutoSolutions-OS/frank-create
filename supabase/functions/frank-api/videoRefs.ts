// Video run references: which stored file is a clip, and the parts OpenRouter takes.

export type ReferenceMedia = "image" | "video";

export type LoadedReference = { id: string; url: string; media: ReferenceMedia };

/** A stored asset is a clip when its metadata or its file says so. */
export function referenceMediaOf(row: { storage_path?: string | null; metadata_json?: any }): ReferenceMedia {
  const meta = row?.metadata_json || {};
  if (meta.media_type === "video") return "video";
  if (typeof meta.mime === "string" && meta.mime.toLowerCase().startsWith("video/")) return "video";
  if (/\.(mp4|mov|webm|m4v)$/i.test(String(row?.storage_path || ""))) return "video";
  return "image";
}

/**
 * input_references for POST /api/v1/videos. OpenRouter's schema takes image,
 * audio and video parts; Seedance (ByteDance generation 2 and newer) honours
 * the video ones.
 */
export function videoReferenceParts(refs: Array<{ url: string; media: ReferenceMedia }>): Array<Record<string, unknown>> {
  return refs.map((ref) =>
    ref.media === "video"
      ? { type: "video_url", video_url: { url: ref.url } }
      : { type: "image_url", image_url: { url: ref.url } }
  );
}

/** What a finished video job says it billed: usage.cost is USD. */
export function videoUsageRecord(status: any): Record<string, unknown> | null {
  const usage = status?.usage;
  if (!usage || typeof usage !== "object") return null;
  const out: Record<string, unknown> = { ...usage };
  if (typeof status?.id === "string") out.job_id = status.id;
  if (typeof status?.generation_id === "string") out.generation_id = status.generation_id;
  return out;
}
