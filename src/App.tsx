import { useRef, useState, useMemo, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as MP4Box from "mp4box";
import { classifyFragment, SafeMSE, probeOrderKey } from "./mergeMP4";
import "./App.css";

interface Frag {
  id: string;
  file: File;
  kind: "init" | "media" | "unknown";
  size: number;
  buf?: ArrayBuffer;
}

function SortableItem({ id, file, index }: { id: string; file: File; index: number }) {
  // Entire row is draggable
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className="file-item" {...attributes} {...listeners}>
      <span>{index + 1}. {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
    </div>
  );
}

async function extractCodecsFromInit(initSegment: ArrayBuffer): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const mp4file = MP4Box.createFile();
      mp4file.onReady = (info: any) => {
        const codecs: string[] = [];
        info?.tracks?.forEach((t: any) => { if (t?.codec) codecs.push(t.codec); });
        resolve(codecs.length ? `video/mp4; codecs="${codecs.join(",")}"` : null);
      };
      const buf = initSegment as any;
      buf.fileStart = 0;
      mp4file.appendBuffer(buf);
      mp4file.flush();
    } catch {
      resolve(null);
    }
  });
}

function App() {
  const [frags, setFrags] = useState<Frag[]>([]);
  const [error, setError] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [toasts, setToasts] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mseRef = useRef<SafeMSE | null>(null);
  const downloadUrlRef = useRef<string | null>(null);

  const [autoMode, setAutoMode] = useState(false);
  const prevFragsRef = useRef<Frag[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    return () => {
      mseRef.current?.destroy();
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
        downloadUrlRef.current = null;
      }
    };
  }, []);

  const initFrag = useMemo(() => frags.find(f => f.kind === "init") ?? null, [frags]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setError("");
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const items: Frag[] = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const kind = classifyFragment(buf);
      items.push({ id: f.name + ":" + f.size + ":" + Math.random(), file: f, kind, size: f.size, buf });
    }

    const unknowns = items.filter(i => i.kind === "unknown");
    if (unknowns.length) {
      setWarnings(w => [
        ...w,
        `${unknowns.length} file(s) aren’t recognizable as MP4 init or media fragments and may be skipped.`,
      ]);
    }
    setFrags(items);
    setAutoMode(false);
    prevFragsRef.current = null;
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setFrags((items) => {
      const oldIndex = items.findIndex(i => i.id === active.id);
      const newIndex = items.findIndex(i => i.id === over.id);
      return arrayMove(items, oldIndex, newIndex);
    });
  }

  function attachTimeUpdate() {
    const video = videoRef.current!;
    if (!video) return;
    const onTU = () => {
      const t = video.currentTime;
      const label = mseRef.current?.getLabelForTime(t) ?? "";
      if (label && label !== nowPlaying) {
        setNowPlaying(label);
      }
    };
    // Remove previous to avoid duplicates
    video.removeEventListener("timeupdate", onTU as any);
    video.addEventListener("timeupdate", onTU);
  }

  async function startPlayback() {
    setToasts([]);
    setWarnings([]);
    setError("");
    setNowPlaying("");

    const video = videoRef.current!;
    if (!video) return;

    const init = initFrag?.buf ?? null;
    if (!init) {
      setError("No init segment detected. Include a fragment that contains MP4 header boxes (ftyp + moov).");
      return;
    }

    const mime = (await extractCodecsFromInit(init)) ?? 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

    // Reset MSE and attach; SafeMSE builds time boundaries for labels
    mseRef.current?.destroy();
    const mse = new SafeMSE(
      video,
      (msg) => setToasts((t) => [...t, msg]),
      (msg) => setToasts((t) => [...t, msg])
    );
    mseRef.current = mse;

    try {
      await mse.open(mime);
    } catch (e) {
      setError(`Could not open MSE SourceBuffer (${(e as Error).message}).`);
      return;
    }

    const rest = frags.filter(f => f.kind !== "init");
    const orderedBuffers = rest.map(f => f.buf!).filter(Boolean);
    const labels = frags.map(f => f.file.name); // labels for media fragments only

    mse.enqueueInitAndMedia(init, orderedBuffers, labels);

    // Prepare download blob in current order
    buildDownloadUrl(init, orderedBuffers);

    attachTimeUpdate();

    try {
      await video.play();
      setIsPlaying(true);
    } catch {
      setError("Autoplay blocked by browser. Press Play in the controls.");
    }
  }

  function stopPlayback() {
    mseRef.current?.destroy();
    setIsPlaying(false);
    setNowPlaying("");
  }

  function clearAll() {
    stopPlayback();
    setFrags([]);
    setWarnings([]);
    setToasts([]);
    setError("");
    setNowPlaying("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
  }

  function buildDownloadUrl(init: ArrayBuffer | null, rest: ArrayBuffer[]) {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    const parts: BlobPart[] = [];
    if (init) parts.push(new Uint8Array(init));
    for (const b of rest) parts.push(new Uint8Array(b));
    const blob = new Blob(parts, { type: "video/mp4" });
    downloadUrlRef.current = URL.createObjectURL(blob);
  }

  function autoOrder(fragsIn: Frag[]): Frag[] {
    // Keep first init (if any) at the top; sort media by tfdt then mfhd
    const init = fragsIn.find(f => f.kind === "init") || null;
    const media = fragsIn.filter(f => f.kind !== "init");

    const scored = media.map(f => {
      const { dts, seq } = probeOrderKey(f.buf!);
      return { frag: f, dts: dts ?? Number.POSITIVE_INFINITY, seq: seq ?? Number.POSITIVE_INFINITY };
    });

    scored.sort((a, b) => {
      if (a.dts !== b.dts) return a.dts - b.dts;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.frag.file.name.localeCompare(b.frag.file.name);
    });

    const sorted = scored.map(s => s.frag);
    return init ? [init, ...sorted] : sorted;
  }

  function toggleAutoMode() {
    if (!autoMode) {
      // Save current order so we can restore
      prevFragsRef.current = frags.slice();
      setFrags(autoOrder(frags));
      setAutoMode(true);
    } else {
      // Restore previous manual order
      if (prevFragsRef.current) setFrags(prevFragsRef.current);
      prevFragsRef.current = null;
      setAutoMode(false);
    }
  }


  return (
    <div className="app">
      <h1>Fragment Player (MSE — plays in your order)</h1>
      <p className="muted">
        Add byte-sliced fragments from the <em>same source MP4</em>. One fragment must contain <code>ftyp</code>+<code>moov</code> (init).
        We don’t fix order — playback follows the list order using MSE <code>sequence</code> mode.
      </p>

      <div className="row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/mp4,.mp4"
          onChange={handleFileSelect}
          style={{ display: "none" }}
        />
        <button onClick={() => fileInputRef.current?.click()}>Add Fragments</button>
        <button className="secondary" onClick={clearAll}>Clear</button>
        {!isPlaying ? (
          <button className="success" disabled={!frags.length} onClick={startPlayback}>Play</button>
        ) : (
          <button className="danger" onClick={stopPlayback}>Stop</button>
        )}

        <button
          className={autoMode ? "secondary" : "secondary"}
          onClick={toggleAutoMode}
          disabled={!frags.length}
          title="Try to sort fragments using mp4 timing/sequence hints"
        >
          {autoMode ? "Manual Order" : "Auto-Order (beta)"}
        </button>


      </div>

      {error && <div className="error">{error}</div>}

      {frags.length > 0 && (
        <div className="file-list">
          <h2>Fragments (drag to set PLAY order)</h2>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={frags.map(f => f.id)} strategy={verticalListSortingStrategy}>
              {frags.map((f, i) => <SortableItem key={f.id} id={f.id} file={f.file} index={i} />)}
            </SortableContext>
          </DndContext>
          <div className="legend">
            <span><b>Init:</b> {initFrag ? initFrag.file.name : "none"}</span>
            <span style={{ marginLeft: 12 }}><b>Mode:</b> sequence (append order = play order)</span>
          </div>
          {warnings.length > 0 && (
            <div className="warnings">
              <h3>Warnings</h3>
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      <div className="preview">
        {isPlaying && nowPlaying && (
          <div className="now-playing">Now playing: <strong>{nowPlaying}</strong></div>
        )}
        <video ref={videoRef} controls playsInline preload="metadata" />
        <div className="download-row">
          <a
            className={`download-btn${downloadUrlRef.current ? "" : " disabled"}`}
            href={downloadUrlRef.current ?? "#"}
            download="fragments-in-current-order.mp4"
            onClick={(e) => { if (!downloadUrlRef.current) e.preventDefault(); }}
          >
            Download MP4 (current order)
          </a>
        </div>
      </div>

      {!!toasts.length && (
        <div className="toasts">
          {toasts.map((m, i) => <div className="toast" key={i} role="status" aria-live="polite">{m}</div>)}
        </div>
      )}
    </div>
  );
}

export default App;
