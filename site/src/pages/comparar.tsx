import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Plus, Search, Users, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Secao } from '@/components/app/secao';
import { Tabela, CelulaNum } from '@/components/app/tabela';
import { FotoCandidato } from '@/components/app/foto';
import {
  BarrasPareadas, MatrizCategorias, PilhasComparadas, montarMatriz, type RotuloItem,
} from '@/components/app/comparacao';
import { executarSQL, obterConexao } from '@/lib/dados';
import {
  CARGOS, FILTROS_VAZIOS, MAX_COMPARADOS, SQL_PARTIDOS_COM_MOVIMENTO, UFS, listaSQL,
  sqlBuscaCandidatos, sqlCategoriasComparadas, sqlCompararCandidatos, sqlCompararPartidos,
  sqlConcorrentes, sqlCustoPorVotoAgregado, wherePartidosComparados,
} from '@/lib/consultas';
import { brl, brlCompacto, custoVoto, num } from '@/lib/format';
import { cn } from '@/lib/utils';

type Modo = 'candidatos' | 'partidos';

/** Um item da comparação — candidatura ou partido —, já no formato que os
 *  gráficos leem. Partido soma as candidaturas do recorte; o custo por voto
 *  dele é o AGREGADO (soma ÷ soma), o mesmo da ficha do partido. */
interface Comparado extends RotuloItem {
  nomeCivil: string | null;
  subtitulo: string;
  foto: { cd: string | null; ue: string | null } | null;
  cargo: string | null;
  arrecadado: number;
  contratado: number;
  pago: number | null;
  publico: number;
  proprios: number;
  votos: number | null;
  votos2t: number | null;
  resultado: string | null;
  custo: number | null;
  custoPublico: number | null;
  custoProprio: number | null;
  custoTerceiros: number | null;
  candidaturas: number | null;
  eleitos: number | null;
}

interface Comparacao {
  itens: Comparado[];
  gastos: { id: string; categoria: string; total: number }[];
}

const SIGLA_VALIDA = /^[A-Za-zÀ-ÿ0-9 .-]{1,30}$/;
const nOuNull = (v: unknown) => (v == null ? null : Number(v));
const unicos = (l: string[]) => [...new Set(l)];

const FATIAS_RECEITA = [
  { rotulo: 'Dinheiro público', cor: '#264E9B' },
  { rotulo: 'Recursos próprios', cor: '#B45309' },
  { rotulo: 'Doações de terceiros', cor: '#6e6a60' },
];

const terceiros = (c: Comparado) => Math.max(c.arrecadado - c.publico - c.proprios, 0);

async function carregarCandidatos(sqs: string[]): Promise<Comparacao> {
  await obterConexao();
  const [r, cats] = await Promise.all([
    executarSQL(sqlCompararCandidatos(sqs)),
    executarSQL(sqlCategoriasComparadas('SQ_CANDIDATO', `SQ_CANDIDATO IN (${listaSQL(sqs)})`)),
  ]);
  const porSq = new Map(r.linhas.map((l) => [String(l[0]), l]));
  const itens = sqs.flatMap((sq): Comparado[] => {
    const l = porSq.get(sq);
    if (!l) return [];
    const nome = String(l[1] ?? '');
    const civil = String(l[2] ?? '');
    return [{
      id: sq,
      rotulo: nome,
      href: `/candidato/${sq}`,
      nomeCivil: civil && civil.toUpperCase() !== nome.toUpperCase() ? civil : null,
      subtitulo: `${l[3]}/${l[4]} · ${l[5]}`,
      foto: { cd: l[18] == null ? null : String(l[18]), ue: l[19] == null ? null : String(l[19]) },
      cargo: l[5] == null ? null : String(l[5]),
      arrecadado: Number(l[6] ?? 0),
      contratado: Number(l[7] ?? 0),
      pago: nOuNull(l[8]),
      publico: Number(l[9] ?? 0),
      proprios: Number(l[10] ?? 0),
      votos: nOuNull(l[11]),
      votos2t: nOuNull(l[12]),
      resultado: l[13] == null ? null : String(l[13]),
      custo: nOuNull(l[14]),
      custoPublico: nOuNull(l[15]),
      custoProprio: nOuNull(l[16]),
      custoTerceiros: nOuNull(l[17]),
      candidaturas: null,
      eleitos: null,
    }];
  });
  return {
    itens,
    gastos: cats.linhas.map((l) => ({ id: String(l[0]), categoria: String(l[1]), total: Number(l[2] ?? 0) })),
  };
}

async function carregarPartidos(siglas: string[], cargo: string, uf: string): Promise<Comparacao> {
  await obterConexao();
  const w = wherePartidosComparados(siglas, cargo, uf);
  const [tot, custo, cats] = await Promise.all([
    executarSQL(sqlCompararPartidos(w)),
    // parquet sem as colunas de voto (janela entre deploy e rotina) não derruba a tela
    executarSQL(sqlCustoPorVotoAgregado(w, 'SG_PARTIDO')).catch(() => ({ linhas: [] as unknown[][] })),
    executarSQL(sqlCategoriasComparadas('SG_PARTIDO', w)),
  ]);
  const totais = new Map(tot.linhas.map((l) => [String(l[0]), l]));
  const custos = new Map(custo.linhas.map((l) => [String(l[0]), l]));
  const recorte = [cargo, uf].filter(Boolean).join(' · ');
  const itens = siglas.flatMap((sigla): Comparado[] => {
    const l = totais.get(sigla);
    if (!l) return [];
    const c = custos.get(sigla);
    const candidaturas = Number(l[1] ?? 0);
    const eleitos = Number(l[2] ?? 0);
    return [{
      id: sigla,
      rotulo: sigla,
      href: `/partido/${encodeURIComponent(sigla)}`,
      nomeCivil: null,
      subtitulo: `${num.format(candidaturas)} candidaturas${recorte ? ` · ${recorte}` : ''}`,
      foto: null,
      cargo: cargo || null,
      arrecadado: Number(l[3] ?? 0),
      contratado: Number(l[4] ?? 0),
      pago: nOuNull(l[5]),
      publico: Number(l[6] ?? 0),
      proprios: Number(l[7] ?? 0),
      votos: c ? Number(c[3] ?? 0) : null,
      votos2t: null,
      resultado: null,
      custo: c ? nOuNull(c[5]) : null,
      custoPublico: c ? nOuNull(c[6]) : null,
      custoProprio: c ? nOuNull(c[7]) : null,
      custoTerceiros: c ? nOuNull(c[8]) : null,
      candidaturas,
      eleitos,
    }];
  });
  return {
    itens,
    gastos: cats.linhas.map((l) => ({ id: String(l[0]), categoria: String(l[1]), total: Number(l[2] ?? 0) })),
  };
}

const seletor =
  'h-9 min-w-0 rounded-md border bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

interface Achado {
  sq: string;
  nome: string;
  civil: string | null;
  descricao: string;
  contratado: number;
  temMovimento: boolean;
}

/** Busca de candidatura por nome (de urna ou civil) ou número — a mesma régua
 *  da busca do Explorar (sqlBuscaCandidatos). Só entra na comparação quem já
 *  declarou alguma movimentação: sem ela não há o que comparar. */
function BuscaCandidato({ escolhidos, aoEscolher }: { escolhidos: string[]; aoEscolher: (sq: string) => void }) {
  const [termo, setTermo] = useState('');
  const [achados, setAchados] = useState<Achado[] | null>(null);
  const [buscando, setBuscando] = useState(false);

  useEffect(() => {
    const t = termo.trim();
    if (t.length < 3 && !/^\d{2,}$/.test(t)) {
      setAchados(null);
      return;
    }
    let vivo = true;
    const espera = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await executarSQL(sqlBuscaCandidatos({ ...FILTROS_VAZIOS, candidato: t }, 8));
        if (!vivo) return;
        setAchados(r.linhas.map((l) => {
          const civil = String(l[1] ?? '');
          const urna = l[2] == null || l[2] === '#NULO' ? null : String(l[2]);
          const nome = urna ?? civil;
          return {
            sq: String(l[0]),
            nome,
            civil: civil.toUpperCase() !== nome.toUpperCase() ? civil : null,
            descricao: `${l[4]}/${l[6]} · ${l[5]}`,
            contratado: Number(l[7] ?? 0),
            temMovimento: Boolean(l[9]),
          };
        }));
      } catch {
        if (vivo) setAchados([]);
      } finally {
        if (vivo) setBuscando(false);
      }
    }, 300);
    return () => {
      vivo = false;
      clearTimeout(espera);
    };
  }, [termo]);

  const cheio = escolhidos.length >= MAX_COMPARADOS;
  return (
    <div>
      <label className="relative block">
        <span className="sr-only">Buscar candidato para comparar</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          className={cn(seletor, 'h-10 w-full pl-9')}
          placeholder={cheio ? `Limite de ${MAX_COMPARADOS} candidatos — remova um para trocar` : 'Nome de urna, nome civil ou número'}
          value={termo}
          disabled={cheio}
          onChange={(e) => setTermo(e.target.value)}
        />
        {buscando && <Spinner className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />}
      </label>
      {achados && (
        <ul className="mt-2 divide-y rounded-lg border bg-card">
          {achados.length === 0 && <li className="px-3 py-2.5 text-sm text-muted-foreground">Nenhuma candidatura encontrada.</li>}
          {achados.map((a) => {
            const jaEsta = escolhidos.includes(a.sq);
            const bloqueado = jaEsta || !a.temMovimento;
            return (
              <li key={a.sq}>
                <button
                  type="button"
                  disabled={bloqueado}
                  onClick={() => {
                    aoEscolher(a.sq);
                    setTermo('');
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-foreground">{a.nome}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.civil && <>{a.civil} · </>}{a.descricao}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {jaEsta ? 'já na comparação' : !a.temMovimento ? 'sem movimentação declarada' : (
                      <span className="inline-flex items-center gap-1 font-medium text-[#264E9B]">
                        <Plus className="h-3.5 w-3.5" /> comparar
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ChipResultado({ resultado }: { resultado: string }) {
  const eleito = resultado.startsWith('ELEITO');
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        eleito
          ? 'border-[#264E9B] bg-[#264E9B] text-white'
          : resultado.includes('TURNO')
            ? 'border-[#B45309]/40 bg-[#B45309]/10 text-[#7c3a06]'
            : 'border-border bg-muted text-muted-foreground',
      )}
    >
      {resultado.toLowerCase()}
    </span>
  );
}

function CartaoComparado({ item, aoRemover }: { item: Comparado; aoRemover: () => void }) {
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-3 p-4 sm:p-4">
        <div className="flex items-start gap-3">
          {item.foto ? (
            <FotoCandidato cdEleicao={item.foto.cd} sq={item.id} sgUe={item.foto.ue} nome={item.rotulo} className="h-12 w-12 text-sm" />
          ) : (
            <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#264E9B]/20 bg-[#264E9B]/10 text-[#264E9B]">
              <Users className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <Link to={item.href} className="block font-bold leading-tight text-[#10244A] underline-offset-4 [overflow-wrap:anywhere] hover:underline">
              {item.rotulo}
            </Link>
            {item.nomeCivil && <p className="truncate text-xs text-muted-foreground">{item.nomeCivil}</p>}
            <p className="mt-0.5 text-xs text-muted-foreground">{item.subtitulo}</p>
          </div>
          <button
            type="button"
            onClick={aoRemover}
            aria-label={`Remover ${item.rotulo} da comparação`}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="mt-auto grid grid-cols-3 gap-2 border-t pt-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Arrecadou</dt>
            <dd className="font-semibold tabular-nums text-foreground">{brlCompacto.format(item.arrecadado)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Contratou</dt>
            <dd className="font-semibold tabular-nums text-foreground">{brlCompacto.format(item.contratado)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Por voto</dt>
            <dd className="font-semibold tabular-nums text-foreground">{custoVoto(item.custo)}</dd>
          </div>
        </dl>
        {(item.resultado || item.eleitos != null) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.resultado && <ChipResultado resultado={item.resultado} />}
            {item.eleitos != null && <span>{num.format(item.eleitos)} eleitos</span>}
            {item.votos != null && <span>{num.format(item.votos)} votos no 1º turno</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Frases de leitura rápida: quem está na ponta de cada régua. Só fatos — o
 *  maior e o menor, com o número. */
function destaques(itens: Comparado[]): string[] {
  if (itens.length < 2) return [];
  const frases: string[] = [];
  const ponta = (f: (c: Comparado) => number | null) => {
    const com = itens.filter((c) => f(c) != null && f(c)! > 0);
    if (com.length < 2) return null;
    const ord = [...com].sort((a, b) => f(b)! - f(a)!);
    return { maior: ord[0], menor: ord[ord.length - 1], v: f };
  };
  const arr = ponta((c) => c.arrecadado);
  if (arr) {
    const razao = arr.v(arr.maior)! / arr.v(arr.menor)!;
    frases.push(
      `${arr.maior.rotulo} arrecadou ${brl.format(arr.maior.arrecadado)}` +
        (razao >= 1.5 ? ` — ${num.format(Math.round(razao * 10) / 10)} vezes o que ${arr.menor.rotulo} arrecadou.` : '.'),
    );
  }
  const pub = ponta((c) => (c.arrecadado > 0 ? (100 * c.publico) / c.arrecadado : null));
  if (pub) {
    frases.push(
      `Dinheiro público pesa mais em ${pub.maior.rotulo} (${Math.round(pub.v(pub.maior)!)}% da receita) ` +
        `e menos em ${pub.menor.rotulo} (${Math.round(pub.v(pub.menor)!)}%).`,
    );
  }
  const custo = ponta((c) => c.custo);
  if (custo) {
    frases.push(
      `O voto mais caro foi o de ${custo.maior.rotulo} (${custoVoto(custo.maior.custo)}); ` +
        `o mais barato, o de ${custo.menor.rotulo} (${custoVoto(custo.menor.custo)}).`,
    );
  }
  return frases;
}

export function Comparar() {
  const [params, setParams] = useSearchParams();
  const modo: Modo = params.get('modo') === 'partidos' ? 'partidos' : 'candidatos';
  const sqs = useMemo(
    () => unicos((params.get('c') ?? '').split(',').filter((s) => /^\d{1,20}$/.test(s))).slice(0, MAX_COMPARADOS),
    [params],
  );
  const siglas = useMemo(
    () => unicos((params.get('p') ?? '').split(',').filter((s) => SIGLA_VALIDA.test(s))).slice(0, MAX_COMPARADOS),
    [params],
  );
  // '' é opção válida (todos), então o valor ausente tem de virar '' ANTES do teste
  const cargoUrl = params.get('cargo') ?? '';
  const ufUrl = params.get('uf') ?? '';
  const cargo = CARGOS.includes(cargoUrl) ? cargoUrl : '';
  const uf = UFS.includes(ufUrl) ? ufUrl : '';
  const selecionados = modo === 'candidatos' ? sqs : siglas;
  const chave = `${modo}|${selecionados.join(',')}|${cargo}|${uf}`;

  const [dados, setDados] = useState<Comparacao | 'carregando' | 'erro' | null>(null);
  const [partidos, setPartidos] = useState<string[]>([]);
  const [concorrentes, setConcorrentes] = useState<{ sq: string; nome: string; partido: string }[]>([]);

  function atualizar(mudancas: Record<string, string>) {
    const novo = new URLSearchParams(params);
    for (const [k, v] of Object.entries(mudancas)) {
      if (v) novo.set(k, v);
      else novo.delete(k);
    }
    // vírgula legível no link compartilhado (?c=1,2 em vez de ?c=1%2C2)
    setParams(novo.toString().replaceAll('%2C', ','));
  }
  const definirSelecao = (lista: string[]) => atualizar({ [modo === 'candidatos' ? 'c' : 'p']: lista.join(',') });

  useEffect(() => {
    if (!selecionados.length) {
      setDados(null);
      return;
    }
    let vivo = true;
    setDados('carregando');
    (modo === 'candidatos' ? carregarCandidatos(sqs) : carregarPartidos(siglas, cargo, uf))
      .then((d) => vivo && setDados(d))
      .catch(() => vivo && setDados('erro'));
    return () => {
      vivo = false;
    };
  }, [chave]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (modo !== 'partidos' || partidos.length) return;
    obterConexao()
      .then(() => executarSQL(SQL_PARTIDOS_COM_MOVIMENTO))
      .then((r) => setPartidos(r.linhas.map((l) => String(l[0]))))
      .catch(() => {});
  }, [modo, partidos.length]);

  // atalho: quem disputou a mesma vaga que o PRIMEIRO candidato escolhido
  useEffect(() => {
    if (modo !== 'candidatos' || !sqs.length || sqs.length >= MAX_COMPARADOS) {
      setConcorrentes([]);
      return;
    }
    let vivo = true;
    obterConexao()
      .then(() => executarSQL(sqlConcorrentes(sqs[0], sqs.slice(1), 4)))
      .then((r) => vivo && setConcorrentes(r.linhas.map((l) => ({ sq: String(l[0]), nome: String(l[1]), partido: String(l[2]) }))))
      .catch(() => vivo && setConcorrentes([]));
    return () => {
      vivo = false;
    };
  }, [modo, sqs]);

  const comparacao = typeof dados === 'object' && dados ? dados : null;
  const itens = comparacao?.itens ?? [];
  const matriz = useMemo(
    () => (comparacao ? montarMatriz(comparacao.itens.map((i) => i.id), comparacao.gastos) : null),
    [comparacao],
  );
  const cargos = unicos(itens.map((i) => i.cargo ?? '').filter(Boolean));
  const temVotos = itens.some((i) => i.votos != null);
  const leituras = destaques(itens);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6 sm:py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Comparar</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-4xl">Lado a lado</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Escolha até {MAX_COMPARADOS} candidatos ou partidos e veja, na mesma escala, quanto cada um arrecadou,
          de onde veio o dinheiro, em que gastou e quanto custou cada voto.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="O que comparar">
            {(['candidatos', 'partidos'] as const).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={modo === m}
                onClick={() => setParams(m === 'partidos' ? { modo: 'partidos' } : {})}
                className={
                  modo === m
                    ? 'rounded-full bg-gradient-to-r from-[#10244A] to-[#264E9B] px-4 py-1.5 text-sm font-semibold text-white shadow-sm'
                    : 'rounded-full border bg-card px-4 py-1.5 text-sm text-muted-foreground shadow-sm transition-colors hover:border-[#264E9B]/40 hover:text-foreground'
                }
              >
                {m === 'candidatos' ? 'Candidatos' : 'Partidos'}
              </button>
            ))}
          </div>

          {modo === 'candidatos' ? (
            <>
              <BuscaCandidato escolhidos={sqs} aoEscolher={(sq) => definirSelecao([...sqs, sq])} />
              {concorrentes.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Disputaram a mesma vaga:</span>
                  {concorrentes.map((c) => (
                    <button
                      key={c.sq}
                      type="button"
                      onClick={() => definirSelecao([...sqs, c.sq])}
                      className="inline-flex items-center gap-1 rounded-full border bg-card px-3 py-1 text-xs shadow-sm transition-colors hover:border-[#264E9B]/40"
                    >
                      <Plus className="h-3 w-3 text-[#264E9B]" /> {c.nome} <span className="text-muted-foreground">({c.partido})</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <select className={seletor} value={cargo} onChange={(e) => atualizar({ cargo: e.target.value })} aria-label="Cargo">
                  <option value="">Todos os cargos</option>
                  {CARGOS.filter(Boolean).map((c) => <option key={c}>{c}</option>)}
                </select>
                <select className={seletor} value={uf} onChange={(e) => atualizar({ uf: e.target.value })} aria-label="UF">
                  <option value="">Todas as UFs</option>
                  {UFS.filter(Boolean).map((u) => <option key={u}>{u}</option>)}
                </select>
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label="Partidos">
                {partidos.length === 0 && <Spinner className="h-4 w-4 text-muted-foreground" />}
                {partidos.map((p) => {
                  const ativo = siglas.includes(p);
                  const cheio = !ativo && siglas.length >= MAX_COMPARADOS;
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={ativo}
                      disabled={cheio}
                      onClick={() => definirSelecao(ativo ? siglas.filter((s) => s !== p) : [...siglas, p])}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                        ativo
                          ? 'border-[#264E9B] bg-[#264E9B] text-white'
                          : 'bg-card text-muted-foreground hover:border-[#264E9B]/40 hover:text-foreground',
                      )}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Partidos em ordem de gasto declarado. Cargo e UF recortam as candidaturas somadas de cada sigla.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {!selecionados.length && (
        <p className="py-10 text-center text-muted-foreground">
          {modo === 'candidatos'
            ? 'Busque um candidato acima para começar. Depois do primeiro, sugerimos quem disputou a mesma vaga.'
            : 'Escolha os partidos acima para começar.'}
        </p>
      )}

      {dados === 'carregando' && (
        <div className="flex min-h-[30vh] items-center justify-center gap-3 text-muted-foreground">
          <Spinner className="h-5 w-5" /> Consultando os dados…
        </div>
      )}
      {dados === 'erro' && (
        <p className="py-10 text-center text-muted-foreground">Não foi possível consultar os dados agora. Tente de novo em instantes.</p>
      )}

      {comparacao && itens.length === 0 && (
        <p className="py-10 text-center text-muted-foreground">Nada declarado neste recorte até agora.</p>
      )}

      {comparacao && itens.length > 0 && (
        <>
          <div className={cn('grid gap-4 sm:grid-cols-2', itens.length === 3 && 'lg:grid-cols-3', itens.length === 4 && 'lg:grid-cols-4')}>
            {itens.map((item) => (
              <CartaoComparado
                key={item.id}
                item={item}
                aoRemover={() => definirSelecao(selecionados.filter((s) => s !== item.id))}
              />
            ))}
          </div>

          {modo === 'candidatos' && cargos.length > 1 && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Os candidatos disputam cargos diferentes ({cargos.join(', ')}). Campanha para governador e para
              deputado têm escalas e eleitorados muito distintos — os números ficam lado a lado, mas não medem a
              mesma coisa.
            </p>
          )}

          {leituras.length > 0 && (
            <Card>
              <CardContent className="p-4 sm:p-5">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Em poucas palavras</p>
                <ul className="mt-2 space-y-1.5 text-sm text-foreground">
                  {leituras.map((f) => <li key={f}>{f}</li>)}
                </ul>
              </CardContent>
            </Card>
          )}

          <Secao
            titulo="Quanto arrecadou e quanto gastou"
            descricao="Receita declarada e despesas contratadas, todos na mesma escala. Contratado acima do arrecadado pode ser só calendário: nota lançada antes de o repasse entrar."
          >
            <BarrasPareadas
              series={['Arrecadado', 'Contratado']}
              itens={itens.map((i) => ({
                ...i,
                valores: [i.arrecadado, i.contratado] as [number, number],
                detalhe: [
                  i.arrecadado > 0 && i.contratado > 0
                    ? `contratou ${num.format(Math.round((100 * i.contratado) / i.arrecadado))}% do arrecadado`
                    : null,
                  i.pago != null && i.contratado > 0
                    ? `pagou ${num.format(Math.round((100 * i.pago) / i.contratado))}% do contratado`
                    : null,
                ].filter(Boolean).join(' · ') || undefined,
              }))}
            />
          </Secao>

          <Secao
            titulo="De onde veio o dinheiro"
            descricao="Cada barra é 100% do que o item arrecadou, repartido entre fundos públicos (Fundo Eleitoral + Fundo Partidário, pela fonte oficial), recursos próprios dos candidatos e doações de terceiros. O total em reais vai ao lado."
          >
            <PilhasComparadas
              proporcional
              fatias={FATIAS_RECEITA}
              formatar={(v) => brl.format(v)}
              formatarTotal={(v) => brlCompacto.format(v)}
              itens={itens.map((i) => ({
                ...i,
                valores: [i.publico, i.proprios, terceiros(i)],
                total: i.arrecadado > 0 ? i.arrecadado : null,
                semDado: 'Sem receita declarada até agora.',
              }))}
            />
          </Secao>

          {matriz && matriz.linhas.length > 0 && (
            <Secao
              titulo="Em que gastou"
              descricao="Quanto cada tipo de despesa representa no total contratado de cada um. As porcentagens deixam comparáveis campanhas de tamanhos muito diferentes; o valor em reais vai embaixo."
            >
              <MatrizCategorias colunas={itens} linhas={matriz.linhas} totais={matriz.totais} />
            </Secao>
          )}

          <Secao
            titulo="Quanto custou cada voto"
            descricao={
              modo === 'candidatos'
                ? 'Contratado dividido pelos votos nominais do 1º turno — o único que todo candidato disputou; quem foi ao 2º turno tem o gasto das semanas extras no numerador. As fatias repartem o custo na proporção da receita. Custo alto não é irregularidade: é o tamanho da campanha diante do resultado.'
                : 'Custo agregado da sigla: soma do contratado ÷ soma dos votos do 1º turno das candidaturas com voto (um candidato de muitos votos pesa mais que um de poucos). As fatias repartem o custo na proporção da receita.'
            }
          >
            {temVotos ? (
              <PilhasComparadas
                fatias={[
                  { rotulo: 'Dinheiro público', cor: '#264E9B' },
                  { rotulo: modo === 'candidatos' ? 'Bolso do candidato' : 'Bolso dos candidatos', cor: '#B45309' },
                  { rotulo: 'Doações de terceiros', cor: '#6e6a60' },
                ]}
                formatar={custoVoto}
                itens={itens.map((i) => ({
                  ...i,
                  valores: [i.custoPublico ?? 0, i.custoProprio ?? 0, i.custoTerceiros ?? 0],
                  total: i.custo,
                  detalhe: i.votos != null ? `${num.format(i.votos)} votos no 1º turno${i.votos2t != null ? ` · ${num.format(i.votos2t)} no 2º` : ''}` : undefined,
                  semDado:
                    i.votos == null
                      ? 'Sem votação totalizada para esta candidatura (não chegou à urna ou a apuração ainda não foi publicada).'
                      : 'Nenhum voto nominal no 1º turno — não há por quem dividir.',
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">A votação destas candidaturas ainda não foi totalizada pelo TSE.</p>
            )}
          </Secao>

          <Secao titulo="Os números lado a lado" descricao="Tudo o que os gráficos acima mostram, em uma tabela.">
            <Tabela colunas={[{ titulo: '' }, ...itens.map((i) => ({ titulo: i.rotulo, numerica: true }))]}>
              {([
                ...(modo === 'partidos'
                  ? [
                      ['Candidaturas', (i: Comparado) => num.format(i.candidaturas ?? 0)],
                      ['Eleitos', (i: Comparado) => num.format(i.eleitos ?? 0)],
                    ]
                  : []),
                ['Arrecadado', (i: Comparado) => brl.format(i.arrecadado)],
                ['Dinheiro público', (i: Comparado) => brl.format(i.publico)],
                ['Recursos próprios', (i: Comparado) => brl.format(i.proprios)],
                ['Doações de terceiros', (i: Comparado) => brl.format(terceiros(i))],
                ['Contratado', (i: Comparado) => brl.format(i.contratado)],
                ['Pago', (i: Comparado) => (i.pago == null ? '—' : brl.format(i.pago))],
                ['Votos (1º turno)', (i: Comparado) => (i.votos == null ? '—' : num.format(i.votos))],
                ...(modo === 'candidatos'
                  ? [['Resultado', (i: Comparado) => (i.resultado ? i.resultado.toLowerCase() : '—')]]
                  : []),
                ['Custo por voto', (i: Comparado) => custoVoto(i.custo)],
                ['Público por voto', (i: Comparado) => custoVoto(i.custoPublico)],
              ] as [string, (i: Comparado) => string][]).map(([rotulo, valor]) => (
                <tr key={rotulo} className="hover:bg-muted/40">
                  <td className="font-medium text-muted-foreground">{rotulo}</td>
                  {itens.map((i) => <CelulaNum key={i.id}>{valor(i)}</CelulaNum>)}
                </tr>
              ))}
            </Tabela>
            <p className="mt-3 text-xs text-muted-foreground">
              Dados declarados pelas próprias campanhas ao TSE, ainda sujeitos a retificação. Diferenças entre
              candidatos e partidos são fatos a conferir, não indício de irregularidade por si só.
            </p>
          </Secao>
        </>
      )}
    </div>
  );
}
