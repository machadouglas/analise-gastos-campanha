import { useMemo, useState } from 'react';
import { brl } from '@/lib/format';

/* Gráficos em série única no matiz da marca (#264E9B), specs do padrão de dataviz:
   barras <=24px com ponta arredondada 4px (base reta), linha 2px com wash de área
   ~10%, grid hairline recessivo, tooltip por marca, valores em tokens de texto. */

const COR = '#264E9B';
const COR_FORTE = '#10244A';

export interface ItemBarra {
  rotulo: string;
  valor: number;
  detalhe?: string;
}

export function BarrasHorizontais({
  dados,
  formatar = (v: number) => brl.format(v),
}: {
  dados: ItemBarra[];
  formatar?: (v: number) => string;
}) {
  const max = Math.max(...dados.map((d) => d.valor), 1);
  if (!dados.length) {
    return <p className="text-sm text-muted-foreground">Nada encontrado com esses filtros.</p>;
  }
  return (
    <div className="space-y-2">
      {dados.map((d) => (
        <div
          key={d.rotulo}
          title={d.detalhe ?? `${d.rotulo}: ${formatar(d.valor)}`}
          className="group grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,16rem)_1fr_auto]"
        >
          <span className="truncate text-muted-foreground" aria-hidden={false}>
            {d.rotulo}
          </span>
          <div className="h-[18px]">
            <div
              className="h-full rounded-r-[4px] transition-colors"
              style={{
                width: `${Math.max((d.valor / max) * 100, 0.5)}%`,
                background: COR,
              }}
              onMouseEnter={(e) => ((e.target as HTMLElement).style.background = COR_FORTE)}
              onMouseLeave={(e) => ((e.target as HTMLElement).style.background = COR)}
            />
          </div>
          <span className="text-xs tabular-nums text-foreground">{formatar(d.valor)}</span>
        </div>
      ))}
    </div>
  );
}

export interface PontoLinha {
  rotulo: string;
  valor: number;
}

export function LinhaTemporal({
  pontos,
  formatar = (v: number) => brl.format(v),
}: {
  pontos: PontoLinha[];
  formatar?: (v: number) => string;
}) {
  const [ativo, setAtivo] = useState<number | null>(null);
  const L = 720;
  const A = 220;
  const M = { topo: 12, dir: 16, base: 26, esq: 56 };

  const { caminho, area, coords, ticks } = useMemo(() => {
    const max = Math.max(...pontos.map((p) => p.valor), 1);
    // teto "redondo" para os ticks
    const passo = Math.pow(10, Math.floor(Math.log10(max)));
    const teto = Math.ceil(max / passo) * passo;
    const x = (i: number) =>
      M.esq + (pontos.length > 1 ? (i / (pontos.length - 1)) * (L - M.esq - M.dir) : 0);
    const y = (v: number) => M.topo + (1 - v / teto) * (A - M.topo - M.base);
    const coords = pontos.map((p, i) => ({ x: x(i), y: y(p.valor), ...p }));
    const caminho = coords.map((c, i) => `${i ? 'L' : 'M'}${c.x},${c.y}`).join(' ');
    const area = `${caminho} L${coords[coords.length - 1]?.x ?? M.esq},${A - M.base} L${M.esq},${A - M.base} Z`;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: teto * f, y: y(teto * f) }));
    return { caminho, area, coords, ticks };
  }, [pontos]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pontos.length < 2) {
    return <p className="text-sm text-muted-foreground">Poucos pontos para uma linha do tempo.</p>;
  }

  function aoMover(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * L;
    let melhor = 0;
    coords.forEach((c, i) => {
      if (Math.abs(c.x - px) < Math.abs(coords[melhor].x - px)) melhor = i;
    });
    setAtivo(melhor);
  }

  const pt = ativo != null ? coords[ativo] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${L} ${A}`}
        className="w-full"
        onMouseMove={aoMover}
        onMouseLeave={() => setAtivo(null)}
        role="img"
        aria-label="Evolução no tempo"
      >
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={M.esq} x2={L - M.dir} y1={t.y} y2={t.y} stroke="#e6dfd2" strokeWidth="1" />
            <text x={M.esq - 8} y={t.y + 3} textAnchor="end" fontSize="10" fill="#6e6a60">
              {t.v >= 1e6 ? `${(t.v / 1e6).toLocaleString('pt-BR')} mi` : t.v.toLocaleString('pt-BR')}
            </text>
          </g>
        ))}
        <path d={area} fill={COR} opacity="0.1" />
        <path d={caminho} fill="none" stroke={COR} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pt && (
          <>
            <line x1={pt.x} x2={pt.x} y1={M.topo} y2={A - M.base} stroke="#6e6a60" strokeWidth="1" />
            <circle cx={pt.x} cy={pt.y} r="5" fill={COR} stroke="#fffdfa" strokeWidth="2" />
          </>
        )}
        {!pt && coords.length > 0 && (
          <circle
            cx={coords[coords.length - 1].x}
            cy={coords[coords.length - 1].y}
            r="4"
            fill={COR}
            stroke="#fffdfa"
            strokeWidth="2"
          />
        )}
        <text x={M.esq} y={A - 8} fontSize="10" fill="#6e6a60">
          {pontos[0].rotulo}
        </text>
        <text x={L - M.dir} y={A - 8} textAnchor="end" fontSize="10" fill="#6e6a60">
          {pontos[pontos.length - 1].rotulo}
        </text>
      </svg>
      {pt && (
        <div
          className="pointer-events-none absolute -top-1 rounded-md border bg-card px-3 py-1.5 text-xs shadow-md"
          style={{ left: `${(pt.x / L) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <span className="text-muted-foreground">{pt.rotulo}</span>{' '}
          <span className="font-semibold tabular-nums">{formatar(pt.valor)}</span>
        </div>
      )}
    </div>
  );
}

/* Linha de duas séries (ex.: contratado × arrecadado). Cores validadas pelo
   guia de dataviz: navy #264E9B e âmbar #B45309 (ΔE CVD 22.8). Legenda sempre
   presente; identidade nunca só pela cor (a legenda nomeia). */

export const CORES_SERIES = ['#264E9B', '#B45309'] as const;

export interface Serie {
  nome: string;
  valores: number[];
}

export function LinhasComparadas({
  rotulos,
  series,
  formatar = (v: number) => brl.format(v),
}: {
  rotulos: string[];
  series: Serie[];
  formatar?: (v: number) => string;
}) {
  const [ativo, setAtivo] = useState<number | null>(null);
  const L = 720;
  const A = 240;
  const M = { topo: 14, dir: 16, base: 26, esq: 60 };

  const { caminhos, coords, ticks } = useMemo(() => {
    const max = Math.max(...series.flatMap((s) => s.valores), 1);
    const passo = Math.pow(10, Math.floor(Math.log10(max)));
    const teto = Math.ceil(max / passo) * passo;
    const x = (i: number) =>
      M.esq + (rotulos.length > 1 ? (i / (rotulos.length - 1)) * (L - M.esq - M.dir) : 0);
    const y = (v: number) => M.topo + (1 - v / teto) * (A - M.topo - M.base);
    const coords = series.map((s) => s.valores.map((v, i) => ({ x: x(i), y: y(v), v })));
    const caminhos = coords.map((c) => c.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' '));
    const ticks = [0, 0.5, 1].map((f) => ({ v: teto * f, y: y(teto * f) }));
    return { caminhos, coords, ticks };
  }, [rotulos, series]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rotulos.length < 2) {
    return <p className="text-sm text-muted-foreground">Ainda há poucos dias de série para comparar.</p>;
  }

  function aoMover(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * L;
    const xs = coords[0].map((c) => c.x);
    let melhor = 0;
    xs.forEach((x, i) => {
      if (Math.abs(x - px) < Math.abs(xs[melhor] - px)) melhor = i;
    });
    setAtivo(melhor);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        {series.map((s, i) => (
          <span key={s.nome} className="inline-flex items-center gap-2 text-muted-foreground">
            <span className="h-[3px] w-5 rounded-full" style={{ background: CORES_SERIES[i] }} />
            {s.nome}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${L} ${A}`} className="w-full" onMouseMove={aoMover}
             onMouseLeave={() => setAtivo(null)} role="img" aria-label="Comparação no tempo">
          {ticks.map((t) => (
            <g key={t.v}>
              <line x1={M.esq} x2={L - M.dir} y1={t.y} y2={t.y} stroke="#e6dfd2" strokeWidth="1" />
              <text x={M.esq - 8} y={t.y + 3} textAnchor="end" fontSize="10" fill="#6e6a60">
                {t.v >= 1e6 ? `${(t.v / 1e6).toLocaleString('pt-BR')} mi`
                  : t.v >= 1e3 ? `${(t.v / 1e3).toLocaleString('pt-BR')} mil`
                  : t.v.toLocaleString('pt-BR')}
              </text>
            </g>
          ))}
          {caminhos.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={CORES_SERIES[i]} strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {ativo != null && (
            <>
              <line x1={coords[0][ativo].x} x2={coords[0][ativo].x} y1={M.topo} y2={A - M.base}
                    stroke="#6e6a60" strokeWidth="1" />
              {coords.map((c, i) => (
                <circle key={i} cx={c[ativo].x} cy={c[ativo].y} r="5" fill={CORES_SERIES[i]}
                        stroke="#fffdfa" strokeWidth="2" />
              ))}
            </>
          )}
          <text x={M.esq} y={A - 8} fontSize="10" fill="#6e6a60">{rotulos[0]}</text>
          <text x={L - M.dir} y={A - 8} textAnchor="end" fontSize="10" fill="#6e6a60">
            {rotulos[rotulos.length - 1]}
          </text>
        </svg>
        {ativo != null && (
          <div className="pointer-events-none absolute -top-1 rounded-md border bg-card px-3 py-1.5 text-xs shadow-md"
               style={{ left: `${(coords[0][ativo].x / L) * 100}%`, transform: 'translateX(-50%)' }}>
            <span className="text-muted-foreground">{rotulos[ativo]}</span>
            {series.map((s) => (
              <span key={s.nome} className="ml-2 font-semibold tabular-nums">
                {s.nome}: {formatar(s.valores[ativo])}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* Strip plot de preços: cada nota do candidato é um ponto sobre a distribuição
   da categoria na UF (faixa p25–p75, traço na mediana). Escala por linha. */

export interface FaixaPreco {
  categoria: string;
  p25: number | null;
  mediana: number | null;
  p75: number | null;
  p95: number | null;
  notas: { valor: number; descricao: string }[];
}

export function FaixasDePreco({ faixas }: { faixas: FaixaPreco[] }) {
  if (!faixas.length) {
    return <p className="text-sm text-muted-foreground">Sem categorias com benchmark disponível.</p>;
  }
  return (
    <div className="space-y-4">
      {faixas.map((f) => {
        const max = Math.max(f.p95 ?? 0, ...f.notas.map((n) => n.valor)) * 1.08 || 1;
        const pos = (v: number) => `${Math.min((v / max) * 100, 100)}%`;
        return (
          <div key={f.categoria} className="grid items-center gap-3 sm:grid-cols-[minmax(0,15rem)_1fr]">
            <div className="truncate text-sm text-muted-foreground" title={f.categoria}>
              {f.categoria}
            </div>
            <div className="relative h-8">
              <div className="absolute inset-y-3 left-0 right-0 rounded-full bg-muted" />
              {f.p25 != null && f.p75 != null && (
                <div className="absolute inset-y-3 rounded-full bg-[#264E9B]/20"
                     style={{ left: pos(f.p25), width: `calc(${pos(f.p75)} - ${pos(f.p25)})` }}
                     title={`faixa típica (p25–p75): ${brl.format(f.p25)} – ${brl.format(f.p75)}`} />
              )}
              {f.mediana != null && (
                <div className="absolute top-1.5 bottom-1.5 w-[2px] bg-[#264E9B]"
                     style={{ left: pos(f.mediana) }}
                     title={`mediana da categoria: ${brl.format(f.mediana)}`} />
              )}
              {f.notas.map((n, i) => (
                <div key={i}
                     className="absolute top-1/2 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#fffdfa] bg-[#B45309]"
                     style={{ left: pos(n.valor) }}
                     title={`${n.descricao}: ${brl.format(n.valor)}`} />
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        <span className="mr-4 inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#B45309]" /> notas deste recorte
        </span>
        <span className="mr-4 inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full bg-[#264E9B]/20" /> faixa típica da categoria (p25–p75)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-[2px] bg-[#264E9B]" /> mediana
        </span>
      </p>
    </div>
  );
}

/* Detecção de forma para resultados de SQL: 1ª coluna texto + 1ª coluna numérica
   -> barras (até 30 linhas); rótulos que parecem data -> linha temporal. */

export interface GraficoDetectado {
  tipo: 'barras' | 'linha';
  titulo: string;
  dados: ItemBarra[];
  moeda: boolean;
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}|^\d{2}\/\d{2}\/\d{4}/;

export function detectarGrafico(colunas: string[], linhas: unknown[][]): GraficoDetectado | null {
  if (linhas.length < 2 || linhas.length > 400 || colunas.length < 2) return null;
  const ehNumero = (v: unknown) => typeof v === 'number' || typeof v === 'bigint';
  const idxNum = colunas.findIndex((_, j) => linhas.every((l) => l[j] == null || ehNumero(l[j])));
  const idxRotulo = colunas.findIndex((_, j) => linhas.every((l) => typeof l[j] === 'string' || l[j] instanceof Date));
  if (idxNum < 0 || idxRotulo < 0 || idxNum === idxRotulo) return null;

  const dados: ItemBarra[] = linhas.map((l) => ({
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
