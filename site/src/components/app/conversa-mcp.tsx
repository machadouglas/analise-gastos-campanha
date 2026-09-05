import { Bot, Check, User, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Resumo, SinalForaDaCurva } from '@/lib/resumo';
import { brl, dataBR, num } from '@/lib/format';
import { metrica } from '@/lib/metricas';

/** Conversa simulada com uma IA conectada ao servidor MCP: a pergunta em
 *  português, as ferramentas que a IA chama (com o JSON que volta) e a
 *  resposta montada em cima dos dados. Os números são os do resumo.json do
 *  dia — a mesma fonte da Home —, então o quadro é sempre real; sem resumo
 *  (rede fora, teste), entra um exemplo com nomes fictícios e é dito que é. */

export interface CandidatoCena {
  sq: string;
  nome: string;
  partido: string;
  uf: string;
  cargo: string;
  sinal: SinalForaDaCurva;
}

export interface Cena {
  ilustrativo: boolean;
  data: string;
  candidatos_com_gastos: number;
  total_contratado: number;
  total_receitas: number;
  removidas: { qtd: number; valor: number } | null;
  candidatos: CandidatoCena[];
}

const PERGUNTA = 'Como está a prestação de contas hoje? Tem alguém gastando muito acima dos concorrentes?';
const PERGUNTA_SEGUINTE = 'Abra a ficha do primeiro e me diga quem são os maiores fornecedores.';

/** Nomes obviamente fictícios: o quadro nunca pode parecer acusar alguém real
 *  quando o dado do dia não carregou. */
const CENA_ILUSTRATIVA: Cena = {
  ilustrativo: true,
  data: '2026-08-31',
  candidatos_com_gastos: 3000,
  total_contratado: 200_000_000,
  total_receitas: 2_500_000_000,
  removidas: { qtd: 290, valor: 1_980_000 },
  candidatos: [
    {
      sq: '900000000001',
      nome: 'ANA EXEMPLO DA SILVA',
      partido: 'PXX',
      uf: 'XX',
      cargo: 'Deputado Federal',
      sinal: { metrica: 'razao_gasto_receita', valor: 1.26, mediana: 0.3, p95: 0.51, grupo_n: 279, grupo_ambito: 'XX' },
    },
    {
      sq: '900000000002',
      nome: 'BRUNO EXEMPLO PEREIRA',
      partido: 'PYY',
      uf: 'YY',
      cargo: 'Deputado Estadual',
      sinal: { metrica: 'pct_sem_nota', valor: 69.8, mediana: 0, p95: 12.5, grupo_n: 61, grupo_ambito: 'YY' },
    },
    {
      sq: '900000000003',
      nome: 'CARLA EXEMPLO SOUZA',
      partido: 'PZZ',
      uf: 'ZZ',
      cargo: 'Governador',
      sinal: { metrica: 'pct_maior_fornecedor', valor: 91.2, mediana: 38, p95: 80.4, grupo_n: 24, grupo_ambito: 'ZZ' },
    },
  ],
};

export function montarCena(resumo: Resumo | null): Cena {
  const fora = (resumo?.fora_da_curva ?? []).filter((c) => c.sinais.length > 0).slice(0, 3);
  if (!resumo || !fora.length) return CENA_ILUSTRATIVA;
  return {
    ilustrativo: false,
    data: resumo.gerado_em,
    candidatos_com_gastos: resumo.totais.candidatos_com_gastos,
    total_contratado: resumo.totais.total_contratado,
    total_receitas: resumo.totais.total_receitas,
    removidas: resumo.mudancas
      ? { qtd: resumo.mudancas.despesas_removidas_qtd, valor: resumo.mudancas.despesas_removidas_valor }
      : null,
    candidatos: fora.map((c) => ({
      sq: c.SQ_CANDIDATO,
      nome: c.NM_CANDIDATO,
      partido: c.SG_PARTIDO,
      uf: c.SG_UF,
      cargo: c.DS_CARGO,
      sinal: c.sinais[0],
    })),
  };
}

/** O que a ferramenta devolve, no formato do servidor (src/mcp/servidor.py),
 *  reduzido ao que a resposta usa — o visitante vê que o JSON existe e como é. */
function resultadoVisaoGeral(cena: Cena) {
  return {
    versao_dado: cena.data,
    totais: {
      candidatos_com_gastos: cena.candidatos_com_gastos,
      total_contratado: cena.total_contratado,
      total_receitas: cena.total_receitas,
    },
    mudancas_desde_a_ultima_extracao: cena.removidas
      ? { despesas_removidas_qtd: cena.removidas.qtd, despesas_removidas_valor: cena.removidas.valor }
      : null,
  };
}

function resultadoForaDaCurva(cena: Cena) {
  return {
    versao_dado: cena.data,
    n: cena.candidatos.length,
    candidatos: cena.candidatos.map((c) => ({
      sq_candidato: c.sq,
      nome: c.nome,
      partido: c.partido,
      uf: c.uf,
      cargo: c.cargo,
      sinais: [
        { metrica: c.sinal.metrica, valor: c.sinal.valor, p95: c.sinal.p95, grupo_n: c.sinal.grupo_n },
      ],
    })),
    regua: 'sinal = métrica > p95 do grupo cargo×UF',
  };
}

function Chamada({
  nome,
  args,
  resultado,
  pendente,
}: {
  nome: string;
  args: string;
  resultado?: unknown;
  pendente?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-background/80 font-mono text-xs" data-testid="chamada-mcp">
      <div className="flex items-center gap-2 px-3 py-2">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-[#264E9B]" />
        <span className="truncate">
          <span className="font-semibold text-foreground">{nome}</span>
          <span className="text-muted-foreground">({args})</span>
        </span>
        {pendente ? (
          <span className="ml-auto text-muted-foreground">…</span>
        ) : (
          <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="respondida" />
        )}
      </div>
      {resultado !== undefined && (
        <details className="border-t">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-muted-foreground hover:text-foreground">
            ver o que voltou
          </summary>
          <pre className="max-h-56 overflow-auto border-t bg-muted/40 p-3 leading-relaxed">
            {JSON.stringify(resultado, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function Balao({ de, children }: { de: 'visitante' | 'ia'; children: React.ReactNode }) {
  const ia = de === 'ia';
  return (
    <div className={`flex items-start gap-2.5 ${ia ? '' : 'flex-row-reverse'}`}>
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          ia ? 'bg-gradient-to-br from-[#10244A] to-[#264E9B] text-white' : 'border bg-background text-muted-foreground'
        }`}
        aria-hidden
      >
        {ia ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
      </span>
      <div
        // min-w-0: sem ele o balão não encolhe abaixo da tabela/JSON e o
        // celular corta o texto no lado direito
        className={`min-w-0 max-w-[92%] space-y-2.5 rounded-2xl px-4 py-3 text-sm leading-relaxed sm:max-w-[85%] ${
          ia ? 'rounded-tl-sm border bg-muted/40' : 'rounded-tr-sm bg-[#264E9B] text-white'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function ConversaMCP({ resumo }: { resumo: Resumo | null }) {
  const cena = montarCena(resumo);
  const primeiro = cena.candidatos[0];
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="conversa-mcp">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5 text-xs">
        <Bot className="h-4 w-4 text-[#264E9B]" />
        <span className="font-semibold">Claude</span>
        <span className="text-muted-foreground">· conector Radar dos Gastos</span>
        {cena.ilustrativo ? (
          <span className="ml-auto rounded-full border px-2 py-0.5 text-muted-foreground">
            exemplo ilustrativo (nomes fictícios)
          </span>
        ) : (
          <span className="ml-auto rounded-full border px-2 py-0.5 text-muted-foreground">
            dados reais de {dataBR(cena.data)}
          </span>
        )}
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <Balao de="visitante">{PERGUNTA}</Balao>

        <Balao de="ia">
          <p>Vou olhar o panorama do dia e depois quem está fora da curva do próprio grupo.</p>
          <Chamada nome="visao_geral" args="" resultado={resultadoVisaoGeral(cena)} />
          <Chamada nome="fora_da_curva" args="limite: 3" resultado={resultadoForaDaCurva(cena)} />
          <p>
            Dados de <strong>{dataBR(cena.data)}</strong> (extração diária do TSE).{' '}
            <strong>{num.format(cena.candidatos_com_gastos)}</strong> candidatos já declararam gastos:{' '}
            <strong>{brl.format(cena.total_contratado)}</strong> contratados contra{' '}
            <strong>{brl.format(cena.total_receitas)}</strong> arrecadados.
            {cena.removidas && cena.removidas.qtd > 0 && (
              <>
                {' '}Desde a última extração, {num.format(cena.removidas.qtd)} despesas sumiram da
                prestação ({brl.format(cena.removidas.valor)}) sem voltar de outra forma.
              </>
            )}
          </p>
          <p>Fora da curva do próprio grupo (mesmo cargo e UF), os destaques:</p>
          <div className="overflow-x-auto rounded-lg border bg-background/70">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2">Candidato</th>
                  <th className="px-3 py-2">Cargo</th>
                  <th className="px-3 py-2">Sinal</th>
                </tr>
              </thead>
              <tbody className="[&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">
                {cena.candidatos.map((c) => {
                  const m = metrica(c.sinal.metrica);
                  return (
                    <tr key={c.sq}>
                      <td>
                        {cena.ilustrativo ? (
                          <span className="font-medium">{c.nome}</span>
                        ) : (
                          <Link to={`/candidato/${c.sq}`} className="font-medium text-[#264E9B] hover:underline">
                            {c.nome}
                          </Link>
                        )}
                        <span className="block text-muted-foreground">
                          {c.partido} · {c.uf}
                        </span>
                      </td>
                      <td className="whitespace-nowrap">{c.cargo}</td>
                      <td>
                        {m.frase(c.sinal.valor)}
                        <span className="block text-muted-foreground">
                          p95 do grupo: {m.formatar(c.sinal.p95)} ({num.format(c.sinal.grupo_n)} candidatos)
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Dados declaratórios e prestação em aberto: são indícios a conferir, não prova. Quer que eu
            abra a ficha de {primeiro.nome}?
          </p>
        </Balao>

        <Balao de="visitante">{PERGUNTA_SEGUINTE}</Balao>

        <Balao de="ia">
          <Chamada nome="ficha_candidato" args={`sq_candidato: "${primeiro.sq}"`} pendente />
          <p className="text-xs text-muted-foreground">
            …e a conversa segue: a ficha traz fornecedores, doadores, declarações removidas e
            corrigidas; depois é só pedir a ficha de um fornecedor, um partido ou uma consulta SQL.
          </p>
        </Balao>
      </div>
    </div>
  );
}
