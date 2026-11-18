import { describe, expect, it } from "vitest";
import { elementsInPrompt, withElementBlock } from "./studio";

const scrub = { tag: "coffee-scrub", kind: "product", name: "Coffee Scrub", description: "Brown pouch, white label." };
const jess = { tag: "jess", kind: "character", name: "Jess", description: "" };

describe("saved items in a brief", () => {
  it("finds @tags of saved items only, once each, in order", () => {
    expect(elementsInPrompt("@jess holds @coffee-scrub, then @coffee-scrub again with @ref1 and a@b.com", [scrub, jess]))
      .toEqual([jess, scrub]);
  });

  it("adds a block naming each item before the brief", () => {
    const out = withElementBlock("@coffee-scrub on a sink", [scrub, jess]);
    expect(out.split("\n")).toEqual([
      "SAVED ITEMS IN THIS BRIEF:",
      '@coffee-scrub = Product "Coffee Scrub": Brown pouch, white label. Its reference photos show exactly how it looks; keep its shape, colours and label unchanged.',
      "",
      "@coffee-scrub on a sink"
    ]);
  });

  it("leaves a brief without saved items alone", () => {
    expect(withElementBlock("a bottle on a sink, like @ref1", [scrub])).toBe("a bottle on a sink, like @ref1");
  });
});

import { estimateImageCost } from "./studio";
import { fallbackConfig } from "./presets";

describe("Nano Banana 2 price before a run", () => {
  const nb2 = fallbackConfig.models.find((m) => m.id === "google-nb-2")!;
  it("follows the real OpenRouter bills (1K $0.0685, 2K $0.1014, 4K $0.1518)", () => {
    expect(estimateImageCost(nb2, { aspect_ratio: "9:16", image_size: "1K", count: 2 })).toBe("~$0.14 · 2 images @ 1K · $0.07/image");
    expect(estimateImageCost(nb2, { aspect_ratio: "1:1", image_size: "4K", count: 1 })).toBe("~$0.15 · 1 image @ 4K · $0.15/image");
  });
});
