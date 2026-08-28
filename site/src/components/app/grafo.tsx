import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject, type LinkObject } from 'react-force-graph-2d';
import { forceCollide, type ForceManyBody } from 'd3-force';
import { brl } from '@/lib/format';

/* Grafo de conexões com a biblioteca de referência (force-graph, canvas):
   física contínua, zoom com o scroll, pan e arrastar nós — de graça.
   Nível 1: contrapartes diretas (raio/espessura ∝ valor; navy = pagamento,
   âmbar = doação; anel vermelho = os dois papéis, o "dinheiro que volta").
   Nível 2: as conexões das conexões, em nós menores e neutros — os rótulos
   delas só aparecem ao aproximar o zoom, para não virar poeira visual. */

export interface NoConexao {
  id: string;
  rotulo: string;
  valor: number;
  tipo: 'despesa' | 'doacao' | 'ambos';
  detalhe?: string;
}

/** Nó de segundo nível: liga-se a um ou mais nós de nível 1. */
export interface NoSecundario {
  id: string;
  rotulo: string;
  valor: number;
  ligadoA: string[];
  detalhe?: string;
}

const NAVY = '#264E9B';
const NAVY_ESCURO = '#10244A';
const AMBAR = '#B45309';
const VERMELHO = '#B42318';
const PAPEL = '#fffdfa';
const TINTA = '#1c1a17';
const TINTA_SUAVE = '#6e6a60';

const TIPO_ROTULO: Record<NoConexao['tipo'], string> = {
  despesa: 'recebeu pagamento',
  doacao: 'fez doação',
  ambos: 'fornecedor E doador',
};

/* tipos "crus" — a lib os embrulha em NodeObject/LinkObject (x, y, fx…) */
interface DadosNo {
  id: string;
  nome: string;
  valor: number;
  nivel: 0 | 1 | 2;
  tipo?: NoConexao['tipo'];
  detalhe?: string;
  r: number;
  fx?: number;
  fy?: number;
}

interface DadosLigacao {
  tipo?: NoConexao['tipo'];
  w: number;
  nivel2?: boolean;
}

type No = NodeObject<DadosNo>;
type Ligacao = LinkObject<DadosNo, DadosLigacao>;

const escapar = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function GrafoConexoes({
  centro,
  nos,
  secundarios = [],
  aoClicar,
  aoClicarSecundario,
  rotuloSecundarios = 'conexões das conexões',
  formatar = (v: number) => brl.format(v),
}: {
  centro: string;
  nos: NoConexao[];
  secundarios?: NoSecundario[];
  aoClicar?: (no: NoConexao) => void;
  aoClicarSecundario?: (no: NoSecundario) => void;
  rotuloSecundarios?: string;
  formatar?: (v: number) => string;
}) {
  const contRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<No, Ligacao> | undefined>(undefined);
  const [largura, setLargura] = useState(0);
  const hoverRef = useRef<string | null>(null);
  const enquadrouRef = useRef(false);

  useEffect(() => {
    const el = contRef.current;
    if (!el) return;
    // medida síncrona primeiro: o ResizeObserver só entrega no pipeline de
    // frames, e uma aba em segundo plano pode demorar a produzir o primeiro
    setLargura(el.clientWidth);
    const ro = new ResizeObserver((entradas) => setLargura(entradas[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  const { dados, altura, temN2, totalN1 } = useMemo(() => {
    const n1 = [...nos].sort((a, b) => b.valor - a.valor).slice(0, 20);
    const idsN1 = new Set(n1.map((n) => n.id));
    const n2 = secundarios
      .filter((s) => !idsN1.has(s.id) && s.ligadoA.some((a) => idsN1.has(a)))
      .slice(0, 30);
    const max = Math.max(...n1.map((n) => n.valor), 1);
    const nodes: DadosNo[] = [
      { id: '__centro__', nome: centro, valor: 0, nivel: 0, r: 11, fx: 0, fy: 0 },
      ...n1.map((n): DadosNo => ({
        id: n.id, nome: n.rotulo, valor: n.valor, nivel: 1, tipo: n.tipo, detalhe: n.detalhe,
        r: 4 + Math.sqrt(n.valor / max) * 8,
      })),
      ...n2.map((n): DadosNo => ({
        id: n.id, nome: n.rotulo, valor: n.valor, nivel: 2, detalhe: n.detalhe, r: 3.5,
      })),
    ];
    const links = [
      ...n1.map((n) => ({
        source: '__centro__', target: n.id, tipo: n.tipo, w: 1 + (n.valor / max) * 5,
      })),
      ...n2.flatMap((s) =>
        s.ligadoA.filter((a) => idsN1.has(a)).map((a) => ({
          source: a, target: s.id, w: 0.7, nivel2: true,
        }))),
    ];
    return {
      dados: { nodes, links },
      altura: Math.min(620, 420 + n2.length * 5),
      temN2: n2.length > 0,
      totalN1: nos.length,
    };
  }, [nos, secundarios, centro]);

  // forças ajustadas ao nosso caso: 2º nível orbita perto do seu nível 1.
  // Depende TAMBÉM de `largura`: o ForceGraph só monta depois da medição do
  // contêiner — sem essa dependência, o efeito rodava antes e o grafo ficava
  // com as forças padrão (tudo grudado no centro).
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || largura <= 0) return;
    enquadrouRef.current = false;
    const carga = fg.d3Force('charge') as ForceManyBody<No> | undefined;
    carga?.strength((n) => (n.nivel === 2 ? -18 : -65));
    const link = fg.d3Force('link') as { distance: (fn: (l: Ligacao) => number) => unknown } | undefined;
    link?.distance((l) => (l.nivel2 ? 48 : 118));
    fg.d3Force('collide', forceCollide<No>().radius((n) => n.r + (n.nivel === 2 ? 8 : 10)));
    fg.d3ReheatSimulation();
    // enquadra com a física ainda em movimento (transição suave), uma vez por
    // dataset; teto de zoom para rede pequena não virar bolas gigantes
    const timer = setTimeout(() => {
      if (enquadrouRef.current) return;
      enquadrouRef.current = true;
      fg.zoomToFit(700, 40);
      setTimeout(() => {
        if (fg.zoom() > 1.15) fg.zoom(1.15, 400);
      }, 750);
    }, 1300);
    return () => clearTimeout(timer);
  }, [dados, largura]);

  const corNo = (n: No) =>
    n.nivel === 0 ? NAVY_ESCURO : n.nivel === 2 ? '#efe9dc' : n.tipo === 'doacao' ? AMBAR : NAVY;

  return (
    <div ref={contRef}>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-5 rounded-full" style={{ background: NAVY }} /> pagamento (despesa)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-5 rounded-full" style={{ background: AMBAR }} /> doação
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: VERMELHO }} />
          fornecedor que também doa ("dinheiro que volta")
        </span>
        {temN2 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full border" style={{ background: '#efe9dc', borderColor: TINTA_SUAVE }} />
            {rotuloSecundarios}
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border bg-[#fffdfa]" style={{ minHeight: altura }}>
        {largura > 0 && (
          <ForceGraph2D<DadosNo, DadosLigacao>
            ref={fgRef}
            width={largura - 2}
            height={altura}
            graphData={dados}
            backgroundColor={PAPEL}
            // sem warmup: a acomodação acontece NA TELA (entrada fluida);
            // decaimentos suaves dão movimento com peso, sem travar
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.3}
            cooldownTime={8000}
            nodeLabel={(n) =>
              `<div style="max-width:280px;font-size:12px;line-height:1.4">` +
              `<strong>${escapar(n.nome)}</strong><br/>` +
              (n.nivel === 0
                ? 'centro da rede'
                : `${n.nivel === 1 ? TIPO_ROTULO[n.tipo ?? 'despesa'] : escapar(n.detalhe ?? '')}` +
                  (n.valor ? `: ${formatar(n.valor)}` : '') +
                  (n.nivel === 1 && n.detalhe ? `<br/>${escapar(n.detalhe)}` : '')) +
              `</div>`}
            nodeCanvasObject={(n, ctx, escala) => {
              const hover = hoverRef.current === n.id;
              // nó
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, n.r, 0, 2 * Math.PI);
              ctx.fillStyle = corNo(n);
              ctx.globalAlpha = n.nivel === 2 && !hover ? 0.9 : 1;
              ctx.fill();
              ctx.globalAlpha = 1;
              ctx.lineWidth = n.tipo === 'ambos' ? 2.5 : 1.2;
              ctx.strokeStyle = n.tipo === 'ambos' ? VERMELHO : n.nivel === 2 ? TINTA_SUAVE : PAPEL;
              ctx.stroke();
              // rótulo: nível 2 só com zoom aproximado (ou hover) — anti-poluição
              if (n.nivel === 2 && escala < 1.4 && !hover) return;
              // fonte dividida pela escala = tamanho CONSTANTE na tela em
              // qualquer zoom (como rótulo de mapa) — sem nomes gigantes
              const fonte = (n.nivel === 0 ? 14 : n.nivel === 1 ? 12 : 10) / escala;
              ctx.font = `${n.nivel === 0 ? '600 ' : ''}${fonte}px Inter, system-ui, sans-serif`;
              const nome = n.nome.length > 28 ? `${n.nome.slice(0, 27)}…` : n.nome;
              const x = (n.x ?? 0) + n.r + 4 / escala;
              const y = (n.y ?? 0) + fonte / 3;
              // halo: legível mesmo cruzando linhas e outros rótulos
              ctx.strokeStyle = PAPEL;
              ctx.lineWidth = 3.5 / escala;
              ctx.textAlign = 'left';
              if (n.nivel === 0) {
                ctx.textAlign = 'center';
                const yCentro = (n.y ?? 0) + n.r + fonte + 4 / escala;
                ctx.strokeText(nome, n.x ?? 0, yCentro);
                ctx.fillStyle = TINTA;
                ctx.fillText(nome, n.x ?? 0, yCentro);
                return;
              }
              ctx.strokeText(nome, x, y);
              ctx.fillStyle = n.nivel === 2 ? TINTA_SUAVE : hover ? TINTA : '#3d3a33';
              ctx.fillText(nome, x, y);
            }}
            nodePointerAreaPaint={(n, cor, ctx) => {
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, n.r + 4, 0, 2 * Math.PI);
              ctx.fillStyle = cor;
              ctx.fill();
            }}
            linkColor={(l) =>
              l.nivel2 ? 'rgba(110,106,96,0.35)'
                : l.tipo === 'doacao' ? 'rgba(180,83,9,0.45)' : 'rgba(38,78,155,0.4)'}
            linkWidth={(l) => l.w}
            onNodeHover={(n) => {
              const anterior = hoverRef.current;
              hoverRef.current = n?.id != null ? String(n.id) : null;
              if (contRef.current) {
                contRef.current.style.cursor = n && n.nivel !== 0 ? 'pointer' : 'default';
              }
              // ondulação: um sopro nos vizinhos do nó sob o mouse — eles se
              // afastam de leve e as forças os trazem de volta (a rede respira)
              if (n && String(n.id) !== anterior) {
                for (const m of dados.nodes as No[]) {
                  if (m.nivel === 0 || m.id === n.id) continue;
                  const dx = (m.x ?? 0) - (n.x ?? 0);
                  const dy = (m.y ?? 0) - (n.y ?? 0);
                  const d = Math.hypot(dx, dy) || 1;
                  if (d < 130) {
                    const forca = 5 * (1 - d / 130);
                    m.vx = (m.vx ?? 0) + (dx / d) * forca;
                    m.vy = (m.vy ?? 0) + (dy / d) * forca;
                  }
                }
                fgRef.current?.d3ReheatSimulation();
              }
            }}
            onNodeDragEnd={(n) => {
              // solta o nó ao largar (a lib o deixaria pregado): a rede se
              // reacomoda em volta em vez de ficar rígida
              if (n.nivel !== 0) {
                n.fx = undefined;
                n.fy = undefined;
              }
            }}
            onNodeClick={(n) => {
              if (n.nivel === 1) {
                const original = nos.find((x) => x.id === n.id);
                if (original) aoClicar?.(original);
              } else if (n.nivel === 2) {
                const original = secundarios.find((x) => x.id === n.id);
                if (original) aoClicarSecundario?.(original);
              }
            }}
          />
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Arraste os nós para reorganizar · role para dar zoom (aproxime para ver os rótulos menores)
        {totalN1 > 20 && ` · mostrando as 20 maiores conexões diretas de ${totalN1}`}
      </p>
    </div>
  );
}
