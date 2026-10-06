import { Link } from 'react-router-dom';
import { CORES_SERIES } from '@/components/app/graficos';
import { brl, brlCompacto, num } from '@/lib/format';

/* Gráficos da tela de comparação. A identidade de cada item comparado vem
   sempre do RÓTULO da linha (nome do candidato ou sigla), nunca de uma cor:
   as cores ficam com o que já significam no resto do site — navy/âmbar para
   arrecadado × contratado, navy/âmbar/cinza para dinheiro público × bolso ×
   terceiros. Todas as barras de um gráfico dividem a MESMA escala, então o
   comprimento compara tamanho entre os itens, não só proporção. */

export interface RotuloItem {
  id: string;
  rotulo: string;
  href: string;
}

function RotuloLinha({ item, detalhe }: { item: RotuloItem; detalhe?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <Link to={item.href} className="truncate text-sm font-semibold text-[#264E9B] underline-offset-4 hover:underline">
        {item.rotulo}
      </Link>
      {detalhe && <span className="text-xs text-muted-foreground">{detalhe}</span>}
    </div>
  );
}

function Legenda({ itens }: { itens: { rotulo: string; cor: string }[] }) {
  return (
    <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {itens.map((i) => (
        <span key={i.rotulo} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.cor }} /> {i.rotulo}
        </span>
      ))}
    </div>
  );
}

/** Duas barras por item (ex.: arrecadado × contratado), com o valor ao lado. */
export function BarrasPareadas({
  itens,
  series,
}: {
  itens: (RotuloItem & { valores: [number, number]; detalhe?: string })[];
  series: [string, string];
}) {
  const max = Math.max(...itens.flatMap((i) => i.valores), 1);
  return (
    <div>
      <Legenda itens={series.map((s, i) => ({ rotulo: s, cor: CORES_SERIES[i] }))} />
      <div className="space-y-5">
        {itens.map((item) => (
          <div key={item.id}>
            <RotuloLinha item={item} detalhe={item.detalhe} />
            <div className="mt-1.5 space-y-1">
              {item.valores.map((v, i) => (
                <div key={series[i]} className="flex items-center gap-3" title={`${series[i]}: ${brl.format(v)}`}>
                  <div className="h-3.5 flex-1">
                    <div
                      className="h-full rounded-r-[4px]"
                      style={{ width: `${Math.max((v / max) * 100, v > 0 ? 0.5 : 0)}%`, background: CORES_SERIES[i] }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-foreground">
                    <span className="sr-only">{series[i]}: </span>
                    {brlCompacto.format(v)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Porcentagem inteira, mas sem afirmar "0%" de uma fatia que existe. */
const pctCurto = (p: number) => (p > 0 && p < 1 ? '<1%' : `${num.format(Math.round(p))}%`);

export interface FatiaPilha {
  rotulo: string;
  cor: string;
}

/** Uma barra empilhada por item, todas na mesma escala: o comprimento é o
 *  total e as fatias, a composição. Com `proporcional`, toda barra ocupa a
 *  largura inteira e só a composição é comparada — é o que serve quando um
 *  item é dezenas de vezes maior que o outro e o tamanho já foi mostrado em
 *  outro gráfico. `total` null = sem dado (a linha diz por quê em `semDado`). */
export function PilhasComparadas({
  itens,
  fatias,
  formatar,
  formatarTotal = formatar,
  proporcional = false,
}: {
  itens: (RotuloItem & { valores: number[]; total: number | null; detalhe?: string; semDado?: string })[];
  fatias: FatiaPilha[];
  formatar: (v: number) => string;
  formatarTotal?: (v: number) => string;
  proporcional?: boolean;
}) {
  const maxTotal = Math.max(...itens.map((i) => i.total ?? 0), 0);
  return (
    <div>
      <Legenda itens={fatias} />
      <div className="space-y-5">
        {itens.map((item) => {
          const soma = item.valores.reduce((s, v) => s + Math.max(v, 0), 0);
          // as fatias repartem o total; se vierem de uma base menor (ex.: só
          // quem declarou receita), são normalizadas para somar o total da barra
          const max = proporcional ? (item.total ?? 0) : maxTotal;
          const largura = (v: number) =>
            item.total != null && max > 0 && soma > 0 ? (100 * item.total * (Math.max(v, 0) / soma)) / max : 0;
          return (
            <div key={item.id}>
              <RotuloLinha item={item} detalhe={item.detalhe} />
              {item.total == null ? (
                <p className="mt-1.5 text-xs text-muted-foreground">{item.semDado ?? 'Sem dado.'}</p>
              ) : (
                <div className="mt-1.5 flex items-center gap-3">
                  <div
                    className="flex h-5 flex-1 gap-[2px]"
                    role="img"
                    aria-label={`${item.rotulo}: ${formatarTotal(item.total)} — ${fatias
                      .map((f, i) => `${f.rotulo} ${formatar(item.valores[i] ?? 0)}`)
                      .join(', ')}`}
                  >
                    {soma <= 0 && max > 0 && (
                      // há total mas não há composição (ex.: custo por voto de
                      // quem não declarou receita): barra neutra, sem fatias
                      <div
                        className="h-full rounded-[4px] bg-[#6e6a60]/30"
                        title="Composição desconhecida: sem receita declarada"
                        style={{ width: `${(100 * item.total) / max}%` }}
                      />
                    )}
                    {fatias.map((f, i) => {
                      const v = item.valores[i] ?? 0;
                      const w = largura(v);
                      if (w <= 0) return null;
                      const pct = soma > 0 ? pctCurto((100 * v) / soma) : '0%';
                      return (
                        <div
                          key={f.rotulo}
                          className="h-full first:rounded-l-[4px] last:rounded-r-[4px]"
                          title={`${f.rotulo}: ${formatar(v)} (${pct})`}
                          style={{ width: `${w}%`, background: f.cor }}
                        />
                      );
                    })}
                  </div>
                  <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums text-[#10244A]">
                    {formatarTotal(item.total)}
                  </span>
                </div>
              )}
              {item.total != null && soma > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {fatias
                    .map((f, i) => ({ f, v: item.valores[i] ?? 0 }))
                    .filter(({ v }) => v > 0)
                    .map(({ f, v }) => `${f.rotulo.toLowerCase()} ${pctCurto((100 * v) / soma)}`)
                    .join(' · ')}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface LinhaCategoria {
  categoria: string;
  /** gasto do item na categoria, alinhado a `colunas` */
  valores: number[];
}

/** Matriz tipo de gasto × item comparado. Cada célula é a FATIA daquele tipo
 *  no gasto do item (barra navy + %) — é o "como gastou": dois candidatos de
 *  tamanhos muito diferentes ficam comparáveis. O valor em R$ vai embaixo. */
export function MatrizCategorias({
  colunas,
  linhas,
  totais,
}: {
  colunas: RotuloItem[];
  linhas: LinhaCategoria[];
  totais: number[];
}) {
  const pct = (v: number, j: number) => (totais[j] > 0 ? (100 * v) / totais[j] : 0);
  const maxPct = Math.max(...linhas.flatMap((l) => l.valores.map((v, j) => pct(v, j))), 1);
  return (
    <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
      {/* table-fixed: as colunas dos itens comparados têm a mesma largura,
          senão a barra de 77% de um parecia menor que a de 57% do outro */}
      <table className="w-full table-fixed border-collapse text-sm" style={{ minWidth: `${12 + colunas.length * 9}rem` }}>
        <thead>
          <tr>
            <th className="w-[26%] border-b px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:px-4">
              Tipo de gasto
            </th>
            {colunas.map((c) => (
              <th key={c.id} className="border-b px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:px-4">
                <Link to={c.href} className="text-[#264E9B] underline-offset-4 hover:underline">{c.rotulo}</Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l) => (
            <tr key={l.categoria} className="border-b last:border-b-0">
              <td className="px-3 py-2.5 align-top text-muted-foreground sm:px-4">{l.categoria}</td>
              {l.valores.map((v, j) => {
                const p = pct(v, j);
                return (
                  <td key={colunas[j].id} className="px-3 py-2.5 align-top sm:px-4" title={`${colunas[j].rotulo} · ${l.categoria}: ${brl.format(v)}`}>
                    {v > 0 ? (
                      <>
                        <div className="flex items-center gap-2">
                          <div className="h-2.5 flex-1">
                            <div className="h-full rounded-r-[4px] bg-[#264E9B]" style={{ width: `${Math.max((p / maxPct) * 100, 2)}%` }} />
                          </div>
                          <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">
                            {pctCurto(p)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{brlCompacto.format(v)}</p>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Escolhe as categorias que aparecem na matriz: as que mais pesam somando a
 *  FATIA de cada item (não o valor bruto — senão o maior candidato decide
 *  sozinho quais linhas o menor terá). O resto vira "Outras". */
export function montarMatriz(
  ids: string[],
  gastos: { id: string; categoria: string; total: number }[],
  maxLinhas = 8,
): { linhas: LinhaCategoria[]; totais: number[] } {
  const totais = ids.map((id) => gastos.filter((g) => g.id === id).reduce((s, g) => s + g.total, 0));
  const peso = new Map<string, number>();
  for (const g of gastos) {
    const j = ids.indexOf(g.id);
    if (j < 0 || totais[j] <= 0) continue;
    peso.set(g.categoria, (peso.get(g.categoria) ?? 0) + g.total / totais[j]);
  }
  const ordenadas = [...peso.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  // "Outras" só existe se juntar 2+ categorias; uma sobra sozinha vira linha própria
  const visiveis = ordenadas.length <= maxLinhas + 1 ? ordenadas : ordenadas.slice(0, maxLinhas);
  const valor = (id: string, cat: string) =>
    gastos.filter((g) => g.id === id && g.categoria === cat).reduce((s, g) => s + g.total, 0);
  const linhas: LinhaCategoria[] = visiveis.map((categoria) => ({
    categoria,
    valores: ids.map((id) => valor(id, categoria)),
  }));
  if (visiveis.length < ordenadas.length) {
    const resto = new Set(ordenadas.slice(visiveis.length));
    linhas.push({
      categoria: `Outras (${resto.size} tipos)`,
      valores: ids.map((id) => gastos.filter((g) => g.id === id && resto.has(g.categoria)).reduce((s, g) => s + g.total, 0)),
    });
  }
  return { linhas, totais };
}
