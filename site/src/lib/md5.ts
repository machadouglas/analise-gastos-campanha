/* MD5 compacto (RFC 1321) para gerar identificadores opacos de URL.
   Uso não-criptográfico: só evita expor CPF em endereços e logs. */

/* eslint-disable no-bitwise */
function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

export function md5(texto: string): string {
  const bytes = new TextEncoder().encode(texto);
  const bitLen = bytes.length * 8;
  const comPad = ((bytes.length + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(comPad);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  new DataView(buf.buffer).setUint32(comPad - 8, bitLen >>> 0, true);
  new DataView(buf.buffer).setUint32(comPad - 4, Math.floor(bitLen / 2 ** 32), true);

  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const vista = new DataView(buf.buffer);

  for (let bloco = 0; bloco < comPad; bloco += 64) {
    const M = Array.from({ length: 16 }, (_, i) => vista.getUint32(bloco + i * 4, true));
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D;
      D = C;
      C = B;
      B = (B + rotl((A + F + K[i] + M[g]) >>> 0, S[i])) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const saida = new Uint8Array(16);
  const dv = new DataView(saida.buffer);
  dv.setUint32(0, a0, true);
  dv.setUint32(4, b0, true);
  dv.setUint32(8, c0, true);
  dv.setUint32(12, d0, true);
  return Array.from(saida, (b) => b.toString(16).padStart(2, '0')).join('');
}
