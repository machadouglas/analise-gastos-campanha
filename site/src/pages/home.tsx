import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bot, Cable, EyeOff, Megaphone, Search, Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum, CelulaTexto } from '@/components/app/tabela';
import { Sparkline } from '@/components/app/graficos';
import { FotoCandidato } from '@/components/app/foto';
import { carregarResumo, type Resumo, type DespesaResumo, type CandidatoForaDaCurva } from '@/lib/resumo';
import { brl, num, cnpjCpf, dataBR, temFichaFornecedor, urlFornecedor } from '@/lib/format';
import { metrica } from '@/lib/metricas';

function BuscaHero() {
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
        placeholder="Busque um candidato pelo nome ou número…"
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

const PERGUNTAS: { icone: LucideIcon; pergunta: string; detalhe: string; href: string }[] = [
  {
    icone: Wallet,
    pergunta: 'Quanto o seu candidato já declarou — e com o quê?',
    detalhe: 'Busque pelo nome ou número e abra a ficha completa, com gráficos e indícios.',
    href: '/explorar',
  },
  {
    icone: Megaphone,
    pergunta: 'Quanto se gasta com carro de som no seu estado?',
    detalhe: 'Filtre qualquer tipo de gasto por UF, cargo ou partido.',
    href: '/explorar?descricao=carro%20de%20som',
  },
  {
    icone: Bot,
    pergunta: 'Quer perguntar do seu jeito?',
    detalhe: 'Use a sua IA (ChatGPT, Claude, Gemini…) para gerar consultas e rode no console aberto.',
    href: '/consultar',
  },
  {
    icone: Cable,
    pergunta: 'Conecte a sua IA direto (MCP)',
    detalhe: 'Claude, ChatGPT, Cursor… consultam os mesmos dados sozinhos: fichas, red flags e SQL livre.',
    href: '/consultar#conecte-sua-ia',
  },
];

function PerguntasSection() {
  return (
    <section className="mt-4">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">
        O que dá para descobrir
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PERGUNTAS.map((p) => {
          const interno = p.href.startsWith('/');
          const conteudo = (
            <>
              <p.icone className="h-5 w-5 shrink-0 text-[#264E9B]" />
              <span>
                <span className="block font-semibold leading-snug">{p.pergunta}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{p.detalhe}</span>
              </span>
              <ArrowRight className="ml-auto h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </>
          );
          const classes =
            'group flex h-full items-start gap-3 rounded-xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#264E9B]/40 hover:shadow-md';
          return interno ? (
            <Link key={p.pergunta} to={p.href} className={classes}>{conteudo}</Link>
          ) : (
            <a key={p.pergunta} href={p.href} className={classes}>{conteudo}</a>
          );
        })}
      </div>
    </section>
  );
}

function Cartao({ rotulo, valor, indice, serie }: {
  rotulo: string;
  valor: string;
  indice: number;
  /** série diária nacional — vira um sparkline discreto sob o número */
  serie?: number[];
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

/** Nome do candidato linkado à ficha (quando o resumo traz o SQ) + partido linkado. */
function CelulaCandidato({ x }: { x: DespesaResumo }) {
  return (
    <td className="min-w-[13rem]">
      {x.SQ_CANDIDATO ? (
        <Link to={`/candidato/${x.SQ_CANDIDATO}`} className="text-[#264E9B] underline-offset-4 hover:underline">
          {x.NM_CANDIDATO}
        </Link>
      ) : (
        x.NM_CANDIDATO
      )}
      <span className="text-muted-foreground">
        {' '}·{' '}
        <Link to={`/partido/${encodeURIComponent(x.SG_PARTIDO)}`} className="hover:underline">
          {x.SG_PARTIDO}
        </Link>
        /{x.SG_UF}
        {x.DS_CARGO && <> · {x.DS_CARGO}</>}
      </span>
    </td>
  );
}

/** Fornecedor linkado à ficha quando há CNPJ/CPF; doador (sem ficha própria) sai plano. */
function CelulaFornecedor({ x }: { x: DespesaResumo }) {
  const nome = x.fornecedor ?? x.NM_DOADOR;
  if (temFichaFornecedor(x.NR_CPF_CNPJ_FORNECEDOR)) {
    return (
      <td className="min-w-[12rem]">
        <Link to={urlFornecedor(x.NR_CPF_CNPJ_FORNECEDOR!)} className="text-[#264E9B] underline-offset-4 hover:underline">
          {nome}
        </Link>
      </td>
    );
  }
  return <td className="min-w-[12rem]">{nome}</td>;
}

function TabelaRemovidas({ linhas, quem }: { linhas: DespesaResumo[]; quem: string }) {
  const max = Math.max(...linhas.map((x) => x.valor ?? 0), 0);
  return (
    <Tabela
      colunas={[
        { titulo: 'Candidato' },
        { titulo: quem },
        { titulo: 'Descrição' },
        { titulo: 'Valor', numerica: true },
        { titulo: 'Visível de → até' },
      ]}
    >
      {linhas.map((x, i) => (
        <tr key={i}>
          <CelulaCandidato x={x} />
          <CelulaFornecedor x={x} />
          <CelulaTexto>{x.DS_DESPESA ?? x.DS_ORIGEM_RECEITA ?? ''}</CelulaTexto>
          <CelulaNum frac={max > 0 ? (x.valor ?? 0) / max : undefined}>{brl.format(x.valor ?? 0)}</CelulaNum>
          <td className="whitespace-nowrap text-muted-foreground">
            {x.dt_primeira_extracao === x.dt_ultima_extracao
              ? `visto apenas em ${dataBR(x.dt_ultima_extracao)}`
              : `${dataBR(x.dt_primeira_extracao)} → ${dataBR(x.dt_ultima_extracao)}`}
          </td>
        </tr>
      ))}
    </Tabela>
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
  const m = resumo.mudancas;
  // a Home mostra só os maiores casos — o trabalho de busca é do Explorar
  const removidas = (resumo.despesas_removidas ?? []).slice(0, 3);
  const removidasReceitas = (resumo.receitas_removidas ?? []).slice(0, 3);
  // remoção é indício raro e contextual (a Justiça Eleitoral admite retificação):
  // a seção só ocupa espaço na Home quando há algo para mostrar — no Explorar e na
  // ficha do candidato o rastro continua sempre disponível
  const temRemocoes = removidas.length > 0 || removidasReceitas.length > 0;
  // quando um único lançamento domina o total, o número cheio assusta sem
  // informar — contexto explícito é a linha editorial do site
  const notaDominancia = (maiores: DespesaResumo[], total: number | undefined) => {
    const maior = maiores[0]?.valor ?? 0;
    if (!total || total <= 0 || maior / total < 0.5) return null;
    const pct = Math.round((100 * maior) / total);
    return (
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Um único lançamento de {brl.format(maior)} responde por {pct}% desse total — valores
        muito destoantes costumam ser erro de digitação, corrigido (ou removido) depois.
      </p>
    );
  };

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
        <BuscaHero />
      </section>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Cartao indice={0} rotulo="Receitas declaradas" valor={brl.format(t.total_receitas)}
                serie={(resumo.serie_nacional ?? []).map((s) => s.receitas)} />
        <Cartao indice={1} rotulo="Despesas contratadas" valor={brl.format(t.total_contratado)}
                serie={(resumo.serie_nacional ?? []).map((s) => s.contratado)} />
        <Cartao indice={2} rotulo="Candidatos com gastos" valor={num.format(t.candidatos_com_gastos)}
                serie={(resumo.serie_nacional ?? []).map((s) => s.candidatos)} />
        <Cartao indice={3} rotulo="Candidaturas registradas" valor={num.format(t.candidaturas_registradas)} />
      </div>

      <PerguntasSection />

      {(resumo.fora_da_curva ?? []).length > 0 && (
        <Secao
          id="fora-da-curva"
          eyebrow="Fora da curva"
          titulo="Quem mais destoa do próprio grupo"
          descricao="Os 5 casos com mais métricas acima do p95 do grupo de comparação (mesmo cargo e estado — âmbito nacional quando o grupo local é pequeno). A lista completa está no Explorar, para você refinar por UF, cargo ou partido. Estar fora da curva não é irregularidade: é onde os dados sugerem começar as perguntas."
          verTudo={{ href: '/explorar?visao=fora-da-curva', rotulo: 'Explorar todos os fora da curva com filtros' }}
        >
          <div className="space-y-3">
            {(resumo.fora_da_curva ?? []).slice(0, 5).map((c: CandidatoForaDaCurva) => (
              <div key={c.SQ_CANDIDATO} className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm sm:gap-4">
                <Link to={`/candidato/${c.SQ_CANDIDATO}`} tabIndex={-1} aria-hidden>
                  <FotoCandidato
                    cdEleicao={c.cd_eleicao}
                    sq={c.SQ_CANDIDATO}
                    sgUe={c.sg_ue}
                    nome={c.NM_CANDIDATO}
                    className="h-12 w-12 text-sm"
                  />
                </Link>
                <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link
                    to={`/candidato/${c.SQ_CANDIDATO}`}
                    className="font-semibold text-[#264E9B] underline-offset-4 hover:underline"
                  >
                    {c.NM_CANDIDATO}
                  </Link>
                  <span className="text-sm text-muted-foreground">
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

      <Secao
        eyebrow="Movimentação"
        titulo={
          resumo.primeira_extracao
            ? 'Maiores despesas declaradas até agora'
            : `Maiores despesas novas em ${dataBR(resumo.gerado_em)}`
        }
        descricao={
          resumo.primeira_extracao
            ? 'Panorama nacional da primeira fotografia da série.'
            : 'As maiores despesas que apareceram na extração mais recente. No Explorar você filtra por estado, cargo, partido ou tipo de gasto.'
        }
        verTudo={{ href: '/explorar', rotulo: 'Explorar todos os gastos com filtros' }}
      >
        <Tabela
          colunas={[
            { titulo: 'Candidato' },
            { titulo: 'Fornecedor' },
            { titulo: 'O quê' },
            { titulo: 'Valor', numerica: true },
          ]}
        >
          {(() => {
            const novas = (resumo.novas_despesas ?? []).slice(0, 6);
            const max = Math.max(...novas.map((x) => x.valor ?? 0), 0);
            return novas.map((x, i) => (
            <tr key={i}>
              <CelulaCandidato x={x} />
              <CelulaFornecedor x={x} />
              <CelulaTexto title={`${x.DS_ORIGEM_DESPESA} — ${x.DS_DESPESA}`}>
                {x.DS_ORIGEM_DESPESA}
                <span className="text-muted-foreground"> — {x.DS_DESPESA}</span>
              </CelulaTexto>
              <CelulaNum frac={max > 0 ? (x.valor ?? 0) / max : undefined}>{brl.format(x.valor ?? 0)}</CelulaNum>
            </tr>
            ));
          })()}
        </Tabela>
      </Secao>

      <Secao
        id="conexoes"
        eyebrow="Conexões"
        titulo="Fornecedores de múltiplos candidatos"
        descricao="Empresas atendendo vários candidatos podem ser fornecedores consolidados do ramo — ou indicar campanhas casadas e rateios. O contexto decide. Clique no nome para abrir a ficha do fornecedor."
        verTudo={{ href: '/explorar?visao=compartilhados', rotulo: 'Ver todos os compartilhados no Explorar' }}
      >
        <Tabela
          colunas={[
            { titulo: 'Fornecedor' },
            { titulo: 'CNPJ/CPF' },
            { titulo: 'Candidatos', numerica: true },
            { titulo: 'Partidos', numerica: true },
            { titulo: 'UFs' },
            { titulo: 'Total recebido', numerica: true },
          ]}
        >
          {(() => {
            const compartilhados = (resumo.fornecedores_compartilhados ?? []).slice(0, 6);
            const max = Math.max(...compartilhados.map((x) => x.total ?? 0), 0);
            return compartilhados.map((x) => (
            <tr key={x.cnpj}>
              <td>
                {temFichaFornecedor(x.cnpj) ? (
                  <Link to={urlFornecedor(x.cnpj)} className="text-[#264E9B] underline-offset-4 hover:underline">
                    {x.fornecedor}
                  </Link>
                ) : (
                  x.fornecedor
                )}
              </td>
              <td className="whitespace-nowrap text-muted-foreground">{cnpjCpf(x.cnpj)}</td>
              <CelulaNum>{num.format(x.candidatos)}</CelulaNum>
              <CelulaNum>{num.format(x.partidos)}</CelulaNum>
              <td className="text-muted-foreground">{x.ufs}</td>
              <CelulaNum frac={max > 0 ? (x.total ?? 0) / max : undefined}>{brl.format(x.total ?? 0)}</CelulaNum>
            </tr>
            ));
          })()}
        </Tabela>
      </Secao>

      {temRemocoes && (
        <Secao
          id="mudancas"
          eyebrow="Rastro"
          titulo="Declarações removidas"
          descricao="O TSE publica só o estado atual: quem apaga uma declaração apaga o rastro público. Estas o radar fotografou antes de sumirem. Já estão fora daqui as notas que o sistema do TSE apenas renumerou e as que reapareceram com um campo corrigido — o que resta é declaração que saiu do ar e não voltou. Ainda assim é ponto de partida para investigar, nunca acusação: a Justiça Eleitoral só trata a divergência como falha grave quando é relevante e não explicada."
          verTudo={{
            href: '/explorar?visao=removidas',
            rotulo: m
              ? `Explorar as ${num.format(m.despesas_removidas_qtd)} despesas removidas com filtros`
              : 'Explorar todas as remoções com filtros',
          }}
        >
          <div className="space-y-6">
            {removidas.length > 0 && (
              <div>
                <p className="mb-3 flex items-start gap-2 text-sm text-muted-foreground">
                  <EyeOff className="mt-0.5 h-4 w-4 shrink-0" />
                  {/* span único: sem ele os dois trechos viram colunas de um
                      flex e no celular cada uma quebra em duas linhas */}
                  <span>
                    {m
                      ? <><strong className="font-semibold text-foreground">Despesas removidas: {num.format(m.despesas_removidas_qtd)}</strong> somando {brl.format(m.despesas_removidas_valor)} — as {removidas.length} maiores:</>
                      : <><strong className="font-semibold text-foreground">Despesas removidas</strong> — as {removidas.length} maiores:</>}
                  </span>
                </p>
                {notaDominancia(removidas, m?.despesas_removidas_valor)}
                <TabelaRemovidas linhas={removidas} quem="Fornecedor" />
              </div>
            )}
            {removidasReceitas.length > 0 && (
              <div>
                <p className="mb-3 flex items-start gap-2 text-sm text-muted-foreground">
                  <EyeOff className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {m
                      ? <><strong className="font-semibold text-foreground">Receitas removidas: {num.format(m.receitas_removidas_qtd)}</strong> somando {brl.format(m.receitas_removidas_valor)} — as {removidasReceitas.length} maiores:</>
                      : <><strong className="font-semibold text-foreground">Receitas removidas</strong> — as {removidasReceitas.length} maiores:</>}
                  </span>
                </p>
                {notaDominancia(removidasReceitas, m?.receitas_removidas_valor)}
                <TabelaRemovidas linhas={removidasReceitas} quem="Doador" />
                <Link
                  to="/explorar?visao=removidas-receitas"
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[#264E9B] underline-offset-4 hover:underline"
                >
                  {m
                    ? `Explorar as ${num.format(m.receitas_removidas_qtd)} receitas removidas com filtros`
                    : 'Explorar todas as receitas removidas com filtros'}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            )}
          </div>
        </Secao>
      )}

      <Secao
        id="ranking"
        eyebrow="Ranking"
        titulo="Quem mais contratou até agora"
        descricao="Despesa contratada × receita declarada. Contratar muito acima do que declarou arrecadar merece atenção — a conta precisa fechar até a prestação final."
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
                    {x.NM_CANDIDATO}
                  </Link>
                ) : (
                  x.NM_CANDIDATO
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
    </div>
  );
}
