import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { brl } from '@/lib/format';

/* Gráficos em série única no matiz da marca (#264E9B), specs do padrão de dataviz:
   barras <=24px com ponta arredondada 4px (base reta), linha 2px com wash de área
   ~10%, grid hairline recessivo, tooltip por marca, valores em tokens de texto. */

const COR = '#264E9B';
const COR_FORTE = '#10244A';

/** Em telas de celular, o viewBox acompanha a largura do contêiner. Sem isso
 *  o SVG de 720 unidades é reduzido a ~45% num aparelho de 375px e todo texto
 *  de 10px vira 4,5px ilegível; medindo, o viewBox fica ~1:1 com o pixel real
 *  e os rótulos voltam ao tamanho pretendido. Acima de 640px devolve o padrão
 *  — o desktop continua exatamente como era. */
const LARGURA_CELULAR = 640;

function useLarguraViewBox(padrao: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [largura, setLargura] = useState(padrao);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => {
      const l = el.clientWidth;
      setLargura(
        window.innerWidth < LARGURA_CELULAR && l > 0
          ? Math.round(Math.min(padrao, Math.max(l, 300)))
          : padrao,
      );
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [padrao]);
  return [ref, largura] as const;
}

export interface ItemBarra {
  rotulo: string;
  valor: number;
  detalhe?: string;
}

// memo: os inputs do Explorar re-renderizam a página a cada tecla
export const BarrasHorizontais = memo(function BarrasHorizontais({
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
          /* no celular o rótulo e o valor ficam na primeira linha e a barra
             ocupa a segunda inteira — em três colunas numa tela de 375px
             sobrava um toco de barra ao lado de um nome truncado */
          className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,16rem)_1fr_auto]"
        >
          <span className="col-start-1 row-start-1 truncate text-muted-foreground" aria-hidden={false}>
            {d.rotulo}
          </span>
          <div className="col-span-2 row-start-2 h-[18px] sm:col-span-1 sm:col-start-2 sm:row-start-1">
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
          <span className="col-start-2 row-start-1 text-right text-xs tabular-nums text-foreground sm:col-start-3">
            {formatar(d.valor)}
          </span>
        </div>
      ))}
    </div>
  );
});

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
  const [refMedida, L] = useLarguraViewBox(720);
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
  }, [pontos, L]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div ref={refMedida} className="relative">
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

export interface MarcaLinha {
  indice: number;
  rotulo: string;
}

export function LinhasComparadas({
  rotulos,
  series,
  marcas = [],
  formatar = (v: number) => brl.format(v),
}: {
  rotulos: string[];
  series: Serie[];
  /** dias a destacar no eixo (ex.: última extração em que algo removido esteve visível) */
  marcas?: MarcaLinha[];
  formatar?: (v: number) => string;
}) {
  const [ativo, setAtivo] = useState<number | null>(null);
  const [refMedida, L] = useLarguraViewBox(720);
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
  }, [rotulos, series, L]); // eslint-disable-line react-hooks/exhaustive-deps

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
        {marcas.length > 0 && (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden>
              <path d="M5,1 l4,6 l-4,6 l-4,-6 Z" fill="#B42318" />
            </svg>
            último dia em que algo removido esteve visível
          </span>
        )}
      </div>
      <div ref={refMedida} className="relative">
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
          {marcas.map((m) => {
            const x = coords[0][m.indice]?.x;
            if (x == null) return null;
            return (
              <g key={m.indice}>
                <title>{m.rotulo}</title>
                <path d={`M${x},${A - M.base + 4} l4,6 l-4,6 l-4,-6 Z`} fill="#B42318" />
              </g>
            );
          })}
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
   da categoria na UF (faixa p25–p75, traço na mediana). Escala por linha.
   Com `grupo`, vira um beeswarm: os demais candidatos do grupo aparecem como
   pontos cinza com jitter vertical — "fora da curva" passa a ser visível. */

export interface FaixaPreco {
  categoria: string;
  p25: number | null;
  mediana: number | null;
  p75: number | null;
  p95: number | null;
  notas: { valor: number; descricao: string }[];
  /** valores dos demais candidatos do grupo de comparação (amostra) */
  grupo?: number[];
  /** formatação dos valores desta linha (R$ por padrão; %, × etc. nos indicadores) */
  formatar?: (v: number) => string;
}

// memo: os inputs do Explorar re-renderizam a página a cada tecla
export const FaixasDePreco = memo(function FaixasDePreco({
  faixas,
  rotuloPontos = 'notas deste recorte',
  rotuloGrupo = 'demais candidatos do grupo',
  vazio = 'Sem categorias com benchmark disponível.',
}: {
  faixas: FaixaPreco[];
  rotuloPontos?: string;
  rotuloGrupo?: string;
  vazio?: string;
}) {
  if (!faixas.length) {
    return <p className="text-sm text-muted-foreground">{vazio}</p>;
  }
  const temGrupo = faixas.some((f) => (f.grupo?.length ?? 0) > 0);
  return (
    <div className="space-y-4">
      {faixas.map((f) => {
        const fmt = f.formatar ?? ((v: number) => brl.format(v));
        const max = Math.max(f.p95 ?? 0, ...f.notas.map((n) => n.valor)) * 1.08 || 1;
        const pos = (v: number) => `${Math.min((v / max) * 100, 100)}%`;
        return (
          <div key={f.categoria} className="grid items-center gap-3 sm:grid-cols-[minmax(0,15rem)_1fr]">
            <div className="text-sm text-muted-foreground sm:truncate" title={f.categoria}>
              {f.categoria}
            </div>
            <div className="relative h-8">
              <div className="absolute inset-y-3 left-0 right-0 rounded-full bg-muted" />
              {f.p25 != null && f.p75 != null && (
                <div className="absolute inset-y-3 rounded-full bg-[#264E9B]/20"
                     style={{ left: pos(f.p25), width: `calc(${pos(f.p75)} - ${pos(f.p25)})` }}
                     title={`faixa típica (p25–p75): ${fmt(f.p25)} – ${fmt(f.p75)}`} />
              )}
              {f.mediana != null && (
                <div className="absolute top-1.5 bottom-1.5 w-[2px] bg-[#264E9B]"
                     style={{ left: pos(f.mediana) }}
                     title={`mediana do grupo: ${fmt(f.mediana)}`} />
              )}
              {(f.grupo ?? []).map((v, i) => (
                // jitter vertical determinístico (sem aleatoriedade — render estável)
                <div key={`g${i}`}
                     aria-hidden
                     className="absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#6e6a60]/35"
                     style={{ left: pos(v), top: `${28 + ((i * 37) % 45)}%` }} />
              ))}
              {f.notas.map((n, i) => (
                <div key={i}
                     className="absolute top-1/2 z-10 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#fffdfa] bg-[#B45309]"
                     style={{ left: pos(n.valor) }}
                     title={`${n.descricao}: ${fmt(n.valor)}`} />
              ))}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        <span className="mr-4 inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#B45309]" /> {rotuloPontos}
        </span>
        {temGrupo && (
          <span className="mr-4 inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-[#6e6a60]/40" /> {rotuloGrupo}
          </span>
        )}
        <span className="mr-4 inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full bg-[#264E9B]/20" /> faixa típica (p25–p75)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-[2px] bg-[#264E9B]" /> mediana
        </span>
      </p>
    </div>
  );
});

/* Sparkline: miniatura de série para dentro dos cartões KPI — só a forma da
   tendência, sem eixos (o número grande do cartão é o valor). */

export function Sparkline({ valores, cor = COR }: { valores: number[]; cor?: string }) {
  if (valores.length < 2) return null;
  const L = 120;
  const A = 30;
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const amplitude = max - min || 1;
  const pts = valores.map((v, i) => ({
    x: (i / (valores.length - 1)) * L,
    y: 3 + (1 - (v - min) / amplitude) * (A - 6),
  }));
  const caminho = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${caminho} L${L},${A} L0,${A} Z`;
  const fim = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${L} ${A}`} className="h-[30px] w-full max-w-[120px]" aria-hidden>
      <path d={area} fill={cor} opacity="0.08" />
      <path d={caminho} fill="none" stroke={cor} strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={fim.x} cy={fim.y} r="2.5" fill={cor} />
    </svg>
  );
}

/* Barra empilhada 100%: composição de um total em poucas fatias nomeadas
   (ex.: dinheiro público × recursos próprios × demais doações). */

export interface FatiaComposicao {
  rotulo: string;
  valor: number;
  cor: string;
}

export function BarraComposicao({
  fatias,
  formatar = (v: number) => brl.format(v),
}: {
  fatias: FatiaComposicao[];
  formatar?: (v: number) => string;
}) {
  const total = fatias.reduce((s, f) => s + Math.max(f.valor, 0), 0);
  if (total <= 0) {
    return <p className="text-sm text-muted-foreground">Sem receitas declaradas para compor.</p>;
  }
  const visiveis = fatias.filter((f) => f.valor > 0);
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded-full" role="img"
           aria-label={visiveis.map((f) => `${f.rotulo}: ${formatar(f.valor)}`).join('; ')}>
        {visiveis.map((f) => (
          <div key={f.rotulo}
               title={`${f.rotulo}: ${formatar(f.valor)} (${Math.round((100 * f.valor) / total)}%)`}
               style={{ width: `${(100 * f.valor) / total}%`, background: f.cor }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {visiveis.map((f) => (
          <span key={f.rotulo} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: f.cor }} />
            {f.rotulo}: <span className="font-semibold tabular-nums text-foreground">{formatar(f.valor)}</span>
            <span>({Math.round((100 * f.valor) / total)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* Dispersão arrecadado × contratado: um ponto por candidato, escala log nos
   dois eixos, diagonal do equilíbrio (gastar = arrecadar). Pontos acima da
   diagonal contrataram mais do que declararam arrecadar. */

export interface PontoDispersao {
  x: number; // arrecadado
  y: number; // contratado
  rotulo: string;
  sq?: string;
}

const PISO_LOG = 100; // R$ 100: piso da escala log (zero não tem log)

function fmtEixo(v: number) {
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('pt-BR')} mi`;
  if (v >= 1e3) return `${(v / 1e3).toLocaleString('pt-BR')} mil`;
  return v.toLocaleString('pt-BR');
}

export function Dispersao({
  pontos,
  aoClicar,
}: {
  pontos: PontoDispersao[];
  aoClicar?: (p: PontoDispersao) => void;
}) {
  const [ativo, setAtivo] = useState<number | null>(null);
  const [refMedida, L] = useLarguraViewBox(720);
  const A = 400;
  const M = { topo: 14, dir: 18, base: 40, esq: 64 };

  const { coords, ticks, diag } = useMemo(() => {
    const teto = Math.max(...pontos.map((p) => Math.max(p.x, p.y)), PISO_LOG * 10);
    const logMin = Math.log10(PISO_LOG);
    const logMax = Math.ceil(Math.log10(teto));
    const escala = (v: number, tam: number) =>
      ((Math.log10(Math.max(v, PISO_LOG)) - logMin) / (logMax - logMin)) * tam;
    const x = (v: number) => M.esq + escala(v, L - M.esq - M.dir);
    const y = (v: number) => A - M.base - escala(v, A - M.topo - M.base);
    const coords = pontos.map((p) => ({ ...p, cx: x(p.x), cy: y(p.y), acima: p.y > p.x }));
    const ticks: { v: number; x: number; y: number }[] = [];
    for (let e = Math.log10(PISO_LOG); e <= logMax; e++) {
      const v = 10 ** e;
      ticks.push({ v, x: x(v), y: y(v) });
    }
    const diag = { x1: x(PISO_LOG), y1: y(PISO_LOG), x2: x(10 ** logMax), y2: y(10 ** logMax) };
    return { coords, ticks, diag };
  }, [pontos, L]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pontos.length < 3) {
    return <p className="text-sm text-muted-foreground">Poucos candidatos neste recorte para uma dispersão.</p>;
  }
  const pt = ativo != null ? coords[ativo] : null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#B45309]" /> contratou acima do arrecadado
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#264E9B]/50" /> dentro do arrecadado
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-5 bg-[#6e6a60]" /> linha do equilíbrio (gastar = arrecadar)
        </span>
      </div>
      <div ref={refMedida} className="relative">
        <svg viewBox={`0 0 ${L} ${A}`} className="w-full" role="img"
             aria-label="Dispersão: arrecadado × contratado por candidato"
             onMouseLeave={() => setAtivo(null)}>
          {ticks.map((t) => (
            <g key={t.v}>
              <line x1={M.esq} x2={L - M.dir} y1={t.y} y2={t.y} stroke="#e6dfd2" strokeWidth="1" />
              <line x1={t.x} x2={t.x} y1={M.topo} y2={A - M.base} stroke="#e6dfd2" strokeWidth="1" />
              <text x={M.esq - 8} y={t.y + 3} textAnchor="end" fontSize="10" fill="#6e6a60">{fmtEixo(t.v)}</text>
              <text x={t.x} y={A - M.base + 14} textAnchor="middle" fontSize="10" fill="#6e6a60">{fmtEixo(t.v)}</text>
            </g>
          ))}
          <line x1={diag.x1} y1={diag.y1} x2={diag.x2} y2={diag.y2}
                stroke="#6e6a60" strokeWidth="1.5" strokeDasharray="5 4" />
          <text x={L - M.dir} y={A - M.base + 30} textAnchor="end" fontSize="10" fill="#6e6a60">
            arrecadado (R$, escala log) →
          </text>
          <text x={14} y={M.topo + 4} fontSize="10" fill="#6e6a60" transform={`rotate(-90 14 ${M.topo + 4})`} textAnchor="end">
            contratado (R$, escala log) →
          </text>
          {coords.map((c, i) => (
            <circle key={i} cx={c.cx} cy={c.cy}
                    r={ativo === i ? 6 : 3.5}
                    fill={c.acima ? '#B45309' : '#264E9B'}
                    opacity={ativo === i ? 1 : c.acima ? 0.85 : 0.45}
                    stroke={ativo === i ? '#fffdfa' : 'none'} strokeWidth="1.5"
                    style={{ cursor: aoClicar ? 'pointer' : 'default' }}
                    onMouseEnter={() => setAtivo(i)}
                    onClick={() => aoClicar?.(c)} />
          ))}
        </svg>
        {pt && (
          <div className="pointer-events-none absolute rounded-md border bg-card px-3 py-1.5 text-xs shadow-md"
               style={{
                 left: `${Math.min((pt.cx / L) * 100, 82)}%`,
                 top: `${(pt.cy / A) * 100}%`,
                 transform: 'translate(8px, -110%)',
               }}>
            <span className="font-semibold">{pt.rotulo}</span>
            <span className="ml-2 tabular-nums text-muted-foreground">
              arrecadou {brl.format(pt.x)} · contratou {brl.format(pt.y)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* A detecção de gráfico para resultados de SQL vive em src/lib/grafico-auto.ts
   (função pura, testada sem React). */
