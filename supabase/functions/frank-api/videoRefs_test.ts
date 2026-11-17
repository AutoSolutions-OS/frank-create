import { assertEquals } from "jsr:@std/assert@1";
import { referenceMediaOf, videoReferenceParts, videoUsageRecord } from "./videoRefs.ts";

Deno.test("a clip is known by its metadata, its mime or its file name", () => {
  assertEquals(referenceMediaOf({ metadata_json: { media_type: "video" } }), "video");
  assertEquals(referenceMediaOf({ metadata_json: { mime: "video/quicktime" } }), "video");
  assertEquals(referenceMediaOf({ storage_path: "s/a.mp4", metadata_json: {} }), "video");
  assertEquals(referenceMediaOf({ storage_path: "s/a.png", metadata_json: { media_type: "image" } }), "image");
  assertEquals(referenceMediaOf({}), "image");
});

Deno.test("images and clips become image_url and video_url parts, in order", () => {
  assertEquals(
    videoReferenceParts([
      { url: "https://x/a.png", media: "image" },
      { url: "https://x/b.mp4", media: "video" },
    ]),
    [
      { type: "image_url", image_url: { url: "https://x/a.png" } },
      { type: "video_url", video_url: { url: "https://x/b.mp4" } },
    ],
  );
});

Deno.test("the finished job's usage is kept with its ids", () => {
  assertEquals(
    videoUsageRecord({ id: "job1", generation_id: "gen1", usage: { cost: 1.25, is_byok: false } }),
    { cost: 1.25, is_byok: false, job_id: "job1", generation_id: "gen1" },
  );
  assertEquals(videoUsageRecord({ status: "completed" }), null);
});
