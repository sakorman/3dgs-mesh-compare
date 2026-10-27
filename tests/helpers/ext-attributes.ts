// Spark 2.4.0 extended layout, verified against src/utils.ts (MIT):
// https://github.com/sparkjsdev/spark/blob/ffe210dc0a45d0515a06c9235878108112827d61/src/utils.ts
export const attributeMasks = {
  position: [[0xffffffff, 0xffffffff, 0xffffffff, 0], [0, 0, 0, 0]],
  opacity: [[0, 0, 0, 0xffff], [0, 0, 0, 0]],
  color: [[0, 0, 0, 0], [0xffffffff, 0xffff, 0, 0]],
  scale: [[0, 0, 0, 0], [0, 0xffff0000, 0xffffffff, 0]],
  rotation: [[0, 0, 0, 0], [0, 0, 0, 0xffffffff]],
} as const;
export type Attribute = keyof typeof attributeMasks;
export function restoreAttributes(base: [Uint32Array, Uint32Array], original: [Uint32Array, Uint32Array], count: number, fields: readonly Attribute[]) {
  if (!Number.isInteger(count) || count < 0 || [...base, ...original].some(a => a.length < count * 4))
    throw new Error("Invalid splat count or array length");
  const out: [Uint32Array, Uint32Array] = [base[0].slice(), base[1].slice()];
  for (let bank = 0; bank < 2; bank++) {
    const masks = [0, 0, 0, 0];
    for (const field of fields) for (let word = 0; word < 4; word++) masks[word] |= attributeMasks[field][bank][word];
    for (let i = 0; i < count * 4; i++) {
      const mask = masks[i % 4];
      out[bank][i] = (base[bank][i] & ~mask) | (original[bank][i] & mask);
    }
  }
  return out;
}
