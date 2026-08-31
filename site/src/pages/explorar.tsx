import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum, CelulaTexto } from '@/components/app/tabela';
import { SecaoRecolhivel } from '@/components/app/recolhivel';
import { FotoCandidato } from '@/components/app/foto';
import { MapaBrasil, type ValorUF } from '@/components/app/mapa';
import {
  BarrasHorizontais, Dispersao, LinhaTemporal,
  type ItemBarra, type PontoDispersao, type PontoLinha,
} from '@/components/app/graficos';
import { executarSQL, obterConexao, tabelasDisponiveis } from '@/lib/duckdb';
import { brl, num, celula, cnpjCpf, temFichaFornecedor, urlFornecedor } from '@/lib/format';
import { metrica } from '@/lib/metricas';
import {
  FILTROS_VAZIOS, SINAIS_FILTRO, eVisaoReceitas, eVisaoRemocao,
  sqlDispersao, sqlForaDaCurvaCards, sqlPainel, sqlRegistrosSemMovimento, sqlTabelaDaVisao,
  whereDaVisao,
  type Filtros, type SinalFiltro, type Visao,
} from '@/lib/consultas';

const UFS = ['', 'AC', 'AL', 'AM', 'AP', 'BA', 'BR', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const CARGOS = ['', 'Presidente', 'Governador', 'Senador', 'Deputado Federal', 'Deputado Estadual', 'Deputado Distrital'];
const POR_PAGINA = 50;

const VISOES: { id: Visao; rotulo: string; descricao: string }[] = [
  {
    id: 'atual',
    rotulo: 'Todos os gastos',
    descricao: 'Estado atual das despesas declaradas ao TSE.',
  },
  {
    id: 'ranking',
    rotulo: 'Quem mais gastou',
    descricao:
      'O mesmo recorte somado por candidato, do maior para o menor. Com os filtros, vira o ranking do que você quiser: quem mais gastou no seu estado, no cargo, no partido — ou num tipo de gasto específico. A coluna Arrecadado é a receita total já declarada pela candidatura, não só a parte do recorte.',
  },
  {
    id: 'fora-da-curva',
    rotulo: 'Fora da curva',
    descricao:
      'Candidatos acima do p95 do próprio grupo de comparação (mesmo cargo e UF; âmbito nacional quando o grupo local é pequeno) em ao menos uma métrica. Estar fora da curva não é irregularidade — é onde vale perguntar. Refine por UF, cargo, partido ou nome.',
  },
  {
    id: 'removidas',
    rotulo: 'Despesas removidas',
    descricao:
      'Despesas que estavam declaradas e deixaram de estar. Não entram aqui as retransmissões renumeradas pelo TSE nem as retificações (a mesma declaração reaparecendo com um campo corrigido). É indício, não acusação.',
  },
  {
    id: 'removidas-receitas',
    rotulo: 'Receitas removidas',
    descricao:
      'Doações e repasses que estavam declarados e deixaram de estar (retransmissões renumeradas pelo sistema do TSE não contam). Pode ser correção legítima — é indício, não acusação.',
  },
  {
    id: 'compartilhados',
    rotulo: 'Fornecedores compartilhados',
    descricao:
      'Só despesas com empresas que atendem mais de um candidato dentro do recorte filtrado — mercado consolidado ou campanhas casadas; o contexto decide.',
  },
  {
    id: 'sem-nota',
    rotulo: 'Sem documento fiscal',
    descricao:
      'Gastos com empresas, documentados sem nota nem cupom fiscal, em tipos de gasto que costumam ter documento fiscal. Ficam de fora as categorias em que a nota não é o documento próprio (transferências, tributos, aluguel, pessoal) e aquelas em que quase ninguém emite nota — impulsionamento, honorários, militância. Pessoa física também fica de fora: ela não emite nota.',
  },
  {
    id: 'pessoa-fisica',
    rotulo: 'Pessoas físicas',
    descricao: 'Despesas com fornecedores pessoa física — serviços relevantes merecem checagem de vínculo.',
  },
];

interface CandidatoEncontrado {
  sq: string;
  nome: string;
  numero: string;
  partido: string;
  cargo: string;
  uf: string;
  contratado: number;
}

/** Card da visão fora-da-curva: sinais estruturados (para os chips) + foto. */
interface CandidatoFora {
  sq: string;
  nome: string;
  partidoUf: string;
  cargo: string;
  contratado: number;
  arrecadado: number | null;
  cdEleicao: string | null;
  sgUe: string | null;
  sinais: { metrica: string; valor: number; p95: number }[];
}

interface Dados {
  kpis: { contratado: number; candidatos: number; fornecedores: number; itens: number };
  encontrados: CandidatoEncontrado[];
  /** registros de candidatura que batem com a busca mas ainda sem movimento */
  registrados: CandidatoEncontrado[];
  categorias: ItemBarra[];
  candidatos: ItemBarra[];
  porDia: PontoLinha[];
  mapa: ValorUF[];
  dispersao: PontoDispersao[] | null;
  foraDaCurva: CandidatoFora[] | null;
  linhas: unknown[][];
  colunas: string[];
}

const LIMITE_DISPERSAO = 1500;

/** Dispersão só faz sentido no recorte por UF/cargo/partido — filtros de texto
 *  (candidato, fornecedor, descrição) recortam despesas, não candidatos. */
async function consultarDispersao(f: Filtros): Promise<PontoDispersao[] | null> {
  // tabelasDisponiveis só é populado quando o motor termina de iniciar; esta
  // função roda em paralelo com as demais consultas e, no primeiro load da
  // página, checaria um Set ainda vazio — aguarde a conexão antes de decidir.
  await obterConexao();
  if (!tabelasDisponiveis.has('indicadores')) return null;
  const sql = sqlDispersao(f, LIMITE_DISPERSAO);
  if (!sql) return null;
  const r = await executarSQL(sql);
  return r.linhas.map((l) => ({
    sq: String(l[0]),
    rotulo: String(l[1]),
    x: Number(l[2] ?? 0),
    y: Number(l[3] ?? 0),
  }));
}

const seletor =
  'h-9 min-w-0 rounded-md border bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function Explorar() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const iniciais: Filtros = {
    ...FILTROS_VAZIOS,
    uf: params.get('uf') ?? '',
    cargo: params.get('cargo') ?? '',
    partido: params.get('partido') ?? '',
    candidato: params.get('candidato') ?? '',
    fornecedor: params.get('fornecedor') ?? '',
    descricao: params.get('descricao') ?? '',
  };
  const visaoParam = params.get('visao');
  const [visao, setVisao] = useState<Visao>(
    VISOES.some((v) => v.id === visaoParam) ? (visaoParam as Visao) : 'atual',
  );
  const sinalParam = params.get('sinal');
  const [sinal, setSinal] = useState<SinalFiltro>(
    SINAIS_FILTRO.some((s) => s === sinalParam) ? (sinalParam as SinalFiltro) : '',
  );
  const [categoria, setCategoria] = useState(params.get('categoria') ?? '');
  const [categorias, setCategorias] = useState<string[]>([]);

  useEffect(() => {
    if (visao !== 'fora-da-curva' || categorias.length) return;
    executarSQL("SELECT DISTINCT DS_ORIGEM_DESPESA FROM benchmark_categorias ORDER BY 1")
      .then((r) => setCategorias(r.linhas.map((l) => String(l[0]))))
      .catch(() => {});
  }, [visao, categorias.length]);
  const [filtros, setFiltros] = useState<Filtros>(iniciais);
  const [digitado, setDigitado] = useState({
    candidato: iniciais.candidato,
    fornecedor: iniciais.fornecedor,
    descricao: iniciais.descricao,
  });
  const [partidos, setPartidos] = useState<string[]>([]);
  const [pagina, setPagina] = useState(0);
  const [dados, setDados] = useState<Dados | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    executarSQL("SELECT DISTINCT SG_PARTIDO FROM despesas_atual WHERE SG_PARTIDO <> '#NULO' ORDER BY 1")
      .then((r) => setPartidos(r.linhas.map((l) => String(l[0]))))
      .catch(() => {});
  }, []);

  const consultar = useCallback(async (f: Filtros, pag: number, v: Visao, s: SinalFiltro, cat: string) => {
    setCarregando(true);
    setErro(null);
    try {
      // espera o boot antes de checar tabelasDisponiveis: na primeira consulta o
      // Set ainda está vazio e a régua do "sem documento fiscal" cairia no
      // fallback (lista fixa) mesmo com norma_documento publicada
      await obterConexao();
      const { base, where: w } = whereDaVisao(v, f, s, cat, tabelasDisponiveis.has('norma_documento'));
      const buscando = v === 'atual' && Boolean(f.candidato.trim());
      const [encontrados, registrados] = await Promise.all([
        buscando
          ? executarSQL(`
            SELECT SQ_CANDIDATO, ANY_VALUE(NM_CANDIDATO), ANY_VALUE(NR_CANDIDATO),
                   ANY_VALUE(SG_PARTIDO), ANY_VALUE(DS_CARGO), ANY_VALUE(SG_UF),
                   ROUND(SUM(valor), 2) AS total
            FROM despesas_atual
            WHERE ${w}
            GROUP BY 1 ORDER BY total DESC LIMIT 100`)
          : Promise.resolve({ linhas: [] as unknown[][] }),
        // quem se registrou mas nunca declarou nada não existe em despesas_atual;
        // sem esta consulta a busca "não encontra" 72% das candidaturas.
        // (sem checar tabelasDisponiveis: no primeiro load o Set ainda está
        // vazio — o executarSQL espera a conexão e o catch cobre parquet ausente)
        buscando
          ? executarSQL(sqlRegistrosSemMovimento(f, 100)).catch(() => ({ linhas: [] as unknown[][] }))
          : Promise.resolve({ linhas: [] as unknown[][] }),
      ]);
      const tabelaSQL = sqlTabelaDaVisao(v, base, w, f, cat, pag, POR_PAGINA);
      const painel = sqlPainel(base, w, v);
      // cards do fora-da-curva: tenta com os metadados da foto; parquet de
      // candidatos antigo (sem CD_ELEICAO/SG_UE) cai na variante sem foto
      const consultarForaDaCurva = async (): Promise<CandidatoFora[]> => {
        await obterConexao();
        let r;
        try {
          r = await executarSQL(sqlForaDaCurvaCards(f, s, pag, POR_PAGINA, tabelasDisponiveis.has('candidatos')));
        } catch {
          r = await executarSQL(sqlForaDaCurvaCards(f, s, pag, POR_PAGINA, false));
        }
        return r.linhas.map((l) => ({
          sq: String(l[0]),
          nome: String(l[1]),
          partidoUf: String(l[2]),
          cargo: String(l[3]),
          contratado: Number(l[4] ?? 0),
          arrecadado: l[5] == null ? null : Number(l[5]),
          cdEleicao: l[6] == null ? null : String(l[6]),
          sgUe: l[7] == null ? null : String(l[7]),
          sinais: String(l[10] ?? '')
            .split(';')
            .filter(Boolean)
            .map((par) => {
              const [metrica, valor, p95] = par.split('~');
              return { metrica, valor: Number(valor), p95: Number(p95) };
            }),
        }));
      };
      const eCards = v === 'fora-da-curva' && !cat;
      const [kpis, categorias, candidatos, porDia, mapa, tabela, dispersao, foraDaCurva] = await Promise.all([
        executarSQL(painel.kpis),
        executarSQL(painel.categorias),
        executarSQL(painel.candidatos),
        executarSQL(painel.porDia),
        executarSQL(painel.mapa),
        eCards ? Promise.resolve({ colunas: [] as string[], linhas: [] as unknown[][] }) : executarSQL(tabelaSQL),
        v === 'atual' ? consultarDispersao(f) : Promise.resolve(null),
        eCards ? consultarForaDaCurva() : Promise.resolve(null),
      ]);
      const [contratado, nCand, nForn, itens] = kpis.linhas[0] ?? [0, 0, 0, 0];
      setDados({
        encontrados: encontrados.linhas.map((l) => ({
          sq: String(l[0]),
          nome: String(l[1]),
          numero: String(l[2]),
          partido: String(l[3]),
          cargo: String(l[4]),
          uf: String(l[5]),
          contratado: Number(l[6] ?? 0),
        })),
        registrados: registrados.linhas.map((l) => ({
          sq: String(l[0]),
          nome: `${l[1]}${l[2] && l[2] !== l[1] ? ` (${l[2]})` : ''}`,
          numero: String(l[3] ?? ''),
          partido: String(l[4] ?? ''),
          cargo: String(l[5] ?? ''),
          uf: String(l[6] ?? ''),
          contratado: 0,
        })),
        kpis: {
          contratado: Number(contratado ?? 0),
          candidatos: Number(nCand ?? 0),
          fornecedores: Number(nForn ?? 0),
          itens: Number(itens ?? 0),
        },
        categorias: categorias.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1]) })),
        candidatos: candidatos.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1]) })),
        porDia: porDia.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[2]) })),
        mapa: mapa.linhas.map((l) => ({ uf: String(l[0]), valor: Number(l[1] ?? 0) })),
        dispersao,
        foraDaCurva,
        colunas: tabela.colunas,
        linhas: tabela.linhas,
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    const foraDaCurva = visao === 'fora-da-curva';
    void consultar(filtros, pagina, visao, foraDaCurva ? sinal : '', foraDaCurva ? categoria : '');
  }, [filtros, pagina, visao, sinal, categoria, consultar]);

  function mudar(parcial: Partial<Filtros>) {
    setPagina(0);
    setFiltros((f) => ({ ...f, ...parcial }));
  }

  /** Clique no mapa: alterna a UF na seleção (o filtro aceita várias, por vírgula). */
  function alternarUF(uf: string) {
    const atual = filtros.uf ? filtros.uf.split(',').filter(Boolean) : [];
    const nova = atual.includes(uf) ? atual.filter((u) => u !== uf) : [...atual, uf];
    mudar({ uf: nova.join(',') });
  }

  function limparFiltros() {
    setPagina(0);
    setSinal('');
    setCategoria('');
    setDigitado({ candidato: '', fornecedor: '', descricao: '' });
    setFiltros(FILTROS_VAZIOS);
  }

  // micro-barras da coluna monetária principal: proporção contra o maior da página
  const idxBarra = dados ? dados.colunas.findIndex((c) => c === 'Valor' || c === 'Total') : -1;
  const maxBarra = dados && idxBarra >= 0
    ? Math.max(...dados.linhas.map((l) => Number(l[idxBarra] ?? 0)), 0)
    : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6 sm:py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Explorar</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Navegue pelos gastos</h1>
        <p className="mt-3 max-w-3xl leading-relaxed text-muted-foreground">
          Escolha uma visão, combine com os filtros — candidato (nome ou número), fornecedor
          (nome ou CNPJ), descrição do gasto — e tudo roda no seu navegador.
        </p>
      </div>

      <div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Visão">
          {VISOES.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={visao === v.id}
              onClick={() => {
                setPagina(0);
                setVisao(v.id);
              }}
              className={
                visao === v.id
                  ? 'rounded-full bg-gradient-to-r from-[#10244A] to-[#264E9B] px-4 py-1.5 text-sm font-semibold text-white shadow-sm'
                  : 'rounded-full border bg-card px-4 py-1.5 text-sm text-muted-foreground shadow-sm transition-colors hover:border-[#264E9B]/40 hover:text-foreground'
              }
            >
              {v.rotulo}
            </button>
          ))}
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {VISOES.find((v) => v.id === visao)?.descricao}
        </p>
        {visao === 'fora-da-curva' && (
          <div className="mt-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Fora da curva em">
            <span className="w-full text-xs font-semibold uppercase tracking-widest text-muted-foreground sm:w-auto">
              Fora da curva em:
            </span>
            {(['', ...SINAIS_FILTRO] as SinalFiltro[]).map((s) => (
              <button
                key={s || 'qualquer'}
                role="tab"
                aria-selected={sinal === s && !categoria}
                onClick={() => {
                  setPagina(0);
                  setCategoria('');
                  setSinal(s);
                }}
                className={
                  sinal === s && !categoria
                    ? 'rounded-full bg-[#B45309] px-3 py-1 text-xs font-semibold text-white shadow-sm'
                    : 'rounded-full border border-[#B45309]/30 bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:border-[#B45309]/60 hover:text-foreground'
                }
              >
                {s ? metrica(s).rotulo : 'Qualquer sinal'}
              </button>
            ))}
            {categorias.length > 0 && (
              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                ou por tipo de gasto:
                <select
                  value={categoria}
                  onChange={(e) => {
                    setPagina(0);
                    setSinal('');
                    setCategoria(e.target.value);
                  }}
                  aria-label="Fora da curva por tipo de gasto"
                  className={`h-7 max-w-72 rounded-full border bg-card px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${categoria ? 'border-[#B45309] font-semibold text-foreground' : 'border-[#B45309]/30'}`}
                >
                  <option value="">— escolha a categoria —</option>
                  {categorias.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </div>

      <form
        /* grade de duas colunas no celular: em `flex-wrap` os campos de 13rem
           sobravam sozinhos por linha, com metade da tela vazia ao lado */
        className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mudar(digitado);
        }}
      >
        <select className={seletor} value={filtros.uf} onChange={(e) => mudar({ uf: e.target.value })} aria-label="UF">
          <option value="">Todas as UFs</option>
          {/* seleção múltipla feita no mapa aparece como opção combinada */}
          {filtros.uf.includes(',') && (
            <option value={filtros.uf}>{filtros.uf.replaceAll(',', ' + ')}</option>
          )}
          {UFS.filter(Boolean).map((uf) => <option key={uf}>{uf}</option>)}
        </select>
        <select className={seletor} value={filtros.cargo} onChange={(e) => mudar({ cargo: e.target.value })} aria-label="Cargo">
          <option value="">Todos os cargos</option>
          {CARGOS.filter(Boolean).map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className={seletor} value={filtros.partido} onChange={(e) => mudar({ partido: e.target.value })} aria-label="Partido">
          <option value="">Todos os partidos</option>
          {partidos.map((p) => <option key={p}>{p}</option>)}
        </select>
        <input
          className={`${seletor} col-span-2 w-full sm:w-52`}
          placeholder="Candidato (nome ou nº)"
          value={digitado.candidato}
          onChange={(e) => setDigitado((d) => ({ ...d, candidato: e.target.value }))}
          aria-label="Candidato"
        />
        <input
          className={`${seletor} col-span-2 w-full sm:w-52`}
          placeholder={eVisaoReceitas(visao) ? 'Doador (nome ou CNPJ)' : 'Fornecedor (nome ou CNPJ)'}
          value={digitado.fornecedor}
          onChange={(e) => setDigitado((d) => ({ ...d, fornecedor: e.target.value }))}
          aria-label={eVisaoReceitas(visao) ? 'Doador' : 'Fornecedor'}
        />
        <input
          className={`${seletor} col-span-2 w-full sm:w-52`}
          placeholder={eVisaoReceitas(visao) ? 'Origem ou espécie da receita' : 'Descrição do gasto'}
          value={digitado.descricao}
          onChange={(e) => setDigitado((d) => ({ ...d, descricao: e.target.value }))}
          aria-label={eVisaoReceitas(visao) ? 'Origem da receita' : 'Descrição'}
        />
        <Button type="submit" variant="secondary" size="sm" className="col-span-2 h-9 gap-1.5 sm:col-span-1 sm:h-8">
          <Search className="h-4 w-4" /> Filtrar
        </Button>
      </form>

      {erro && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-foreground">
          {erro}
        </div>
      )}

      {carregando && !dados ? (
        // esqueleto com a forma da página: a espera do DuckDB-WASM (motor +
        // parquet) é longa na primeira visita e a tela em branco parecia travada
        <div aria-hidden className="space-y-6">
          <div className="flex items-start gap-3 text-sm text-muted-foreground">
            <Spinner className="mt-0.5 h-4 w-4 shrink-0" /> Preparando o motor de consultas no seu navegador —
            só na primeira visita, as próximas são rápidas…
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border bg-card shadow-sm" />
            ))}
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="h-64 animate-pulse rounded-xl border bg-card shadow-sm" />
            <div className="h-64 animate-pulse rounded-xl border bg-card shadow-sm" />
          </div>
          <div className="h-72 animate-pulse rounded-xl border bg-card shadow-sm" />
        </div>
      ) : dados ? (
        <div className={carregando ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {filtros.candidato.trim() && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="text-base">
                  Candidatos encontrados{dados.encontrados.length ? ` (${dados.encontrados.length})` : ''}
                </CardTitle>
                <CardDescription>
                  Clique no nome para abrir a ficha completa, com gráficos e indícios do candidato.
                  Os números e gráficos abaixo somam este recorte.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {dados.encontrados.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhum candidato com esse {/^\d+$/.test(filtros.candidato.trim()) ? 'número' : 'nome'} tem
                    gastos declarados nesse recorte.
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto">
                    <Tabela colunas={[
                      { titulo: 'Candidato' }, { titulo: 'Número' }, { titulo: 'Cargo' },
                      { titulo: 'Partido/UF' }, { titulo: 'Contratado', numerica: true },
                    ]}>
                      {dados.encontrados.map((c) => (
                        <tr key={c.sq} className="hover:bg-muted/40">
                          <td>
                            <Link to={`/candidato/${c.sq}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                              {c.nome}
                            </Link>
                          </td>
                          <td className="tabular-nums">{c.numero}</td>
                          <td className="text-muted-foreground">{c.cargo}</td>
                          <td>
                            <Link to={`/partido/${encodeURIComponent(c.partido)}`} className="hover:underline">
                              {c.partido}
                            </Link>/{c.uf}
                          </td>
                          <CelulaNum>{brl.format(c.contratado)}</CelulaNum>
                        </tr>
                      ))}
                    </Tabela>
                  </div>
                )}
                {dados.registrados.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      Registrados sem movimento declarado ({dados.registrados.length})
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Candidaturas registradas que ainda não declararam nenhuma despesa ou receita —
                      a ficha registra esse fato.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {dados.registrados.map((c) => (
                        <Link
                          key={c.sq}
                          to={`/candidato/${c.sq}`}
                          className="rounded-full border px-3 py-1 text-xs text-[#264E9B] underline-offset-4 hover:underline"
                        >
                          {c.nome} · {c.cargo} · {c.partido}/{c.uf}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                // os rótulos acompanham a visão: em "removidas" os números são
                // o que SAIU da declaração, não o que está contratado hoje
                {
                  rotulo: eVisaoRemocao(visao)
                    ? 'Valor removido' : 'Despesas contratadas',
                  valor: brl.format(dados.kpis.contratado),
                },
                { rotulo: 'Candidatos', valor: num.format(dados.kpis.candidatos) },
                {
                  rotulo: eVisaoReceitas(visao) ? 'Doadores' : 'Fornecedores',
                  valor: num.format(dados.kpis.fornecedores),
                },
                {
                  rotulo: eVisaoRemocao(visao)
                    ? 'Itens removidos' : 'Itens declarados',
                  valor: num.format(dados.kpis.itens),
                },
              ].map((k) => (
                <Card key={k.rotulo}>
                  <CardContent className="p-5 sm:p-5">
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{k.rotulo}</p>
                    <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">{k.valor}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {eVisaoReceitas(visao) ? 'De onde vinha o dinheiro' : 'Para onde vai o dinheiro'}
                  </CardTitle>
                  <CardDescription>
                    {eVisaoReceitas(visao)
                      ? 'Origens das receitas removidas, pelo valor.'
                      : 'Categorias de gasto, pelo total contratado.'}
                  </CardDescription>
                </CardHeader>
                <CardContent><BarrasHorizontais dados={dados.categorias} /></CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {eVisaoRemocao(visao)
                      ? 'Candidatos com mais valor removido'
                      : 'Quem mais contratou'}
                  </CardTitle>
                  <CardDescription>
                    {eVisaoRemocao(visao)
                      ? 'Os dez candidatos com mais valor removido no recorte.'
                      : 'Os dez candidatos com maior despesa no recorte.'}
                  </CardDescription>
                </CardHeader>
                <CardContent><BarrasHorizontais dados={dados.candidatos} /></CardContent>
              </Card>
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">
                        {eVisaoRemocao(visao)
                          ? 'Onde houve remoção'
                          : 'Onde está o dinheiro'}
                      </CardTitle>
                      <CardDescription className="mt-1.5">
                        Distribuição do recorte pelas UFs — clique nos estados para filtrar
                        (a seleção acumula).
                      </CardDescription>
                    </div>
                    {filtros.uf && (
                      <Button variant="outline" size="sm" onClick={() => mudar({ uf: '' })}>
                        Limpar seleção ({filtros.uf.split(',').filter(Boolean).length})
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <MapaBrasil
                    dados={dados.mapa}
                    selecionada={filtros.uf}
                    aoClicar={alternarUF}
                    rotuloValor={eVisaoRemocao(visao)
                      ? 'valor removido' : 'valor do recorte'}
                  />
                </CardContent>
              </Card>
              {/* gráficos secundários recolhidos: quem quiser expande — a página
                  não vira um paredão de visualizações */}
              <div className="space-y-6">
                <SecaoRecolhivel
                  titulo={eVisaoReceitas(visao)
                    ? 'Receita declarada por dia da doação'
                    : 'Gasto declarado por dia da despesa'}
                  descricao={eVisaoReceitas(visao)
                    ? 'Soma dos valores pela data em que a doação foi recebida.'
                    : 'Soma dos valores pela data em que a despesa foi realizada.'}
                >
                  <LinhaTemporal pontos={dados.porDia} />
                </SecaoRecolhivel>
                {dados.dispersao && dados.dispersao.length >= 3 && (
                  <SecaoRecolhivel
                    titulo="Arrecadado × contratado, candidato a candidato"
                    descricao={`Cada ponto é um candidato do recorte${
                      dados.dispersao.length >= LIMITE_DISPERSAO
                        ? ` (os ${num.format(LIMITE_DISPERSAO)} de maior movimentação)`
                        : ''
                    }. Acima da linha tracejada, contratou mais do que declarou arrecadar. Clique num ponto para abrir a ficha.`}
                  >
                    <Dispersao
                      pontos={dados.dispersao}
                      aoClicar={(p) => p.sq && navigate(`/candidato/${p.sq}`)}
                    />
                  </SecaoRecolhivel>
                )}
              </div>
            </div>

          <div className="mt-6">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {visao === 'ranking'
                  ? 'Candidatos do recorte, quem mais gastou primeiro'
                  : visao === 'compartilhados'
                  ? 'Fornecedores compartilhados do recorte, maiores primeiro'
                  : visao === 'removidas'
                    ? 'Despesas removidas do recorte, maiores primeiro'
                    : visao === 'removidas-receitas'
                    ? 'Receitas removidas do recorte, maiores primeiro'
                    : visao === 'fora-da-curva'
                      ? categoria
                        ? `Fora da curva em "${categoria}" — quem mais gasta acima do p95 do grupo primeiro`
                        : 'Candidatos fora da curva do recorte — mais sinais primeiro (os gráficos acima mostram os gastos deles)'
                      : 'Despesas do recorte, maiores primeiro'} — página {pagina + 1}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={pagina === 0 || carregando} onClick={() => setPagina((p) => p - 1)}>
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={carregando || (dados.foraDaCurva ?? dados.linhas).length < POR_PAGINA}
                  onClick={() => setPagina((p) => p + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
            {dados.foraDaCurva ? (
              dados.foraDaCurva.length === 0 && !carregando ? (
                <div className="rounded-xl border bg-card p-8 text-center shadow-sm">
                  <p className="text-sm text-muted-foreground">
                    Ninguém fora da curva com esses filtros — o que também é uma informação.
                  </p>
                  <Button variant="outline" size="sm" className="mt-4" onClick={limparFiltros}>
                    Limpar filtros
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {dados.foraDaCurva.map((c) => (
                    <div key={c.sq} className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm sm:gap-4">
                      <Link to={`/candidato/${c.sq}`} tabIndex={-1} aria-hidden>
                        <FotoCandidato
                          cdEleicao={c.cdEleicao}
                          sq={c.sq}
                          sgUe={c.sgUe}
                          nome={c.nome}
                          className="h-12 w-12 text-sm"
                        />
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <Link
                            to={`/candidato/${c.sq}`}
                            className="font-semibold text-[#264E9B] underline-offset-4 hover:underline"
                          >
                            {c.nome}
                          </Link>
                          <span className="text-sm text-muted-foreground">
                            {c.partidoUf} · {c.cargo} · contratou {brl.format(c.contratado)}
                            {c.arrecadado != null && <> · arrecadou {brl.format(c.arrecadado)}</>}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {c.sinais.map((si) => {
                            const m = metrica(si.metrica);
                            const selecionado = sinal === si.metrica;
                            return (
                              <button
                                key={si.metrica}
                                onClick={() => {
                                  setPagina(0);
                                  setCategoria('');
                                  setSinal(selecionado ? '' : (si.metrica as SinalFiltro));
                                }}
                                title={`corte do grupo (p95): ${m.formatar(si.p95)} — clique para ${selecionado ? 'limpar o filtro deste sinal' : 'ver todos fora da curva neste sinal'}`}
                                /* inline-block: rótulo, valor e corte fluem como texto e
                                   quebram naturalmente no celular (em flex viravam colunas) */
                                className={
                                  selecionado
                                    ? 'inline-block rounded-2xl border border-[#B45309] bg-[#B45309] px-3 py-1 text-left text-xs font-medium leading-relaxed text-white sm:rounded-full'
                                    : 'inline-block rounded-2xl border border-[#B45309]/40 bg-[#B45309]/10 px-3 py-1 text-left text-xs font-medium leading-relaxed text-[#7c3a06] transition-colors hover:border-[#B45309] hover:bg-[#B45309]/20 sm:rounded-full'
                                }
                              >
                                <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-3px]" />
                                {m.frase(si.valor)}{' '}
                                <span className={selecionado ? 'text-white/75' : 'text-[#7c3a06]/70'}>
                                  · corte (p95): {m.formatar(si.p95)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : dados.linhas.length === 0 && !carregando ? (
              <div className="rounded-xl border bg-card p-8 text-center shadow-sm">
                <p className="text-sm text-muted-foreground">
                  Nada encontrado com esses filtros neste recorte — o que também é uma informação.
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={limparFiltros}>
                  Limpar filtros
                </Button>
              </div>
            ) : (
            <Tabela colunas={dados.colunas.filter((c) => !c.startsWith('_')).map((c) => ({
              titulo: c,
              numerica: ['Valor', 'Total', 'Candidatos', 'Partidos', 'Contratado', 'Arrecadado', 'Sinais', 'Neste sinal', 'Neste tipo de gasto', 'p95 do grupo', 'Itens', 'Fornecedores'].includes(c),
            }))}>
              {dados.linhas.map((l, i) => (
                <tr key={i} className="hover:bg-muted/40">
                  {l.map((v, j) => {
                    const col = dados.colunas[j];
                    if (col.startsWith('_')) return null;
                    if (col === 'Valor' || col === 'Total')
                      return (
                        <CelulaNum key={j} frac={maxBarra > 0 ? Number(v ?? 0) / maxBarra : undefined}>
                          {brl.format(Number(v ?? 0))}
                        </CelulaNum>
                      );
                    if (col === 'Contratado')
                      return <CelulaNum key={j}>{brl.format(Number(v ?? 0))}</CelulaNum>;
                    if (col === 'Arrecadado')
                      return <CelulaNum key={j}>{v == null ? '—' : brl.format(Number(v))}</CelulaNum>;
                    if (col === 'Neste sinal' || col === 'Neste tipo de gasto' || col === 'p95 do grupo') {
                      const fmt = sinal ? metrica(sinal).formatar : (n: number) => brl.format(n);
                      return <CelulaNum key={j}>{v == null ? '—' : fmt(Number(v))}</CelulaNum>;
                    }
                    if (col === 'Candidatos' || col === 'Partidos' || col === 'Sinais'
                        || col === 'Itens' || col === 'Fornecedores')
                      return <CelulaNum key={j}>{num.format(Number(v ?? 0))}</CelulaNum>;
                    if (col === 'Descrição' || col === 'Acima do típico do grupo em')
                      return <CelulaTexto key={j}>{celula(v)}</CelulaTexto>;
                    if (col === 'CNPJ/CPF')
                      return <td key={j} className="whitespace-nowrap text-muted-foreground">{cnpjCpf(celula(v))}</td>;
                    if (col === 'Candidato')
                      return (
                        <td key={j} className="min-w-[13rem]">
                          <Link to={`/candidato/${celula(l[0])}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                            {celula(v)}
                          </Link>
                        </td>
                      );
                    if (col === 'Fornecedor' || col === 'Doador')
                      return (
                        <td key={j} className="min-w-[12rem]">
                          {temFichaFornecedor(celula(l[1])) ? (
                            <Link to={urlFornecedor(celula(l[1]))} className="text-[#264E9B] underline-offset-4 hover:underline">
                              {celula(v)}
                            </Link>
                          ) : (
                            celula(v)
                          )}
                        </td>
                      );
                    return <td key={j}>{celula(v)}</td>;
                  })}
                </tr>
              ))}
            </Tabela>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
