/** Construtores de SQL do Explorar e regras espelhadas do backend.
 *
 *  Este arquivo é o ponto único de sincronia com o Python:
 *  - CATEGORIAS_SEM_NOTA_ESPERADA espelha src/analises.py
 *  - SINAIS_CTE / SINAIS_FILTRO espelham METRICAS_SINAL em src/resumo.py
 *  tests/test_sincronia_site.py lê este arquivo e falha se as listas divergirem.
 */

export function escSQL(s: string): string {
  return s.replaceAll("'", "''");
}

export interface Filtros {
  uf: string;
  cargo: string;
  partido: string;
  candidato: string;
  fornecedor: string;
  descricao: string;
}

export const FILTROS_VAZIOS: Filtros = {
  uf: '', cargo: '', partido: '', candidato: '', fornecedor: '', descricao: '',
};

/** Visões: recortes prontos que respondem uma pergunta e aceitam os demais filtros. */
export type Visao =
  | 'atual'
  | 'fora-da-curva'
  | 'removidas'
  | 'removidas-receitas'
  | 'compartilhados'
  | 'sem-nota'
  | 'pessoa-fisica';

/** A visão de receitas removidas anda sobre a tabela de receitas — a contraparte
 *  é o doador e a categoria é a origem da receita, não a do gasto. */
export const eVisaoReceitas = (v: Visao) => v === 'removidas-receitas';

// manter em sincronia com CATEGORIAS_SEM_NOTA_ESPERADA em src/analises.py
// (teste automático em tests/test_sincronia_site.py)
export const CATEGORIAS_SEM_NOTA_ESPERADA = [
  'Doações financeiras a outros candidatos/partidos',
  'Encargos financeiros, taxas bancárias e/ou op. cartão de crédito',
  'Encargos sociais',
  'Impostos, contribuições e taxas',
  'Locação/cessão de bens imóveis',
  'Despesas com pessoal',
];

export const SQL_CATEGORIAS_SEM_NOTA = CATEGORIAS_SEM_NOTA_ESPERADA
  .map((c) => `'${escSQL(c)}'`)
  .join(', ');

/** Mesma régua do backend (src/analises.py / src/agregados.py): documento
 *  ausente ou diferente de nota fiscal, fora das categorias em que a nota não
 *  é o documento próprio. Usada no Explorar e na ficha do fornecedor. */
export const CONDICAO_SEM_NOTA =
  `(DS_TIPO_DOCUMENTO IS NULL OR DS_TIPO_DOCUMENTO = '#NULO'` +
  ` OR DS_TIPO_DOCUMENTO NOT ILIKE '%nota fiscal%')` +
  ` AND DS_ORIGEM_DESPESA NOT IN (${SQL_CATEGORIAS_SEM_NOTA})`;

// espelha METRICAS_SINAL em src/resumo.py: sinal = métrica estritamente acima
// do p95 do grupo (cargo×UF; BR-TODAS quando o grupo local não existe).
// razão gasto÷arrecadado só é sinal quando > 1 — mesma régua do backend.
export const SINAIS_CTE = `
  metricas AS (
    SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'total_contratado' AS metrica, total_contratado AS valor
    FROM indicadores WHERE total_contratado > 0
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'razao_gasto_receita', razao_gasto_receita
    FROM indicadores WHERE razao_gasto_receita > 1
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'pct_maior_fornecedor', pct_maior_fornecedor
    FROM indicadores WHERE n_fornecedores > 1
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'pct_sem_nota', pct_sem_nota
    FROM indicadores WHERE total_contratado > 0
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'pct_pessoa_fisica', pct_pessoa_fisica
    FROM indicadores WHERE total_contratado > 0),
  sinais AS (
    SELECT m.SQ_CANDIDATO, m.metrica, m.valor, COALESCE(buf.p95, bbr.p95) AS p95
    FROM metricas m
    LEFT JOIN benchmark_indicadores buf
      ON buf.DS_CARGO = m.DS_CARGO AND buf.SG_UF = m.SG_UF AND buf.metrica = m.metrica
    LEFT JOIN benchmark_indicadores bbr
      ON bbr.DS_CARGO = m.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.metrica = m.metrica
    WHERE COALESCE(buf.p95, bbr.p95) IS NOT NULL AND m.valor > COALESCE(buf.p95, bbr.p95))`;

// filtro de segundo nível da visão fora-da-curva: EM QUAL sinal a pessoa
// destoa ('' = qualquer). Ids espelham METRICAS_SINAL em src/resumo.py.
export const SINAIS_FILTRO = [
  'total_contratado',
  'razao_gasto_receita',
  'pct_maior_fornecedor',
  'pct_sem_nota',
  'pct_pessoa_fisica',
] as const;
export type SinalFiltro = (typeof SINAIS_FILTRO)[number] | '';

export const ROTULO_SINAL_SQL = `CASE s.metrica
  WHEN 'total_contratado' THEN 'gasto total'
  WHEN 'razao_gasto_receita' THEN 'gasto ÷ arrecadado'
  WHEN 'pct_maior_fornecedor' THEN 'concentração no maior fornecedor'
  WHEN 'pct_sem_nota' THEN '% sem nota fiscal'
  WHEN 'pct_pessoa_fisica' THEN '% a pessoas físicas'
  ELSE s.metrica END`;

/** Condição de UF: o filtro aceita várias UFs separadas por vírgula (seleção
 *  múltipla no mapa) — uma vira igualdade, várias viram IN. */
export function condUF(uf: string, prefixo = ''): string | null {
  const lista = uf.split(',').map((s) => s.trim()).filter(Boolean);
  if (!lista.length) return null;
  if (lista.length === 1) return `${prefixo}SG_UF = '${escSQL(lista[0])}'`;
  return `${prefixo}SG_UF IN (${lista.map((u) => `'${escSQL(u)}'`).join(', ')})`;
}

/** Filtros aplicáveis sobre `indicadores` (fornecedor/descrição não existem lá). */
export function whereIndicadores(f: Filtros): string {
  const partes = ['1=1'];
  const uf = condUF(f.uf, 'i.');
  if (uf) partes.push(uf);
  if (f.cargo) partes.push(`i.DS_CARGO ILIKE '${escSQL(f.cargo)}'`);
  if (f.partido) partes.push(`i.SG_PARTIDO = '${escSQL(f.partido)}'`);
  const cand = f.candidato.trim();
  if (cand) {
    partes.push(
      /^\d+$/.test(cand) ? `i.NR_CANDIDATO = '${cand}'` : `i.NM_CANDIDATO ILIKE '%${escSQL(cand)}%'`,
    );
  }
  return partes.join(' AND ');
}

/** CTE do fora-da-curva POR CATEGORIA: total do candidato na categoria contra
 *  o p95 do grupo em benchmark_categorias (UF, com fallback BR-TODAS). */
export function cteCategoria(categoria: string): string {
  const cat = escSQL(categoria);
  return `
  gasto AS (
    SELECT SQ_CANDIDATO, SUM(valor) AS total
    FROM despesas_atual WHERE DS_ORIGEM_DESPESA = '${cat}' GROUP BY 1),
  estouro AS (
    SELECT g.SQ_CANDIDATO, g.total, COALESCE(buf.p95, bbr.p95) AS p95
    FROM gasto g
    JOIN indicadores i USING (SQ_CANDIDATO)
    LEFT JOIN benchmark_categorias buf
      ON buf.DS_CARGO = i.DS_CARGO AND buf.SG_UF = i.SG_UF AND buf.DS_ORIGEM_DESPESA = '${cat}'
    LEFT JOIN benchmark_categorias bbr
      ON bbr.DS_CARGO = i.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.DS_ORIGEM_DESPESA = '${cat}'
    WHERE COALESCE(buf.p95, bbr.p95) IS NOT NULL AND g.total > COALESCE(buf.p95, bbr.p95))`;
}

export function montarWhere(f: Filtros, receitas = false): string {
  const partes = ['1=1'];
  const uf = condUF(f.uf);
  if (uf) partes.push(uf);
  if (f.cargo) partes.push(`DS_CARGO ILIKE '${escSQL(f.cargo)}'`);
  if (f.partido) partes.push(`SG_PARTIDO = '${escSQL(f.partido)}'`);
  const cand = f.candidato.trim();
  if (cand) {
    partes.push(
      /^\d+$/.test(cand)
        ? `NR_CANDIDATO = '${cand}'`
        : `NM_CANDIDATO ILIKE '%${escSQL(cand)}%'`,
    );
  }
  const forn = f.fornecedor.trim();
  if (forn) {
    const [colId, colNome, colNomeRfb] = receitas
      ? ['NR_CPF_CNPJ_DOADOR', 'NM_DOADOR', 'NM_DOADOR_RFB']
      : ['NR_CPF_CNPJ_FORNECEDOR', 'NM_FORNECEDOR', 'NM_FORNECEDOR_RFB'];
    partes.push(
      /^[\d./-]+$/.test(forn)
        ? `${colId} LIKE '${forn.replace(/\D/g, '')}%'`
        : `(${colNome} ILIKE '%${escSQL(forn)}%' OR ${colNomeRfb} ILIKE '%${escSQL(forn)}%')`,
    );
  }
  const desc = f.descricao.trim();
  if (desc) {
    partes.push(
      receitas
        ? `(DS_ORIGEM_RECEITA ILIKE '%${escSQL(desc)}%' OR DS_ESPECIE_RECEITA ILIKE '%${escSQL(desc)}%')`
        : `(DS_DESPESA ILIKE '%${escSQL(desc)}%' OR DS_ORIGEM_DESPESA ILIKE '%${escSQL(desc)}%')`,
    );
  }
  return partes.join(' AND ');
}

export function whereDaVisao(
  visao: Visao,
  f: Filtros,
  sinal: SinalFiltro,
  categoria: string,
): { base: string; where: string } {
  if (visao === 'removidas-receitas') return { base: 'receitas_removidas', where: montarWhere(f, true) };
  const w = montarWhere(f);
  if (visao === 'removidas') return { base: 'despesas_removidas', where: w };
  if (visao === 'fora-da-curva') {
    // gráficos e KPIs mostram os gastos DOS candidatos fora da curva do recorte
    if (categoria) {
      return {
        base: 'despesas_atual',
        where:
          `${w} AND SQ_CANDIDATO IN (WITH ${cteCategoria(categoria)} ` +
          `SELECT e.SQ_CANDIDATO FROM estouro e ` +
          `JOIN indicadores i USING (SQ_CANDIDATO) WHERE ${whereIndicadores(f)})`,
      };
    }
    const porSinal = sinal ? ` AND s.metrica = '${sinal}'` : '';
    return {
      base: 'despesas_atual',
      where:
        `${w} AND SQ_CANDIDATO IN (WITH ${SINAIS_CTE} ` +
        `SELECT DISTINCT s.SQ_CANDIDATO FROM sinais s ` +
        `JOIN indicadores i USING (SQ_CANDIDATO) WHERE ${whereIndicadores(f)}${porSinal})`,
    };
  }
  if (visao === 'sem-nota') {
    return { base: 'despesas_atual', where: `${w} AND ${CONDICAO_SEM_NOTA}` };
  }
  if (visao === 'pessoa-fisica') {
    return { base: 'despesas_atual', where: `${w} AND DS_TIPO_FORNECEDOR ILIKE '%f_sica%'` };
  }
  if (visao === 'compartilhados') {
    return {
      base: 'despesas_atual',
      where:
        `${w} AND NR_CPF_CNPJ_FORNECEDOR IN (` +
        `SELECT NR_CPF_CNPJ_FORNECEDOR FROM despesas_atual WHERE ${w}` +
        ` AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')` +
        ` GROUP BY 1 HAVING COUNT(DISTINCT SQ_CANDIDATO) > 1)`,
    };
  }
  return { base: 'despesas_atual', where: w };
}
