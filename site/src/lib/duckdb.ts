import * as duckdb from '@duckdb/duckdb-wasm';

// Os Parquet são servidos pela mesma origem via Pages Function (/dados/*).
export const TABELAS = [
  'despesas',
  'receitas',
  'despesas_pagas',
  'receitas_doador_originario',
  'candidatos',
  'serie_diaria',
  'benchmark_precos',
  'benchmark_indicadores',
  'benchmark_categorias',
  'indicadores',
  'rede',
  'fornecedores',
] as const;

/** Tabelas que de fato conseguiram registrar (um parquet pode ainda não existir no release). */
export const tabelasDisponiveis = new Set<string>();

let conexao: Promise<duckdb.AsyncDuckDBConnection> | null = null;

async function iniciar(): Promise<duckdb.AsyncDuckDBConnection> {
  // O motor (~10 MB gzip) vem do CDN oficial do duckdb-wasm em runtime:
  // o Cloudflare Pages limita arquivos do build a 25 MiB e o wasm passa disso.
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const urlWorker = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  );
  const worker = new Worker(urlWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const con = await db.connect();

  const origem = window.location.origin;
  // Cache-buster: o carimbo de publicação (resumo.json, cache curto) entra na
  // URL dos parquet — publicação nova = URL nova, sem servir arquivo velho do
  // cache de 1h nem misturar arquivos de publicações diferentes.
  let versao = '';
  try {
    const r = await fetch(`${origem}/dados/resumo.json`, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      // publicado_em (carimbo por publicação); gerado_em (data da extração)
      // cobre resumos antigos que ainda não trazem o carimbo
      versao = String(j.publicado_em ?? j.gerado_em ?? '');
    }
  } catch {
    // sem resumo, segue sem versão — os parquet ainda funcionam
  }
  const sufixo = versao ? `?v=${encodeURIComponent(versao)}` : '';
  for (const t of TABELAS) {
    try {
      await con.query(
        `CREATE VIEW ${t} AS SELECT * FROM read_parquet('${origem}/dados/${t}.parquet${sufixo}')`,
      );
      tabelasDisponiveis.add(t);
    } catch {
      // parquet ainda não publicado — a página degrada sem essa visão
    }
  }
  // Atalhos com o estado atual das declarações e valor numérico pronto.
  // Linhas-placeholder do SPCE (contraparte '-1'/'#NULO' E valor zero = prestação
  // sem movimento) ficam de fora — sincronia com filtro_placeholder em src/carga.py.
  await con.query(`
    CREATE VIEW despesas_atual AS
    SELECT *, TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas AS valor
    FROM despesas
    WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM despesas)
      AND NOT (NR_CPF_CNPJ_FORNECEDOR IN ('-1', '#NULO')
               AND COALESCE(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE), 0) = 0)
  `);
  await con.query(`
    CREATE VIEW receitas_atual AS
    SELECT *, TRY_CAST(REPLACE(VR_RECEITA, ',', '.') AS DOUBLE) * qt_linhas AS valor
    FROM receitas
    WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM receitas)
      AND NOT (NR_CPF_CNPJ_DOADOR IN ('-1', '#NULO')
               AND COALESCE(TRY_CAST(REPLACE(VR_RECEITA, ',', '.') AS DOUBLE), 0) = 0)
  `);
  try {
    // Remoções com o MESMO critério do backend: retransmitir a prestação
    // renumera as notas, então só é remoção o conteúdo sem correspondente de
    // mesma essência no estado atual (sincronia com ESSENCIA em src/historico.py).
    await con.query(`
      CREATE VIEW despesas_removidas AS
      SELECT d.*, TRY_CAST(REPLACE(d.VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * d.qt_linhas AS valor
      FROM despesas d
      WHERE d.dt_ultima_extracao < (SELECT MAX(dt_ultima_extracao) FROM despesas)
        AND NOT (d.NR_CPF_CNPJ_FORNECEDOR IN ('-1', '#NULO')
                 AND COALESCE(TRY_CAST(REPLACE(d.VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE), 0) = 0)
        AND NOT EXISTS (
          SELECT 1 FROM despesas_atual v
          WHERE v.SQ_CANDIDATO = d.SQ_CANDIDATO
            AND v.NR_CPF_CNPJ_FORNECEDOR = d.NR_CPF_CNPJ_FORNECEDOR
            AND v.DS_DESPESA = d.DS_DESPESA
            AND v.VR_DESPESA_CONTRATADA = d.VR_DESPESA_CONTRATADA
            AND v.DT_DESPESA = d.DT_DESPESA)
    `);
    tabelasDisponiveis.add('despesas_removidas');
  } catch {
    // sem o parquet de despesas a visão não existe — as páginas degradam
  }
  try {
    // mesma régua para receitas: sincronia com ESSENCIA['receitas'] em src/historico.py
    await con.query(`
      CREATE VIEW receitas_removidas AS
      SELECT r.*, TRY_CAST(REPLACE(r.VR_RECEITA, ',', '.') AS DOUBLE) * r.qt_linhas AS valor
      FROM receitas r
      WHERE r.dt_ultima_extracao < (SELECT MAX(dt_ultima_extracao) FROM receitas)
        AND NOT (r.NR_CPF_CNPJ_DOADOR IN ('-1', '#NULO')
                 AND COALESCE(TRY_CAST(REPLACE(r.VR_RECEITA, ',', '.') AS DOUBLE), 0) = 0)
        AND NOT EXISTS (
          SELECT 1 FROM receitas_atual v
          WHERE v.SQ_CANDIDATO = r.SQ_CANDIDATO
            AND v.NR_CPF_CNPJ_DOADOR = r.NR_CPF_CNPJ_DOADOR
            AND v.DS_ORIGEM_RECEITA = r.DS_ORIGEM_RECEITA
            AND v.VR_RECEITA = r.VR_RECEITA
            AND v.DT_RECEITA = r.DT_RECEITA)
    `);
    tabelasDisponiveis.add('receitas_removidas');
  } catch {
    // sem o parquet de receitas a visão não existe — as páginas degradam
  }
  return con;
}

export function obterConexao(): Promise<duckdb.AsyncDuckDBConnection> {
  conexao ??= iniciar();
  return conexao;
}

const PERMITIDOS = /^\s*(select|with|describe|summarize|show|from|pivot|unpivot)\b/i;

export interface ResultadoConsulta {
  colunas: string[];
  linhas: unknown[][];
  total: number;
  ms: number;
}

export async function executarSQL(sql: string): Promise<ResultadoConsulta> {
  const semComentarios = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (!PERMITIDOS.test(semComentarios)) {
    throw new Error('Apenas consultas de leitura (SELECT/WITH/DESCRIBE/SUMMARIZE) são permitidas.');
  }
  const con = await obterConexao();
  const inicio = performance.now();
  const tabela = await con.query(sql);
  const ms = performance.now() - inicio;
  const colunas = tabela.schema.fields.map((f) => f.name);
  const linhas = tabela.toArray().map((linha) => colunas.map((c) => linha[c]));
  return { colunas, linhas, total: linhas.length, ms };
}
