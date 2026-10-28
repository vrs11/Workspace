// Small lossless RGB/RGBA PNG utility for deterministic fixtures and native
// screenshot assertions. No image library or runtime dependency is added.
import { deflateSync, inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
function crc(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Buffer) {
  const type = Buffer.from(kind),
    length = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, sum]);
}
export function pixelFixture(width = 256, height = 160) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.fill(
        (x + y) % 2 ? 255 : 0,
        y * (1 + width * 3) + 1 + x * 3,
        y * (1 + width * 3) + 1 + (x + 1) * 3,
      );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function readPng(bytes: Buffer) {
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Not a PNG");
  let width = 0,
    height = 0,
    channels = 0;
  const parts: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset),
      kind = bytes.toString("ascii", offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, offset + 8 + size);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (data[8] !== 8 || !channels || data[12] !== 0)
        throw new Error("Unsupported screenshot PNG format");
    }
    if (kind === "IDAT") parts.push(data);
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)),
    stride = width * channels,
    pixels = Buffer.alloc(width * height * channels);
  if (raw.length !== height * (stride + 1))
    throw new Error("Invalid PNG scanlines");
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0,
        above = y ? pixels[(y - 1) * stride + x] : 0,
        upperLeft =
          y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = above;
      else if (filter === 3) prediction = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft,
          a = Math.abs(p - left),
          b = Math.abs(p - above),
          c = Math.abs(p - upperLeft);
        prediction = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      } else if (filter !== 0) throw new Error("Invalid PNG filter");
      pixels[y * stride + x] =
        (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return {
    width,
    height,
    pixel: (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height)
        throw new Error("Screenshot sample is outside image");
      return [
        ...pixels.subarray(
          (y * width + x) * channels,
          (y * width + x) * channels + 3,
        ),
      ];
    },
  };
}
