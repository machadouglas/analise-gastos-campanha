import { describe, expect, it } from 'vitest';
import { celula, cnpjCpf, temFichaFornecedor, urlFornecedor } from './format';

describe('cnpjCpf', () => {
  it('CNPJ sai completo e formatado (dado público pleno)', () => {
    expect(cnpjCpf('12345678000190')).toBe('12.345.678/0001-90');
  });

  it('CPF sai mascarado (minimização — pessoa física não é figura pública)', () => {
    const m = cnpjCpf('12345678901');
    expect(m).toBe('***.456.789-**');
    expect(m).not.toContain('123');
  });

  it('códigos do TSE para "sem contraparte" viram travessão', () => {
    expect(cnpjCpf('-1')).toBe('—');
    expect(cnpjCpf('#NULO')).toBe('—');
  });
});

describe('temFichaFornecedor', () => {
  it('só CPF/CNPJ reais têm ficha', () => {
    expect(temFichaFornecedor('12345678000190')).toBe(true);
    expect(temFichaFornecedor('12345678901')).toBe(true);
    expect(temFichaFornecedor('-1')).toBe(false);
    expect(temFichaFornecedor('#NULO')).toBe(false);
    expect(temFichaFornecedor(null)).toBe(false);
  });
});

describe('urlFornecedor', () => {
  it('CNPJ viaja cru na URL; CPF vira identificador opaco e estável', () => {
    expect(urlFornecedor('12345678000190')).toBe('/fornecedor/12345678000190');
    const u = urlFornecedor('12345678901');
    expect(u).toMatch(/^\/fornecedor\/pf-[0-9a-f]{16}$/);
    expect(u).not.toContain('12345678901');
    expect(urlFornecedor('12345678901')).toBe(u); // determinístico (links compartilháveis)
  });
});

describe('celula', () => {
  it('converte os tipos do Arrow para texto exibível', () => {
    expect(celula(null)).toBe('');
    expect(celula(10n)).toBe('10');
    expect(celula(new Date('2026-08-20T00:00:00Z'))).toBe('2026-08-20');
    expect(celula('texto')).toBe('texto');
  });
});
