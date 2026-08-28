/** Detecção de forma para resultados de SQL (console do Consultar):
 *  1ª coluna texto + 1ª coluna numérica -> barras (até 30 linhas);
 *  rótulos que parecem data -> linha temporal. Função pura — testada em
 *  grafico-auto.test.ts. */

export interface PontoGrafico {
  rotulo: string;
  valor: number;
  detalhe?: string;
}

export interface GraficoDetectado {
  tipo: 'barras' | 'linha';
  titulo: string;
  dados: PontoGrafico[];
  moeda: boolean;
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}|^\d{2}\/\d{2}\/\d{4}/;

export function detectarGrafico(colunas: string[], linhas: unknown[][]): GraficoDetectado | null {
  if (linhas.length < 2 || linhas.length > 400 || colunas.length < 2) return null;
  const ehNumero = (v: unknown) => typeof v === 'number' || typeof v === 'bigint';
  const idxNum = colunas.findIndex((_, j) => linhas.every((l) => l[j] == null || ehNumero(l[j])));
  const idxRotulo = colunas.findIndex((_, j) => linhas.every((l) => typeof l[j] === 'string' || l[j] instanceof Date));
  if (idxNum < 0 || idxRotulo < 0 || idxNum === idxRotulo) return null;

  const dados: PontoGrafico[] = linhas.map((l) => ({
    rotulo: l[idxRotulo] instanceof Date
      ? (l[idxRotulo] as Date).toISOString().slice(0, 10)
      : String(l[idxRotulo]),
    valor: Number(l[idxNum] ?? 0),
  }));
  const moeda = /valor|total|vr_|receita|despesa|pago|contratado/i.test(colunas[idxNum]);
  const temporal = dados.every((d) => RE_DATA.test(d.rotulo));
  if (temporal) {
    return { tipo: 'linha', titulo: colunas[idxNum], dados, moeda };
  }
  if (linhas.length > 30) return null;
  return { tipo: 'barras', titulo: colunas[idxNum], dados, moeda };
}
