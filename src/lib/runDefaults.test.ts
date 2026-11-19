import { describe, expect, it } from "vitest";

import { fallbackConfig } from "./presets";
import {
  defaultStudioSettings,
  filterSizesForAspect,
  lowestOption,
  modelsForMedia,
  nearestImageSize,
  normalizeStudioSettingsForModel,
  normalizeVideoSettings,
  resolveForModel
} from "./studio";
import type { StudioModel } from "./types";

const imageModels = modelsForMedia(fallbackConfig.models, "image");
const videoModels = modelsForMedia(fallbackConfig.models, "video");
const byId = (id: string) => fallbackConfig.models.find((model) => model.id === id) as StudioModel;

/**
 * Ticket cab71f0b (Sebastien Boulard, 19 Nov 2026): every refresh started the
 * composer at 4K and 4 picks. A fresh load now starts at the cheapest choice.
 */
describe("run defaults start at the cheapest choice", () => {
  it("Nano Banana 2.1, the default model, starts at 1K and 1 pick", () => {
    const settings = defaultStudioSettings(fallbackConfig.models[0]);
    expect(fallbackConfig.models[0].id).toBe("google-nb-2-1");
    expect(settings).toMatchObject({ image_size: "1K", count: 1 });
  });

  it("every image model starts at its lowest size and 1 pick", () => {
    for (const model of imageModels) {
      const settings = defaultStudioSettings(model);
      const sizes = filterSizesForAspect(model.allowed_image_sizes, settings.aspect_ratio);
      expect(settings.count, model.id).toBe(1);
      expect(settings.image_size, model.id).toBe(sizes.length ? sizes[0] : "");
      expect(settings.image_size, model.id).not.toBe("4K");
    }
    expect(defaultStudioSettings(byId("seedream-5-pro")).image_size).toBe("2K");
  });

  it("a refresh lands on the cheapest size for the remembered model, not 4K", () => {
    // On load the composer starts from the first roster model, then fits the
    // settings to the model remembered from last time.
    const start = defaultStudioSettings(fallbackConfig.models[0]);
    for (const model of imageModels) {
      const fitted = normalizeStudioSettingsForModel(start, model);
      const sizes = filterSizesForAspect(model.allowed_image_sizes, fitted.aspect_ratio);
      expect(fitted.count, model.id).toBe(1);
      expect(fitted.image_size, model.id).toBe(sizes.length ? sizes[0] : "");
    }
  });

  it("a 4K x 4 pick still holds for the session", () => {
    const model = byId("google-nb-2-1");
    const picked = normalizeStudioSettingsForModel({ aspect_ratio: "1:1", image_size: "4K", count: 4 }, model);
    expect(picked).toMatchObject({ image_size: "4K", count: 4 });
  });
});

describe("a size a model cannot honour goes to the nearest, never the dearest", () => {
  it("keeps a size the model offers", () => {
    expect(nearestImageSize("2K", ["1K", "2K", "4K"])).toBe("2K");
  });

  it("moves to the nearest size by resolution", () => {
    expect(nearestImageSize("4K", ["1K", "2K"])).toBe("2K");
    expect(nearestImageSize("1K", ["2K", "4K"])).toBe("2K");
  });

  it("falls back to the cheapest size when there is nothing to match", () => {
    expect(nearestImageSize("", ["1K", "2K", "4K"])).toBe("1K");
    expect(nearestImageSize("square", ["1K", "2K", "4K"])).toBe("1K");
    expect(nearestImageSize("1K", [])).toBe("");
  });

  it("side by side fills an empty size with the cheapest", () => {
    const { settings } = resolveForModel(byId("google-nb-2-1"), { aspect_ratio: "1:1", image_size: "", count: 1 });
    expect(settings.image_size).toBe("1K");
  });
});

describe("lowestOption", () => {
  it("orders by size, whatever the roster order", () => {
    expect(lowestOption(["4K", "1K", "2K"])).toBe("1K");
    expect(lowestOption(["1080p", "480p", "720p"])).toBe("480p");
    expect(lowestOption(["4k", "720p"])).toBe("720p");
  });

  it("keeps roster order for options with no readable size", () => {
    expect(lowestOption(["auto", "square"])).toBe("auto");
    expect(lowestOption([])).toBe("");
  });
});

describe("video defaults start at the cheapest choice", () => {
  it("every video model starts at its lowest resolution and shortest clip", () => {
    const start = defaultStudioSettings(fallbackConfig.models[0]);
    for (const model of videoModels) {
      const settings = normalizeVideoSettings(start, model);
      expect(settings.count, model.id).toBe(1);
      if (model.allowed_resolutions?.length) {
        expect(settings.video_resolution, model.id).toBe(model.allowed_resolutions[0]);
      }
      if (model.allowed_durations?.length) {
        expect(settings.duration, model.id).toBe(Math.min(...model.allowed_durations));
      }
    }
  });

  it("Seedance 2.0 starts at 480p, not 4k", () => {
    const settings = normalizeVideoSettings({ aspect_ratio: "16:9", image_size: "", count: 1 }, byId("dreamina-seedance-2"));
    expect(settings.video_resolution).toBe("480p");
  });

  it("a picked resolution still holds", () => {
    const settings = normalizeVideoSettings(
      { aspect_ratio: "16:9", image_size: "", count: 1, video_resolution: "1080p" },
      byId("seedance-2-5")
    );
    expect(settings.video_resolution).toBe("1080p");
  });
});
