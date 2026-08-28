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
import { brl, num, celula, temFichaFornecedor, urlFornecedor } from '@/lib/format';

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

  const consultar = useCallback(async (f: Filtros, pag: number) => {
    setCarregando(true);
    setErro(null);
    try {
      const w = montarWhere(f);
      const encontrados = f.candidato.trim()
        ? await executarSQL(`
            SELECT SQ_CANDIDATO, ANY_VALUE(NM_CANDIDATO), ANY_VALUE(NR_CANDIDATO),
                   ANY_VALUE(SG_PARTIDO), ANY_VALUE(DS_CARGO), ANY_VALUE(SG_UF),
                   ROUND(SUM(valor), 2) AS total
            FROM despesas_atual
            WHERE ${w}
            GROUP BY 1 ORDER BY total DESC LIMIT 100`)
        : { linhas: [] as unknown[][] };
      const [kpis, categorias, candidatos, porDia, tabela, dispersao] = await Promise.all([
        executarSQL(`SELECT ROUND(SUM(valor),2), COUNT(DISTINCT SQ_CANDIDATO),
                            COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR), COUNT(*)
                     FROM despesas_atual WHERE ${w}`),
        executarSQL(`SELECT DS_ORIGEM_DESPESA, ROUND(SUM(valor),2) AS total
                     FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`),
        executarSQL(`SELECT NM_CANDIDATO || ' (' || SG_PARTIDO || '/' || SG_UF || ')', ROUND(SUM(valor),2) AS total
                     FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`),
        executarSQL(`SELECT STRFTIME(STRPTIME(DT_DESPESA, '%d/%m/%Y'), '%d/%m') AS dia,
                            MIN(STRPTIME(DT_DESPESA, '%d/%m/%Y')) AS ord, ROUND(SUM(valor),2) AS total
                     FROM despesas_atual WHERE ${w} AND DT_DESPESA <> '#NULO'
                     GROUP BY 1 ORDER BY ord`),
        executarSQL(`SELECT SQ_CANDIDATO AS "_sq", NR_CPF_CNPJ_FORNECEDOR AS "_cnpj",
                            DT_DESPESA AS "Data", NM_CANDIDATO AS "Candidato",
                            SG_PARTIDO || '/' || SG_UF AS "Partido/UF",
                            COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS "Fornecedor",
                            DS_ORIGEM_DESPESA AS "Categoria", DS_DESPESA AS "Descrição",
                            ROUND(valor, 2) AS "Valor"
                     FROM despesas_atual WHERE ${w}
                     ORDER BY valor DESC LIMIT ${POR_PAGINA} OFFSET ${pag * POR_PAGINA}`),
        consultarDispersao(f),
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
    void consultar(filtros, pagina);
  }, [filtros, pagina, consultar]);

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
          Combine os filtros como quiser — cada campo filtra o que diz: candidato (nome ou número),
          fornecedor (nome ou CNPJ), descrição do gasto. Tudo roda no seu navegador, sobre o estado
          atual das declarações.
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
                Despesas do recorte, maiores primeiro — página {pagina + 1}
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
            <Tabela colunas={dados.colunas.filter((c) => !c.startsWith('_')).map((c) => ({ titulo: c, numerica: c === 'Valor' }))}>
              {dados.linhas.map((l, i) => (
                <tr key={i} className="hover:bg-muted/40">
                  {l.map((v, j) => {
                    const col = dados.colunas[j];
                    if (col.startsWith('_')) return null;
                    if (col === 'Valor') return <CelulaNum key={j}>{brl.format(Number(v ?? 0))}</CelulaNum>;
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
