import { describe, expect, it } from 'vitest';
import {
  CONDICAO_SEM_NOTA, FILTROS_VAZIOS, SINAIS_FILTRO,
  condUF, montarWhere, whereDaVisao, whereIndicadores,
} from './consultas';

const f = (parcial: Partial<typeof FILTROS_VAZIOS>) => ({ ...FILTROS_VAZIOS, ...parcial });

describe('montarWhere', () => {
  it('sem filtros vira condição neutra', () => {
    expect(montarWhere(FILTROS_VAZIOS)).toBe('1=1');
  });

  it('escapa aspas simples (nome com apóstrofo não quebra nem injeta SQL)', () => {
    const w = montarWhere(f({ candidato: "D'AVILA" }));
    expect(w).toContain("D''AVILA");
    expect(w).not.toContain("D'AVILA'");
  });

  it('candidato numérico busca por número, texto busca por nome', () => {
    expect(montarWhere(f({ candidato: '12345' }))).toContain("NR_CANDIDATO = '12345'");
    expect(montarWhere(f({ candidato: 'FULANO' }))).toContain("NM_CANDIDATO ILIKE '%FULANO%'");
  });

  it('fornecedor com pontuação de CNPJ busca pelo prefixo só de dígitos', () => {
    const w = montarWhere(f({ fornecedor: '12.345.678/0001-90' }));
    expect(w).toContain("NR_CPF_CNPJ_FORNECEDOR LIKE '12345678000190%'");
  });

  it('uma UF vira igualdade; várias (seleção múltipla do mapa) viram IN', () => {
    expect(montarWhere(f({ uf: 'SP' }))).toContain("SG_UF = 'SP'");
    expect(montarWhere(f({ uf: 'SP,RJ' }))).toContain("SG_UF IN ('SP', 'RJ')");
    expect(whereIndicadores(f({ uf: 'SP,RJ' }))).toContain("i.SG_UF IN ('SP', 'RJ')");
    expect(condUF('')).toBeNull();
    expect(condUF('SP, RJ,')).toBe("SG_UF IN ('SP', 'RJ')"); // tolera espaços e vírgula solta
  });

  it('no modo receitas a contraparte é o doador', () => {
    const w = montarWhere(f({ fornecedor: 'ACME' }), true);
    expect(w).toContain('NM_DOADOR');
    expect(w).not.toContain('NM_FORNECEDOR');
  });
});

describe('whereDaVisao', () => {
  it('sem-nota exclui as categorias em que a nota não é esperada', () => {
    const { base, where } = whereDaVisao('sem-nota', FILTROS_VAZIOS, '', '');
    expect(base).toBe('despesas_atual');
    expect(where).toContain(CONDICAO_SEM_NOTA);
    expect(where).toContain('Despesas com pessoal');
  });

  it('removidas-receitas anda sobre a tabela de receitas', () => {
    const { base } = whereDaVisao('removidas-receitas', FILTROS_VAZIOS, '', '');
    expect(base).toBe('receitas_removidas');
  });

  it('compartilhados exige mais de um candidato por fornecedor', () => {
    const { where } = whereDaVisao('compartilhados', FILTROS_VAZIOS, '', '');
    expect(where).toContain('COUNT(DISTINCT SQ_CANDIDATO) > 1');
  });

  it('fora-da-curva filtra por sinal quando um é escolhido', () => {
    const { where } = whereDaVisao('fora-da-curva', FILTROS_VAZIOS, 'pct_sem_nota', '');
    expect(where).toContain("s.metrica = 'pct_sem_nota'");
  });

  it('fora-da-curva por categoria usa benchmark_categorias e escapa a categoria', () => {
    const { where } = whereDaVisao('fora-da-curva', FILTROS_VAZIOS, '', "Locação/cessão d'água");
    expect(where).toContain('benchmark_categorias');
    expect(where).toContain("d''água");
  });
});

describe('SINAIS_FILTRO', () => {
  it('cobre as métricas do fora-da-curva (espelho de METRICAS_SINAL no backend)', () => {
    expect([...SINAIS_FILTRO]).toEqual([
      'total_contratado', 'razao_gasto_receita', 'pct_maior_fornecedor',
      'pct_sem_nota', 'pct_pessoa_fisica',
    ]);
  });
});
