import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle, ArrowRight, Bot, Building2, CheckCircle2, EyeOff, Megaphone,
  Scale, Search, Wallet, type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum } from '@/components/app/tabela';
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
    icone: Building2,
    pergunta: 'Que empresas recebem de vários candidatos ao mesmo tempo?',
    detalhe: 'Fornecedores compartilhados podem ser mercado consolidado — ou campanhas casadas. Filtre por UF, cargo ou partido.',
    href: '/explorar?visao=compartilhados',
  },
  {
    icone: Megaphone,
    pergunta: 'Quanto se gasta com carro de som no seu estado?',
    detalhe: 'Filtre qualquer tipo de gasto por UF, cargo ou partido.',
    href: '/explorar?descricao=carro%20de%20som',
  },
  {
    icone: Scale,
    pergunta: 'Quem está fora da curva do próprio grupo?',
    detalhe: 'Cada candidato comparado aos pares do mesmo cargo e estado — gasto, concentração, documentação.',
    href: '#fora-da-curva',
  },
  {
    icone: EyeOff,
    pergunta: 'Alguém removeu declarações que já tinha feito?',
    detalhe: 'O TSE não mostra o passado; o radar fotografa todo dia e guarda o rastro. Explore todas as remoções, com filtros.',
    href: '/explorar?visao=removidas',
  },
  {
    icone: Bot,
    pergunta: 'Quer perguntar do seu jeito?',
    detalhe: 'Use a sua IA (ChatGPT, Claude, Gemini…) para gerar consultas e rode no console aberto.',
    href: '/consultar',
  },
];

function PerguntasSection() {
  return (
    <section className="mt-4">
      <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">
        O que dá para descobrir
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

function Cartao({ rotulo, valor, indice }: { rotulo: string; valor: string; indice: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: indice * 0.06, ease: 'easeOut' }}
    >
      <Card>
        <CardContent className="p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {rotulo}
          </p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">
            {valor}
          </p>
        </CardContent>
      </Card>
    </motion.div>
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
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#264E9B] underline-offset-4 hover:underline"
        >
          {verTudo.rotulo} <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </section>
  );
}

function TabelaRemovidas({ linhas, quem }: { linhas: DespesaResumo[]; quem: string }) {
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
          <td>
            {x.NM_CANDIDATO}
            <span className="text-muted-foreground"> · {x.SG_PARTIDO}/{x.SG_UF}</span>
          </td>
          <td>{x.fornecedor ?? x.NM_DOADOR}</td>
          <td>{x.DS_DESPESA ?? x.DS_ORIGEM_RECEITA ?? ''}</td>
          <CelulaNum>{brl.format(x.valor ?? 0)}</CelulaNum>
          <td className="whitespace-nowrap text-muted-foreground">
            {dataBR(x.dt_primeira_extracao)} → {dataBR(x.dt_ultima_extracao)}
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
      <div className="flex min-h-[50vh] items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="h-5 w-5" /> Carregando os dados mais recentes…
      </div>
    );
  }
  if (resumo === 'erro') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
        Não foi possível carregar os dados. Tente novamente em instantes.
      </div>
    );
  }

  const t = resumo.totais;
  const removidas = resumo.despesas_removidas ?? [];
  const removidasReceitas = resumo.receitas_removidas ?? [];

  return (
    <div className="mx-auto max-w-7xl px-6 pb-24">
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
          O TSE publica apenas o estado atual das contas de campanha. Este radar fotografa as
          declarações todos os dias e mostra o que foi declarado, alterado e{' '}
          <strong className="text-foreground">removido</strong>.
        </p>
        <BuscaHero />
      </section>

      <PerguntasSection />

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Cartao indice={0} rotulo="Receitas declaradas" valor={brl.format(t.total_receitas)} />
        <Cartao indice={1} rotulo="Despesas contratadas" valor={brl.format(t.total_contratado)} />
        <Cartao indice={2} rotulo="Candidatos com gastos" valor={num.format(t.candidatos_com_gastos)} />
        <Cartao indice={3} rotulo="Candidaturas registradas" valor={num.format(t.candidaturas_registradas)} />
      </div>

      <Secao
        id="mudancas"
        eyebrow="O diferencial"
        titulo="Declarações removidas ou alteradas"
        descricao="Quem apaga ou edita uma declaração no TSE apaga também o rastro público. Aqui ficam as maiores; a lista completa, com filtros por UF, cargo, partido ou candidato, está no Explorar. Uma remoção pode ser correção legítima — é um indício para investigar, nunca uma acusação."
        verTudo={{ href: '/explorar?visao=removidas', rotulo: 'Ver todas as remoções no Explorar' }}
      >
        {removidas.length === 0 && removidasReceitas.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-[#264E9B]" />
              Nenhuma declaração removida detectada até a extração de {dataBR(resumo.gerado_em)}.
              {resumo.primeira_extracao &&
                ' (Primeira fotografia da série — as comparações começam na próxima extração.)'}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {removidas.length > 0 && (
              <div>
                <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-destructive-foreground">
                  <AlertTriangle className="h-4 w-4" /> Despesas que sumiram da declaração: {removidas.length}
                </p>
                <TabelaRemovidas linhas={removidas} quem="Fornecedor" />
              </div>
            )}
            {removidasReceitas.length > 0 && (
              <div>
                <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-destructive-foreground">
                  <AlertTriangle className="h-4 w-4" /> Receitas que sumiram da declaração: {removidasReceitas.length}
                </p>
                <TabelaRemovidas linhas={removidasReceitas} quem="Doador" />
              </div>
            )}
          </div>
        )}
      </Secao>

      {(resumo.fora_da_curva ?? []).length > 0 && (
        <Secao
          id="fora-da-curva"
          eyebrow="Fora da curva"
          titulo="Quem mais destoa do próprio grupo"
          descricao="Candidatos com mais métricas acima do p95 do grupo de comparação (mesmo cargo e estado — âmbito nacional quando o grupo local é pequeno). Estar fora da curva não é irregularidade: é onde os dados sugerem começar as perguntas. Cada sinal traz o valor do candidato e a mediana do grupo, conferíveis na página Consultar."
        >
          <div className="space-y-3">
            {(resumo.fora_da_curva ?? []).map((c: CandidatoForaDaCurva) => (
              <div key={c.SQ_CANDIDATO} className="rounded-xl border bg-card p-4 shadow-sm">
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
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {c.sinais.map((s) => {
                    const m = metrica(s.metrica);
                    return (
                      <span
                        key={s.metrica}
                        title={`p95 do grupo (${s.grupo_n} candidatos${s.grupo_ambito === 'BR-TODAS' ? ', âmbito nacional' : ''}): ${m.formatar(s.p95)}`}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#B45309]/40 bg-[#B45309]/10 px-3 py-1 text-xs font-medium text-[#7c3a06]"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {m.rotulo}: {m.formatar(s.valor)}
                        <span className="text-[#7c3a06]/70">· grupo: {m.formatar(s.mediana)}</span>
                      </span>
                    );
                  })}
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
            : 'Despesas que apareceram na extração mais recente e não constavam na anterior.'
        }
      >
        <Tabela
          colunas={[
            { titulo: 'Candidato' },
            { titulo: 'Fornecedor' },
            { titulo: 'O quê' },
            { titulo: 'Valor', numerica: true },
          ]}
        >
          {(resumo.novas_despesas ?? []).map((x, i) => (
            <tr key={i}>
              <td>
                {x.NM_CANDIDATO}
                <span className="text-muted-foreground">
                  {' '}· {x.SG_PARTIDO}/{x.SG_UF} · {x.DS_CARGO}
                </span>
              </td>
              <td>{x.fornecedor}</td>
              <td>
                {x.DS_ORIGEM_DESPESA}
                <span className="text-muted-foreground"> — {x.DS_DESPESA}</span>
              </td>
              <CelulaNum>{brl.format(x.valor ?? 0)}</CelulaNum>
            </tr>
          ))}
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
          {(resumo.fornecedores_compartilhados ?? []).map((x) => (
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
              <CelulaNum>{brl.format(x.total ?? 0)}</CelulaNum>
            </tr>
          ))}
        </Tabela>
      </Secao>

      <Secao
        id="ranking"
        eyebrow="Ranking"
        titulo="Quem mais contratou até agora"
        descricao="Despesa contratada × receita declarada. Contratar muito acima do que declarou arrecadar merece atenção — a conta precisa fechar até a prestação final."
        verTudo={{ href: '/explorar', rotulo: 'Explorar todos os gastos' }}
      >
        <Tabela
          colunas={[
            { titulo: 'Candidato' },
            { titulo: 'Cargo' },
            { titulo: 'Contratado', numerica: true },
            { titulo: 'Receita declarada', numerica: true },
          ]}
        >
          {(resumo.top_candidatos ?? []).map((x, i) => (
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
              <CelulaNum>{brl.format(x.contratado ?? 0)}</CelulaNum>
              <CelulaNum>{x.receita == null ? '—' : brl.format(x.receita)}</CelulaNum>
            </tr>
          ))}
        </Tabela>
      </Secao>
    </div>
  );
}
