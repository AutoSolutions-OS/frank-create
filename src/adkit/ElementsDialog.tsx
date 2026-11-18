import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Banner, Button, Icon, Select, Text, TextField } from "../ds";
import { archiveElement, createElement, importProduct, updateElement } from "../lib/api";
import { thumbnailUrl } from "../lib/studio";
import type { Asset, StudioElement } from "../lib/types";

/**
 * Products, characters, locations and styles a company saves once and calls
 * with an @tag in any brief. Photos come from the reference dock or from a
 * product page link.
 */

const KINDS: { value: StudioElement["kind"]; label: string }[] = [
  { value: "product", label: "Product" },
  { value: "character", label: "Character" },
  { value: "location", label: "Location" },
  { value: "style", label: "Style" }
];

function slugTag(name: string): string {
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

type Photo = { id: string; url: string; title: string };

type Draft = {
  id?: string;
  kind: StudioElement["kind"];
  name: string;
  tag: string;
  tagTouched: boolean;
  description: string;
  photoIds: string[];
  sourceUrl: string | null;
  facts: Record<string, unknown>;
};

const EMPTY: Draft = {
  kind: "product",
  name: "",
  tag: "",
  tagTouched: false,
  description: "",
  photoIds: [],
  sourceUrl: null,
  facts: {}
};

export interface ElementsDialogProps {
  open: boolean;
  onClose: () => void;
  elements: StudioElement[];
  onElementsChange: (next: StudioElement[]) => void;
  sessionId: string | null;
  /** Image references in the dock now: the photos a new item can take. */
  dockReferences: Asset[];
  onAssetsCreated: (assets: Asset[]) => void;
  onUse: (element: StudioElement) => void;
  onStatus: (text: string) => void;
}

export function ElementsDialog(props: ElementsDialogProps) {
  const { open, onClose, elements, onElementsChange, sessionId, dockReferences, onAssetsCreated, onUse, onStatus } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [imported, setImported] = useState<Photo[]>([]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<"" | "import" | "save" | "archive">("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | StudioElement["kind"]>("all");

  const photoChoices: Photo[] = useMemo(() => {
    const seen = new Set<string>();
    const out: Photo[] = [];
    const editing = draft?.id ? elements.find((el) => el.id === draft.id) : undefined;
    for (const img of editing?.images ?? []) out.push({ id: img.asset_id, url: img.url, title: "Saved photo" });
    for (const photo of imported) out.push(photo);
    for (const ref of dockReferences) {
      if (ref.media_type === "video") continue;
      out.push({ id: ref.id, url: ref.preview_url || ref.remote_url || "", title: ref.title });
    }
    return out.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }, [draft?.id, elements, imported, dockReferences]);

  if (!open) return null;

  const shown = elements.filter((el) => filter === "all" || el.kind === filter);

  function startNew() {
    setDraft({ ...EMPTY });
    setImported([]);
    setLink("");
    setError(null);
  }

  function startEdit(el: StudioElement) {
    setDraft({
      id: el.id,
      kind: el.kind,
      name: el.name,
      tag: el.tag,
      tagTouched: true,
      description: el.description,
      photoIds: el.images.map((img) => img.asset_id),
      sourceUrl: el.source_url ?? null,
      facts: el.facts ?? {}
    });
    setImported([]);
    setLink("");
    setError(null);
  }

  async function readLink() {
    if (!sessionId) {
      setError("Open a session first.");
      return;
    }
    setBusy("import");
    setError(null);
    try {
      const result = await importProduct(link.trim(), sessionId);
      onAssetsCreated(result.assets);
      const photos = result.assets.map((asset) => ({
        id: asset.id,
        url: asset.preview_url || asset.remote_url || "",
        title: asset.title
      }));
      setImported(photos);
      const p = result.product;
      setDraft((current) => ({
        ...(current ?? EMPTY),
        kind: "product",
        name: current?.name || p.name,
        tag: current?.tagTouched ? current.tag : p.suggested_tag,
        description: current?.description || [p.brand ? `By ${p.brand}.` : "", p.description].filter(Boolean).join(" ").slice(0, 2000),
        photoIds: photos.map((photo) => photo.id).slice(0, 6),
        sourceUrl: p.url,
        facts: { brand: p.brand || undefined, price: p.price || undefined, currency: p.currency || undefined }
      }));
      onStatus(
        photos.length
          ? `Read the page: ${photos.length} photo${photos.length === 1 ? "" : "s"}${result.skipped_images ? `, ${result.skipped_images} skipped` : ""}.`
          : "Read the page, but it had no usable photos. Add photos from the dock."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that page.");
    } finally {
      setBusy("");
    }
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError("Give it a name.");
      return;
    }
    if (!draft.photoIds.length) {
      setError("Pick at least one photo, so the models can see it.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const payload = {
        kind: draft.kind,
        name: draft.name.trim(),
        tag: (draft.tag || slugTag(draft.name)).trim(),
        description: draft.description.trim(),
        image_asset_ids: draft.photoIds
      };
      const { element } = draft.id
        ? await updateElement(draft.id, payload)
        : await createElement({ ...payload, source_url: draft.sourceUrl, facts: draft.facts });
      const next = draft.id
        ? elements.map((el) => (el.id === element.id ? element : el))
        : [...elements, element].sort((a, b) => a.name.localeCompare(b.name));
      onElementsChange(next);
      onStatus(`Saved @${element.tag}. Use it in any brief.`);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy("");
    }
  }

  async function archive(el: StudioElement) {
    if (!window.confirm(`Remove @${el.tag} for everyone in your company? Past rounds keep their pictures.`)) return;
    setBusy("archive");
    try {
      await archiveElement(el.id);
      onElementsChange(elements.filter((item) => item.id !== el.id));
      onStatus(`Removed @${el.tag}.`);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove it.");
    } finally {
      setBusy("");
    }
  }

  function togglePhoto(id: string) {
    setDraft((current) => {
      if (!current) return current;
      const has = current.photoIds.includes(id);
      if (!has && current.photoIds.length >= 6) return current;
      return { ...current, photoIds: has ? current.photoIds.filter((x) => x !== id) : [...current.photoIds, id] };
    });
  }

  return createPortal(
    <div className="reference-picker-overlay" role="dialog" aria-modal="true" aria-label="Products and characters" onClick={onClose}>
      <div className="reference-picker elements-dialog" onClick={(event) => event.stopPropagation()}>
        <button className="reference-picker-close" type="button" onClick={onClose} aria-label="Close">
          <Icon source="x-mark" tone="inherit" size={18} />
        </button>
        <header className="reference-picker-header">
          <h3>{draft ? (draft.id ? `Edit @${draft.tag}` : "New saved item") : "Products and characters"}</h3>
        </header>

        {error ? <Banner tone="critical">{error}</Banner> : null}

        {!draft ? (
          <>
            <Text variant="bodySm" tone="secondary" as="p">
              Save a product, character, location or style once. Type its @tag in a brief and its photos go in as references. Everyone in your company can use them.
            </Text>
            <div className="elements-toolbar">
              <div className="elements-filter" role="group" aria-label="Show">
                {(["all", "product", "character", "location", "style"] as const).map((key) => (
                  <button key={key} type="button" className={`elements-filter__chip${filter === key ? " is-on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                    {key === "all" ? "All" : KINDS.find((k) => k.value === key)?.label}
                  </button>
                ))}
              </div>
              <Button variant="primary" icon="plus" onClick={startNew}>New</Button>
            </div>
            <div className="elements-grid">
              {shown.length ? shown.map((el) => (
                <article key={el.id} className="element-card">
                  <div className="element-card__photo">
                    {el.images[0]?.url ? <img src={thumbnailUrl(el.images[0].url, 240, 40, "webp")} alt="" loading="lazy" /> : <Icon source="photo" size={20} />}
                    {el.images.length > 1 ? <span className="element-card__count">{el.images.length}</span> : null}
                  </div>
                  <div className="element-card__body">
                    <strong>{el.name}</strong>
                    <span className="element-card__tag">@{el.tag} · {KINDS.find((k) => k.value === el.kind)?.label}</span>
                    {el.description ? <span className="element-card__desc">{el.description}</span> : null}
                  </div>
                  <div className="element-card__actions">
                    <Button size="micro" variant="primary" onClick={() => onUse(el)}>Use</Button>
                    <Button size="micro" variant="plain" onClick={() => startEdit(el)}>Edit</Button>
                  </div>
                </article>
              )) : (
                <div className="reference-picker-empty">
                  Nothing saved yet. Press New, paste a product page link or pick photos from your dock.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="element-form">
            {!draft.id ? (
              <div className="element-form__import">
                <TextField
                  label="Product page link (optional)"
                  value={link}
                  placeholder="https://shop.com/products/..."
                  onChange={(event) => setLink(event.target.value)}
                  helpText="Reads the name, text and up to 4 photos from the page."
                />
                <Button onClick={() => void readLink()} loading={busy === "import"} disabled={!link.trim() || busy !== ""} icon="link">
                  Read page
                </Button>
              </div>
            ) : null}
            <div className="element-form__row">
              <Select
                label="Kind"
                options={KINDS.map((k) => ({ label: k.label, value: k.value }))}
                value={draft.kind}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as StudioElement["kind"] })}
              />
              <TextField
                label="Name"
                value={draft.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft({ ...draft, name, tag: draft.tagTouched ? draft.tag : slugTag(name) });
                }}
              />
              <TextField
                label="@tag"
                value={draft.tag}
                prefix="@"
                onChange={(event) => setDraft({ ...draft, tag: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40), tagTouched: true })}
              />
            </div>
            <TextField
              label="What must stay true"
              multiline
              rows={3}
              value={draft.description}
              placeholder="Shape, colours, label, materials. For a character: age range, hair, build, clothes."
              onChange={(event) => setDraft({ ...draft, description: event.target.value.slice(0, 2000) })}
            />
            <div>
              <Text variant="headingSm" as="h4">Photos ({draft.photoIds.length} of 6)</Text>
              <Text variant="bodySm" tone="secondary" as="p">
                {photoChoices.length
                  ? "Pick the clearest photos: front, back, detail."
                  : "No photos to pick. Add references to the dock first, or read a product page."}
              </Text>
              <div className="element-photo-grid">
                {photoChoices.map((photo) => {
                  const on = draft.photoIds.includes(photo.id);
                  return (
                    <button key={photo.id} type="button" className={`element-photo${on ? " is-on" : ""}`} aria-pressed={on} title={photo.title} onClick={() => togglePhoto(photo.id)}>
                      {photo.url ? <img src={thumbnailUrl(photo.url, 160, 35, "webp")} alt={photo.title} loading="lazy" /> : null}
                      {on ? <span className="element-photo__check"><Icon source="check" tone="inherit" size={14} /></span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="element-form__actions">
              {draft.id ? (
                <Button tone="critical" variant="plain" icon="trash" disabled={busy !== ""} onClick={() => {
                  const el = elements.find((item) => item.id === draft.id);
                  if (el) void archive(el);
                }}>
                  Remove
                </Button>
              ) : <span />}
              <div className="element-form__buttons">
                <Button onClick={() => setDraft(null)} disabled={busy === "save"}>Back</Button>
                <Button variant="primary" onClick={() => void save()} loading={busy === "save"} disabled={busy !== ""}>Save</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
