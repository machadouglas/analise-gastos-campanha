import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum } from '@/components/app/tabela';
import { BarrasHorizontais, LinhaTemporal, type ItemBarra, type PontoLinha } from '@/components/app/graficos';
import { executarSQL } from '@/lib/duckdb';
import { brl, num, celula } from '@/lib/format';

const UFS = ['', 'AC', 'AL', 'AM', 'AP', 'BA', 'BR', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const CARGOS = ['', 'Presidente', 'Governador', 'Senador', 'Deputado Federal', 'Deputado Estadual', 'Deputado Distrital'];
const POR_PAGINA = 50;

interface Filtros {
  uf: string;
  cargo: string;
  partido: string;
  busca: string;
}

function montarWhere(f: Filtros): string {
  const partes = ['1=1'];
  const esc = (s: string) => s.replaceAll("'", "''");
  if (f.uf) partes.push(`SG_UF = '${esc(f.uf)}'`);
  if (f.cargo) partes.push(`DS_CARGO ILIKE '${esc(f.cargo)}'`);
  if (f.partido) partes.push(`SG_PARTIDO = '${esc(f.partido)}'`);
  const b = f.busca.trim();
  if (b) {
    if (/^\d+$/.test(b)) {
      // número de candidato (ou início de CNPJ)
      partes.push(`(NR_CANDIDATO = '${b}' OR NR_CPF_CNPJ_FORNECEDOR LIKE '${b}%')`);
    } else {
      const e = esc(b);
      partes.push(
        `(NM_CANDIDATO ILIKE '%${e}%' OR NM_FORNECEDOR ILIKE '%${e}%' OR NM_FORNECEDOR_RFB ILIKE '%${e}%' OR DS_DESPESA ILIKE '%${e}%')`,
      );
    }
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
  linhas: unknown[][];
  colunas: string[];
}

const seletor =
  'h-9 rounded-md border bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function Explorar() {
  const [filtros, setFiltros] = useState<Filtros>({ uf: '', cargo: '', partido: '', busca: '' });
  const [buscaDigitada, setBuscaDigitada] = useState('');
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
      const b = f.busca.trim();
      const filtroCandidato = /^\d+$/.test(b)
        ? `NR_CANDIDATO = '${b}'`
        : `NM_CANDIDATO ILIKE '%${b.replaceAll("'", "''")}%'`;
      const encontrados = b
        ? await executarSQL(`
            SELECT SQ_CANDIDATO, ANY_VALUE(NM_CANDIDATO), ANY_VALUE(NR_CANDIDATO),
                   ANY_VALUE(SG_PARTIDO), ANY_VALUE(DS_CARGO), ANY_VALUE(SG_UF),
                   ROUND(SUM(valor), 2) AS total
            FROM despesas_atual
            WHERE ${montarWhere({ ...f, busca: '' })} AND ${filtroCandidato}
            GROUP BY 1 ORDER BY total DESC LIMIT 100`)
        : { linhas: [] as unknown[][] };
      const [kpis, categorias, candidatos, porDia, tabela] = await Promise.all([
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
        executarSQL(`SELECT SQ_CANDIDATO AS "_sq", DT_DESPESA AS "Data", NM_CANDIDATO AS "Candidato",
                            SG_PARTIDO || '/' || SG_UF AS "Partido/UF",
                            COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS "Fornecedor",
                            DS_ORIGEM_DESPESA AS "Categoria", DS_DESPESA AS "Descrição",
                            ROUND(valor, 2) AS "Valor"
                     FROM despesas_atual WHERE ${w}
                     ORDER BY valor DESC LIMIT ${POR_PAGINA} OFFSET ${pag * POR_PAGINA}`),
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
          Filtre por estado, cargo, partido ou busque um nome — candidato, fornecedor ou descrição
          do gasto. Tudo roda no seu navegador, sobre o estado atual das declarações.
        </p>
      </div>

      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mudar({ busca: buscaDigitada });
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
        <div className="flex items-center gap-2">
          <input
            className={`${seletor} w-64`}
            placeholder="Candidato, fornecedor ou descrição…"
            value={buscaDigitada}
            onChange={(e) => setBuscaDigitada(e.target.value)}
            aria-label="Busca"
          />
          <Button type="submit" variant="secondary" size="sm" className="gap-1.5">
            <Search className="h-4 w-4" /> Buscar
          </Button>
        </div>
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
          {filtros.busca.trim() && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle className="text-base">
                  Candidatos encontrados{dados.encontrados.length ? ` (${dados.encontrados.length})` : ''}
                </CardTitle>
                <CardDescription>
                  Clique no nome para abrir a ficha completa, com gráficos e indícios do candidato.
                  A tabela de despesas abaixo lista os itens do recorte (inclui fornecedores e
                  descrições que casam com a busca).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {dados.encontrados.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhum candidato com esse {/^\d+$/.test(filtros.busca.trim()) ? 'número' : 'nome'} tem
                    gastos declarados — a busca também cobre fornecedores e descrições, refletidos abaixo.
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
          {!filtros.busca.trim() && (
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
            </>
          )}

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
            <Tabela colunas={dados.colunas.filter((c) => c !== '_sq').map((c) => ({ titulo: c, numerica: c === 'Valor' }))}>
              {dados.linhas.map((l, i) => (
                <tr key={i} className="hover:bg-muted/40">
                  {l.map((v, j) => {
                    const col = dados.colunas[j];
                    if (col === '_sq') return null;
                    if (col === 'Valor') return <CelulaNum key={j}>{brl.format(Number(v ?? 0))}</CelulaNum>;
                    if (col === 'Candidato')
                      return (
                        <td key={j}>
                          <Link to={`/candidato/${celula(l[0])}`} className="text-[#264E9B] underline-offset-4 hover:underline">
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
