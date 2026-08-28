import { describe, expect, it } from 'vitest';
import { celula, cnpjCpf, ePessoaFisica, temFichaFornecedor, urlFornecedor } from './format';

describe('cnpjCpf', () => {
  it('CNPJ sai completo e formatado (dado público pleno)', () => {
    expect(cnpjCpf('12345678000190')).toBe('12.345.678/0001-90');
  });

  it('pessoa física nunca exibe o documento (minimização — não é figura pública)', () => {
    // pseudônimo publicado pelo backend (dados novos)
    expect(cnpjCpf('pf-0123456789abcdef')).toBe('CPF protegido');
    // CPF cru (publicações antigas): também não vaza nenhum dígito
    const m = cnpjCpf('12345678901');
    expect(m).toBe('CPF protegido');
    expect(m).not.toContain('123');
  });

  it('códigos do TSE para "sem contraparte" viram travessão', () => {
    expect(cnpjCpf('-1')).toBe('—');
    expect(cnpjCpf('#NULO')).toBe('—');
  });
});

describe('ePessoaFisica', () => {
  it('reconhece o pseudônimo pf- e o CPF cru de dados antigos', () => {
    expect(ePessoaFisica('pf-0123456789abcdef')).toBe(true);
    expect(ePessoaFisica('12345678901')).toBe(true);
    expect(ePessoaFisica('12345678000190')).toBe(false);
    expect(ePessoaFisica('-1')).toBe(false);
  });
});

describe('temFichaFornecedor', () => {
  it('só ids reais têm ficha (CNPJ, pf- ou CPF de dados antigos)', () => {
    expect(temFichaFornecedor('12345678000190')).toBe(true);
    expect(temFichaFornecedor('pf-0123456789abcdef')).toBe(true);
    expect(temFichaFornecedor('12345678901')).toBe(true);
    expect(temFichaFornecedor('-1')).toBe(false);
    expect(temFichaFornecedor('#NULO')).toBe(false);
    expect(temFichaFornecedor(null)).toBe(false);
  });
});

describe('urlFornecedor', () => {
  it('CNPJ viaja cru na URL; pessoa física usa identificador opaco', () => {
    expect(urlFornecedor('12345678000190')).toBe('/fornecedor/12345678000190');
    // pseudônimo do backend passa direto — o CPF nunca esteve no navegador
    expect(urlFornecedor('pf-0123456789abcdef')).toBe('/fornecedor/pf-0123456789abcdef');
    // dados antigos com CPF cru: hash local mantém o número fora da URL
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
