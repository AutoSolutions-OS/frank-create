import { describe, expect, it } from "vitest";

import { fallbackConfig } from "./presets";
import {
  buildReferenceManifest,
  estimateVideoCost,
  expandReferenceTags,
  normalizeVideoSettings,
  planVideoReferences,
  referenceVideoSeconds,
  videoReferenceSizeError,
  videoTokenCost
} from "./studio";
import type { StudioModel, StudioSettings } from "./types";

const seedance = fallbackConfig.models.find((model) => model.id === "seedance-2-5") as StudioModel;
const grok = fallbackConfig.models.find((model) => model.id === "grok-imagine-video-1-5") as StudioModel;
const base: StudioSettings = { aspect_ratio: "16:9", image_size: "", count: 1, duration: 4, video_resolution: "1080p" };

describe("Seedance 2.5 1080p and references", () => {
  it("offers 1080p and keeps it when picked", () => {
    expect(seedance.allowed_resolutions).toEqual(["480p", "720p", "1080p"]);
    expect(seedance.supports_video_references).toBe(true);
    expect(normalizeVideoSettings(base, seedance).video_resolution).toBe("1080p");
  });

  it("prices per token: 480p matches OpenRouter's own $0.1028/s", () => {
    const cost = videoTokenCost(seedance, { ...base, video_resolution: "480p", duration: 1 });
    expect(cost?.perSecond).toBeCloseTo(0.1028, 3);
  });

  it("1080p uses its own rate and the real pixel size of the aspect", () => {
    const wide = videoTokenCost(seedance, base);
    // 1920 x 1080 x 24 / 1024 = 48,600 tokens/s at $0.0000117.
    expect(wide?.perSecond).toBeCloseTo(0.5686, 3);
    expect(wide?.usd).toBeCloseTo(2.27, 2);
    const square = videoTokenCost(seedance, { ...base, aspect_ratio: "1:1" });
    expect(square?.width).toBe(1080);
    expect(square?.usd).toBeCloseTo(1.28, 2);
  });

  it("a video reference uses the video-input rate and counts its own seconds", () => {
    const withClip = videoTokenCost(seedance, { ...base, aspect_ratio: "1:1" }, 3);
    // (4 + 3) s x 27,337.5 tokens/s x $0.000007.
    expect(withClip?.usd).toBeCloseTo(1.34, 2);
    expect(estimateVideoCost(seedance, { ...base, aspect_ratio: "1:1" }, { videoInputSeconds: 3 }))
      .toBe("approx. ~$1.34 · 4s @ 1080p · + 3s video ref · 1080x1080");
  });

  it("other video models keep their per-second estimate", () => {
    expect(videoTokenCost(grok, base)).toBeNull();
    expect(estimateVideoCost(grok, { ...base, duration: 5 })).toContain("5s @ 1080p");
  });
});

describe("planVideoReferences", () => {
  const img1 = { id: "a", media_type: "image" as const };
  const img2 = { id: "b", media_type: "image" as const };
  const clip = { id: "c", media_type: "video" as const, duration: 5 };

  it("keeps start and end frames by default", () => {
    const plan = planVideoReferences(seedance, [img1, img2], "frames");
    expect(plan.mode).toBe("frames");
    expect(plan.firstFrame).toBe(img1);
    expect(plan.lastFrame).toBe(img2);
  });

  it("uses every reference when asked, with no frame", () => {
    const plan = planVideoReferences(seedance, [img1, img2], "references");
    expect(plan).toEqual({ mode: "references", references: [img1, img2] });
  });

  it("a clip in the dock always means references", () => {
    const plan = planVideoReferences(seedance, [img1, clip], "frames");
    expect(plan.mode).toBe("references");
    expect(plan.references).toEqual([img1, clip]);
    expect(referenceVideoSeconds(plan.references)).toBe(5);
  });

  it("a model without video references drops clips and keeps frames", () => {
    const plan = planVideoReferences(grok, [clip, img1], "references");
    expect(plan.mode).toBe("frames");
    expect(plan.firstFrame).toBe(img1);
    expect(plan.references).toEqual([img1]);
  });
});

describe("reference manifest with clips", () => {
  it("numbers images and videos apart", () => {
    const refs = [
      { title: "Bottle", media_type: "image" },
      { title: "Pour shot", media_type: "video" }
    ];
    expect(buildReferenceManifest(refs)).toBe(
      "REFERENCE MANIFEST (images and video clips, attached in this exact order):\n" +
        "Reference image 1 (@ref1) = Bottle\n" +
        "Reference video 1 (@ref2) = Pour shot"
    );
    expect(expandReferenceTags("Move like @ref2", refs)).toBe("Move like reference video 1 (@ref2)");
  });

  it("an image-only manifest reads as before", () => {
    expect(buildReferenceManifest([{ title: "A" }])).toBe(
      "REFERENCE IMAGE MANIFEST (attached in this exact order):\nReference image 1 (@ref1) = A"
    );
  });
});

describe("reference clip size", () => {
  it("a clip under 407,696 pixels is named before the run", () => {
    expect(videoReferenceSizeError(seedance, [{ title: "flying saucer", media_type: "video", width: 480, height: 480 }]))
      .toBe('Seedance 2.5 needs reference clips of at least 640x640 or 854x480. "flying saucer" is 480x480.');
  });

  it("640x640, 854x480, images and clips of unknown size pass", () => {
    expect(videoReferenceSizeError(seedance, [
      { media_type: "video", width: 640, height: 640 },
      { media_type: "video", width: 854, height: 480 },
      { media_type: "image", width: 100, height: 100 },
      { media_type: "video" }
    ])).toBeUndefined();
  });

  it("models without a minimum never complain", () => {
    expect(videoReferenceSizeError(grok, [{ media_type: "video", width: 10, height: 10 }])).toBeUndefined();
  });
});
