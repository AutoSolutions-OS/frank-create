import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, Icon, PageHeader, Select, Text, TextField } from "../ds";
import {
  createInferenceTurn,
  createVideoStoryboard,
  fetchTurnStatus,
  joinStoryboard,
  listStoryboards,
  planStoryboard,
  updateStoryboard,
  useElement
} from "../lib/api";
import {
  buildTurnRequest,
  composeReferencePrompt,
  estimateImageCost,
  estimateVideoCost,
  modelsForMedia,
  normalizeStudioSettingsForModel,
  normalizeVideoSettings,
  thumbnailUrl,
  videoTokenCost,
  withElementBlock
} from "../lib/studio";
import type { AdMode, Asset, StudioElement, StudioModel, StudioSettings, Storyboard, StoryboardShot } from "../lib/types";
import { WhatsNewButton } from "../components/WhatsNewButton";

/**
 * Ad builder: a saved product + an ad style -> a planned set of shots -> one
 * still per shot (with the product's photos as references) -> one clip per
 * shot (the still is its first frame) -> one joined film.
 */

const DEFAULT_STILL_MODEL = "google-nb-2";
const DEFAULT_VIDEO_MODEL = "seedance-2-5";
const PARALLEL = 3;

export interface AdBuilderProps {
  models: StudioModel[];
  sessionId: string | null;
  connection: "online" | "offline" | "checking";
  elements: StudioElement[];
  modes: Record<string, AdMode>;
  assets: Asset[];
  onOpenElements: () => void;
  onAssetsCreated: (assets: Asset[]) => void;
  onStatus: (text: string) => void;
  onExpandAsset?: (asset: Asset) => void;
  onDownloadAsset?: (asset: Asset) => void;
}

type ShotBusy = Record<string, "still" | "clip" | undefined>;

async function untilDone(turnId: string, isCancelled: () => boolean) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 4 ? 2500 : 5000));
    if (isCancelled()) return null;
    try {
      const snapshot = await fetchTurnStatus(turnId);
      if (snapshot.status !== "running") return snapshot;
    } catch {
      continue;
    }
  }
  return null;
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await run(item);
    }
  });
  await Promise.all(workers);
}

export function AdBuilder(props: AdBuilderProps) {
  const { models, sessionId, connection, elements, modes, assets, onOpenElements, onAssetsCreated, onStatus, onExpandAsset, onDownloadAsset } = props;
  const imageModels = useMemo(() => modelsForMedia(models, "image").filter((m) => m.status === "ready"), [models]);
  // Every shot starts from its still, so any ready video model can run it.
  const videoModels = useMemo(() => modelsForMedia(models, "video").filter((m) => m.status === "ready"), [models]);

  const [elementIds, setElementIds] = useState<string[]>([]);
  const [mode, setMode] = useState("hero");
  const [note, setNote] = useState("");
  const [shotCount, setShotCount] = useState(4);
  const [stillModelId, setStillModelId] = useState(DEFAULT_STILL_MODEL);
  const [videoModelId, setVideoModelId] = useState(DEFAULT_VIDEO_MODEL);
  const videoModel = videoModels.find((m) => m.id === videoModelId) ?? videoModels[0];
  const stillModel = imageModels.find((m) => m.id === stillModelId) ?? imageModels[0];
  const [aspect, setAspect] = useState("9:16");
  const [resolution, setResolution] = useState("480p");
  const [seconds, setSeconds] = useState(4);

  const [board, setBoard] = useState<Storyboard | null>(null);
  const boardRef = useRef<Storyboard | null>(null);
  boardRef.current = board;
  const [recent, setRecent] = useState<Storyboard[]>([]);
  const [busy, setBusy] = useState<"" | "plan" | "stills" | "clips" | "join">("");
  const [shotBusy, setShotBusy] = useState<ShotBusy>({});
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Record<string, Asset>>({});
  const refCache = useRef<Record<string, Asset[]>>({});
  const unmounted = useRef(false);
  useEffect(() => () => { unmounted.current = true; }, []);

  useEffect(() => {
    if (connection !== "online") return;
    listStoryboards().then((r) => setRecent(r.storyboards)).catch(() => undefined);
  }, [connection]);

  // Keep the video settings inside what the picked model takes.
  useEffect(() => {
    if (!videoModel) return;
    const aspects = videoModel.allowed_aspect_ratios ?? [];
    if (aspects.length && !aspects.includes(aspect)) setAspect(aspects.includes("9:16") ? "9:16" : aspects[0]);
    const res = videoModel.allowed_resolutions ?? [];
    if (res.length && !res.includes(resolution)) setResolution(res[0]);
    const durs = videoModel.allowed_durations ?? [];
    if (durs.length && !durs.includes(seconds)) setSeconds(durs[0]);
  }, [videoModel, aspect, resolution, seconds]);

  const assetById = useMemo(() => {
    const map = new Map<string, Asset>();
    for (const asset of assets) map.set(asset.id, asset);
    for (const asset of Object.values(made)) map.set(asset.id, asset);
    return map;
  }, [assets, made]);

  const products = elements;
  const boardElements = board ? elements.filter((el) => board.element_ids.includes(el.id)) : [];
  const shots = board?.shots ?? [];

  const stillSettings: StudioSettings | null = stillModel
    ? normalizeStudioSettingsForModel({ aspect_ratio: aspect, image_size: stillModel.allowed_image_sizes?.[0] ?? "", count: 1 }, stillModel)
    : null;
  const clipSettings: StudioSettings | null = videoModel
    ? normalizeVideoSettings({ aspect_ratio: aspect, image_size: "", count: 1, duration: seconds, video_resolution: resolution }, videoModel)
    : null;

  const stillsToMake = shots.filter((s) => !s.still_asset_id).length || shots.length;
  const clipsToMake = shots.filter((s) => s.still_asset_id && !s.clip_asset_id).length;
  const stillsCost = stillModel && stillSettings ? estimateImageCost(stillModel, { ...stillSettings, count: Math.max(1, stillsToMake) }) : null;
  const perClip = videoModel && clipSettings ? videoTokenCost(videoModel, clipSettings) : null;
  const clipsCost = perClip
    ? `approx. ~$${(perClip.usd * Math.max(1, clipsToMake)).toFixed(2)} · ${Math.max(1, clipsToMake)} clip${clipsToMake === 1 ? "" : "s"} · ${clipSettings?.duration}s @ ${clipSettings?.video_resolution}`
    : videoModel && clipSettings
      ? `${estimateVideoCost(videoModel, clipSettings) ?? ""} each`
      : null;

  async function saveBoard(next: Storyboard) {
    setBoard(next);
    try {
      const { storyboard } = await updateStoryboard(next.id, { shots: next.shots, status: next.status, title: next.title, brief: next.brief });
      if (!unmounted.current) setBoard((current) => (current && current.id === storyboard.id ? { ...storyboard, shots: current.shots } : current));
    } catch {
      // Kept locally; the next save carries it.
    }
  }

  function patchShot(id: string, patch: Partial<StoryboardShot>) {
    const current = boardRef.current;
    if (!current) return null;
    const next = { ...current, shots: current.shots.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
    boardRef.current = next;
    setBoard(next);
    return next;
  }

  async function plan() {
    if (!sessionId) return setError("Open a session first.");
    setBusy("plan");
    setError(null);
    try {
      const { storyboard } = await planStoryboard({
        session_id: sessionId,
        mode,
        element_ids: elementIds,
        note,
        shots: shotCount,
        seconds,
        aspect_ratio: aspect,
        settings: { still_model: stillModel?.id, video_model: videoModel?.id, aspect_ratio: aspect, video_resolution: resolution, seconds }
      });
      setBoard(storyboard);
      setRecent((list) => [storyboard, ...list.filter((s) => s.id !== storyboard.id)].slice(0, 20));
      onStatus(`Planned ${storyboard.shots.length} shots. Check them, then make the stills.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The planner did not answer.");
    } finally {
      setBusy("");
    }
  }

  /** Your own dock copies of each saved item's photos, made once. */
  async function referenceAssets(): Promise<Asset[]> {
    if (!sessionId || !board) return [];
    const out: Asset[] = [];
    for (const id of board.element_ids) {
      if (!refCache.current[id]) {
        const result = await useElement(id, sessionId);
        refCache.current[id] = result.assets;
        onAssetsCreated(result.assets);
      }
      out.push(...refCache.current[id]);
    }
    return out.slice(0, stillModel?.reference_image_limit || 6);
  }

  async function makeStill(shot: StoryboardShot, refs: Asset[]) {
    if (!sessionId || !stillModel || !stillSettings) return;
    setShotBusy((b) => ({ ...b, [shot.id]: "still" }));
    patchShot(shot.id, { status: "still_running" });
    try {
      const prompt = shot.image_prompt;
      const providerPrompt = composeReferencePrompt(withElementBlock(prompt, boardElements), refs);
      const request = buildTurnRequest({
        sessionId,
        modelId: stillModel.id,
        prompt,
        promptMode: "generate",
        settings: stillSettings,
        referenceAssetIds: refs.map((r) => r.id),
        providerPrompt
      });
      const started = await createInferenceTurn(request);
      let result: { status: string; assets?: Asset[]; error?: { message?: string } } = started;
      if (started.status === "running" || started.status === "queued") {
        const done = await untilDone(started.turn.id, () => unmounted.current);
        if (done) result = done;
      }
      const asset = result.assets?.[0];
      if (result.status === "complete" && asset) {
        setMade((m) => ({ ...m, [asset.id]: asset }));
        onAssetsCreated([asset]);
        const next = patchShot(shot.id, { still_asset_id: asset.id, clip_asset_id: null, status: "still_done" });
        if (next) await saveBoard(next);
      } else {
        const next = patchShot(shot.id, { status: "failed" });
        if (next) await saveBoard(next);
        setError(result.error?.message ?? `The still for "${shot.title}" did not come back.`);
      }
    } catch (err) {
      patchShot(shot.id, { status: "failed" });
      setError(err instanceof Error ? err.message : "The still failed.");
    } finally {
      setShotBusy((b) => ({ ...b, [shot.id]: undefined }));
    }
  }

  async function makeClip(shot: StoryboardShot) {
    if (!sessionId || !videoModel || !clipSettings || !shot.still_asset_id) return;
    setShotBusy((b) => ({ ...b, [shot.id]: "clip" }));
    patchShot(shot.id, { status: "clip_running" });
    try {
      let result: { status: string; assets?: Asset[]; turn: { id: string }; error?: { message?: string } } = await createVideoStoryboard({
        session_id: sessionId,
        model: videoModel.id,
        prompt: shot.motion_prompt,
        settings: clipSettings,
        source_asset_id: shot.still_asset_id,
        reference_asset_ids: [],
        reference_mode: "frames",
        provider_prompt: `${shot.motion_prompt}\nThe first frame is fixed: keep the product, people and set exactly as they look in it.`
      });
      const next0 = patchShot(shot.id, { clip_message_id: result.turn?.id ?? null });
      if (next0) void saveBoard(next0);
      if (result.status === "running") {
        const done = await untilDone(result.turn.id, () => unmounted.current);
        if (done) result = { ...result, ...done };
      }
      const asset = result.assets?.[0];
      if (result.status === "complete" && asset) {
        setMade((m) => ({ ...m, [asset.id]: asset }));
        onAssetsCreated([asset]);
        const next = patchShot(shot.id, { clip_asset_id: asset.id, status: "clip_done" });
        if (next) await saveBoard(next);
      } else {
        const next = patchShot(shot.id, { status: "failed" });
        if (next) await saveBoard(next);
        setError(result.error?.message ?? `The clip for "${shot.title}" did not come back.`);
      }
    } catch (err) {
      patchShot(shot.id, { status: "failed" });
      setError(err instanceof Error ? err.message : "The clip failed.");
    } finally {
      setShotBusy((b) => ({ ...b, [shot.id]: undefined }));
    }
  }

  async function makeAllStills() {
    if (!board) return;
    setBusy("stills");
    setError(null);
    try {
      const refs = await referenceAssets();
      const todo = board.shots.filter((s) => !s.still_asset_id);
      await inBatches(todo.length ? todo : board.shots, PARALLEL, (shot) => makeStill(shot, refs));
      onStatus("Stills are in. Redo any you do not like, then make the clips.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not make the stills.");
    } finally {
      setBusy("");
    }
  }

  async function redoStill(shot: StoryboardShot) {
    setError(null);
    try {
      await makeStill(shot, await referenceAssets());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not make the still.");
    }
  }

  async function makeAllClips() {
    if (!board) return;
    setBusy("clips");
    setError(null);
    try {
      const todo = board.shots.filter((s) => s.still_asset_id && !s.clip_asset_id);
      await inBatches(todo, PARALLEL, (shot) => makeClip(shot));
      onStatus("Clips are in. Join them into one film when you are happy.");
    } finally {
      setBusy("");
    }
  }

  async function join() {
    if (!board) return;
    setBusy("join");
    setError(null);
    try {
      const { asset, storyboard } = await joinStoryboard(board.id);
      setMade((m) => ({ ...m, [asset.id]: asset }));
      onAssetsCreated([asset]);
      setBoard((current) => (current ? { ...storyboard, shots: current.shots } : storyboard));
      onStatus("The film is ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the clips.");
    } finally {
      setBusy("");
    }
  }

  function editShot(id: string, patch: Partial<StoryboardShot>) {
    patchShot(id, patch);
  }

  const film = board?.final_asset_id ? assetById.get(board.final_asset_id) : undefined;
  const allClips = shots.length > 1 && shots.every((s) => s.clip_asset_id);
  const anyBusy = busy !== "" || Object.values(shotBusy).some(Boolean);

  return (
    <div className="ad-builder">
      <PageHeader
        title="Ad builder"
        subtitle="A saved product and an ad style become a few planned shots, a still per shot, a clip per shot, and one film."
        actions={<WhatsNewButton />}
      />

      {error ? <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner> : null}

      <section className="ad-step">
        <header className="ad-step__head">
          <span className="ad-step__num">1</span>
          <Text variant="headingMd" as="h2">Plan</Text>
        </header>
        <div className="ad-plan">
          <div className="ad-plan__products">
            <Text variant="headingSm" as="h3">Products and characters</Text>
            {products.length ? (
              <div className="ad-chip-row">
                {products.map((el) => {
                  const on = elementIds.includes(el.id);
                  return (
                    <button
                      key={el.id}
                      type="button"
                      className={`ad-element-chip${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() => setElementIds((ids) => (on ? ids.filter((x) => x !== el.id) : [...ids, el.id].slice(0, 4)))}
                    >
                      {el.images[0]?.url ? <img src={thumbnailUrl(el.images[0].url, 64, 35, "webp")} alt="" /> : null}
                      @{el.tag}
                    </button>
                  );
                })}
              </div>
            ) : (
              <Text variant="bodySm" tone="secondary" as="p">Nothing saved yet. Save a product first (you can paste its page link).</Text>
            )}
            <Button size="micro" variant="plain" icon="plus" onClick={onOpenElements}>Products and characters</Button>
          </div>

          <div>
            <Text variant="headingSm" as="h3">Ad style</Text>
            <div className="ad-chip-row">
              {Object.entries(modes).map(([key, value]) => (
                <button key={key} type="button" className={`ad-mode-chip${mode === key ? " is-on" : ""}`} aria-pressed={mode === key} title={value.guide} onClick={() => setMode(key)}>
                  {value.label}
                </button>
              ))}
            </div>
            {modes[mode] ? <Text variant="bodySm" tone="secondary" as="p">{modes[mode].guide}</Text> : null}
          </div>

          <TextField
            label="Note for the planner (optional)"
            multiline
            rows={2}
            value={note}
            placeholder="Season, place, feeling, a line the ad must land, what to avoid."
            onChange={(event) => setNote(event.target.value.slice(0, 2000))}
          />

          <div className="ad-settings">
            <Select label="Shots" options={["2", "3", "4", "5", "6"]} value={String(shotCount)} onChange={(e) => setShotCount(Number(e.target.value))} />
            <Select label="Still model" options={imageModels.map((m) => ({ label: m.short_label ?? m.label, value: m.id }))} value={stillModel?.id ?? ""} onChange={(e) => setStillModelId(e.target.value)} />
            <Select label="Video model" options={videoModels.map((m) => ({ label: m.short_label ?? m.label, value: m.id }))} value={videoModel?.id ?? ""} onChange={(e) => setVideoModelId(e.target.value)} />
            <Select label="Shape" options={videoModel?.allowed_aspect_ratios ?? [aspect]} value={aspect} onChange={(e) => setAspect(e.target.value)} />
            <Select
              label="Clip quality"
              options={(videoModel?.allowed_resolutions ?? [resolution]).map((r) => ({ label: r === "480p" ? "480p (draft)" : r, value: r }))}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
            <Select label="Seconds per shot" options={(videoModel?.allowed_durations ?? [seconds]).map(String)} value={String(seconds)} onChange={(e) => setSeconds(Number(e.target.value))} />
          </div>
          <Text variant="bodySm" tone="secondary" as="p">
            Tip: make the clips at 480p first. When the cut works, set 1080p and make them again.
          </Text>
          <div className="ad-actions">
            <Button variant="primary" icon="sparkles" loading={busy === "plan"} disabled={anyBusy || connection !== "online"} onClick={() => void plan()}>
              {board ? "Plan again" : "Plan shots"}
            </Button>
            {recent.length ? (
              <Select
                label="Open a past plan"
                labelHidden
                options={[{ label: "Open a past plan...", value: "" }, ...recent.map((s) => ({ label: `${s.title || "Product ad"} (${s.shots.length} shots)`, value: s.id }))]}
                value=""
                onChange={(e) => {
                  const found = recent.find((s) => s.id === e.target.value);
                  if (found) setBoard(found);
                }}
              />
            ) : null}
          </div>
        </div>
      </section>

      {board ? (
        <section className="ad-step">
          <header className="ad-step__head">
            <span className="ad-step__num">2</span>
            <Text variant="headingMd" as="h2">{board.title || "Shots"}</Text>
          </header>
          {board.brief ? <Text variant="bodyMd" tone="secondary" as="p">{board.brief}</Text> : null}
          {boardElements.length ? (
            <Text variant="bodySm" tone="secondary" as="p">Uses {boardElements.map((el) => `@${el.tag}`).join(", ")}: their photos go in as references for every still.</Text>
          ) : null}

          <ol className="ad-shots">
            {shots.map((shot, index) => {
              const still = shot.still_asset_id ? assetById.get(shot.still_asset_id) : undefined;
              const clip = shot.clip_asset_id ? assetById.get(shot.clip_asset_id) : undefined;
              const working = shotBusy[shot.id];
              return (
                <li key={shot.id} className={`ad-shot${shot.status === "failed" ? " is-failed" : ""}`}>
                  <div className="ad-shot__media">
                    <div className="ad-shot__frame">
                      {working === "still" ? <span className="ad-shot__wait">Making still...</span>
                        : still?.preview_url ? (
                          <button type="button" className="ad-shot__thumb" onClick={() => onExpandAsset?.(still)} aria-label={`Open still ${index + 1}`}>
                            <img src={thumbnailUrl(still.preview_url, 320, 50, "webp")} alt="" />
                          </button>
                        ) : <span className="ad-shot__wait">No still yet</span>}
                    </div>
                    <div className="ad-shot__frame">
                      {working === "clip" ? <span className="ad-shot__wait">Making clip... (a few minutes)</span>
                        : clip?.preview_url ? <video src={clip.preview_url} controls muted playsInline preload="metadata" />
                          : <span className="ad-shot__wait">No clip yet</span>}
                    </div>
                  </div>
                  <div className="ad-shot__text">
                    <TextField label={`Shot ${index + 1}`} value={shot.title} onChange={(e) => editShot(shot.id, { title: e.target.value.slice(0, 80) })} onBlur={() => board && void saveBoard(boardRef.current!)} />
                    <TextField label="First frame (still)" multiline rows={3} value={shot.image_prompt} onChange={(e) => editShot(shot.id, { image_prompt: e.target.value.slice(0, 1200) })} onBlur={() => board && void saveBoard(boardRef.current!)} />
                    <TextField label="Motion (clip)" multiline rows={2} value={shot.motion_prompt} onChange={(e) => editShot(shot.id, { motion_prompt: e.target.value.slice(0, 600) })} onBlur={() => board && void saveBoard(boardRef.current!)} />
                    <div className="ad-shot__buttons">
                      <Button size="micro" icon="arrow-path" disabled={anyBusy} onClick={() => void redoStill(shot)}>{still ? "Redo still" : "Make still"}</Button>
                      <Button size="micro" icon="play" disabled={anyBusy || !shot.still_asset_id} onClick={() => void makeClip(shot)}>{clip ? "Redo clip" : "Make clip"}</Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="ad-run">
            <div>
              <Button variant="primary" icon="photo" loading={busy === "stills"} disabled={anyBusy} onClick={() => void makeAllStills()}>
                {shots.some((s) => s.still_asset_id) ? "Make missing stills" : "Make all stills"}
              </Button>
              {stillsCost ? <Text variant="bodySm" tone="secondary" as="p" numeric>{stillsCost}</Text> : null}
            </div>
            <div>
              <Button variant="primary" icon="play" loading={busy === "clips"} disabled={anyBusy || !clipsToMake} onClick={() => void makeAllClips()}>
                Make clips
              </Button>
              {clipsCost && clipsToMake ? <Text variant="bodySm" tone="secondary" as="p" numeric>{clipsCost}</Text> : null}
            </div>
            <div>
              <Button variant="primary" icon="squares-plus" loading={busy === "join"} disabled={anyBusy || !allClips} onClick={() => void join()}>
                Join film
              </Button>
              <Text variant="bodySm" tone="secondary" as="p">No extra cost. Every clip must have the same shape and quality.</Text>
            </div>
          </div>

          {film?.preview_url ? (
            <div className="ad-film">
              <Text variant="headingSm" as="h3">Film</Text>
              <video src={film.preview_url} controls playsInline preload="metadata" />
              <div className="ad-actions">
                <Button icon="arrow-down-tray" onClick={() => onDownloadAsset?.(film)}>Download</Button>
                <Button variant="plain" icon="photo" onClick={() => onExpandAsset?.(film)}>Open</Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <div className="ad-empty">
          <Icon source="sparkles" size={20} />
          <Text variant="bodyMd" tone="secondary" as="p">Pick a product and an ad style, then plan the shots. Planning is free; stills and clips cost what the price line says.</Text>
        </div>
      )}
    </div>
  );
}
