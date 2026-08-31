/** Construtores de SQL do Explorar e regras espelhadas do backend.
 *
 *  Este arquivo é o ponto único de sincronia com o Python:
 *  - CATEGORIAS_SEM_NOTA_ESPERADA espelha src/analises.py
 *  - SINAIS_CTE / SINAIS_FILTRO espelham METRICAS_SINAL em src/resumo.py
 *  - SITUACAO_NAO_ENCONTRADA espelha SITUACAO_NAO_ENCONTRADO em src/cnpj.py
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
  | 'ranking'
  | 'fora-da-curva'
  | 'removidas'
  | 'removidas-receitas'
  | 'compartilhados'
  | 'sem-nota'
  | 'pessoa-fisica';

/** A visão de receitas removidas anda sobre a tabela de receitas — a contraparte
 *  é o doador e a categoria é a origem da receita, não a do gasto. */
export const eVisaoReceitas = (v: Visao) => v === 'removidas-receitas';

/** Visões de conteúdo removido (despesas ou receitas) — mudam rótulos e colunas. */
export const eVisaoRemocao = (v: Visao) => v === 'removidas' || v === 'removidas-receitas';

/** Lápide gravada em `fornecedores.situacao` quando a base pública da Receita
 *  respondeu 404 para o CNPJ: o cadastro não existe lá, e não "a empresa existe
 *  mas veio sem dados". Manter em sincronia com SITUACAO_NAO_ENCONTRADO em
 *  src/cnpj.py (teste automático em tests/test_sincronia_site.py). */
export const SITUACAO_NAO_ENCONTRADA = 'NAO ENCONTRADO NA BASE PUBLICA';

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

const SQL_CATEGORIAS_SEM_NOTA = CATEGORIAS_SEM_NOTA_ESPERADA
  .map((c) => `'${escSQL(c)}'`)
  .join(', ');

/** Documento declarado que não comprova a despesa perante o fisco. Cupom fiscal
 *  conta como fiscal — espelha DOCUMENTOS_FISCAIS em src/analises.py. */
export const CONDICAO_DOCUMENTO_NAO_FISCAL =
  `(DS_TIPO_DOCUMENTO IS NULL OR DS_TIPO_DOCUMENTO = '#NULO'` +
  ` OR (DS_TIPO_DOCUMENTO NOT ILIKE '%nota fiscal%'` +
  ` AND DS_TIPO_DOCUMENTO NOT ILIKE '%cupom fiscal%'))`;

/** Régua do "sem documento fiscal", espelho de cond_sem_documento_fiscal em
 *  src/analises.py: documento não fiscal + fornecedor PJ + tipo de gasto que
 *  costuma ter documento fiscal. `temNorma` diz se o parquet `norma_documento`
 *  foi publicado; sem ele o corte por categoria cai na lista fixa (o release
 *  antigo continua navegável, só com a régua anterior). */
export function condicaoSemNota(temNorma: boolean): string {
  const categoria = temNorma
    ? 'DS_ORIGEM_DESPESA IN (SELECT DS_ORIGEM_DESPESA FROM norma_documento WHERE exige_documento)'
    : `DS_ORIGEM_DESPESA NOT IN (${SQL_CATEGORIAS_SEM_NOTA})`;
  return `${CONDICAO_DOCUMENTO_NAO_FISCAL}`
    + ` AND LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14`
    + ` AND ${categoria}`;
}

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
    WHERE COALESCE(buf.p95, bbr.p95) IS NOT NULL
      AND (m.valor > COALESCE(buf.p95, bbr.p95)
           -- métrica percentual satura: com 5%+ do grupo em 100%, o p95 vai ao
           -- teto e "estritamente acima" nunca acontece — estar no teto conta
           OR (m.metrica LIKE 'pct_%' AND COALESCE(buf.p95, bbr.p95) >= 100 AND m.valor >= 100)))`;

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

/** Condição de UF: o filtro aceita várias UFs separadas por vírgula (seleção
 *  múltipla no mapa) — uma vira igualdade, várias viram IN. */
export function condUF(uf: string, prefixo = ''): string | null {
  const lista = uf.split(',').map((s) => s.trim()).filter(Boolean);
  if (!lista.length) return null;
  if (lista.length === 1) return `${prefixo}SG_UF = '${escSQL(lista[0])}'`;
  return `${prefixo}SG_UF IN (${lista.map((u) => `'${escSQL(u)}'`).join(', ')})`;
}


/** Busca textual tolerante: cada palavra do termo é exigida (AND) dentro de UMA
 *  das colunas, e palavra de 4+ letras terminada em "s" perde o "s" no padrão.
 *  Sem isso a busca é literal demais: "carro de som" não achava a categoria
 *  oficial do TSE "Publicidade por carros de som", e "JOSE SILVA" não achava
 *  "JOSE DA SILVA". `plural` fica desligado em nomes próprios, onde o "s" final
 *  costuma ser parte do nome. */
const CONECTIVOS = new Set([
  'a', 'as', 'o', 'os', 'e', 'de', 'da', 'do', 'das', 'dos',
  'em', 'na', 'no', 'nas', 'nos', 'para', 'por', 'com',
]);

export function condTexto(termo: string, colunas: string[], plural = false): string | null {
  const palavras = termo.trim().split(/\s+/).filter(Boolean);
  // conectivos não discriminam nada e só estreitariam o resultado à toa
  // ("carro de som" tem de achar "CARRO SOM"); se sobrar nada, vale o termo cru
  const semConectivos = palavras.filter((t) => !CONECTIVOS.has(t.toLowerCase()));
  const tokens = semConectivos.length ? semConectivos : palavras;
  if (!tokens.length || !colunas.length) return null;
  const padrao = (t: string) =>
    `%${escSQL(plural && t.length >= 4 && /s$/i.test(t) ? t.slice(0, -1) : t)}%`;
  const porColuna = colunas.map(
    (c) => `(${tokens.map((t) => `${c} ILIKE '${padrao(t)}'`).join(' AND ')})`,
  );
  return porColuna.length === 1 ? porColuna[0] : `(${porColuna.join(' OR ')})`;
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
      /^\d+$/.test(cand) ? `i.NR_CANDIDATO = '${cand}'` : condTexto(cand, ['i.NM_CANDIDATO'])!,
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
        : condTexto(cand, ['NM_CANDIDATO'])!,
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
        : condTexto(forn, [colNome, colNomeRfb])!,
    );
  }
  const desc = f.descricao.trim();
  if (desc) {
    partes.push(
      condTexto(
        desc,
        receitas ? ['DS_ORIGEM_RECEITA', 'DS_ESPECIE_RECEITA'] : ['DS_DESPESA', 'DS_ORIGEM_DESPESA'],
        true,
      )!,
    );
  }
  return partes.join(' AND ');
}

export function whereDaVisao(
  visao: Visao,
  f: Filtros,
  sinal: SinalFiltro,
  categoria: string,
  temNorma = false,
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
    return { base: 'despesas_atual', where: `${w} AND ${condicaoSemNota(temNorma)}` };
  }
  if (visao === 'pessoa-fisica') {
    return { base: 'despesas_atual', where: `${w} AND DS_TIPO_FORNECEDOR ILIKE '%f_sica%'` };
  }
  // ranking anda sobre as MESMAS despesas da visão padrão (mesmos filtros, e o
  // painel acima continua valendo) — o que muda é a tabela, que agrega por
  // candidato em vez de listar item a item
  if (visao === 'ranking') return { base: 'despesas_atual', where: w };
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

/* ------------------------------------------------------------------------- *
 * Construtores das consultas do Explorar. Vivem aqui (e não na página) para
 * serem testáveis no vitest junto das regras espelhadas que eles usam.
 * ------------------------------------------------------------------------- */

/** SQL dos cards fora-da-curva: um candidato por linha, sinais agregados de
 *  forma legível por máquina (metrica~valor~p95;...) e, quando o parquet de
 *  candidatos traz CD_ELEICAO/SG_UE, os metadados da foto oficial. */
export function sqlForaDaCurvaCards(
  f: Filtros,
  s: SinalFiltro,
  pag: number,
  porPagina: number,
  comFoto: boolean,
): string {
  return `WITH ${SINAIS_CTE}${comFoto ? `,
    foto AS (SELECT SQ_CANDIDATO, ANY_VALUE(CD_ELEICAO) AS cd, ANY_VALUE(SG_UE) AS ue
             FROM candidatos GROUP BY 1)` : ''}
    SELECT i.SQ_CANDIDATO, i.NM_CANDIDATO, i.SG_PARTIDO || '/' || i.SG_UF AS partido_uf,
           i.DS_CARGO, ROUND(i.total_contratado, 2) AS contratado,
           ROUND(i.total_receitas, 2) AS arrecadado,
           ${comFoto ? 'ANY_VALUE(c.cd) AS cd, ANY_VALUE(c.ue) AS ue,' : 'NULL AS cd, NULL AS ue,'}
           ${s ? `ROUND(MAX(CASE WHEN s.metrica = '${s}' THEN s.valor END), 4) AS sinal_sel,` : 'NULL AS sinal_sel,'}
           COUNT(*) AS n_sinais,
           STRING_AGG(s.metrica || '~' || ROUND(s.valor, 4) || '~' || ROUND(s.p95, 4), ';' ORDER BY s.metrica) AS sinais
    FROM sinais s JOIN indicadores i USING (SQ_CANDIDATO)
    ${comFoto ? 'LEFT JOIN foto c USING (SQ_CANDIDATO)' : ''}
    WHERE ${whereIndicadores(f)}
    GROUP BY ALL
    ${s ? 'HAVING sinal_sel IS NOT NULL ORDER BY sinal_sel DESC' : 'ORDER BY n_sinais DESC, contratado DESC'}
    LIMIT ${porPagina} OFFSET ${pag * porPagina}`;
}

/** SQL da tabela de resultados de cada visão ('' quando a visão vira cards). */
export function sqlTabelaDaVisao(
  v: Visao,
  base: string,
  w: string,
  f: Filtros,
  cat: string,
  pag: number,
  porPagina: number,
): string {
  const paginacao = `LIMIT ${porPagina} OFFSET ${pag * porPagina}`;
  if (v === 'removidas-receitas')
    return `SELECT SQ_CANDIDATO AS "_sq", '' AS "_cnpj",
                    DT_RECEITA AS "Data", NM_CANDIDATO AS "Candidato",
                    SG_PARTIDO || '/' || SG_UF AS "Partido/UF",
                    COALESCE(NULLIF(NM_DOADOR_RFB,'#NULO'), NULLIF(NM_DOADOR,'#NULO'),
                             'Não identificado (declarado sem contraparte)') AS "Doador",
                    DS_ORIGEM_RECEITA AS "Origem", DS_ESPECIE_RECEITA AS "Espécie",
                    STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS "Visível até",
                    ROUND(valor, 2) AS "Valor"
             FROM ${base} WHERE ${w}
             ORDER BY valor DESC ${paginacao}`;
  if (v === 'fora-da-curva' && cat)
    return `WITH ${cteCategoria(cat)}
             SELECT i.SQ_CANDIDATO AS "_sq", '' AS "_cnpj",
                    i.NM_CANDIDATO AS "Candidato",
                    i.SG_PARTIDO || '/' || i.SG_UF AS "Partido/UF",
                    i.DS_CARGO AS "Cargo",
                    ROUND(e.total, 2) AS "Neste tipo de gasto",
                    ROUND(e.p95, 2) AS "p95 do grupo",
                    ROUND(i.total_contratado, 2) AS "Contratado",
                    ROUND(i.total_receitas, 2) AS "Arrecadado"
             FROM estouro e JOIN indicadores i USING (SQ_CANDIDATO)
             WHERE ${whereIndicadores(f)}
             ORDER BY "Neste tipo de gasto" DESC
             ${paginacao}`;
  if (v === 'fora-da-curva') return ''; // sem categoria, a visão vira cards
  if (v === 'ranking')
    // agrega ANTES de juntar com as receitas: `w` traz colunas sem qualificação
    // (SG_UF, NM_CANDIDATO...) que existem nas duas tabelas e ficariam ambíguas
    return `WITH r AS (
               SELECT SQ_CANDIDATO AS sq, ANY_VALUE(NM_CANDIDATO) AS nome,
                      ANY_VALUE(SG_PARTIDO) AS partido, ANY_VALUE(SG_UF) AS uf,
                      ANY_VALUE(DS_CARGO) AS cargo, ROUND(SUM(valor), 2) AS total,
                      COUNT(*) AS itens,
                      COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR) FILTER (
                        WHERE NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')) AS fornecedores
               FROM ${base} WHERE ${w} GROUP BY 1),
             rec AS (
               SELECT SQ_CANDIDATO, ROUND(SUM(valor), 2) AS arrecadado
               FROM receitas_atual GROUP BY 1)
             SELECT r.sq AS "_sq", '' AS "_cnpj",
                    r.nome AS "Candidato",
                    r.partido || '/' || r.uf AS "Partido/UF",
                    r.cargo AS "Cargo",
                    r.total AS "Total",
                    r.itens AS "Itens",
                    r.fornecedores AS "Fornecedores",
                    rec.arrecadado AS "Arrecadado"
             FROM r LEFT JOIN rec ON rec.SQ_CANDIDATO = r.sq
             ORDER BY "Total" DESC ${paginacao}`;
  if (v === 'compartilhados')
    return `SELECT NULL AS "_sq", NR_CPF_CNPJ_FORNECEDOR AS "_cnpj",
                    COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS "Fornecedor",
                    NR_CPF_CNPJ_FORNECEDOR AS "CNPJ/CPF",
                    COUNT(DISTINCT SQ_CANDIDATO) AS "Candidatos",
                    COUNT(DISTINCT SG_PARTIDO) AS "Partidos",
                    STRING_AGG(DISTINCT SG_UF, ', ') AS "UFs",
                    ROUND(SUM(valor), 2) AS "Total"
             FROM ${base} WHERE ${w}
             GROUP BY ALL ORDER BY "Total" DESC ${paginacao}`;
  const colunaExtra =
    v === 'sem-nota'
      ? 'DS_TIPO_DOCUMENTO AS "Documento",'
      : v === 'removidas'
        ? 'STRFTIME(dt_ultima_extracao, \'%d/%m/%Y\') AS "Visível até",'
        : '';
  return `SELECT SQ_CANDIDATO AS "_sq", NR_CPF_CNPJ_FORNECEDOR AS "_cnpj",
                    DT_DESPESA AS "Data", NM_CANDIDATO AS "Candidato",
                    SG_PARTIDO || '/' || SG_UF AS "Partido/UF",
                    COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NULLIF(NM_FORNECEDOR,'#NULO'),
                             'Não identificado (declarado sem contraparte)') AS "Fornecedor",
                    DS_ORIGEM_DESPESA AS "Categoria", DS_DESPESA AS "Descrição",
                    ${colunaExtra}
                    ROUND(valor, 2) AS "Valor"
             FROM ${base} WHERE ${w}
             ORDER BY valor DESC ${paginacao}`;
}

/** As cinco consultas do painel (KPIs, categorias, candidatos, série, mapa) —
 *  colunas de contraparte/categoria/data trocam quando a visão é de receitas. */
export function sqlPainel(base: string, w: string, v: Visao) {
  const colContraparte = eVisaoReceitas(v) ? 'NR_CPF_CNPJ_DOADOR' : 'NR_CPF_CNPJ_FORNECEDOR';
  const colCategoria = eVisaoReceitas(v) ? 'DS_ORIGEM_RECEITA' : 'DS_ORIGEM_DESPESA';
  const colData = eVisaoReceitas(v) ? 'DT_RECEITA' : 'DT_DESPESA';
  return {
    kpis: `SELECT ROUND(SUM(valor),2), COUNT(DISTINCT SQ_CANDIDATO),
                            COUNT(DISTINCT ${colContraparte}), COUNT(*)
                     FROM ${base} WHERE ${w}`,
    categorias: `SELECT ${colCategoria}, ROUND(SUM(valor),2) AS total
                     FROM ${base} WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`,
    candidatos: `SELECT NM_CANDIDATO || ' (' || SG_PARTIDO || '/' || SG_UF || ')', ROUND(SUM(valor),2) AS total
                     FROM ${base} WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`,
    porDia: `SELECT STRFTIME(STRPTIME(${colData}, '%d/%m/%Y'), '%d/%m') AS dia,
                            MIN(STRPTIME(${colData}, '%d/%m/%Y')) AS ord, ROUND(SUM(valor),2) AS total
                     FROM ${base} WHERE ${w} AND ${colData} <> '#NULO'
                     GROUP BY 1 ORDER BY ord`,
    mapa: `SELECT SG_UF, ROUND(SUM(valor),2) AS total
                     FROM ${base} WHERE ${w} AND SG_UF NOT IN ('#NULO', 'BR')
                     GROUP BY 1`,
  };
}

/** Dispersão arrecadado×contratado sobre `indicadores` — null quando há filtro
 *  de texto (candidato/fornecedor/descrição recortam despesas, não candidatos). */
export function sqlDispersao(f: Filtros, limite: number): string | null {
  if (f.candidato.trim() || f.fornecedor.trim() || f.descricao.trim()) return null;
  const partes = ['(total_contratado > 0 OR COALESCE(total_receitas, 0) > 0)'];
  const uf = condUF(f.uf);
  if (uf) partes.push(uf);
  if (f.cargo) partes.push(`DS_CARGO ILIKE '${escSQL(f.cargo)}'`);
  if (f.partido) partes.push(`SG_PARTIDO = '${escSQL(f.partido)}'`);
  return `
      SELECT SQ_CANDIDATO, NM_CANDIDATO || ' (' || SG_PARTIDO || '/' || SG_UF || ')',
             COALESCE(total_receitas, 0), total_contratado
      FROM indicadores WHERE ${partes.join(' AND ')}
      ORDER BY total_contratado + COALESCE(total_receitas, 0) DESC
      LIMIT ${limite}`;
}

/** Registros de candidatura que batem com a busca por nome/número mas ainda não
 *  declararam NENHUMA despesa ou receita — 72% das candidaturas no início da
 *  campanha; sem isso a busca do site simplesmente não os encontra. */
export function sqlRegistrosSemMovimento(f: Filtros, limite: number): string {
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
        : condTexto(cand, ['NM_CANDIDATO', 'NM_URNA_CANDIDATO'])!,
    );
  }
  return `
      SELECT SQ_CANDIDATO, ANY_VALUE(NM_URNA_CANDIDATO), ANY_VALUE(NM_CANDIDATO),
             ANY_VALUE(NR_CANDIDATO), ANY_VALUE(SG_PARTIDO), ANY_VALUE(DS_CARGO), ANY_VALUE(SG_UF)
      FROM candidatos
      WHERE ${partes.join(' AND ')}
        AND SQ_CANDIDATO NOT IN (SELECT SQ_CANDIDATO FROM indicadores)
      GROUP BY 1 ORDER BY 2 LIMIT ${limite}`;
}
