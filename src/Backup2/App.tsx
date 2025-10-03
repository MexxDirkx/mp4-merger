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
import { classifyFragment } from "./mp4Probe";
import { SafeMSE } from "./msePlayer";
import { extractCodecsFromInit } from "./codecFromInit";
import { Toasts } from "./Toast";

interface Frag {
  id: string;
  file: File;
  kind: "init" | "media" | "unknown";
  size: number;
  buf?: ArrayBuffer; // cached
}

function SortableItem({ id, file, index }: { id: string; file: File; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className="file-item">
      <div {...attributes} {...listeners} className="drag-handle">⋮⋮</div>
      <span>{index + 1}. {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
    </div>
  );
}

export default function App() {
  const [frags, setFrags] = useState<Frag[]>([]);
  const [error, setError] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [toasts, setToasts] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mseRef = useRef<SafeMSE | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => () => { // cleanup on unmount
    mseRef.current?.destroy();
  }, []);

  const initFrag = useMemo(() => frags.find(f => f.kind === "init") ?? null, [frags]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setError("");
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    // Read buffers and classify
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
        `${unknowns.length} file(s) do not look like MP4 init or media fragments and may be skipped.`,
      ]);
    }
    setFrags(items);
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

  async function startPlayback() {
    setToasts([]);
    setWarnings([]);
    setError("");

    const video = videoRef.current!;
    if (!video) return;

    // Ensure we have an init segment
    const init = initFrag?.buf ?? null;
    if (!init) {
      setError("No init segment detected. Include a fragment containing 'ftyp' and 'moov' (the MP4 header).");
      return;
    }

    // Extract codecs from init with mp4box; fall back if not found
    const mime = (await extractCodecsFromInit(init)) ?? 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

    // Setup MSE
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

    // Build enqueue order: init first, then user-ordered media/unknown
    const ordered = frags.filter(f => f.kind !== "init").map(f => f.buf!).filter(Boolean);
    mse.enqueueManyFirstInit(init, ordered);

    try {
      await video.play();
      setIsPlaying(true);
    } catch (e) {
      setError("Autoplay blocked. Press Play to start.");
    }
  }

  function stopPlayback() {
    mseRef.current?.destroy();
    setIsPlaying(false);
  }

  async function clearList() {
    stopPlayback();
    setFrags([]);
    setWarnings([]);
    setToasts([]);
    setError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="app">
      <h1>Byte-Slice MP4 Fragment Player (MSE)</h1>

      <p className="muted">
        Add byte-sliced MP4 fragments from the <em>same source video</em> (one must contain <code>ftyp+moov</code>).
        Drag to reorder. Playback will gracefully skip bad/out-of-order fragments.
      </p>

      <div className="row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/mp4, .mp4"
          onChange={handleFileSelect}
          style={{ display: "none" }}
        />
        <button onClick={() => fileInputRef.current?.click()}>Add Fragments</button>
        <button className="secondary" onClick={clearList}>Clear</button>
        {!isPlaying ? (
          <button disabled={!frags.length} className="success" onClick={startPlayback}>Play</button>
        ) : (
          <button className="danger" onClick={stopPlayback}>Stop</button>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {frags.length > 0 && (
        <div className="file-list">
          <h2>Fragments (drag to reorder)</h2>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={frags.map(f => f.id)} strategy={verticalListSortingStrategy}>
              {frags.map((f, i) => (
                <SortableItem key={f.id} id={f.id} file={f.file} index={i} />
              ))}
            </SortableContext>
          </DndContext>
          <div className="legend">
            <span><b>Detected init:</b> {initFrag ? initFrag.file.name : "none"}</span>
          </div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="warnings">
          <h3>Warnings</h3>
          <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      <div className="preview">
        <video ref={videoRef} controls playsInline preload="metadata" />
      </div>

      <Toasts messages={toasts} onClear={() => setToasts([])} />
    </div>
  );
}
