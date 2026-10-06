import { Vote } from 'lucide-react';
import { Secao } from '@/components/app/secao';
import { FaixasDePreco, type FaixaPreco } from '@/components/app/graficos';
import { brl, brlCentavos, num } from '@/lib/format';

/** Votos e custo por voto de um candidato, como o backend publica em
 *  `indicadores` (src/agregados.py). O denominador é sempre o 1º turno. */
export interface VotosCandidato {
  votos: number;
  votos2t: number | null;
  resultado: string | null;
  /** null quando não houve voto (não há por quem dividir) */
  custoPorVoto: number | null;
  custoPublicoPorVoto: number | null;
  custoProprioPorVoto: number | null;
  custoTerceirosPorVoto: number | null;
}

function ChipResultado({ resultado }: { resultado: string }) {
  const eleito = resultado.startsWith('ELEITO');
  const segundoTurno = resultado.includes('TURNO');
  const classe = eleito
    ? 'border-[#264E9B] bg-[#264E9B] text-white'
    : segundoTurno
      ? 'border-[#B45309]/40 bg-[#B45309]/10 text-[#7c3a06]'
      : 'border-border bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${classe}`}>
      {resultado.toLowerCase()}
    </span>
  );
}

/** Seção da ficha: quanto a campanha declarou para cada voto do 1º turno, e
 *  quanto de dinheiro público e do próprio bolso entrou por voto. `faixa` põe o
 *  número na distribuição do grupo de comparação (mesmo cargo, mesma UF). */
export function SecaoCustoPorVoto({
  dados,
  contratado,
  faixa,
}: {
  dados: VotosCandidato;
  contratado: number;
  faixa: FaixaPreco | null;
}) {
  // fatias do custo, na proporção da receita (somam o número grande)
  const parcelas: [string, number | null, string][] = [
    ['Dinheiro público', dados.custoPublicoPorVoto, '#264E9B'],
    ['Bolso do candidato', dados.custoProprioPorVoto, '#B45309'],
    ['Doações de terceiros', dados.custoTerceirosPorVoto, '#6e6a60'],
  ];
  return (
    <Secao
      titulo="Custo por voto"
      descricao="Quanto a campanha declarou ter contratado para cada voto recebido no 1º turno — o único que todo candidato disputou. Custo alto ou baixo não é irregularidade: é o tamanho da campanha diante do resultado."
    >
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="text-4xl font-bold tracking-tight text-[#10244A] sm:text-5xl">
            {dados.custoPorVoto == null ? '—' : brlCentavos.format(dados.custoPorVoto)}
            <span className="ml-2 text-base font-medium text-muted-foreground">por voto</span>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {dados.votos === 0
              ? `${brl.format(contratado)} contratados e nenhum voto nominal no 1º turno`
              : `${brl.format(contratado)} contratados ÷ ${num.format(dados.votos)} votos`}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          {dados.resultado && <ChipResultado resultado={dados.resultado} />}
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Vote className="h-4 w-4" />
            {num.format(dados.votos)} votos no 1º turno
            {dados.votos2t != null && <> · {num.format(dados.votos2t)} no 2º</>}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {parcelas.map(([rotulo, valor, cor]) => (
          <div key={rotulo} className="rounded-lg border bg-background p-4" style={{ borderLeftColor: cor, borderLeftWidth: 4 }}>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{rotulo}</p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">
              {valor == null ? '—' : brlCentavos.format(valor)}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {dados.custoPublicoPorVoto == null
          ? 'Sem receita declarada não dá para saber de onde veio o dinheiro de cada voto.'
          : 'De cada real gasto por voto, quanto veio de Fundo Eleitoral + Fundo Partidário, do bolso do candidato e de doações de terceiros — na proporção da receita declarada. As três parcelas somam o custo. Dinheiro não tem carimbo: a divisão é proporcional, não nota a nota.'}
      </p>

      {faixa && (
        <div className="mt-6">
          <FaixasDePreco faixas={[faixa]} rotuloPontos="este candidato" />
        </div>
      )}
    </Secao>
  );
}
