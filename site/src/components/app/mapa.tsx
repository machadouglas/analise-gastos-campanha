import { memo, useMemo } from 'react';
import { brl } from '@/lib/format';

/* Cartograma de tiles do Brasil: cada UF é um quadrado de mesma área numa
   grade que lembra o contorno do país — melhor que o mapa geográfico para
   comparar valores (a área de um estado não distorce a leitura) e não exige
   geometria embutida. Clique aplica o filtro de UF. */

const POSICOES: Record<string, [number, number]> = {
  RR: [2, 0], AP: [4, 0],
  AM: [1, 1], PA: [3, 1], MA: [5, 1], CE: [6, 1], RN: [7, 1],
  AC: [0, 2], RO: [2, 2], TO: [4, 2], PI: [5, 2], PB: [7, 2],
  MT: [3, 3], GO: [4, 3], BA: [5, 3], PE: [6, 3], AL: [7, 3],
  MS: [3, 4], DF: [4, 4], MG: [5, 4], SE: [6, 4],
  SP: [4, 5], RJ: [5, 5], ES: [6, 5],
  PR: [4, 6],
  SC: [4, 7],
  RS: [3, 8],
};

const CELULA = 40;
const GAP = 4;

export interface ValorUF {
  uf: string;
  valor: number;
}

// memo: os inputs do Explorar re-renderizam a página a cada tecla
export const MapaBrasil = memo(function MapaBrasil({
  dados,
  selecionada = '',
  aoClicar,
  formatar = (v: number) => brl.format(v),
  rotuloValor = 'total',
}: {
  dados: ValorUF[];
  /** UFs selecionadas, separadas por vírgula ('SP,RJ') — seleção múltipla */
  selecionada?: string;
  /** recebe a UF clicada; quem decide alternar/acumular é a página */
  aoClicar?: (uf: string) => void;
  formatar?: (v: number) => string;
  rotuloValor?: string;
}) {
  const porUF = useMemo(() => new Map(dados.map((d) => [d.uf, d.valor])), [dados]);
  const ativas = useMemo(
    () => new Set(selecionada.split(',').map((s) => s.trim()).filter(Boolean)),
    [selecionada],
  );
  const max = Math.max(...dados.map((d) => d.valor), 1);

  const L = 8 * (CELULA + GAP);
  const A = 9 * (CELULA + GAP);

  return (
    <div>
      <svg viewBox={`0 0 ${L} ${A}`} className="mx-auto w-full max-w-[22rem]" role="img"
           aria-label={`Mapa do Brasil por UF (${rotuloValor})`}>
        {Object.entries(POSICOES).map(([uf, [col, row]]) => {
          const valor = porUF.get(uf) ?? 0;
          // raiz quadrada: distribuição de gasto é assimétrica e a escala linear
          // apagaria todo mundo fora dos 2–3 maiores
          const intensidade = valor > 0 ? 0.1 + 0.85 * Math.sqrt(valor / max) : 0;
          const ativa = ativas.has(uf);
          const x = col * (CELULA + GAP);
          const y = row * (CELULA + GAP);
          return (
            <g key={uf}
               onClick={() => aoClicar?.(uf)}
               style={{ cursor: aoClicar ? 'pointer' : 'default' }}>
              <title>{`${uf}: ${valor > 0 ? formatar(valor) : `sem ${rotuloValor} no recorte`}${ativa ? ' — clique para tirar da seleção' : aoClicar ? ' — clique para adicionar à seleção' : ''}`}</title>
              <rect x={x} y={y} width={CELULA} height={CELULA} rx="6"
                    fill={valor > 0 ? '#264E9B' : '#efe9dc'}
                    fillOpacity={valor > 0 ? intensidade : 1}
                    stroke={ativa ? '#B45309' : '#e6dfd2'}
                    strokeWidth={ativa ? 2.5 : 1} />
              <text x={x + CELULA / 2} y={y + CELULA / 2 + 4}
                    textAnchor="middle" fontSize="13" fontWeight="600"
                    fill={intensidade > 0.55 ? '#fffdfa' : '#10244A'}>
                {uf}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Quanto mais escuro, maior o {rotuloValor} — de {formatar(0)} ao máximo de {formatar(max)}
        {aoClicar ? '. Clique nas UFs para filtrar (vários estados se combinam; clique de novo para tirar).' : '.'}
      </p>
    </div>
  );
});
