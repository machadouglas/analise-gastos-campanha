import { describe, expect, it } from 'vitest';
import {
  FILTROS_VAZIOS, SINAIS_FILTRO, condicaoSemNota,
  condUF, eVisaoRemocao, montarWhere, sqlDispersao, sqlForaDaCurvaCards, sqlPainel,
  sqlRegistrosSemMovimento, sqlTabelaDaVisao, whereDaVisao, whereIndicadores,
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

  it('nome com várias palavras exige todas, em qualquer ordem (acha "JOSE DA SILVA")', () => {
    const w = montarWhere(f({ candidato: 'JOSE SILVA' }));
    expect(w).toContain("NM_CANDIDATO ILIKE '%JOSE%' AND NM_CANDIDATO ILIKE '%SILVA%'");
  });

  it('descrição tolera plural: "carro de som" acha "Publicidade por carros de som"', () => {
    const w = montarWhere(f({ descricao: 'carro de som' }));
    // cada palavra vira um LIKE exigido na MESMA coluna
    expect(w).toContain("DS_ORIGEM_DESPESA ILIKE '%carro%'");
    expect(w).toContain("DS_ORIGEM_DESPESA ILIKE '%som%'");
    expect(w).not.toContain("ILIKE '%de%'"); // conectivo descartado
    // e o plural do usuário também perde o "s" (4+ letras) para achar o singular
    expect(montarWhere(f({ descricao: 'carros' }))).toContain("ILIKE '%carro%'");
    // palavra curta não é mutilada
    expect(montarWhere(f({ descricao: 'gás' }))).toContain("ILIKE '%gás%'");
  });

  it('nome próprio não perde o "s" final (SANTOS continua SANTOS)', () => {
    expect(montarWhere(f({ fornecedor: 'SANTOS' }))).toContain("ILIKE '%SANTOS%'");
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
  it('sem-nota sem a norma publicada cai na lista fixa de categorias', () => {
    const { base, where } = whereDaVisao('sem-nota', FILTROS_VAZIOS, '', '');
    expect(base).toBe('despesas_atual');
    expect(where).toContain(condicaoSemNota(false));
    expect(where).toContain('Despesas com pessoal');
  });

  it('sem-nota com a norma publicada corta pela categoria medida', () => {
    const { where } = whereDaVisao('sem-nota', FILTROS_VAZIOS, '', '', true);
    expect(where).toContain('FROM norma_documento WHERE exige_documento');
    expect(where).not.toContain('Despesas com pessoal'); // a lista fixa sai de cena
  });

  it('a régua exige PJ e aceita cupom fiscal como documento fiscal', () => {
    const c = condicaoSemNota(true);
    expect(c).toContain('LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14');
    expect(c).toContain("NOT ILIKE '%cupom fiscal%'");
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

describe('sqlTabelaDaVisao', () => {
  const monta = (v: Parameters<typeof sqlTabelaDaVisao>[0], cat = '') => {
    const { base, where } = whereDaVisao(v, FILTROS_VAZIOS, '', cat);
    return sqlTabelaDaVisao(v, base, where, FILTROS_VAZIOS, cat, 0, 50);
  };

  it('cada visão de tabela consulta a base certa e pagina', () => {
    expect(monta('atual')).toContain('FROM despesas_atual');
    expect(monta('atual')).toContain('LIMIT 50 OFFSET 0');
    expect(monta('removidas')).toContain('Visível até');
    expect(monta('removidas-receitas')).toContain('"Doador"');
    expect(monta('compartilhados')).toContain('COUNT(DISTINCT SQ_CANDIDATO)');
    expect(monta('sem-nota')).toContain('"Documento"');
    expect(monta('ranking')).toContain('GROUP BY 1');
    expect(monta('ranking')).toContain('ORDER BY "Total" DESC');
  });

  it('ranking agrega por candidato e junta a receita fora do WHERE ambíguo', () => {
    const { base, where } = whereDaVisao('ranking', f({ uf: 'MT', descricao: 'carro de som' }), '', '');
    const sql = sqlTabelaDaVisao('ranking', base, where, FILTROS_VAZIOS, '', 0, 50);
    // o recorte (UF + descrição) filtra a agregação de despesas...
    expect(sql).toContain("SG_UF = 'MT'");
    expect(sql).toContain("DS_DESPESA ILIKE '%carro%'");
    // ...e a receita entra por CTE separada, sem repetir o WHERE nas duas tabelas
    expect(sql).toContain('FROM receitas_atual GROUP BY 1');
    expect(sql.match(/ILIKE '%carro%'/g)).toHaveLength(2); // DS_DESPESA e DS_ORIGEM_DESPESA
    expect(sql).toContain('"_sq"');
  });

  it('fora-da-curva sem categoria vira cards (sem SQL de tabela)', () => {
    expect(monta('fora-da-curva')).toBe('');
    expect(monta('fora-da-curva', 'Publicidade por materiais impressos')).toContain('estouro');
  });

  it('página 2 desloca o OFFSET', () => {
    const { base, where } = whereDaVisao('atual', FILTROS_VAZIOS, '', '');
    expect(sqlTabelaDaVisao('atual', base, where, FILTROS_VAZIOS, '', 2, 50)).toContain('OFFSET 100');
  });
});

describe('sqlPainel', () => {
  it('visões de despesa e de receita usam as colunas próprias', () => {
    const desp = sqlPainel('despesas_atual', '1=1', 'atual');
    expect(desp.kpis).toContain('NR_CPF_CNPJ_FORNECEDOR');
    expect(desp.porDia).toContain('DT_DESPESA');
    const rec = sqlPainel('receitas_removidas', '1=1', 'removidas-receitas');
    expect(rec.kpis).toContain('NR_CPF_CNPJ_DOADOR');
    expect(rec.categorias).toContain('DS_ORIGEM_RECEITA');
    expect(rec.porDia).toContain('DT_RECEITA');
  });
});

describe('sqlDispersao', () => {
  it('só existe sem filtros de texto (que recortam despesas, não candidatos)', () => {
    expect(sqlDispersao(f({ candidato: 'FULANO' }), 1500)).toBeNull();
    expect(sqlDispersao(f({ fornecedor: 'ACME' }), 1500)).toBeNull();
    const sql = sqlDispersao(f({ uf: 'SP' }), 1500);
    expect(sql).toContain('FROM indicadores');
    expect(sql).toContain('LIMIT 1500');
  });
});

describe('sqlForaDaCurvaCards', () => {
  it('escapa o sinal e só junta a foto quando o parquet permite', () => {
    const com = sqlForaDaCurvaCards(FILTROS_VAZIOS, 'pct_sem_nota', 0, 50, true);
    expect(com).toContain('LEFT JOIN foto');
    expect(com).toContain("s.metrica = 'pct_sem_nota'");
    const sem = sqlForaDaCurvaCards(FILTROS_VAZIOS, '', 1, 50, false);
    expect(sem).not.toContain('LEFT JOIN foto');
    expect(sem).toContain('OFFSET 50');
  });
});

describe('sqlRegistrosSemMovimento', () => {
  it('busca por nome/urna, exclui quem já movimentou e escapa a entrada', () => {
    const sql = sqlRegistrosSemMovimento(f({ candidato: "D'AVILA" }), 100);
    expect(sql).toContain('NM_URNA_CANDIDATO ILIKE');
    expect(sql).toContain('NOT IN (SELECT SQ_CANDIDATO FROM indicadores)');
    expect(sql).toContain("D''AVILA");
    expect(sqlRegistrosSemMovimento(f({ candidato: '12345' }), 100)).toContain("NR_CANDIDATO = '12345'");
  });
});

describe('eVisaoRemocao', () => {
  it('marca as duas visões de remoção e nada mais', () => {
    expect(eVisaoRemocao('removidas')).toBe(true);
    expect(eVisaoRemocao('removidas-receitas')).toBe(true);
    expect(eVisaoRemocao('atual')).toBe(false);
    expect(eVisaoRemocao('compartilhados')).toBe(false);
  });
});
