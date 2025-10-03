// Helpers used by App.tsx: MP4 fragment classifier + resilient MSE controller that
// uses SourceBuffer.mode = "sequence" so playback follows append order.

export type ProbeKind = "init" | "media" | "unknown";

// --------- MP4 probing (very light) ----------
function findBoxOffsets(buf: Uint8Array, type: string): number[] {
  const t0 = type.charCodeAt(0), t1 = type.charCodeAt(1), t2 = type.charCodeAt(2), t3 = type.charCodeAt(3);
  const hits: number[] = [];
  for (let i = 0; i + 7 < buf.length; i++) {
    if (buf[i+4] === t0 && buf[i+5] === t1 && buf[i+6] === t2 && buf[i+7] === t3) hits.push(i);
  }
  return hits;
}

export function classifyFragment(ab: ArrayBuffer): ProbeKind {
  const u8 = new Uint8Array(ab);
  const hasFtyp = findBoxOffsets(u8, "ftyp").length > 0;
  const hasMoov = findBoxOffsets(u8, "moov").length > 0;
  const hasMoof = findBoxOffsets(u8, "moof").length > 0;
  const hasMdat = findBoxOffsets(u8, "mdat").length > 0;

  if (hasFtyp && hasMoov) return "init";
  if (hasMoof || hasMdat) return "media";
  return "unknown";
}

// --------- Resilient MSE controller (SEQUENCE mode) ----------
type Listener = (msg: string) => void;

export class SafeMSE {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private pending = false;
  private video: HTMLVideoElement;
  private onWarn: Listener;
  private onInfo: Listener;

  constructor(video: HTMLVideoElement, onWarn: Listener, onInfo: Listener) {
    this.video = video;
    this.onWarn = onWarn;
    this.onInfo = onInfo;
  }

  async open(mime: string) {
    if (!("MediaSource" in window)) throw new Error("MediaSource not supported in this browser");
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    await new Promise<void>((resolve, reject) => {
      const ms = this.mediaSource!;
      const onOpen = () => {
        ms.removeEventListener("sourceopen", onOpen);
        try {
          this.sourceBuffer = ms.addSourceBuffer(mime);

          // Play in append order regardless of timestamps
          try { (this.sourceBuffer as any).mode = "sequence"; } catch {}

          // Allow infinite streaming-style appends
          try { ms.duration = Infinity; } catch {}

          this.sourceBuffer.addEventListener("error", () => {
            this.onWarn("SourceBuffer error — skipping fragment");
            this.skipCurrent();
          });
          resolve();
        } catch (e) { reject(e); }
      };
      ms.addEventListener("sourceopen", onOpen);
      ms.addEventListener("error", () => reject(new Error("MediaSource error")));
    });
  }

  enqueueManyFirstInit(init: ArrayBuffer | null, rest: ArrayBuffer[]) {
    this.queue = [];
    if (init) this.queue.push(init);
    for (const b of rest) this.queue.push(b);
    this.pump();
  }

  private pump() {
    if (!this.sourceBuffer || this.pending) return;
    if (this.queue.length === 0) {
      if (this.mediaSource && this.mediaSource.readyState === "open") {
        try { this.mediaSource.endOfStream(); } catch {}
      }
      return;
    }

    const sb = this.sourceBuffer;
    if (sb.updating) {
      sb.addEventListener("updateend", () => this.pump(), { once: true });
      return;
    }

    const fragment = this.queue[0];
    this.pending = true;

    const onOk = () => {
      cleanup();
      this.queue.shift();
      this.pending = false;
      this.pump();
    };
    const onTimeout = () => {
      cleanup();
      this.onWarn("Append stalled — skipping fragment");
      this.skipCurrent();
    };
    const cleanup = () => {
      clearTimeout(timer);
      sb.removeEventListener("updateend", onOk);
    };

    const timer = setTimeout(onTimeout, 4000);
    sb.addEventListener("updateend", onOk, { once: true });

    try {
      sb.appendBuffer(fragment);
    } catch {
      cleanup();
      this.onWarn("Append threw — skipping fragment");
      this.skipCurrent();
    }
  }

  private skipCurrent() {
    if (this.queue.length > 0) this.queue.shift();
    this.pending = false;
    this.pump();
  }

  destroy() {
    try {
      if (this.sourceBuffer && this.mediaSource?.readyState === "open") {
        this.sourceBuffer.abort();
        this.mediaSource.endOfStream();
      }
    } catch {}
    if (this.video.src) URL.revokeObjectURL(this.video.src);
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.queue = [];
    this.pending = false;
  }
}

// --------- Optional stubs to keep old imports compiling ---------
export async function mergeMP4(_files: File[]): Promise<Blob> {
  throw new Error("mergeMP4 is not used for playback. MSE streams fragments directly in append order.");
}

export async function checkFormatCompatibility(files: File[]): Promise<string[]> {
  const warns: string[] = [];
  for (const f of files) {
    if (f.type !== "video/mp4") warns.push(`File ${f.name} is not an MP4 file`);
  }
  return warns;
}
