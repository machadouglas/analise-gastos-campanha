/** Gate de leitura do console SQL. O duckdb-wasm executa statements múltiplos
 *  separados por ';', então validar só o início da string deixaria passar
 *  `SELECT 1; CREATE ...`. Este scanner percorre a consulta uma única vez —
 *  ciente de strings, identificadores entre aspas, comentários e dollar-quoting —
 *  separa os statements de nível superior e exige que cada um comece com um
 *  verbo de leitura. Funções puras — testadas em sql-gate.test.ts. */

const VERBOS_LEITURA = /^(select|with|describe|summarize|show|from|pivot|unpivot)\b/i;

export const VERBOS_DESCRICAO =
  'SELECT/WITH/DESCRIBE/SUMMARIZE/SHOW/FROM/PIVOT/UNPIVOT';

/** Divide o SQL em statements de nível superior, já sem comentários.
 *  Respeita strings '...' (escape por duplicação ''), identificadores "...",
 *  comentários -- e slash-asterisco e dollar-quoting $tag$...$tag$ do DuckDB —
 *  um ';' dentro de qualquer um deles não separa statements. */
export function separarStatements(sql: string): string[] {
  const partes: string[] = [];
  let atual = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      atual += ' ';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const fim = sql.indexOf('*/', i + 2);
      i = fim < 0 ? n : fim + 2;
      atual += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (c === "'" && sql[j + 1] === "'") {
            j += 2; // '' dentro de string = aspa escapada, não fecha
            continue;
          }
          break;
        }
        j++;
      }
      atual += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const marcador = /^\$(\w*)\$/.exec(sql.slice(i));
      if (marcador) {
        const fim = sql.indexOf(marcador[0], i + marcador[0].length);
        const ate = fim < 0 ? n : fim + marcador[0].length;
        atual += sql.slice(i, ate);
        i = ate;
        continue;
      }
    }
    if (c === ';') {
      partes.push(atual);
      atual = '';
      i++;
      continue;
    }
    atual += c;
    i++;
  }
  partes.push(atual);
  return partes;
}

/** Mensagem de erro se a consulta contém algo além de leitura; null se ok. */
export function validarLeitura(sql: string): string | null {
  const statements = separarStatements(sql)
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length === 0) return 'Consulta vazia.';
  for (const st of statements) {
    if (!VERBOS_LEITURA.test(st)) {
      return `Apenas consultas de leitura (${VERBOS_DESCRICAO}) são permitidas.`;
    }
  }
  return null;
}
