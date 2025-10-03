// Classifier + SafeMSE in SEQUENCE mode.
// Now tracks buffered end after each media fragment to map currentTime -> label.

export type ProbeKind = "init" | "media" | "unknown";

function findBoxOffsets(buf: Uint8Array, type: string): number[] {
  const t0 = type.charCodeAt(0), t1 = type.charCodeAt(1), t2 = type.charCodeAt(2), t3 = type.charCodeAt(3);
  const hits: number[] = [];
  for (let i = 0; i + 7 < buf.length; i++) {
    if (buf[i+4] === t0 && buf[i+5] === t1 && buf[i+6] === t2 && buf[i+7] === t3) hits.push(i);
  }
  return hits;
}

export function classifyFragment(ab: ArrayBuffer): "init" | "media" | "unknown" {
  const u8 = new Uint8Array(ab);
  const hasFtyp = findBoxOffsets(u8, "ftyp").length > 0;
  const hasMoov = findBoxOffsets(u8, "moov").length > 0;
  const hasMoof = findBoxOffsets(u8, "moof").length > 0;
  const hasMdat = findBoxOffsets(u8, "mdat").length > 0;

  if (hasFtyp && hasMoov) return "init";
  if (hasMoof || hasMdat) return "media";
  return "unknown";
}

type Listener = (msg: string) => void;

export class SafeMSE {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private labels: string[] = [];      // labels for media fragments only (no label for init)
  private pending = false;
  private video: HTMLVideoElement;
  private onWarn: Listener;
  private onInfo: Listener;

  // Timing map (end times after each media append, in seconds)
  private boundaries: number[] = [];

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
          try { (this.sourceBuffer as any).mode = "sequence"; } catch {}
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

  // Enqueue init (if any) + media buffers; 'labels' aligns with media only
  enqueueInitAndMedia(init: ArrayBuffer | null, media: ArrayBuffer[], labels: string[]) {
    this.queue = [];
    this.labels = [...labels];
    this.boundaries = [];

    if (init) this.queue.push(init);
    for (const b of media) this.queue.push(b);

    this.pump();
  }

  private getBufferedEnd(): number {
    const sb = this.sourceBuffer!;
    const br = sb.buffered;
    if (!br || br.length === 0) return 0;
    // In sequence mode there should be one contiguous range; use the last end just in case.
    return br.end(br.length - 1);
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
    const isInitAppend = (this.boundaries.length === 0) && (this.labels.length === this.queue.length - 1);
    const prevEnd = this.getBufferedEnd();
    this.pending = true;

    const onOk = () => {
      cleanup();
      // After append, if this was a media fragment, record new boundary end
      const newEnd = this.getBufferedEnd();
      const delta = newEnd - prevEnd;

      // Init usually doesn't change buffered time; only record for media
      if (!isInitAppend && delta > 0.005) {
        this.boundaries.push(newEnd);
      }

      // Shift queue; if media, shift a label too
      this.queue.shift();
      if (!isInitAppend) {
        // when not init append, consume one media label
        // (labels array aligns with number of media fragments appended so far)
      } else {
        // do nothing to labels on init append
      }
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

    const timer = setTimeout(onTimeout, 5000);
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
    // No label shift here; labels aren’t consumed directly, we only use boundaries to map times.
    this.pending = false;
    this.pump();
  }

  // Map currentTime to label: find first boundary >= t
  getLabelForTime(t: number): string {
    if (this.labels.length === 0 || this.boundaries.length === 0) return "";
    for (let i = 0; i < this.boundaries.length; i++) {
      if (t <= this.boundaries[i] + 1e-3) {
        return this.labels[i] ?? "";
      }
    }
    return this.labels[this.labels.length - 1] ?? "";
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
    this.labels = [];
    this.boundaries = [];
    this.pending = false;
  }
}

// Optional stubs to keep old imports compiling
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


// Reads ordering hints from a fragmented MP4 media fragment.
// Returns either a decode-time (tfdt) and/or a sequence number (mfhd).
export function probeOrderKey(ab: ArrayBuffer): { seq?: number; dts?: number } {
  try {
    const u8 = new Uint8Array(ab);
    const dv = new DataView(ab);

    // --- mfhd (sequence number) ---
    const mfhdHits = findBoxOffsets(u8, "mfhd");
    let seq: number | undefined = undefined;
    if (mfhdHits.length) {
      const off = mfhdHits[0];
      // size(4) + type(4) + version/flags(4) + sequence_number(4)
      seq = dv.getUint32(off + 8 + 4, false);
    }

    // --- tfdt (baseMediaDecodeTime) ---
    const tfdtHits = findBoxOffsets(u8, "tfdt");
    let dts: number | undefined = undefined;
    if (tfdtHits.length) {
      const off = tfdtHits[0];
      const version = dv.getUint8(off + 8); // version/flags
      if (version === 1) {
        // 64-bit base decode time
        const hi = dv.getUint32(off + 12, false);
        const lo = dv.getUint32(off + 16, false);
        const big = (BigInt(hi) << BigInt(32)) | BigInt(lo);
        const maybe = Number(big);
        dts = Number.isFinite(maybe) ? maybe : undefined;
      } else {
        dts = dv.getUint32(off + 12, false);
      }
    }

    return { seq, dts };
  } catch {
    return {};
  }
}
