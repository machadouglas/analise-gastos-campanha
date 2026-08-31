import { useMemo, useState } from 'react';
import { brl } from '@/lib/format';

/* Sankey de duas etapas: origens da receita → candidato → categorias de gasto.
   Mesma linguagem dos demais gráficos (SVG próprio, navy para dinheiro que
   entra, âmbar para o que sai). Lados podem somar totais diferentes — a
   "tesoura" (gastar mais do que arrecadou) fica visível no próprio nó central. */

export interface NoFluxo {
  rotulo: string;
  valor: number;
}

const NAVY = '#264E9B';
const AMBAR = '#B45309';
const TINTA = '#6e6a60';

interface Faixa {
  rotulo: string;
  valor: number;
  top: number;
  altura: number;
}

function empilhar(nos: NoFluxo[], escala: number, topo: number, gap: number): Faixa[] {
  let y = topo;
  return nos.map((n) => {
    const altura = Math.max(n.valor * escala, 3);
    const faixa = { rotulo: n.rotulo, valor: n.valor, top: y, altura };
    y += altura + gap;
    return faixa;
  });
}

function truncar(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Distribui os rótulos (2 linhas cada) sem sobreposição: parte do centro de
 *  cada nó, empurra para baixo quem colidir e, se estourar embaixo, recua de
 *  volta — nós pequenos consecutivos ganham linha-guia até o rótulo. */
function layoutRotulos(centros: number[], min: number, max: number, esp = 30): number[] {
  const y = centros.map((c) => Math.min(Math.max(c, min), max));
  for (let i = 1; i < y.length; i++) y[i] = Math.max(y[i], y[i - 1] + esp);
  if (y.length && y[y.length - 1] > max) {
    y[y.length - 1] = max;
    for (let i = y.length - 2; i >= 0; i--) y[i] = Math.min(y[i], y[i + 1] - esp);
  }
  return y;
}

export function FluxoDinheiro({
  entradas,
  saidas,
  centro,
  formatar = (v: number) => brl.format(v),
}: {
  entradas: NoFluxo[];
  saidas: NoFluxo[];
  centro: string;
  formatar?: (v: number) => string;
}) {
  const [ativo, setAtivo] = useState<string | null>(null);

  const { faixasIn, faixasOut, fluxosIn, fluxosOut, centroBox, A, totalIn, totalOut } = useMemo(() => {
    const totalIn = entradas.reduce((s, n) => s + n.valor, 0);
    const totalOut = saidas.reduce((s, n) => s + n.valor, 0);
    const GAP = 8;
    const TOPO = 18;
    const maiorLado = Math.max(entradas.length, saidas.length);
    const A = Math.max(240, maiorLado * 40 + TOPO * 2);
    const alturaUtil = A - TOPO * 2 - GAP * Math.max(maiorLado - 1, 0);
    const escala = alturaUtil / Math.max(totalIn, totalOut, 1);

    const faixasIn = empilhar(entradas, escala, TOPO, GAP);
    const faixasOut = empilhar(saidas, escala, TOPO, GAP);
    const alturaCentro = Math.max(Math.max(totalIn, totalOut) * escala, 6);
    const centroBox = { top: (A - alturaCentro) / 2, altura: alturaCentro };

    // ligações: cada lado se acomoda em sequência na borda do nó central
    let yIn = centroBox.top + (alturaCentro - totalIn * escala) / 2;
    const fluxosIn = faixasIn.map((f) => {
      const h = f.valor * escala;
      const fluxo = { ...f, cTop: yIn, cAltura: Math.max(h, 2) };
      yIn += h;
      return fluxo;
    });
    let yOut = centroBox.top + (alturaCentro - totalOut * escala) / 2;
    const fluxosOut = faixasOut.map((f) => {
      const h = f.valor * escala;
      const fluxo = { ...f, cTop: yOut, cAltura: Math.max(h, 2) };
      yOut += h;
      return fluxo;
    });
    return { faixasIn, faixasOut, fluxosIn, fluxosOut, centroBox, A, totalIn, totalOut };
  }, [entradas, saidas]);

  if (!entradas.length && !saidas.length) {
    return <p className="text-sm text-muted-foreground">Sem movimentação declarada para desenhar o fluxo.</p>;
  }

  // rótulos com espaçamento garantido (nós pequenos empilhados sobrepunham texto)
  const rotuloYIn = layoutRotulos(faixasIn.map((f) => f.top + f.altura / 2), 18, A - 18);
  const rotuloYOut = layoutRotulos(faixasOut.map((f) => f.top + f.altura / 2), 18, A - 18);

  const L = 760;
  const X = { rotuloIn: 218, barraIn: 224, centro: 372, larguraCentro: 16, barraOut: 520, rotuloOut: 538 };
  const LARGURA_BARRA = 10;

  const ribbon = (x1: number, t1: number, h1: number, x2: number, t2: number, h2: number) => {
    const m = (x1 + x2) / 2;
    return `M${x1},${t1} C${m},${t1} ${m},${t2} ${x2},${t2} L${x2},${t2 + h2} C${m},${t2 + h2} ${m},${t1 + h1} ${x1},${t1 + h1} Z`;
  };

  return (
    <div>
      {/* o diagrama é largo por natureza (rótulos nos dois lados): comprimi-lo
          na largura de um celular deixaria o texto de 11px em ~5px. Abaixo de
          ~700px ele mantém a largura legível e rola na horizontal. */}
      <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${L} ${A}`} className="w-full min-w-[42rem]" role="img"
           aria-label={`Fluxo do dinheiro: ${entradas.length} origens de receita e ${saidas.length} categorias de gasto`}
           onMouseLeave={() => setAtivo(null)}>
        {/* ligações origem → candidato */}
        {fluxosIn.map((f) => (
          <path key={`i${f.rotulo}`}
                d={ribbon(X.barraIn + LARGURA_BARRA, f.top, f.altura, X.centro, f.cTop, f.cAltura)}
                fill={NAVY}
                opacity={ativo === null ? 0.22 : ativo === `i${f.rotulo}` ? 0.5 : 0.08}
                onMouseEnter={() => setAtivo(`i${f.rotulo}`)}>
            <title>{`${f.rotulo} → ${centro}: ${formatar(f.valor)}`}</title>
          </path>
        ))}
        {/* ligações candidato → categoria */}
        {fluxosOut.map((f) => (
          <path key={`o${f.rotulo}`}
                d={ribbon(X.centro + X.larguraCentro, f.cTop, f.cAltura, X.barraOut, f.top, f.altura)}
                fill={AMBAR}
                opacity={ativo === null ? 0.22 : ativo === `o${f.rotulo}` ? 0.5 : 0.08}
                onMouseEnter={() => setAtivo(`o${f.rotulo}`)}>
            <title>{`${centro} → ${f.rotulo}: ${formatar(f.valor)}`}</title>
          </path>
        ))}
        {/* nós de origem */}
        {faixasIn.map((f, i) => {
          const yR = rotuloYIn[i];
          const deslocado = Math.abs(yR - (f.top + f.altura / 2)) > 6;
          return (
            <g key={f.rotulo} onMouseEnter={() => setAtivo(`i${f.rotulo}`)}>
              <title>{`${f.rotulo}: ${formatar(f.valor)}`}</title>
              <rect x={X.barraIn} y={f.top} width={LARGURA_BARRA} height={f.altura} rx="2" fill={NAVY} />
              {deslocado && (
                <line x1={X.rotuloIn + 3} y1={yR} x2={X.barraIn - 2} y2={f.top + f.altura / 2}
                      stroke="#d8d2c4" strokeWidth="1" />
              )}
              <text x={X.rotuloIn} y={yR - 2} textAnchor="end" fontSize="11" fill="#1c1a17">
                {truncar(f.rotulo, 34)}
              </text>
              <text x={X.rotuloIn} y={yR + 11} textAnchor="end" fontSize="10" fill={TINTA}>
                {formatar(f.valor)}
              </text>
            </g>
          );
        })}
        {/* nós de categoria */}
        {faixasOut.map((f, i) => {
          const yR = rotuloYOut[i];
          const deslocado = Math.abs(yR - (f.top + f.altura / 2)) > 6;
          return (
            <g key={f.rotulo} onMouseEnter={() => setAtivo(`o${f.rotulo}`)}>
              <title>{`${f.rotulo}: ${formatar(f.valor)}`}</title>
              <rect x={X.barraOut} y={f.top} width={LARGURA_BARRA} height={f.altura} rx="2" fill={AMBAR} />
              {deslocado && (
                <line x1={X.barraOut + LARGURA_BARRA + 2} y1={f.top + f.altura / 2} x2={X.rotuloOut - 3} y2={yR}
                      stroke="#d8d2c4" strokeWidth="1" />
              )}
              <text x={X.rotuloOut} y={yR - 2} fontSize="11" fill="#1c1a17">
                {truncar(f.rotulo, 34)}
              </text>
              <text x={X.rotuloOut} y={yR + 11} fontSize="10" fill={TINTA}>
                {formatar(f.valor)}
              </text>
            </g>
          );
        })}
        {/* nó central */}
        <rect x={X.centro} y={centroBox.top} width={X.larguraCentro} height={centroBox.altura}
              rx="3" fill="#10244A" />
        <text x={X.centro + X.larguraCentro / 2} y={Math.max(centroBox.top - 6, 10)}
              textAnchor="middle" fontSize="10" fill={TINTA}>
          {truncar(centro, 26)}
        </text>
      </svg>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Arrecadado <span className="font-semibold tabular-nums text-foreground">{formatar(totalIn)}</span>
        {' '}· contratado <span className="font-semibold tabular-nums text-foreground">{formatar(totalOut)}</span>
        {totalOut > totalIn && totalIn >= 0 && (
          <> — contratou {formatar(totalOut - totalIn)} além do que declarou arrecadar</>
        )}
      </p>
    </div>
  );
}
