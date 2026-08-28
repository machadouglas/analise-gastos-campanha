import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum } from '@/components/app/tabela';
import {
  BarrasHorizontais, Dispersao, LinhaTemporal,
  type ItemBarra, type PontoDispersao, type PontoLinha,
} from '@/components/app/graficos';
import { executarSQL, tabelasDisponiveis } from '@/lib/duckdb';
import { brl, num, celula, cnpjCpf, temFichaFornecedor, urlFornecedor } from '@/lib/format';

const UFS = ['', 'AC', 'AL', 'AM', 'AP', 'BA', 'BR', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const CARGOS = ['', 'Presidente', 'Governador', 'Senador', 'Deputado Federal', 'Deputado Estadual', 'Deputado Distrital'];
const POR_PAGINA = 50;

interface Filtros {
  uf: string;
  cargo: string;
  partido: string;
  candidato: string;
  fornecedor: string;
  descricao: string;
}

const FILTROS_VAZIOS: Filtros = { uf: '', cargo: '', partido: '', candidato: '', fornecedor: '', descricao: '' };

/** Visões: recortes prontos que respondem uma pergunta e aceitam os demais filtros. */
type Visao = 'atual' | 'removidas' | 'compartilhados' | 'sem-nota' | 'pessoa-fisica';

const VISOES: { id: Visao; rotulo: string; descricao: string }[] = [
  {
    id: 'atual',
    rotulo: 'Todos os gastos',
    descricao: 'Estado atual das despesas declaradas ao TSE.',
  },
  {
    id: 'removidas',
    rotulo: 'Declarações removidas',
    descricao:
      'Despesas que estavam declaradas e deixaram de estar (retransmissões renumeradas pelo sistema do TSE não contam). Pode ser correção legítima — é indício, não acusação.',
  },
  {
    id: 'compartilhados',
    rotulo: 'Fornecedores compartilhados',
    descricao:
      'Só despesas com empresas que atendem mais de um candidato dentro do recorte filtrado — mercado consolidado ou campanhas casadas; o contexto decide.',
  },
  {
    id: 'sem-nota',
    rotulo: 'Sem nota fiscal',
    descricao:
      'Despesas documentadas sem nota fiscal, fora das categorias em que a nota não é o documento próprio (transferências, tributos, aluguel de imóvel, pessoal).',
  },
  {
    id: 'pessoa-fisica',
    rotulo: 'Pessoas físicas',
    descricao: 'Despesas com fornecedores pessoa física — serviços relevantes merecem checagem de vínculo.',
  },
];

// manter em sincronia com CATEGORIAS_SEM_NOTA_ESPERADA em src/analises.py
const CATEGORIAS_SEM_NOTA_ESPERADA = [
  'Doações financeiras a outros candidatos/partidos',
  'Encargos financeiros, taxas bancárias e/ou op. cartão de crédito',
  'Encargos sociais',
  'Impostos, contribuições e taxas',
  'Locação/cessão de bens imóveis',
  'Despesas com pessoal',
];

function whereDaVisao(visao: Visao, w: string): { base: string; where: string } {
  if (visao === 'removidas') return { base: 'despesas_removidas', where: w };
  if (visao === 'sem-nota') {
    const categorias = CATEGORIAS_SEM_NOTA_ESPERADA.map((c) => `'${c.replaceAll("'", "''")}'`).join(', ');
    return {
      base: 'despesas_atual',
      where:
        `${w} AND (DS_TIPO_DOCUMENTO IS NULL OR DS_TIPO_DOCUMENTO = '#NULO'` +
        ` OR DS_TIPO_DOCUMENTO NOT ILIKE '%nota fiscal%') AND DS_ORIGEM_DESPESA NOT IN (${categorias})`,
    };
  }
  if (visao === 'pessoa-fisica') {
    return { base: 'despesas_atual', where: `${w} AND DS_TIPO_FORNECEDOR ILIKE '%f_sica%'` };
  }
  if (visao === 'compartilhados') {
    return {
      base: 'despesas_atual',
      where:
        `${w} AND NR_CPF_CNPJ_FORNECEDOR IN (` +
        `SELECT NR_CPF_CNPJ_FORNECEDOR FROM despesas_atual WHERE ${w}` +
        ` AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')` +
        ` GROUP BY 1 HAVING COUNT(DISTINCT SQ_CANDIDATO) > 1)`,
    };
  }
  return { base: 'despesas_atual', where: w };
}

function montarWhere(f: Filtros): string {
  const partes = ['1=1'];
  const esc = (s: string) => s.replaceAll("'", "''");
  if (f.uf) partes.push(`SG_UF = '${esc(f.uf)}'`);
  if (f.cargo) partes.push(`DS_CARGO ILIKE '${esc(f.cargo)}'`);
  if (f.partido) partes.push(`SG_PARTIDO = '${esc(f.partido)}'`);
  const cand = f.candidato.trim();
  if (cand) {
    partes.push(
      /^\d+$/.test(cand)
        ? `NR_CANDIDATO = '${cand}'`
        : `NM_CANDIDATO ILIKE '%${esc(cand)}%'`,
    );
  }
  const forn = f.fornecedor.trim();
  if (forn) {
    partes.push(
      /^[\d./-]+$/.test(forn)
        ? `NR_CPF_CNPJ_FORNECEDOR LIKE '${forn.replace(/\D/g, '')}%'`
        : `(NM_FORNECEDOR ILIKE '%${esc(forn)}%' OR NM_FORNECEDOR_RFB ILIKE '%${esc(forn)}%')`,
    );
  }
  const desc = f.descricao.trim();
  if (desc) {
    partes.push(`(DS_DESPESA ILIKE '%${esc(desc)}%' OR DS_ORIGEM_DESPESA ILIKE '%${esc(desc)}%')`);
  }
  return partes.join(' AND ');
}

interface CandidatoEncontrado {
  sq: string;
  nome: string;
  numero: string;
  partido: string;
  cargo: string;
  uf: string;
  contratado: number;
}

interface Dados {
  kpis: { contratado: number; candidatos: number; fornecedores: number; itens: number };
  encontrados: CandidatoEncontrado[];
  categorias: ItemBarra[];
  candidatos: ItemBarra[];
  porDia: PontoLinha[];
  dispersao: PontoDispersao[] | null;
  linhas: unknown[][];
  colunas: string[];
}

const LIMITE_DISPERSAO = 1500;

/** Dispersão só faz sentido no recorte por UF/cargo/partido — filtros de texto
 *  (candidato, fornecedor, descrição) recortam despesas, não candidatos. */
async function consultarDispersao(f: Filtros): Promise<PontoDispersao[] | null> {
  if (!tabelasDisponiveis.has('indicadores')) return null;
  if (f.candidato.trim() || f.fornecedor.trim() || f.descricao.trim()) return null;
  const esc = (s: string) => s.replaceAll("'", "''");
  const partes = ['(total_contratado > 0 OR COALESCE(total_receitas, 0) > 0)'];
  if (f.uf) partes.push(`SG_UF = '${esc(f.uf)}'`);
  if (f.cargo) partes.push(`DS_CARGO ILIKE '${esc(f.cargo)}'`);
  if (f.partido) partes.push(`SG_PARTIDO = '${esc(f.partido)}'`);
  const r = await executarSQL(`
      SELECT SQ_CANDIDATO, NM_CANDIDATO || ' (' || SG_PARTIDO || '/' || SG_UF || ')',
             COALESCE(total_receitas, 0), total_contratado
      FROM indicadores WHERE ${partes.join(' AND ')}
      ORDER BY total_contratado + COALESCE(total_receitas, 0) DESC
      LIMIT ${LIMITE_DISPERSAO}`);
  return r.linhas.map((l) => ({
    sq: String(l[0]),
    rotulo: String(l[1]),
    x: Number(l[2] ?? 0),
    y: Number(l[3] ?? 0),
  }));
}

const seletor =
  'h-9 rounded-md border bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

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

  const consultar = useCallback(async (f: Filtros, pag: number, v: Visao) => {
    setCarregando(true);
    setErro(null);
    try {
      const { base, where: w } = whereDaVisao(v, montarWhere(f));
      const encontrados = v === 'atual' && f.candidato.trim()
        ? await executarSQL(`
            SELECT SQ_CANDIDATO, ANY_VALUE(NM_CANDIDATO), ANY_VALUE(NR_CANDIDATO),
                   ANY_VALUE(SG_PARTIDO), ANY_VALUE(DS_CARGO), ANY_VALUE(SG_UF),
                   ROUND(SUM(valor), 2) AS total
            FROM despesas_atual
            WHERE ${w}
            GROUP BY 1 ORDER BY total DESC LIMIT 100`)
        : { linhas: [] as unknown[][] };
      const colunaExtra =
        v === 'sem-nota'
          ? 'DS_TIPO_DOCUMENTO AS "Documento",'
          : v === 'removidas'
            ? 'STRFTIME(dt_ultima_extracao, \'%d/%m/%Y\') AS "Visível até",'
            : '';
      const tabelaSQL =
        v === 'compartilhados'
          ? `SELECT NULL AS "_sq", NR_CPF_CNPJ_FORNECEDOR AS "_cnpj",
                    COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS "Fornecedor",
                    NR_CPF_CNPJ_FORNECEDOR AS "CNPJ/CPF",
                    COUNT(DISTINCT SQ_CANDIDATO) AS "Candidatos",
                    COUNT(DISTINCT SG_PARTIDO) AS "Partidos",
                    STRING_AGG(DISTINCT SG_UF, ', ') AS "UFs",
                    ROUND(SUM(valor), 2) AS "Total"
             FROM ${base} WHERE ${w}
             GROUP BY ALL ORDER BY "Total" DESC LIMIT ${POR_PAGINA} OFFSET ${pag * POR_PAGINA}`
          : `SELECT SQ_CANDIDATO AS "_sq", NR_CPF_CNPJ_FORNECEDOR AS "_cnpj",
                    DT_DESPESA AS "Data", NM_CANDIDATO AS "Candidato",
                    SG_PARTIDO || '/' || SG_UF AS "Partido/UF",
                    COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS "Fornecedor",
                    DS_ORIGEM_DESPESA AS "Categoria", DS_DESPESA AS "Descrição",
                    ${colunaExtra}
                    ROUND(valor, 2) AS "Valor"
             FROM ${base} WHERE ${w}
             ORDER BY valor DESC LIMIT ${POR_PAGINA} OFFSET ${pag * POR_PAGINA}`;
      const [kpis, categorias, candidatos, porDia, tabela, dispersao] = await Promise.all([
        executarSQL(`SELECT ROUND(SUM(valor),2), COUNT(DISTINCT SQ_CANDIDATO),
                            COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR), COUNT(*)
                     FROM ${base} WHERE ${w}`),
        executarSQL(`SELECT DS_ORIGEM_DESPESA, ROUND(SUM(valor),2) AS total
                     FROM ${base} WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`),
        executarSQL(`SELECT NM_CANDIDATO || ' (' || SG_PARTIDO || '/' || SG_UF || ')', ROUND(SUM(valor),2) AS total
                     FROM ${base} WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`),
        executarSQL(`SELECT STRFTIME(STRPTIME(DT_DESPESA, '%d/%m/%Y'), '%d/%m') AS dia,
                            MIN(STRPTIME(DT_DESPESA, '%d/%m/%Y')) AS ord, ROUND(SUM(valor),2) AS total
                     FROM ${base} WHERE ${w} AND DT_DESPESA <> '#NULO'
                     GROUP BY 1 ORDER BY ord`),
        executarSQL(tabelaSQL),
        v === 'atual' ? consultarDispersao(f) : Promise.resolve(null),
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
        kpis: {
          contratado: Number(contratado ?? 0),
          candidatos: Number(nCand ?? 0),
          fornecedores: Number(nForn ?? 0),
          itens: Number(itens ?? 0),
        },
        categorias: categorias.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1]) })),
        candidatos: candidatos.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1]) })),
        porDia: porDia.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[2]) })),
        dispersao,
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
    void consultar(filtros, pagina, visao);
  }, [filtros, pagina, visao, consultar]);

  function mudar(parcial: Partial<Filtros>) {
    setPagina(0);
    setFiltros((f) => ({ ...f, ...parcial }));
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-12">
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
      </div>

      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mudar(digitado);
        }}
      >
        <select className={seletor} value={filtros.uf} onChange={(e) => mudar({ uf: e.target.value })} aria-label="UF">
          <option value="">Todas as UFs</option>
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
          className={`${seletor} w-52`}
          placeholder="Candidato (nome ou nº)"
          value={digitado.candidato}
          onChange={(e) => setDigitado((d) => ({ ...d, candidato: e.target.value }))}
          aria-label="Candidato"
        />
        <input
          className={`${seletor} w-52`}
          placeholder="Fornecedor (nome ou CNPJ)"
          value={digitado.fornecedor}
          onChange={(e) => setDigitado((d) => ({ ...d, fornecedor: e.target.value }))}
          aria-label="Fornecedor"
        />
        <input
          className={`${seletor} w-52`}
          placeholder="Descrição do gasto"
          value={digitado.descricao}
          onChange={(e) => setDigitado((d) => ({ ...d, descricao: e.target.value }))}
          aria-label="Descrição"
        />
        <Button type="submit" variant="secondary" size="sm" className="gap-1.5">
          <Search className="h-4 w-4" /> Filtrar
        </Button>
      </form>

      {erro && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-foreground">
          {erro}
        </div>
      )}

      {carregando && !dados ? (
        <div className="flex min-h-[30vh] items-center justify-center gap-3 text-muted-foreground">
          <Spinner className="h-5 w-5" /> Preparando o motor de consultas no seu navegador…
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
              </CardContent>
            </Card>
          )}
          <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { rotulo: 'Despesas contratadas', valor: brl.format(dados.kpis.contratado) },
                  { rotulo: 'Candidatos', valor: num.format(dados.kpis.candidatos) },
                  { rotulo: 'Fornecedores', valor: num.format(dados.kpis.fornecedores) },
                  { rotulo: 'Itens declarados', valor: num.format(dados.kpis.itens) },
                ].map((k) => (
                  <Card key={k.rotulo}>
                    <CardContent className="p-5">
                      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{k.rotulo}</p>
                      <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">{k.valor}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Para onde vai o dinheiro</CardTitle>
                    <CardDescription>Categorias de gasto, pelo total contratado.</CardDescription>
                  </CardHeader>
                  <CardContent><BarrasHorizontais dados={dados.categorias} /></CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Quem mais contratou</CardTitle>
                    <CardDescription>Os dez candidatos com maior despesa no recorte.</CardDescription>
                  </CardHeader>
                  <CardContent><BarrasHorizontais dados={dados.candidatos} /></CardContent>
                </Card>
              </div>

              <Card className="mt-6">
                <CardHeader>
                  <CardTitle className="text-base">Gasto declarado por dia da despesa</CardTitle>
                  <CardDescription>Soma dos valores pela data em que a despesa foi realizada.</CardDescription>
                </CardHeader>
                <CardContent><LinhaTemporal pontos={dados.porDia} /></CardContent>
              </Card>

              {dados.dispersao && dados.dispersao.length >= 3 && (
                <Card className="mt-6">
                  <CardHeader>
                    <CardTitle className="text-base">Arrecadado × contratado, candidato a candidato</CardTitle>
                    <CardDescription>
                      Cada ponto é um candidato do recorte
                      {dados.dispersao.length >= LIMITE_DISPERSAO
                        ? ` (mostrando os ${num.format(LIMITE_DISPERSAO)} de maior movimentação)`
                        : ''}
                      . Acima da linha tracejada, contratou mais do que declarou arrecadar — a conta
                      precisa fechar até a prestação final. Clique num ponto para abrir a ficha.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Dispersao
                      pontos={dados.dispersao}
                      aoClicar={(p) => p.sq && navigate(`/candidato/${p.sq}`)}
                    />
                  </CardContent>
                </Card>
              )}
          </>

          <div className="mt-6">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {visao === 'compartilhados'
                  ? 'Fornecedores compartilhados do recorte, maiores primeiro'
                  : visao === 'removidas'
                    ? 'Declarações removidas do recorte, maiores primeiro'
                    : 'Despesas do recorte, maiores primeiro'} — página {pagina + 1}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={pagina === 0 || carregando} onClick={() => setPagina((p) => p - 1)}>
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={carregando || dados.linhas.length < POR_PAGINA}
                  onClick={() => setPagina((p) => p + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
            <Tabela colunas={dados.colunas.filter((c) => !c.startsWith('_')).map((c) => ({
              titulo: c,
              numerica: ['Valor', 'Total', 'Candidatos', 'Partidos'].includes(c),
            }))}>
              {dados.linhas.map((l, i) => (
                <tr key={i} className="hover:bg-muted/40">
                  {l.map((v, j) => {
                    const col = dados.colunas[j];
                    if (col.startsWith('_')) return null;
                    if (col === 'Valor' || col === 'Total')
                      return <CelulaNum key={j}>{brl.format(Number(v ?? 0))}</CelulaNum>;
                    if (col === 'Candidatos' || col === 'Partidos')
                      return <CelulaNum key={j}>{num.format(Number(v ?? 0))}</CelulaNum>;
                    if (col === 'CNPJ/CPF')
                      return <td key={j} className="whitespace-nowrap text-muted-foreground">{cnpjCpf(celula(v))}</td>;
                    if (col === 'Candidato')
                      return (
                        <td key={j}>
                          <Link to={`/candidato/${celula(l[0])}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                            {celula(v)}
                          </Link>
                        </td>
                      );
                    if (col === 'Fornecedor' && temFichaFornecedor(celula(l[1])))
                      return (
                        <td key={j}>
                          <Link to={urlFornecedor(celula(l[1]))} className="text-[#264E9B] underline-offset-4 hover:underline">
                            {celula(v)}
                          </Link>
                        </td>
                      );
                    return <td key={j}>{celula(v)}</td>;
                  })}
                </tr>
              ))}
            </Tabela>
          </div>
        </div>
      ) : null}
    </div>
  );
}
