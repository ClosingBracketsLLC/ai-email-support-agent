export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('not a PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
