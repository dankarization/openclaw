/** Expand one G.711 mu-law sample to signed 16-bit PCM. */
export function mulawToLinear(value: number): number {
  const muLaw = ~value & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  const sample = (((mantissa << 3) + 132) << exponent) - 132;
  return sign ? -sample : sample;
}

/** Encode mono 8 kHz G.711 mu-law frames as a little-endian 16-bit PCM WAV. */
export function encodeMulaw8kWav(chunks: readonly Uint8Array[]): ArrayBuffer {
  const pcmBytes = chunks.reduce((bytes, chunk) => bytes + chunk.length * 2, 0);
  const wav = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(wav);
  view.setUint32(0, 0x52494646); // RIFF
  view.setUint32(4, 36 + pcmBytes, true);
  view.setUint32(8, 0x57415645); // WAVE
  view.setUint32(12, 0x666d7420); // fmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461); // data
  view.setUint32(40, pcmBytes, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      view.setInt16(offset, mulawToLinear(sample), true);
      offset += 2;
    }
  }
  return wav;
}
