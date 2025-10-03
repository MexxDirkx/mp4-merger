// A small MSE controller that safely appends buffers, skips on error, and continues.
// It guarantees init segment goes first, regardless of the user order.

type Listener = (msg: string) => void;

export class SafeMSE {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private mime: string | null = null;
  private queue: ArrayBuffer[] = [];
  private pending: boolean = false;
  private video: HTMLVideoElement;
  private onWarn: Listener;
  private onInfo: Listener;

  constructor(video: HTMLVideoElement, onWarn: Listener, onInfo: Listener) {
    this.video = video;
    this.onWarn = onWarn;
    this.onInfo = onInfo;
  }

  async open(mime: string) {
    if (!("MediaSource" in window)) throw new Error("MediaSource not supported");
    this.mime = mime;

    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);

    await new Promise<void>((resolve, reject) => {
      const ms = this.mediaSource!;
      const onOpen = () => {
        ms.removeEventListener("sourceopen", onOpen);
        try {
          this.sourceBuffer = ms.addSourceBuffer(mime);
          // Soft error handling
          this.sourceBuffer.addEventListener("error", () => {
            this.onWarn("SourceBuffer error — skipping current fragment");
            this.skipCurrent();
          });
          resolve();
        } catch (e) {
          reject(e);
        }
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
      // End stream a little later so the tag updates time ranges
      if (this.mediaSource && this.mediaSource.readyState === "open") {
        try { this.mediaSource.endOfStream(); } catch {}
      }
      return;
    }

    const buf = this.queue[0];
    this.pending = true;

    const sb = this.sourceBuffer;
    const onEnd = () => {
      cleanup();
      this.queue.shift();        // consume OK fragment
      this.pending = false;
      this.pump();
    };
    const onErrorTimeout = () => {
      cleanup();
      this.onWarn("Append stalled — skipping fragment");
      this.skipCurrent();        // consume bad fragment
    };
    const cleanup = () => {
      clearTimeout(timer);
      sb.removeEventListener("updateend", onEnd);
    };

    // If the buffer is currently updating, wait for it to finish.
    if (sb.updating) {
      sb.addEventListener("updateend", () => this.pump(), { once: true });
      this.pending = false;
      return;
    }

    // Append with a watchdog; if it never resolves, skip.
    const timer = setTimeout(onErrorTimeout, 4000);

    sb.addEventListener("updateend", onEnd, { once: true });

    try {
      sb.appendBuffer(buf);
    } catch (e) {
      cleanup();
      this.onWarn("Append threw — skipping fragment");
      this.skipCurrent();
    }
  }

  private skipCurrent() {
    // Drop the fragment and keep going
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
    this.mime = null;
  }
}
