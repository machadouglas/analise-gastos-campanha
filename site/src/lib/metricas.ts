import { brl } from '@/lib/format';

/** Métricas comparáveis por grupo (cargo×UF) — mesmos nomes das linhas de
 *  benchmark_indicadores e dos sinais do resumo.json (src/agregados.py). */

export interface MetricaInfo {
  rotulo: string;
  formatar: (v: number) => string;
}

const pct = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const vezes = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}×`;

export const METRICAS: Record<string, MetricaInfo> = {
  total_contratado: { rotulo: 'Total contratado', formatar: (v) => brl.format(v) },
  total_receitas: { rotulo: 'Total arrecadado', formatar: (v) => brl.format(v) },
  razao_gasto_receita: { rotulo: 'Gasto ÷ arrecadado', formatar: vezes },
  pct_maior_fornecedor: { rotulo: '% no maior fornecedor', formatar: pct },
  pct_sem_nota: { rotulo: '% sem nota fiscal', formatar: pct },
  pct_pessoa_fisica: { rotulo: '% pago a pessoas físicas', formatar: pct },
  pct_fundos_publicos: { rotulo: '% de dinheiro público', formatar: pct },
};

/** Rótulo seguro para métrica desconhecida (schema pode evoluir antes do front). */
export function metrica(nome: string): MetricaInfo {
  return METRICAS[nome] ?? { rotulo: nome, formatar: (v) => v.toLocaleString('pt-BR') };
}
