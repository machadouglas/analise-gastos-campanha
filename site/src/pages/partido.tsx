import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum } from '@/components/app/tabela';
import { BarraComposicao, BarrasHorizontais, LinhasComparadas, type ItemBarra, type Serie } from '@/components/app/graficos';
import { executarSQL, obterConexao, tabelasDisponiveis } from '@/lib/duckdb';
import { escSQL } from '@/lib/consultas';
import { brl, num, celula, cnpjCpf, temFichaFornecedor, urlFornecedor } from '@/lib/format';

/** Mínimo constitucional do FEFC para candidaturas femininas (EC 117/2022). */
export const PISO_FEFC_FEMININO = 30;
/** Cor/raça que a regra de proporcionalidade do TSE agrupa como candidaturas
 *  negras — espelha COR_RACA_NEGRA em src/agregados.py. */
export const COR_RACA_NEGRA = ['PRETA', 'PARDA'] as const;

/** Fatias do Fundo Especial que chegaram ao partido, por gênero e cor/raça
 *  (tabela cota_fefc). `baseRegistro` diz se a fatia das candidaturas vem do
 *  registro do TSE (todas as candidaturas) ou só de quem já recebeu fundo. */
interface CotaPartido {
  fefc: number;
  pctFefcFeminino: number;
  pctCandidaturasFemininas: number;
  pctFefcNegros: number;
  pctCandidaturasNegras: number;
  candidaturas: number;
  baseRegistro: boolean;
}

interface DadosPartido {
  nome: string;
  kpis: { candidatos: number; contratado: number; receitas: number; fornecedores: number };
  composicao: { publico: number; proprios: number; total: number };
  cota: CotaPartido | null;
  serieRotulos: string[];
  series: Serie[];
  origens: ItemBarra[];
  doadoresOriginarios: ItemBarra[];
  compartilhados: unknown[][];
  candidatos: { sq: string; nome: string; cargo: string; uf: string; contratado: number; receitas: number | null }[];
}

async function carregarPartido(sigla: string): Promise<DadosPartido | null> {
  // siglas reais são curtas e alfanuméricas — qualquer outra coisa nem consulta
  if (!/^[A-Za-zÀ-ÿ0-9 .-]{1,30}$/.test(sigla)) return null;
  // guardas de tabelasDisponiveis só valem depois do boot (ver candidato.tsx)
  await obterConexao();
  const w = `SG_PARTIDO = '${escSQL(sigla)}'`;

  // as oito consultas são independentes; juntas, o pipeline de leitura dos
  // parquet não fica serializado atrás de cada round-trip
  const negros = COR_RACA_NEGRA.map((c) => `'${c}'`).join(', ');
  const [kpis, rec, comp, serie, origens, doadores, compartilhados, candidatos, cota] = await Promise.all([
    // candidatos = quem movimentou QUALQUER coisa (despesa OU receita): partido
    // que só arrecadou também tem ficha. Sentinelas '-1'/'#NULO' fora do KPI de
    // fornecedores — "sem contraparte" não é um fornecedor a mais.
    executarSQL(`
      SELECT (SELECT COUNT(*) FROM (
                SELECT DISTINCT SQ_CANDIDATO FROM despesas_atual WHERE ${w}
                UNION
                SELECT DISTINCT SQ_CANDIDATO FROM receitas_atual WHERE ${w})),
             (SELECT ROUND(SUM(valor), 2) FROM despesas_atual WHERE ${w}),
             (SELECT COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR) FROM despesas_atual
              WHERE ${w} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO'))`),
    executarSQL(`SELECT ROUND(SUM(valor), 2) FROM receitas_atual WHERE ${w}`),
    // mesma régua de src/analises.py: dinheiro público pela FONTE oficial
    // (FUNDO%), recursos próprios pela origem declarada
    executarSQL(`
      SELECT ROUND(SUM(CASE WHEN DS_FONTE_RECEITA ILIKE 'FUNDO%' THEN valor ELSE 0 END), 2),
             ROUND(SUM(CASE WHEN DS_ORIGEM_RECEITA ILIKE '%pr_prio%' THEN valor ELSE 0 END), 2),
             ROUND(SUM(valor), 2)
      FROM receitas_atual WHERE ${w}`),
    tabelasDisponiveis.has('serie_diaria')
      ? executarSQL(`
        SELECT STRFTIME(dt_extracao, '%d/%m') AS dia,
               ROUND(SUM(total_contratado), 2), ROUND(SUM(total_receitas), 2)
        FROM serie_diaria WHERE ${w} GROUP BY dt_extracao, dia ORDER BY dt_extracao`)
      : Promise.resolve({ linhas: [] as unknown[][] }),
    executarSQL(`
      SELECT DS_ORIGEM_RECEITA, ROUND(SUM(valor), 2) AS total
      FROM receitas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 8`),
    tabelasDisponiveis.has('rede')
      ? executarSQL(`
        SELECT contraparte, ROUND(SUM(valor), 2) AS total
        FROM rede WHERE tipo = 'doacao_originaria' AND ${w}
        GROUP BY 1 ORDER BY total DESC LIMIT 10`)
      : Promise.resolve({ linhas: [] as unknown[][] }),
    executarSQL(`
      SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS "Fornecedor",
             NR_CPF_CNPJ_FORNECEDOR AS "CNPJ/CPF",
             COUNT(DISTINCT SQ_CANDIDATO) AS "Candidatos",
             ROUND(SUM(valor), 2) AS "Total"
      FROM despesas_atual WHERE ${w} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
      GROUP BY 1, 2 HAVING "Candidatos" > 1
      ORDER BY "Total" DESC LIMIT 15`),
    executarSQL(`
      WITH r AS (SELECT SQ_CANDIDATO, ROUND(SUM(valor), 2) AS receitas FROM receitas_atual GROUP BY 1)
      SELECT d.SQ_CANDIDATO, ANY_VALUE(d.NM_CANDIDATO), ANY_VALUE(d.DS_CARGO), ANY_VALUE(d.SG_UF),
             ROUND(SUM(d.valor), 2) AS contratado, ANY_VALUE(r.receitas)
      FROM despesas_atual d LEFT JOIN r USING (SQ_CANDIDATO)
      WHERE d.${w} GROUP BY 1 ORDER BY contratado DESC LIMIT 50`),
    // FEFC por gênero e cor — o MESMO SQL de sql_cota_por_partido em
    // src/resumo.py: a fatia das candidaturas vem do registro quando o partido
    // tem qualquer registro com gênero/cor; senão, de quem já recebeu fundo.
    // Os dois denominadores nunca se misturam.
    tabelasDisponiveis.has('cota_fefc')
      ? executarSQL(`
        WITH p AS (
          SELECT SUM(fefc) AS fefc,
                 SUM(candidatos_fefc) AS cf,
                 COALESCE(SUM(fefc) FILTER (WHERE genero = 'FEMININO'), 0) AS fefc_f,
                 COALESCE(SUM(fefc) FILTER (WHERE cor_raca IN (${negros})), 0) AS fefc_n,
                 SUM(candidaturas) AS reg,
                 COALESCE(SUM(candidaturas) FILTER (WHERE genero = 'FEMININO'), 0) AS reg_f,
                 COALESCE(SUM(candidaturas) FILTER (WHERE cor_raca IN (${negros})), 0) AS reg_n,
                 COALESCE(SUM(candidatos_fefc) FILTER (WHERE genero = 'FEMININO'), 0) AS cf_f,
                 COALESCE(SUM(candidatos_fefc) FILTER (WHERE cor_raca IN (${negros})), 0) AS cf_n
          FROM cota_fefc WHERE ${w})
        SELECT ROUND(fefc, 2),
               ROUND(100.0 * fefc_f / NULLIF(fefc, 0), 1),
               ROUND(100.0 * (CASE WHEN reg IS NOT NULL THEN reg_f ELSE cf_f END)
                     / NULLIF(COALESCE(reg, cf), 0), 1),
               ROUND(100.0 * fefc_n / NULLIF(fefc, 0), 1),
               ROUND(100.0 * (CASE WHEN reg IS NOT NULL THEN reg_n ELSE cf_n END)
                     / NULLIF(COALESCE(reg, cf), 0), 1),
               COALESCE(reg, cf), reg IS NOT NULL
        FROM p`)
      : Promise.resolve({ linhas: [] as unknown[][] }),
  ]);
  const [nCand, contratado, nForn] = kpis.linhas[0] ?? [0, 0, 0];
  if (!Number(nCand)) return null;

  const c = cota.linhas[0];
  const cotaPartido: CotaPartido | null =
    c && Number(c[0] ?? 0) > 0
      ? {
          fefc: Number(c[0]),
          pctFefcFeminino: Number(c[1] ?? 0),
          pctCandidaturasFemininas: Number(c[2] ?? 0),
          pctFefcNegros: Number(c[3] ?? 0),
          pctCandidaturasNegras: Number(c[4] ?? 0),
          candidaturas: Number(c[5] ?? 0),
          baseRegistro: Boolean(c[6]),
        }
      : null;

  return {
    nome: sigla,
    kpis: {
      candidatos: Number(nCand),
      contratado: Number(contratado ?? 0),
      receitas: Number(rec.linhas[0]?.[0] ?? 0),
      fornecedores: Number(nForn ?? 0),
    },
    composicao: {
      publico: Number(comp.linhas[0]?.[0] ?? 0),
      proprios: Number(comp.linhas[0]?.[1] ?? 0),
      total: Number(comp.linhas[0]?.[2] ?? 0),
    },
    cota: cotaPartido,
    serieRotulos: serie.linhas.map((l) => String(l[0])),
    series: [
      { nome: 'Contratado', valores: serie.linhas.map((l) => Number(l[1] ?? 0)) },
      { nome: 'Arrecadado', valores: serie.linhas.map((l) => Number(l[2] ?? 0)) },
    ],
    origens: origens.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1]) })),
    doadoresOriginarios: doadores.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1]) })),
    compartilhados: compartilhados.linhas,
    candidatos: candidatos.linhas.map((l) => ({
      sq: String(l[0]),
      nome: String(l[1]),
      cargo: String(l[2]),
      uf: String(l[3]),
      contratado: Number(l[4] ?? 0),
      receitas: l[5] == null ? null : Number(l[5]),
    })),
  };
}

const pct = (v: number) => `${num.format(v)}%`;

/** Uma régua: barra navy = fatia do fundo; traço âmbar = fatia das candidaturas;
 *  traço tracejado = piso legal, quando há. A leitura é a distância entre eles. */
function ReguaCota({
  titulo, pctFundo, pctCandidaturas, piso, leitura,
}: {
  titulo: string; pctFundo: number; pctCandidaturas: number; piso?: number; leitura: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold text-foreground">{titulo}</p>
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-[#264E9B]">{pct(pctFundo)} do fundo</span>
          {' · '}
          <span className="text-[#B45309]">{pct(pctCandidaturas)} das candidaturas</span>
          {piso != null && <> · piso legal {pct(piso)}</>}
        </p>
      </div>
      <div className="relative mt-2 h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-[#264E9B]" style={{ width: `${Math.min(pctFundo, 100)}%` }} />
        <div
          className="absolute inset-y-0 w-0.5 bg-[#B45309]"
          style={{ left: `calc(${Math.min(pctCandidaturas, 100)}% - 1px)` }}
          title={`${pct(pctCandidaturas)} das candidaturas`}
        />
        {piso != null && (
          <div
            className="absolute inset-y-0 w-0.5 border-l-2 border-dashed border-[#10244A]"
            style={{ left: `calc(${piso}% - 1px)` }}
            title={`piso legal: ${pct(piso)}`}
          />
        )}
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{leitura}</p>
    </div>
  );
}

function leituraGenero(c: CotaPartido): string {
  const dist = c.pctFefcFeminino - PISO_FEFC_FEMININO;
  if (dist < 0)
    return `${pct(-dist)} abaixo do piso de ${pct(PISO_FEFC_FEMININO)} no que já chegou às candidatas. O piso é sobre o total aplicado pelo partido, que também gasta fundo diretamente — e a prestação está aberta.`;
  return `Acima do piso de ${pct(PISO_FEFC_FEMININO)} no que já chegou às candidatas.`;
}

function leituraRaca(c: CotaPartido): string {
  const dist = c.pctFefcNegros - c.pctCandidaturasNegras;
  const base = c.baseRegistro ? 'das candidaturas registradas' : 'de quem já recebeu fundo';
  if (dist < -0.05)
    return `Candidaturas negras são ${pct(c.pctCandidaturasNegras)} ${base} e receberam ${pct(c.pctFefcNegros)} do fundo — ${pct(-dist)} a menos do que a proporção delas.`;
  return `Candidaturas negras são ${pct(c.pctCandidaturasNegras)} ${base} e receberam ${pct(c.pctFefcNegros)} do fundo — na proporção ou acima dela.`;
}

export function Partido() {
  const { sigla } = useParams<{ sigla: string }>();
  const [dados, setDados] = useState<DadosPartido | null | 'carregando' | 'nao-encontrado'>('carregando');

  useEffect(() => {
    if (!sigla) return;
    setDados('carregando');
    carregarPartido(decodeURIComponent(sigla))
      .then((d) => setDados(d ?? 'nao-encontrado'))
      .catch(() => setDados('nao-encontrado'));
  }, [sigla]);

  if (dados === 'carregando') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <Spinner className="h-5 w-5" /> Consultando os dados do partido no seu navegador…
      </div>
    );
  }
  if (dados === 'nao-encontrado' || dados === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <p>Partido sem movimentação declarada até agora.</p>
        <Link to="/explorar" className="text-[#264E9B] underline underline-offset-4">Voltar ao Explorar</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6 sm:py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Ficha do partido</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{dados.nome}</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Consolidado das candidaturas com movimentação declarada nas Eleições 2026.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Candidatos com gastos', num.format(dados.kpis.candidatos)],
          ['Arrecadado', brl.format(dados.kpis.receitas)],
          ['Contratado', brl.format(dados.kpis.contratado)],
          ['Fornecedores', num.format(dados.kpis.fornecedores)],
        ].map(([r, v]) => (
          <Card key={r}>
            <CardContent className="p-5 sm:p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{r}</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">{v}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {dados.composicao.total > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Composição da receita</CardTitle>
            <CardDescription>
              De que tipo de dinheiro as campanhas da sigla vivem: fundos públicos (Fundo Eleitoral +
              Fundo Partidário), bolso dos próprios candidatos e doações de terceiros.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarraComposicao
              fatias={[
                { rotulo: 'Dinheiro público', valor: dados.composicao.publico, cor: '#264E9B' },
                { rotulo: 'Recursos próprios', valor: dados.composicao.proprios, cor: '#B45309' },
                {
                  rotulo: 'Demais doações',
                  valor: Math.max(dados.composicao.total - dados.composicao.publico - dados.composicao.proprios, 0),
                  cor: '#6e6a60',
                },
              ]}
            />
          </CardContent>
        </Card>
      )}

      {dados.cota && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fundo Eleitoral: gênero e cor/raça</CardTitle>
            <CardDescription>
              Do Fundo Especial que já chegou aos candidatos da sigla ({brl.format(dados.cota.fefc)}),
              quanto foi para candidatas e para candidaturas negras — ao lado da fatia que elas são
              das candidaturas. A lei exige ao menos 30% do fundo para mulheres e distribuição
              proporcional para candidaturas negras (pretas e pardas). Isto mede só o que chegou a
              candidato: termômetro, não a conta oficial.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <ReguaCota
              titulo="Candidaturas femininas"
              pctFundo={dados.cota.pctFefcFeminino}
              pctCandidaturas={dados.cota.pctCandidaturasFemininas}
              piso={PISO_FEFC_FEMININO}
              leitura={leituraGenero(dados.cota)}
            />
            <ReguaCota
              titulo="Candidaturas negras (pretas e pardas)"
              pctFundo={dados.cota.pctFefcNegros}
              pctCandidaturas={dados.cota.pctCandidaturasNegras}
              leitura={leituraRaca(dados.cota)}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dinheiro no tempo</CardTitle>
          <CardDescription>Soma diária do declarado por todos os candidatos do partido.</CardDescription>
        </CardHeader>
        <CardContent>
          <LinhasComparadas rotulos={dados.serieRotulos} series={dados.series} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">De onde vem o dinheiro</CardTitle>
            <CardDescription>Origens das receitas declaradas pelos candidatos do partido.</CardDescription>
          </CardHeader>
          <CardContent><BarrasHorizontais dados={dados.origens} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Doadores originários</CardTitle>
            <CardDescription>Quem estava na origem dos repasses partidários (rastreio do TSE).</CardDescription>
          </CardHeader>
          <CardContent><BarrasHorizontais dados={dados.doadoresOriginarios} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fornecedores compartilhados no partido</CardTitle>
          <CardDescription>Mesma empresa atendendo vários candidatos da sigla — campanhas casadas ou rateio. Clique no nome para abrir a ficha do fornecedor.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabela colunas={[{ titulo: 'Fornecedor' }, { titulo: 'CNPJ/CPF' }, { titulo: 'Candidatos', numerica: true }, { titulo: 'Total', numerica: true }]}>
            {dados.compartilhados.map((l, i) => {
              const max = Number(dados.compartilhados[0]?.[3] ?? 0);
              return (
              <tr key={i} className="hover:bg-muted/40">
                <td>
                  {temFichaFornecedor(celula(l[1])) ? (
                    <Link to={urlFornecedor(celula(l[1]))} className="text-[#264E9B] underline-offset-4 hover:underline">
                      {celula(l[0])}
                    </Link>
                  ) : (
                    celula(l[0])
                  )}
                </td>
                <td className="whitespace-nowrap text-muted-foreground">{cnpjCpf(celula(l[1]))}</td>
                <CelulaNum>{num.format(Number(l[2] ?? 0))}</CelulaNum>
                <CelulaNum frac={max > 0 ? Number(l[3] ?? 0) / max : undefined}>{brl.format(Number(l[3] ?? 0))}</CelulaNum>
              </tr>
              );
            })}
          </Tabela>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Candidatos do partido</CardTitle>
          <CardDescription>Clique para abrir a ficha completa de cada um.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabela colunas={[{ titulo: 'Candidato' }, { titulo: 'Cargo' }, { titulo: 'UF' }, { titulo: 'Contratado', numerica: true }, { titulo: 'Arrecadado', numerica: true }]}>
            {dados.candidatos.map((c) => {
              const max = dados.candidatos[0]?.contratado ?? 0;
              return (
              <tr key={c.sq} className="hover:bg-muted/40">
                <td>
                  <Link to={`/candidato/${c.sq}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                    {c.nome}
                  </Link>
                </td>
                <td className="text-muted-foreground">{c.cargo}</td>
                <td>{c.uf}</td>
                <CelulaNum frac={max > 0 ? c.contratado / max : undefined}>{brl.format(c.contratado)}</CelulaNum>
                <CelulaNum>{c.receitas == null ? '—' : brl.format(c.receitas)}</CelulaNum>
              </tr>
              );
            })}
          </Tabela>
        </CardContent>
      </Card>
    </div>
  );
}
