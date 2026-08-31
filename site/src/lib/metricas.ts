import { brl } from '@/lib/format';

/** Métricas comparáveis por grupo (cargo×UF) — mesmos nomes das linhas de
 *  benchmark_indicadores (src/agregados.py) e dos sinais do resumo.json
 *  (METRICAS_SINAL em src/resumo.py). */

export interface MetricaInfo {
  rotulo: string;
  formatar: (v: number) => string;
  /** Frase do chip de sinal, quando o par "rótulo: valor" não diz o que está
   *  sendo afirmado. "Gasto ÷ arrecadado: 1,03×" faz o leitor fazer a conta;
   *  "Gastou 1,03× o que arrecadou" já entrega o fato. (Sem o "mais": "2,44×
   *  mais" seria, ao pé da letra, 3,44× o arrecadado.) */
  frase?: (v: number) => string;
}

/** Metrica com a frase resolvida — o que `metrica()` devolve. */
export type Metrica = Required<MetricaInfo>;

const pct = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
/** Duas casas fixas: a razão vem arredondada em 2 casas do banco
 *  (src/agregados.py) e é perto de 1 que ela decide o sinal — com 1 casa,
 *  1,03 virava "1×" e o chip parecia implicância com quem está no normal. */
const vezes = (v: number) =>
  `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;

export const METRICAS: Record<string, MetricaInfo> = {
  total_contratado: { rotulo: 'Total contratado', formatar: (v) => brl.format(v) },
  total_receitas: { rotulo: 'Total arrecadado', formatar: (v) => brl.format(v) },
  razao_gasto_receita: {
    rotulo: 'Gasto ÷ arrecadado',
    formatar: vezes,
    frase: (v) => `Gastou ${vezes(v)} o que arrecadou`,
  },
  pct_maior_fornecedor: { rotulo: '% no maior fornecedor', formatar: pct },
  pct_sem_nota: { rotulo: '% sem documento fiscal', formatar: pct },
  pct_pessoa_fisica: { rotulo: '% pago a pessoas físicas', formatar: pct },
  pct_fundos_publicos: { rotulo: '% de dinheiro público', formatar: pct },
};

/** Rótulo seguro para métrica desconhecida (schema pode evoluir antes do front). */
export function metrica(nome: string): Metrica {
  const info = METRICAS[nome] ?? { rotulo: nome, formatar: (v: number) => v.toLocaleString('pt-BR') };
  return { ...info, frase: info.frase ?? ((v: number) => `${info.rotulo}: ${info.formatar(v)}`) };
}
