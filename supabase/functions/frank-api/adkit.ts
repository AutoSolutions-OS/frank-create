// Product ad kit: saved products (elements), product page import and the
// storyboard planner. Pure helpers only; the routes live in index.ts.

export const ELEMENT_KINDS = ["product", "character", "location", "style"] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** Ad modes the planner knows. Our own wording; the app shows the label and line. */
export const AD_MODES: Record<string, { label: string; guide: string }> = {
  hero: {
    label: "Hero product film",
    guide:
      "The product alone on a clean set. Slow orbits, push-ins and light sweeps show its shape, label and texture. The last shot is a clean pack shot.",
  },
  unboxing: {
    label: "Unboxing",
    guide:
      "Hands open the packaging and reveal the product, turn it to the light, show details close up, and set it down beside its box.",
  },
  ugc: {
    label: "Creator review",
    guide:
      "Handheld phone look. One person in a real bathroom or bedroom shows the product to camera, uses it, and reacts. Natural light, casual framing, no studio polish.",
  },
  texture: {
    label: "Texture and use",
    guide:
      "Extreme close-ups of the product's texture, then it being applied or used by hand, in slow motion, then the pack.",
  },
  lifestyle: {
    label: "Lifestyle",
    guide:
      "The product inside a real routine and place that fits the brand, used by people, ending on the product in that setting.",
  },
  spot: {
    label: "Short brand spot",
    guide:
      "A hook shot, the moment or problem, the product as the answer, a payoff shot, and a closing pack shot with clear space for an end card.",
  },
};

/** "Coffee Scrub 200g" -> "coffee-scrub-200g": what goes after @ in a brief. */
export function slugTag(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "item";
}

export function isValidTag(tag: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(tag);
}

/** Tags written as @tag in a brief, without the reference and frame tags. */
export function tagsInPrompt(prompt: string): string[] {
  const out = new Set<string>();
  for (const match of prompt.matchAll(/(^|[^a-z0-9_])@([a-z0-9][a-z0-9-]{0,39})/gi)) {
    const tag = match[2].toLowerCase().replace(/-+$/, "");
    if (/^ref\d+$/.test(tag) || tag === "first" || tag === "last") continue;
    out.add(tag);
  }
  return Array.from(out);
}

/**
 * A product page link we may fetch: http(s), a public host name, no IP
 * literals, no local or internal names, standard ports only.
 */
export function isSafeProductUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return false;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return false;
  if (host.endsWith(".supabase.co") || host.endsWith(".supabase.in")) return false;
  return true;
}

export type ProductPage = {
  name: string;
  description: string;
  brand: string;
  price: string;
  currency: string;
  images: string[];
  url: string;
};

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(text: string): string {
  return decodeEntities(
    text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function metaContent(html: string, key: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[:.]/g, "\\$&")}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return "";
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "";
  return decodeEntities(content).trim();
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Every JSON-LD node of type Product in the page, @graph included. */
function jsonLdProducts(html: string): any[] {
  const out: any[] = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const stack: unknown[] = asArray(data as any);
    while (stack.length) {
      const node: any = stack.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node["@graph"])) stack.push(...node["@graph"]);
      const types = asArray(node["@type"]).map((t) => String(t).toLowerCase());
      if (types.includes("product") || types.includes("productgroup")) out.push(node);
    }
  }
  return out;
}

function imageUrl(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.url || value.contentUrl || value["@id"] || "");
}

/** Name, text, price and photos from a product page (JSON-LD first, then meta tags). */
export function parseProductPage(html: string, pageUrl: string): ProductPage {
  const product = jsonLdProducts(html)[0] ?? {};
  const offer = asArray(product.offers)[0] ?? {};
  const offerPrice = offer.price ?? asArray(offer.priceSpecification)[0]?.price ?? offer.lowPrice ?? "";
  const brand = typeof product.brand === "string" ? product.brand : product.brand?.name ?? "";
  const images = [
    ...asArray(product.image).map(imageUrl),
    ...asArray(product.hasVariant).flatMap((v: any) => asArray(v?.image).map(imageUrl)),
    metaContent(html, "og:image:secure_url"),
    metaContent(html, "og:image"),
    metaContent(html, "twitter:image"),
  ];
  const absolute: string[] = [];
  for (const raw of images) {
    if (!raw) continue;
    try {
      const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, pageUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const key = url.toString().replace(/[?&](width|height|w|h|v)=\d+/g, "");
      if (!absolute.some((seen) => seen.replace(/[?&](width|height|w|h|v)=\d+/g, "") === key)) {
        absolute.push(url.toString());
      }
    } catch {
      continue;
    }
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return {
    name: stripHtml(String(product.name || metaContent(html, "og:title") || title)).slice(0, 120),
    description: stripHtml(String(product.description || metaContent(html, "og:description") || metaContent(html, "description"))).slice(0, 2000),
    brand: stripHtml(String(brand || metaContent(html, "og:site_name"))).slice(0, 80),
    price: String(offerPrice || metaContent(html, "product:price:amount") || metaContent(html, "og:price:amount") || "").slice(0, 20),
    currency: String(offer.priceCurrency || metaContent(html, "product:price:currency") || metaContent(html, "og:price:currency") || "").slice(0, 8),
    images: absolute.slice(0, 8),
    url: pageUrl,
  };
}

export type PlannerElement = { tag: string; kind: string; name: string; description: string; facts?: Record<string, unknown> };

export type PlanInput = {
  mode: string;
  note: string;
  shots: number;
  seconds: number;
  aspectRatio: string;
  elements: PlannerElement[];
};

/** Messages for the planner model. It must answer with JSON only. */
export function storyboardMessages(input: PlanInput): Array<{ role: string; content: string }> {
  const mode = AD_MODES[input.mode] ?? AD_MODES.hero;
  const elementLines = input.elements.length
    ? input.elements.map((el) => {
      const facts = el.facts && Object.keys(el.facts).length ? ` Facts: ${JSON.stringify(el.facts).slice(0, 400)}` : "";
      return `- @${el.tag} (${el.kind}) "${el.name}": ${el.description || "no description"}${facts}`;
    }).join("\n")
    : "- none saved; work from the note.";
  const system = [
    "You plan short video ads for a brand content team. Answer with one JSON object and nothing else.",
    'Shape: {"title": string, "brief": string, "shots": [{"title": string, "image_prompt": string, "motion_prompt": string}]}',
    `Write exactly ${input.shots} shots. Each shot is one continuous ${input.seconds}-second take, aspect ratio ${input.aspectRatio}.`,
    "image_prompt: the FIRST FRAME as a still photograph: shot size and angle, where the product sits and how big, setting, props, light, colour. Name each saved item by its @tag so its reference photos are used, and say the product must match its photos exactly (shape, colour, label). 40 to 90 words.",
    "motion_prompt: only what moves during the take and how the camera moves (one or two named moves, for example slow push-in, orbit left, rack focus, handheld drift). Do not repeat static details. Keep the product's look unchanged. 15 to 45 words.",
    "brief: two or three sentences on the idea and the order of shots.",
    "No on-screen text, captions or logos added by the model unless the note asks. No real people's names, no other brands, no children. Keep people consistent across shots if they appear (describe the same person the same way).",
    `Ad style: ${mode.label}. ${mode.guide}`,
  ].join("\n");
  const user = [
    "Saved items:",
    elementLines,
    `Note from the team: ${input.note.trim() || "(none)"}`,
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export type PlannedShot = { title: string; image_prompt: string; motion_prompt: string };

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The planner's JSON, checked and trimmed; null when it is not usable. */
export function parsePlannerReply(reply: string, wanted: number): { title: string; brief: string; shots: PlannedShot[] } | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: any;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const shots = (Array.isArray(data?.shots) ? data.shots : [])
    .map((shot: any, i: number) => ({
      title: clean(shot?.title, 80) || `Shot ${i + 1}`,
      image_prompt: clean(shot?.image_prompt, 1200),
      motion_prompt: clean(shot?.motion_prompt, 600),
    }))
    .filter((shot: PlannedShot) => shot.image_prompt && shot.motion_prompt)
    .slice(0, Math.max(1, wanted));
  if (!shots.length) return null;
  return { title: clean(data?.title, 120) || "Product ad", brief: clean(data?.brief, 2000), shots };
}

export type StoryboardShot = {
  id: string;
  title: string;
  image_prompt: string;
  motion_prompt: string;
  still_asset_id?: string | null;
  clip_message_id?: string | null;
  clip_asset_id?: string | null;
  status?: string;
};

const SHOT_STATUSES = new Set(["planned", "still_running", "still_done", "clip_running", "clip_done", "failed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shots sent by the app, kept to the fields and sizes the table expects. */
export function sanitizeShots(value: unknown): StoryboardShot[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const out: StoryboardShot[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const shot = raw as Record<string, unknown>;
    const id = typeof shot.id === "string" && UUID.test(shot.id) ? shot.id : crypto.randomUUID();
    const ref = (key: string) => (typeof shot[key] === "string" && UUID.test(shot[key] as string) ? (shot[key] as string) : null);
    out.push({
      id,
      title: clean(shot.title, 80),
      image_prompt: clean(shot.image_prompt, 1200),
      motion_prompt: clean(shot.motion_prompt, 600),
      still_asset_id: ref("still_asset_id"),
      clip_message_id: ref("clip_message_id"),
      clip_asset_id: ref("clip_asset_id"),
      status: typeof shot.status === "string" && SHOT_STATUSES.has(shot.status) ? shot.status : "planned",
    });
  }
  return out;
}
