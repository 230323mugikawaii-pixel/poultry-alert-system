// Deterministic, locally synthesized PCM. No third-party recording or CDN.
import { mkdirSync, writeFileSync } from "node:fs";
const root = new URL("../audio/", import.meta.url);
mkdirSync(root, { recursive: true });
const rate = 44100;
function wav(name, duration, tones, peak, square) {
  const frames = Math.round(rate * duration);
  const file = Buffer.alloc(44 + frames * 2);
  file.write("RIFF");
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WAVEfmt ", 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(rate, 24);
  file.writeUInt32LE(rate * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36);
  file.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const time = i / rate;
    let sample = 0;
    for (const [start, frequency, length] of tones) {
      const t = time - start;
      if (t < 0 || t >= length) continue;
      const envelope =
        t < 0.02
          ? 0.0001 * (peak / 0.0001) ** (t / 0.02)
          : t > length - 0.04
            ? peak * (0.0001 / peak) ** ((t - length + 0.04) / 0.04)
            : peak;
      const wave = Math.sin(2 * Math.PI * frequency * t);
      sample += (square ? Math.sign(wave) : wave) * envelope;
    }
    file.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
      44 + i * 2,
    );
  }
  writeFileSync(new URL(name, root), file);
}
wav("confirmation-v1.wav", 0.5, [[0.02, 660, 0.45]], 0.25, false);
wav(
  "alarm-v1.wav",
  0.94,
  [
    [0.03, 880, 0.22],
    [0.35, 1175, 0.22],
    [0.67, 880, 0.22],
  ],
  0.28,
  true,
);
// Complete period includes silence; the HTML player reloads after natural end.
wav(
  "alarm-loop-v2.wav",
  1.3,
  [
    [0.03, 880, 0.22],
    [0.35, 1175, 0.22],
    [0.67, 880, 0.22],
  ],
  0.28,
  true,
);
