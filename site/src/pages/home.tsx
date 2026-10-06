import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bot, Cable, Landmark, Search, Vote, Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum } from '@/components/app/tabela';
import { Sparkline } from '@/components/app/graficos';
import { FotoCandidato } from '@/components/app/foto';
import {
  carregarResumo, type Resumo, type CandidatoForaDaCurva, type CustoCandidato, type CustoPartido,
} from '@/lib/resumo';
import { brl, brlCentavos, custoVoto, num, dataBR, nomeCandidato } from '@/lib/format';
import { metrica } from '@/lib/metricas';

function BuscaHero({ comVotos }: { comVotos: boolean }) {
  const navigate = useNavigate();
  const [busca, setBusca] = useState('');
  return (
    <form
      className="mt-6 flex max-w-xl items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(busca.trim() ? `/explorar?candidato=${encodeURIComponent(busca.trim())}` : '/explorar');
      }}
    >
      <input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder={comVotos
          ? 'Quanto custou o voto do seu candidato? Busque pelo nome ou número…'
          : 'Busque um candidato pelo nome ou número…'}
        aria-label="Buscar candidato"
        className="h-11 w-full rounded-lg border bg-card px-4 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <button
        type="submit"
        className="group inline-flex h-11 shrink-0 items-center gap-2 rounded-lg bg-gradient-to-r from-[#10244A] to-[#264E9B] px-5 text-sm font-semibold text-white shadow-lg shadow-[#10244A]/20 transition-all hover:shadow-xl hover:shadow-[#10244A]/30"
      >
        <Search className="h-4 w-4" /> Buscar
      </button>
    </form>
  );
}

/* As portas de entrada ficam só nas duas perguntas sobre candidato e custo; os
   atalhos de IA/MCP viraram uma linha discreta no fim da página. */
const PERGUNTAS: { icone: LucideIcon; pergunta: string; detalhe: string; href: string }[] = [
  {
    icone: Wallet,
    pergunta: 'Quanto o seu candidato gastou — e por voto?',
    detalhe: 'Busque pelo nome ou número e abra a ficha completa: gastos, fornecedores, votos e custo por voto.',
    href: '/explorar',
  },
  {
    icone: Landmark,
    pergunta: 'Quanto custa eleger um deputado no seu estado?',
    detalhe: 'Filtre o custo por voto por UF, cargo e partido; veja quem mais gastou sem se eleger.',
    href: '/explorar?visao=custo-por-voto',
  },
];

function PerguntasSection() {
  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">
        O que dá para descobrir
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {PERGUNTAS.map((p) => (
          <Link
            key={p.pergunta}
            to={p.href}
            className="group flex h-full items-start gap-3 rounded-xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#264E9B]/40 hover:shadow-md"
          >
            <p.icone className="h-5 w-5 shrink-0 text-[#264E9B]" />
            <span>
              <span className="block font-semibold leading-snug">{p.pergunta}</span>
              <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{p.detalhe}</span>
            </span>
            <ArrowRight className="ml-auto h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>
    </section>
  );
}

function Cartao({ rotulo, valor, indice, serie, detalhe }: {
  rotulo: string;
  valor: string;
  indice: number;
  /** série diária nacional — vira um sparkline discreto sob o número */
  serie?: number[];
  /** linha curta sob o número, quando não há série */
  detalhe?: string;
}) {
  return (
    <div className="animar-entrada" style={{ animationDelay: `${indice * 0.06}s` }}>
      {/* h-full iguala a altura na linha; o rótulo fica ancorado no topo (como
          nos vizinhos) e o miolo — valor e sparkline — se centra no que sobra,
          senão o cartão sem sparkline fica com o número colado no rótulo */}
      <Card className="h-full">
        <CardContent className="flex h-full flex-col p-5 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {rotulo}
          </p>
          <div className="flex flex-1 flex-col justify-center">
            <p className="text-2xl font-bold tracking-tight text-[#10244A]">
              {valor}
            </p>
            {serie && serie.length >= 2 && (
              <div className="mt-2" title="evolução por dia de extração">
                <Sparkline valores={serie} />
              </div>
            )}
            {detalhe && <p className="mt-1 text-xs text-muted-foreground">{detalhe}</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Secao({
  eyebrow,
  titulo,
  descricao,
  id,
  verTudo,
  children,
}: {
  eyebrow: string;
  titulo: string;
  descricao: string;
  id?: string;
  /** rota do Explorar com a visão/filtro desta seção já aplicados */
  verTudo?: { href: string; rotulo: string };
  children: React.ReactNode;
}) {
  return (
    <section className="mt-16 scroll-mt-20" id={id}>
      <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{titulo}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{descricao}</p>
      <div className="mt-6">{children}</div>
      {verTudo && (
        <Link
          to={verTudo.href}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-[#10244A] to-[#264E9B] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[#10244A]/15 transition-all hover:shadow-lg hover:shadow-[#10244A]/25"
        >
          {verTudo.rotulo} <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------- *
 * Custo por voto: abas por cargo sobre listas que o resumo.json já traz com os
 * primeiros de CADA cargo — filtrar aqui não custa consulta nenhuma.
 * ------------------------------------------------------------------------- */

const ABAS_CARGO = ['Todos', 'Governador', 'Senador', 'Deputado Federal', 'Deputado Estadual'] as const;
type AbaCargo = (typeof ABAS_CARGO)[number];
const POR_LISTA = 6;

/** As quatro listas de candidatos, com o rótulo e a ordenação do Explorar. */
const LISTAS: { chave: keyof NonNullable<Resumo['custo_por_voto']>; titulo: string; ordem: string; porGasto?: boolean }[] = [
  { chave: 'eleitos_mais_caros', titulo: 'Eleitos com o voto mais caro', ordem: 'eleitos-mais-caros' },
  { chave: 'gastaram_sem_eleger', titulo: 'Mais gastaram sem se eleger', ordem: 'gastou-sem-eleger', porGasto: true },
  { chave: 'maiores_gastos', titulo: 'Quem mais contratou', ordem: 'mais-caro', porGasto: true },
];

function porAba(lista: CustoCandidato[], aba: AbaCargo): CustoCandidato[] {
  return (aba === 'Todos' ? lista : lista.filter((c) => c.DS_CARGO === aba)).slice(0, POR_LISTA);
}

function ListaCusto({ titulo, itens, porGasto, href }: {
  titulo: string;
  itens: CustoCandidato[];
  /** a barra acompanha a coluna que ordena a lista: custo ou gasto bruto */
  porGasto?: boolean;
  href: string;
}) {
  const valorBarra = (c: CustoCandidato) => (porGasto ? c.contratado : c.custo_por_voto);
  const max = Math.max(...itens.map((c) => valorBarra(c) ?? 0), 0);
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{titulo}</p>
        <Link to={href} className="text-xs font-semibold text-[#264E9B] underline-offset-4 hover:underline">
          ver todos →
        </Link>
      </div>
      {itens.length === 0 ? (
        <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground shadow-sm">
          Nenhum candidato neste cargo ainda.
        </p>
      ) : (
        <Tabela
          colunas={[
            { titulo: 'Candidato' },
            { titulo: 'Votos', numerica: true },
            { titulo: 'Contratado', numerica: true },
            { titulo: 'Custo por voto', numerica: true },
          ]}
        >
          {itens.map((c) => (
            <tr key={c.SQ_CANDIDATO}>
              <td className="min-w-[12rem]">
                <Link to={`/candidato/${c.SQ_CANDIDATO}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                  {nomeCandidato(c.NM_URNA_CANDIDATO, c.NM_CANDIDATO).principal}
                </Link>
                <span className="text-muted-foreground">
                  {' '}·{' '}
                  <Link to={`/partido/${encodeURIComponent(c.SG_PARTIDO)}`} className="hover:underline">
                    {c.SG_PARTIDO}
                  </Link>
                  /{c.SG_UF} · {c.DS_CARGO.replace('Deputado ', 'Dep. ')}
                  {!c.resultado.startsWith('ELEITO') && <> · {c.resultado.toLowerCase()}</>}
                </span>
              </td>
              <CelulaNum>{num.format(c.votos)}</CelulaNum>
              <CelulaNum frac={porGasto && max > 0 ? c.contratado / max : undefined}>{brl.format(c.contratado)}</CelulaNum>
              <CelulaNum frac={!porGasto && max > 0 ? c.custo_por_voto / max : undefined}>{custoVoto(c.custo_por_voto)}</CelulaNum>
            </tr>
          ))}
        </Tabela>
      )}
    </div>
  );
}

/** As três fatias do custo por voto, nas cores da composição da receita. */
const FATIAS_CUSTO = [
  { chave: 'custo_publico_por_voto', rotulo: 'Dinheiro público', cor: '#264E9B' },
  { chave: 'custo_proprio_por_voto', rotulo: 'Bolso dos candidatos', cor: '#B45309' },
  { chave: 'custo_terceiros_por_voto', rotulo: 'Doações de terceiros', cor: '#6e6a60' },
] as const;

/** Barras empilhadas, um partido por linha: o comprimento é o custo agregado por
 *  voto e as fatias repartem esse custo entre dinheiro público, bolso dos
 *  candidatos e terceiros. As fatias vêm só de quem declarou receita, então
 *  são normalizadas para somar o custo da barra. */
function GraficoPartidos({ partidos }: { partidos: CustoPartido[] }) {
  const max = Math.max(...partidos.map((p) => p.custo_por_voto), 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {FATIAS_CUSTO.map((f) => (
          <span key={f.chave} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: f.cor }} /> {f.rotulo}
          </span>
        ))}
      </div>
      <div className="space-y-1.5">
        {partidos.map((p) => {
          const fatias = FATIAS_CUSTO.map((f) => ({ ...f, valor: p[f.chave] ?? 0 }));
          const soma = fatias.reduce((s, f) => s + f.valor, 0);
          const largura = (v: number) => (max > 0 && soma > 0 ? (100 * p.custo_por_voto * (v / soma)) / max : 0);
          return (
            <div key={p.SG_PARTIDO} className="flex items-center gap-3 text-sm">
              <Link to={`/partido/${encodeURIComponent(p.SG_PARTIDO)}`} className="w-28 shrink-0 truncate font-medium text-[#264E9B] underline-offset-4 hover:underline">
                {p.SG_PARTIDO}
              </Link>
              <div
                className="flex h-5 flex-1 overflow-hidden rounded bg-muted"
                role="img"
                aria-label={`${p.SG_PARTIDO}: ${brlCentavos.format(p.custo_por_voto)} por voto — ${fatias.map((f) => `${f.rotulo} ${brlCentavos.format(f.valor)}`).join(', ')}`}
              >
                {fatias.map((f) => (
                  <div key={f.chave} title={`${f.rotulo}: ${brlCentavos.format(f.valor)} por voto`} style={{ width: `${largura(f.valor)}%`, background: f.cor }} />
                ))}
              </div>
              <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-[#10244A]">{brlCentavos.format(p.custo_por_voto)}</span>
              <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:inline">{num.format(p.eleitos)} eleitos</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SecaoCustoPorVoto({ custo }: { custo: NonNullable<Resumo['custo_por_voto']> }) {
  const [aba, setAba] = useState<AbaCargo>('Todos');
  const filtroCargo = aba === 'Todos' ? '' : `&cargo=${encodeURIComponent(aba)}`;
  return (
    <Secao
      id="custo-por-voto"
      eyebrow="Custo por voto"
      titulo="Quanto custou cada voto"
      descricao="Gasto declarado dividido pelos votos nominais do 1º turno — a única régua que todo candidato disputou. Custo alto não é irregularidade: é o tamanho da campanha diante do resultado. Quem foi ao 2º turno tem o gasto das semanas extras no numerador; a eleição presidencial entra quando o TSE a totalizar."
      verTudo={{ href: `/explorar?visao=custo-por-voto${filtroCargo}`, rotulo: 'Explorar o custo por voto com filtros' }}
    >
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Cargo">
        {ABAS_CARGO.map((a) => (
          <button
            key={a}
            role="tab"
            aria-selected={aba === a}
            onClick={() => setAba(a)}
            className={
              aba === a
                ? 'rounded-full bg-gradient-to-r from-[#10244A] to-[#264E9B] px-4 py-1.5 text-sm font-semibold text-white shadow-sm'
                : 'rounded-full border bg-card px-4 py-1.5 text-sm text-muted-foreground shadow-sm transition-colors hover:border-[#264E9B]/40 hover:text-foreground'
            }
          >
            {a}
          </button>
        ))}
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        {LISTAS.map((l) => (
          <ListaCusto
            key={l.chave}
            titulo={l.titulo}
            itens={porAba(custo[l.chave] as CustoCandidato[], aba)}
            porGasto={l.porGasto}
            href={`/explorar?visao=custo-por-voto&ordem=${l.ordem}${filtroCargo}`}
          />
        ))}
      </div>

      {custo.partidos.length > 0 && (
        <div className="mt-8">
          <p className="mb-1 text-sm font-semibold text-foreground">Partido a partido: quanto custou o voto e quem pagou</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Custo agregado da sigla em todos os cargos (soma do contratado ÷ soma dos votos das candidaturas com
            voto; só partidos com 10+ candidaturas votadas), repartido na proporção da receita declarada. Passe o
            mouse nas fatias; clique na sigla para a ficha do partido.
          </p>
          <GraficoPartidos partidos={custo.partidos} />
        </div>
      )}
    </Secao>
  );
}

export function Home() {
  const [resumo, setResumo] = useState<Resumo | null | 'erro'>(null);

  useEffect(() => {
    carregarResumo().then((r) => setResumo(r ?? 'erro'));
  }, []);

  if (resumo === null) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <Spinner className="h-5 w-5" /> Carregando os dados mais recentes…
      </div>
    );
  }
  if (resumo === 'erro') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center px-6 text-center text-muted-foreground">
        Não foi possível carregar os dados. Tente novamente em instantes.
      </div>
    );
  }

  const t = resumo.totais;
  const nacional = resumo.custo_por_voto?.nacional ?? null;
  const custo = nacional && resumo.custo_por_voto ? resumo.custo_por_voto : null;
  const pctPublico = t.total_receitas > 0 && nacional?.custo_publico_por_voto != null && nacional.custo_por_voto > 0
    ? Math.round((100 * nacional.custo_publico_por_voto) / nacional.custo_por_voto)
    : null;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
      <section className="pt-14 pb-4">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#264E9B]/20 bg-[#264E9B]/5 px-4 py-1.5 text-sm text-[#264E9B]">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#264E9B] opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#264E9B]" />
          </span>
          Extração do TSE de {dataBR(resumo.gerado_em)}
        </div>
        {nacional ? (
          <>
            <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
              {brl.format(t.total_contratado)} declarados.{' '}
              <span className="bg-gradient-to-r from-[#10244A] to-[#264E9B] bg-clip-text text-transparent">
                Quanto custou cada voto?
              </span>
            </h1>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              <strong className="font-semibold text-foreground">{brlCentavos.format(nacional.custo_por_voto)} por voto</strong>
              {' '}no país, somando o que {num.format(nacional.candidatos)} candidatos declararam ter contratado e
              dividindo pelos {num.format(nacional.votos)} votos que receberam no 1º turno
              {pctPublico != null && <> — {pctPublico}% disso veio de dinheiro público</>}.
              O radar fotografa a prestação de contas todo dia e cruza com a urna.
            </p>
          </>
        ) : (
          <>
            <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
              A prestação de contas,{' '}
              <span className="bg-gradient-to-r from-[#10244A] to-[#264E9B] bg-clip-text text-transparent">
                dia após dia.
              </span>
            </h1>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              Quanto cada candidatura declarou, com quem gastou e quem destoa dos concorrentes.
              O TSE mostra só o estado atual das contas; o radar fotografa todo dia e guarda o
              que mudou.
            </p>
          </>
        )}
        <BuscaHero comVotos={nacional != null} />
      </section>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Cartao indice={0} rotulo="Despesas contratadas" valor={brl.format(t.total_contratado)}
                serie={(resumo.serie_nacional ?? []).map((s) => s.contratado)} />
        {nacional ? (
          <>
            <Cartao indice={1} rotulo="Custo por voto no país" valor={brlCentavos.format(nacional.custo_por_voto)}
                    detalhe={`${num.format(nacional.votos)} votos no 1º turno`} />
            <Cartao indice={2} rotulo="Dinheiro público por voto"
                    valor={nacional.custo_publico_por_voto == null ? '—' : brlCentavos.format(nacional.custo_publico_por_voto)}
                    detalhe={pctPublico == null ? undefined : `${pctPublico}% do custo de cada voto`} />
          </>
        ) : (
          <>
            <Cartao indice={1} rotulo="Receitas declaradas" valor={brl.format(t.total_receitas)}
                    serie={(resumo.serie_nacional ?? []).map((s) => s.receitas)} />
            <Cartao indice={2} rotulo="Candidaturas registradas" valor={num.format(t.candidaturas_registradas)} />
          </>
        )}
        <Cartao indice={3} rotulo="Candidatos com gastos" valor={num.format(t.candidatos_com_gastos)}
                serie={(resumo.serie_nacional ?? []).map((s) => s.candidatos)} />
      </div>

      <PerguntasSection />

      {custo && <SecaoCustoPorVoto custo={custo} />}

      {(resumo.fora_da_curva ?? []).length > 0 && (
        <Secao
          id="fora-da-curva"
          eyebrow="Fora da curva"
          titulo="Quem mais destoa do próprio grupo"
          descricao="Os 3 casos com mais métricas acima do p95 do grupo de comparação (mesmo cargo e estado — âmbito nacional quando o grupo local é pequeno). Estar fora da curva não é irregularidade: é onde os dados sugerem começar as perguntas. A lista completa está no Explorar."
          verTudo={{ href: '/explorar?visao=fora-da-curva', rotulo: 'Explorar todos os fora da curva com filtros' }}
        >
          <div className="space-y-3">
            {(resumo.fora_da_curva ?? []).slice(0, 3).map((c: CandidatoForaDaCurva) => (
              <div key={c.SQ_CANDIDATO} className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm sm:gap-4">
                <Link to={`/candidato/${c.SQ_CANDIDATO}`} tabIndex={-1} aria-hidden>
                  <FotoCandidato
                    cdEleicao={c.cd_eleicao}
                    sq={c.SQ_CANDIDATO}
                    sgUe={c.sg_ue}
                    nome={nomeCandidato(c.NM_URNA_CANDIDATO, c.NM_CANDIDATO).principal}
                    className="h-12 w-12 text-sm"
                  />
                </Link>
                <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    to={`/candidato/${c.SQ_CANDIDATO}`}
                    className="font-semibold text-[#264E9B] underline-offset-4 hover:underline"
                  >
                    {nomeCandidato(c.NM_URNA_CANDIDATO, c.NM_CANDIDATO).principal}
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    {nomeCandidato(c.NM_URNA_CANDIDATO, c.NM_CANDIDATO).civil && (
                      <>{nomeCandidato(c.NM_URNA_CANDIDATO, c.NM_CANDIDATO).civil} · </>
                    )}
                    {c.SG_PARTIDO}/{c.SG_UF} · {c.DS_CARGO} · contratou {brl.format(c.total_contratado)}
                  </span>
                  <Link
                    to={`/explorar?visao=fora-da-curva&uf=${encodeURIComponent(c.SG_UF)}&cargo=${encodeURIComponent(c.DS_CARGO)}`}
                    className="w-full text-xs font-semibold text-[#264E9B] underline-offset-4 hover:underline sm:ml-auto sm:w-auto"
                  >
                    ver o grupo ({c.DS_CARGO}/{c.SG_UF}) →
                  </Link>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {c.sinais.map((s) => {
                    const m = metrica(s.metrica);
                    return (
                      <Link
                        key={s.metrica}
                        to={`/explorar?visao=fora-da-curva&sinal=${encodeURIComponent(s.metrica)}&uf=${encodeURIComponent(c.SG_UF)}&cargo=${encodeURIComponent(c.DS_CARGO)}`}
                        title={`p95 do grupo (${s.grupo_n} candidatos${s.grupo_ambito === 'BR-TODAS' ? ', âmbito nacional' : ''}): ${m.formatar(s.p95)} — clique para ver todos fora da curva neste sinal`}
                        /* inline-block (e não inline-flex): assim o rótulo, o valor e o
                           contexto fluem como texto e quebram naturalmente no celular —
                           em três itens de flex cada um virava uma coluna espremida */
                        className="inline-block rounded-2xl border border-[#B45309]/40 bg-[#B45309]/10 px-3 py-1 text-xs font-medium leading-relaxed text-[#7c3a06] transition-colors hover:border-[#B45309] hover:bg-[#B45309]/20 sm:rounded-full"
                      >
                        <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-3px]" />
                        {m.frase(s.valor)}{' '}
                        {/* mediana E p95 nomeados: "grupo: 0" sem dizer o que é parecia dado quebrado,
                            e o p95 (o critério do corte) vivia só no tooltip, invisível no toque */}
                        <span className="text-[#7c3a06]/70">
                          · mediana do grupo: {m.formatar(s.mediana)} · corte (p95): {m.formatar(s.p95)}
                        </span>
                      </Link>
                    );
                  })}
                </div>
                </div>
              </div>
            ))}
          </div>
        </Secao>
      )}

      {!custo && (
        <Secao
          id="ranking"
          eyebrow="Ranking"
          titulo="Quem mais contratou até agora"
          descricao="Despesa contratada × receita declarada. Contratar muito acima do que declarou arrecadar merece atenção — a conta precisa fechar até a prestação final. Quando o TSE totalizar os votos, este ranking ganha a coluna de custo por voto."
          verTudo={{ href: '/explorar?visao=ranking', rotulo: 'Explorar o ranking completo com filtros' }}
        >
          <Tabela
            colunas={[
              { titulo: 'Candidato' },
              { titulo: 'Cargo' },
              { titulo: 'Contratado', numerica: true },
              { titulo: 'Receita declarada', numerica: true },
            ]}
          >
            {(() => {
              const top = (resumo.top_candidatos ?? []).slice(0, 6);
              const max = Math.max(...top.map((x) => x.contratado ?? 0), 0);
              return top.map((x, i) => (
              <tr key={i}>
                <td>
                  {x.SQ_CANDIDATO ? (
                    <Link to={`/candidato/${x.SQ_CANDIDATO}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                      {nomeCandidato(x.NM_URNA_CANDIDATO, x.NM_CANDIDATO).principal}
                    </Link>
                  ) : (
                    nomeCandidato(x.NM_URNA_CANDIDATO, x.NM_CANDIDATO).principal
                  )}
                  <span className="text-muted-foreground">
                    {' '}·{' '}
                    <Link to={`/partido/${encodeURIComponent(x.SG_PARTIDO)}`} className="hover:underline">
                      {x.SG_PARTIDO}
                    </Link>
                    /{x.SG_UF}
                  </span>
                </td>
                <td className="text-muted-foreground">{x.DS_CARGO}</td>
                <CelulaNum frac={max > 0 ? (x.contratado ?? 0) / max : undefined}>{brl.format(x.contratado ?? 0)}</CelulaNum>
                <CelulaNum>{x.receita == null ? '—' : brl.format(x.receita)}</CelulaNum>
              </tr>
              ));
            })()}
          </Tabela>
        </Secao>
      )}

      <p className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-6 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Vote className="h-4 w-4" /> Fornecedores compartilhados, declarações removidas e os demais recortes continuam no{' '}
          <Link to="/explorar" className="text-[#264E9B] underline-offset-4 hover:underline">Explorar</Link>.</span>
        <Link to="/consultar" className="inline-flex items-center gap-1.5 text-[#264E9B] underline-offset-4 hover:underline">
          <Bot className="h-4 w-4" /> Pergunte do seu jeito com a sua IA
        </Link>
        <Link to="/consultar#conecte-sua-ia" className="inline-flex items-center gap-1.5 text-[#264E9B] underline-offset-4 hover:underline">
          <Cable className="h-4 w-4" /> Conecte a sua IA direto (MCP)
        </Link>
      </p>
    </div>
  );
}
