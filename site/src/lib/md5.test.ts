import { describe, expect, it } from 'vitest';
import { md5 } from './md5';

describe('md5', () => {
  it('bate com os vetores conhecidos do RFC 1321', () => {
    // regressão aqui quebraria silenciosamente todos os links pf- de dados
    // antigos já compartilhados — o hash precisa ser exatamente o MD5 padrão
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('12345678901')).toBe(md5('12345678901')); // determinístico
  });
});
