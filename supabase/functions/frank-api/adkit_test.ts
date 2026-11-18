import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  isSafeProductUrl,
  parsePlannerReply,
  parseProductPage,
  sanitizeShots,
  slugTag,
  storyboardMessages,
  tagsInPrompt,
} from "./adkit.ts";

Deno.test("tags: from a name, and read back from a brief", () => {
  assertEquals(slugTag("Coffee Scrub 200g"), "coffee-scrub-200g");
  assertEquals(slugTag("  Crème Brûlée!! "), "creme-brulee");
  assertEquals(slugTag("***"), "item");
  assertEquals(tagsInPrompt("@coffee-scrub on a sink, like @ref1, from @first. mail me@x.com"), ["coffee-scrub"]);
});

Deno.test("product links: public pages only", () => {
  assert(isSafeProductUrl("https://frankbody.com/products/original-coffee-scrub"));
  assert(!isSafeProductUrl("http://localhost:3000/x"));
  assert(!isSafeProductUrl("http://127.0.0.1/x"));
  assert(!isSafeProductUrl("http://[::1]/x"));
  assert(!isSafeProductUrl("http://169.254.169.254/latest"));
  assert(!isSafeProductUrl("https://abc.supabase.co/rest/v1"));
  assert(!isSafeProductUrl("ftp://shop.com/x"));
  assert(!isSafeProductUrl("https://shop.com:8080/x"));
  assert(!isSafeProductUrl("https://intranet/x"));
});

Deno.test("product page: JSON-LD first, meta tags as backup", () => {
  const html = `<html><head><title>Ignore me</title>
  <meta property="og:image" content="//cdn.shop.com/a.jpg?v=1">
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Frank"},
  {"@type":"Product","name":"Original Coffee Scrub","description":"<p>A scrub &amp; more.</p>","brand":{"@type":"Brand","name":"frank body"},
  "image":["https://cdn.shop.com/a.jpg","https://cdn.shop.com/b.jpg"],"offers":{"@type":"Offer","price":"19.95","priceCurrency":"AUD"}}]}</script>
  </head></html>`;
  const page = parseProductPage(html, "https://frankbody.com/products/x");
  assertEquals(page.name, "Original Coffee Scrub");
  assertEquals(page.description, "A scrub & more.");
  assertEquals(page.brand, "frank body");
  assertEquals([page.price, page.currency], ["19.95", "AUD"]);
  assertEquals(page.images, ["https://cdn.shop.com/a.jpg", "https://cdn.shop.com/b.jpg"]);

  const metaOnly = parseProductPage(
    `<meta property="og:title" content="Body Oil"><meta name="description" content="Glow oil"><meta property="og:image" content="/img/oil.png">`,
    "https://shop.example.com/p/oil",
  );
  assertEquals([metaOnly.name, metaOnly.description], ["Body Oil", "Glow oil"]);
  assertEquals(metaOnly.images, ["https://shop.example.com/img/oil.png"]);
});

Deno.test("planner: asks for the shot count and reads its JSON back", () => {
  const messages = storyboardMessages({
    mode: "unboxing", note: "summer", shots: 4, seconds: 6, aspectRatio: "9:16",
    elements: [{ tag: "coffee-scrub", kind: "product", name: "Coffee Scrub", description: "brown pouch" }],
  });
  assert(messages[0].content.includes("exactly 4 shots"));
  assert(messages[0].content.includes("Unboxing"));
  assert(messages[1].content.includes("@coffee-scrub"));

  const reply = "Sure!\n```json\n" + JSON.stringify({
    title: "Summer scrub",
    brief: "Open, reveal, pack.",
    shots: [
      { title: "Open", image_prompt: "Hands on a pouch", motion_prompt: "push in" },
      { title: "", image_prompt: "Close up", motion_prompt: "orbit" },
      { title: "bad", image_prompt: "", motion_prompt: "x" },
    ],
  }) + "\n```";
  const plan = parsePlannerReply(reply, 4)!;
  assertEquals(plan.title, "Summer scrub");
  assertEquals(plan.shots.map((s) => s.title), ["Open", "Shot 2"]);
  assertEquals(parsePlannerReply("no json here", 3), null);
});

Deno.test("shots from the app: ids kept, junk dropped, at most 8", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const [shot] = sanitizeShots([{ id, title: " A ", image_prompt: "x", motion_prompt: "y", still_asset_id: "nope", status: "clip_done" }])!;
  assertEquals([shot.id, shot.title, shot.still_asset_id, shot.status], [id, "A", null, "clip_done"]);
  assertEquals(sanitizeShots(new Array(9).fill({})), null);
  assertEquals(sanitizeShots("x"), null);
});
