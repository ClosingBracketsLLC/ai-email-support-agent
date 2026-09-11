/** An ICO container whose entries are PNG-compressed (Windows Vista+ and every current browser read these). 6-byte header, 16 bytes per directory entry, then the PNG blobs. */
export function packIco(entries: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)                  // reserved
  header.writeUInt16LE(1, 2)                  // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ size, png }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e)     // width (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1) // height
    dir.writeUInt8(0, e + 2)                      // palette size
    dir.writeUInt8(0, e + 3)                      // reserved
    dir.writeUInt16LE(1, e + 4)                   // colour planes
    dir.writeUInt16LE(32, e + 6)                  // bits per pixel
    dir.writeUInt32LE(png.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...entries.map((x) => x.png)])
}

export function readIco(buf: Buffer): { width: number; height: number; bytes: number; offset: number; png: Buffer }[] {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO')
  const count = buf.readUInt16LE(4)
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + i * 16
    const w = buf.readUInt8(e), h = buf.readUInt8(e + 1)
    const bytes = buf.readUInt32LE(e + 8), offset = buf.readUInt32LE(e + 12)
    return { width: w === 0 ? 256 : w, height: h === 0 ? 256 : h, bytes, offset, png: buf.subarray(offset, offset + bytes) }
  })
}
