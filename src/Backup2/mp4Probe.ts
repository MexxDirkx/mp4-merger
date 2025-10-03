// Super light MP4 probe: detects box presence and extracts a best-effort codec string.
// For reliable codec strings, we use mp4box when an init segment is present.

export type ProbeKind = "init" | "media" | "unknown";

export function findBoxOffsets(buf: Uint8Array, type: string): number[] {
  const t0 = type.charCodeAt(0),
        t1 = type.charCodeAt(1),
        t2 = type.charCodeAt(2),
        t3 = type.charCodeAt(3);
  const hits: number[] = [];
  for (let i = 0; i + 7 < buf.length; i++) {
    // MP4 box: [size:4][type:4]
    if (buf[i+4] === t0 && buf[i+5] === t1 && buf[i+6] === t2 && buf[i+7] === t3) {
      hits.push(i);
    }
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
