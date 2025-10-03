import * as MP4Box from "mp4box";

export async function extractCodecsFromInit(initSegment: ArrayBuffer): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // mp4box expects a File-like stream with byte positions. We can feed the whole init.
      const mp4file = MP4Box.createFile();
      mp4file.onReady = (info: any) => {
        // Build a codecs string like 'video/mp4; codecs="avc1.4d401f,mp4a.40.2"'
        const codecs: string[] = [];
        info.tracks?.forEach((t: any) => {
          if (t.codec) codecs.push(t.codec);
        });
        if (codecs.length) resolve(`video/mp4; codecs="${codecs.join(",")}"`);
        else resolve(null);
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
