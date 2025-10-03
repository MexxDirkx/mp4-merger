export async function mergeMP4(files: File[]): Promise<Blob> {
  if (files.length === 0) throw new Error('No files provided');
  if (files.length === 1) return files[0];

  // Read all files as ArrayBuffers
  const buffers: ArrayBuffer[] = [];
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    buffers.push(buffer);
  }

  // Calculate total size
  const totalSize = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);

  // Create combined buffer
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const buffer of buffers) {
    combined.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }

  return new Blob([combined], { type: 'video/mp4' });
}

export async function checkFormatCompatibility(files: File[]): Promise<string[]> {
  const warnings: string[] = [];

  // Basic checks: file type and size comparison
  for (let i = 0; i < files.length; i++) {
    if (files[i].type !== 'video/mp4') {
      warnings.push(`File ${files[i].name} is not an MP4 file`);
    }
    if (i > 0 && Math.abs(files[i].size - files[0].size) > files[0].size * 0.1) {
      warnings.push(`File ${files[i].name} has significantly different size than ${files[0].name}`);
    }
  }

  return warnings;
}