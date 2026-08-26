import * as duckdb from '@duckdb/duckdb-wasm';

// Os Parquet são servidos pela mesma origem via Pages Function (/dados/*).
export const TABELAS = [
  'despesas',
  'receitas',
  'despesas_pagas',
  'receitas_doador_originario',
  'candidatos',
] as const;

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
  for (const t of TABELAS) {
    await con.query(
      `CREATE VIEW ${t} AS SELECT * FROM read_parquet('${origem}/dados/${t}.parquet')`,
    );
  }
  // Atalhos com o estado atual das declarações e valor numérico pronto
  await con.query(`
    CREATE VIEW despesas_atual AS
    SELECT *, TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas AS valor
    FROM despesas
    WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM despesas)
  `);
  await con.query(`
    CREATE VIEW receitas_atual AS
    SELECT *, TRY_CAST(REPLACE(VR_RECEITA, ',', '.') AS DOUBLE) * qt_linhas AS valor
    FROM receitas
    WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM receitas)
  `);
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
