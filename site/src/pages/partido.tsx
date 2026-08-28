import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum } from '@/components/app/tabela';
import { BarraComposicao, BarrasHorizontais, LinhasComparadas, type ItemBarra, type Serie } from '@/components/app/graficos';
import { executarSQL, tabelasDisponiveis } from '@/lib/duckdb';
import { brl, num, celula, cnpjCpf, temFichaFornecedor, urlFornecedor } from '@/lib/format';

interface DadosPartido {
  nome: string;
  kpis: { candidatos: number; contratado: number; receitas: number; fornecedores: number };
  composicao: { publico: number; proprios: number; total: number };
  serieRotulos: string[];
  series: Serie[];
  origens: ItemBarra[];
  doadoresOriginarios: ItemBarra[];
  compartilhados: unknown[][];
  candidatos: { sq: string; nome: string; cargo: string; uf: string; contratado: number; receitas: number | null }[];
}

async function carregarPartido(sigla: string): Promise<DadosPartido | null> {
  const w = `SG_PARTIDO = '${sigla.replaceAll("'", "''")}'`;

  const kpis = await executarSQL(`
      SELECT COUNT(DISTINCT SQ_CANDIDATO),
             ROUND(SUM(valor), 2),
             COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR)
      FROM despesas_atual WHERE ${w}`);
  const [nCand, contratado, nForn] = kpis.linhas[0] ?? [0, 0, 0];
  if (!Number(nCand)) return null;

  const rec = await executarSQL(`SELECT ROUND(SUM(valor), 2) FROM receitas_atual WHERE ${w}`);

  // mesma régua de src/analises.py: dinheiro público pela FONTE oficial
  // (FUNDO%), recursos próprios pela origem declarada
  const comp = await executarSQL(`
      SELECT ROUND(SUM(CASE WHEN DS_FONTE_RECEITA ILIKE 'FUNDO%' THEN valor ELSE 0 END), 2),
             ROUND(SUM(CASE WHEN DS_ORIGEM_RECEITA ILIKE '%pr_prio%' THEN valor ELSE 0 END), 2),
             ROUND(SUM(valor), 2)
      FROM receitas_atual WHERE ${w}`);

  const serie = tabelasDisponiveis.has('serie_diaria')
    ? await executarSQL(`
        SELECT STRFTIME(dt_extracao, '%d/%m') AS dia,
               ROUND(SUM(total_contratado), 2), ROUND(SUM(total_receitas), 2)
        FROM serie_diaria WHERE ${w} GROUP BY dt_extracao, dia ORDER BY dt_extracao`)
    : { linhas: [] as unknown[][] };

  const origens = await executarSQL(`
      SELECT DS_ORIGEM_RECEITA, ROUND(SUM(valor), 2) AS total
      FROM receitas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 8`);

  const doadores = tabelasDisponiveis.has('rede')
    ? await executarSQL(`
        SELECT contraparte, ROUND(SUM(valor), 2) AS total
        FROM rede WHERE tipo = 'doacao_originaria' AND ${w}
        GROUP BY 1 ORDER BY total DESC LIMIT 10`)
    : { linhas: [] as unknown[][] };

  const compartilhados = await executarSQL(`
      SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS "Fornecedor",
             NR_CPF_CNPJ_FORNECEDOR AS "CNPJ/CPF",
             COUNT(DISTINCT SQ_CANDIDATO) AS "Candidatos",
             ROUND(SUM(valor), 2) AS "Total"
      FROM despesas_atual WHERE ${w} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
      GROUP BY 1, 2 HAVING "Candidatos" > 1
      ORDER BY "Total" DESC LIMIT 15`);

  const candidatos = await executarSQL(`
      WITH r AS (SELECT SQ_CANDIDATO, ROUND(SUM(valor), 2) AS receitas FROM receitas_atual GROUP BY 1)
      SELECT d.SQ_CANDIDATO, ANY_VALUE(d.NM_CANDIDATO), ANY_VALUE(d.DS_CARGO), ANY_VALUE(d.SG_UF),
             ROUND(SUM(d.valor), 2) AS contratado, ANY_VALUE(r.receitas)
      FROM despesas_atual d LEFT JOIN r USING (SQ_CANDIDATO)
      WHERE d.${w} GROUP BY 1 ORDER BY contratado DESC LIMIT 50`);

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
      <div className="flex min-h-[50vh] items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="h-5 w-5" /> Consultando os dados do partido no seu navegador…
      </div>
    );
  }
  if (dados === 'nao-encontrado' || dados === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>Partido sem movimentação declarada até agora.</p>
        <Link to="/explorar" className="text-[#264E9B] underline underline-offset-4">Voltar ao Explorar</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Ficha do partido</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{dados.nome}</h1>
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
            <CardContent className="p-5">
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
