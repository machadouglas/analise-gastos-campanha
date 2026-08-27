import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tabela, CelulaNum } from '@/components/app/tabela';
import { BarrasHorizontais, LinhaTemporal, type ItemBarra, type PontoLinha } from '@/components/app/graficos';
import { executarSQL, tabelasDisponiveis } from '@/lib/duckdb';
import { brl, num, celula, cnpjCpf, dataBR, urlFornecedor } from '@/lib/format';

interface CadastroRFB {
  razaoSocial: string | null;
  abertura: string | null;
  situacao: string | null;
  porte: string | null;
  mei: boolean;
  cnae: string | null;
  sede: string | null;
  capital: number | null;
  socios: string | null;
}

interface Perfil {
  nome: string;
  tipo: string | null;
  cnae: string | null;
  sqCandidato: string | null; // preenchido quando o fornecedor é ele próprio candidato
  nCandidatos: number;
  nPartidos: number;
  nUfs: number;
  total: number;
  itens: number;
  flags: string[];
}

interface DadosFornecedor {
  perfil: Perfil;
  rfb: CadastroRFB | null;
  topCandidatos: ItemBarra[];
  categorias: ItemBarra[];
  porDia: PontoLinha[];
  candidatos: { sq: string; nome: string; cargo: string; partido: string; uf: string; itens: number; total: number }[];
  doacoes: unknown[][];
  removidas: unknown[][];
  notas: unknown[][];
}

function esc(s: string) {
  return s.replaceAll("'", "''");
}

/** Resolve o identificador da URL para o CPF/CNPJ real: ids `pf-<hash>` são
 *  opacos (o CPF não viaja na URL) e voltam ao valor via md5 no próprio banco. */
async function resolverId(param: string): Promise<string | null> {
  if (/^\d{6,14}$/.test(param)) return param;
  const m = /^pf-([0-9a-f]{16})$/.exec(param);
  if (!m) return null;
  const r = await executarSQL(`
      SELECT DISTINCT NR_CPF_CNPJ_FORNECEDOR FROM despesas_atual
      WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 11
        AND md5(NR_CPF_CNPJ_FORNECEDOR) LIKE '${m[1]}%' LIMIT 1`);
  return r.total ? String(r.linhas[0][0]) : null;
}

async function carregarFornecedor(id: string): Promise<DadosFornecedor | null> {
  const w = `NR_CPF_CNPJ_FORNECEDOR = '${esc(id)}'`;

  const perfilRes = await executarSQL(`
      SELECT ANY_VALUE(COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR)),
             ANY_VALUE(NULLIF(DS_TIPO_FORNECEDOR, '#NULO')),
             ANY_VALUE(NULLIF(DS_CNAE_FORNECEDOR, '#NULO')),
             ANY_VALUE(CASE WHEN SQ_CANDIDATO_FORNECEDOR NOT IN ('-1', '#NULO')
                            THEN SQ_CANDIDATO_FORNECEDOR END),
             COUNT(DISTINCT SQ_CANDIDATO), COUNT(DISTINCT SG_PARTIDO), COUNT(DISTINCT SG_UF),
             ROUND(SUM(valor), 2), COUNT(*),
             ROUND(SUM(valor) FILTER (WHERE DS_TIPO_DOCUMENTO IS NULL
                                         OR TRIM(DS_TIPO_DOCUMENTO) IN ('', '#NULO')), 2)
      FROM despesas_atual WHERE ${w}`);
  const l = perfilRes.linhas[0] ?? [];
  if (!Number(l[4])) return null;
  const semNota = Number(l[9] ?? 0);

  const rfbRes = tabelasDisponiveis.has('fornecedores')
    ? await executarSQL(`
        SELECT razao_social, data_abertura, situacao, porte, opcao_mei, cnae_principal,
               NULLIF(municipio || '/' || uf, '/') AS sede, capital_social, socios
        FROM fornecedores WHERE cnpj = '${esc(id)}'`)
    : { linhas: [] as unknown[][] };
  const r = rfbRes.linhas[0];
  const rfb: CadastroRFB | null = r
    ? {
        razaoSocial: r[0] == null ? null : String(r[0]),
        abertura: r[1] == null ? null : String(r[1]),
        situacao: r[2] == null ? null : String(r[2]),
        porte: r[3] == null ? null : String(r[3]),
        mei: Boolean(r[4]),
        cnae: r[5] == null ? null : String(r[5]),
        sede: r[6] == null ? null : String(r[6]),
        capital: r[7] == null ? null : Number(r[7]),
        socios: r[8] ? String(r[8]) : null,
      }
    : null;

  const doacaoAgg = await executarSQL(`
      SELECT ROUND(SUM(valor), 2), COUNT(DISTINCT SQ_CANDIDATO)
      FROM receitas_atual WHERE NR_CPF_CNPJ_DOADOR = '${esc(id)}'`);
  const totalDoado = Number(doacaoAgg.linhas[0]?.[0] ?? 0);

  const removidasAgg = await executarSQL(`
      SELECT COUNT(*),
             ROUND(SUM(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas), 2)
      FROM despesas
      WHERE ${w} AND dt_ultima_extracao < (SELECT MAX(dt_ultima_extracao) FROM despesas)`);
  const valorRemovido = Number(removidasAgg.linhas[0]?.[1] ?? 0);

  const flags: string[] = [];
  const nCandidatos = Number(l[4]);
  const nPartidos = Number(l[5] ?? 0);
  if (nCandidatos > 1)
    flags.push(`recebe de ${num.format(nCandidatos)} candidatos de ${num.format(nPartidos)} partido${nPartidos > 1 ? 's' : ''}`);
  if (totalDoado > 0) flags.push(`também aparece como doador: ${brl.format(totalDoado)}`);
  if (/f.sica/i.test(String(l[1] ?? ''))) flags.push('pessoa física prestando serviços de campanha');
  if (semNota > 0) flags.push(`${brl.format(semNota)} sem documento fiscal informado`);
  if (valorRemovido > 0) flags.push(`${brl.format(valorRemovido)} em declarações removidas`);
  if (rfb?.abertura && rfb.abertura >= '2025-10-01')
    flags.push(`CNPJ aberto em ${dataBR(rfb.abertura)}, às vésperas da eleição`);
  if (l[3] != null) flags.push('o fornecedor também é candidato nesta eleição');

  const perfil: Perfil = {
    nome: String(l[0]),
    tipo: l[1] == null ? null : String(l[1]),
    cnae: l[2] == null ? null : String(l[2]),
    sqCandidato: l[3] == null ? null : String(l[3]),
    nCandidatos,
    nPartidos,
    nUfs: Number(l[6] ?? 0),
    total: Number(l[7] ?? 0),
    itens: Number(l[8] ?? 0),
    flags,
  };

  const candidatos = await executarSQL(`
      SELECT SQ_CANDIDATO, ANY_VALUE(NM_CANDIDATO), ANY_VALUE(DS_CARGO),
             ANY_VALUE(SG_PARTIDO), ANY_VALUE(SG_UF),
             COUNT(*) AS itens, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 50`);

  const categorias = await executarSQL(`
      SELECT DS_ORIGEM_DESPESA, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`);

  const porDia = await executarSQL(`
      SELECT STRFTIME(STRPTIME(DT_DESPESA, '%d/%m/%Y'), '%d/%m') AS dia,
             MIN(STRPTIME(DT_DESPESA, '%d/%m/%Y')) AS ord, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} AND DT_DESPESA <> '#NULO'
      GROUP BY 1 ORDER BY ord`);

  const doacoes = totalDoado > 0
    ? (await executarSQL(`
        SELECT SQ_CANDIDATO AS "_sq", NM_CANDIDATO AS "Candidato",
               SG_PARTIDO || '/' || SG_UF AS "Partido/UF", DT_RECEITA AS "Data",
               DS_ORIGEM_RECEITA AS "Origem", DS_ESPECIE_RECEITA AS "Espécie",
               ROUND(valor, 2) AS "Valor"
        FROM receitas_atual WHERE NR_CPF_CNPJ_DOADOR = '${esc(id)}'
        ORDER BY valor DESC LIMIT 30`)).linhas
    : [];

  const removidas = valorRemovido > 0
    ? (await executarSQL(`
        SELECT NM_CANDIDATO AS "Candidato", SG_PARTIDO || '/' || SG_UF AS "Partido/UF",
               DS_DESPESA AS "Descrição",
               ROUND(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas, 2) AS "Valor",
               STRFTIME(dt_primeira_extracao, '%d/%m/%Y') AS "Visível de",
               STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS "Até"
        FROM despesas
        WHERE ${w} AND dt_ultima_extracao < (SELECT MAX(dt_ultima_extracao) FROM despesas)
        ORDER BY 4 DESC LIMIT 30`)).linhas
    : [];

  const notas = await executarSQL(`
      SELECT DT_DESPESA AS "Data", SQ_CANDIDATO AS "_sq", NM_CANDIDATO AS "Candidato",
             DS_ORIGEM_DESPESA AS "Categoria", DS_DESPESA AS "Descrição",
             NULLIF(DS_TIPO_DOCUMENTO, '#NULO') AS "Documento",
             ROUND(valor, 2) AS "Valor"
      FROM despesas_atual WHERE ${w} ORDER BY valor DESC LIMIT 50`);

  return {
    perfil,
    rfb,
    topCandidatos: candidatos.linhas.slice(0, 10).map((c) => ({
      rotulo: `${c[1]} (${c[3]}/${c[4]})`,
      valor: Number(c[6] ?? 0),
    })),
    categorias: categorias.linhas.map((c) => ({ rotulo: String(c[0]), valor: Number(c[1]) })),
    porDia: porDia.linhas.map((c) => ({ rotulo: String(c[0]), valor: Number(c[2]) })),
    candidatos: candidatos.linhas.map((c) => ({
      sq: String(c[0]),
      nome: String(c[1]),
      cargo: String(c[2]),
      partido: String(c[3]),
      uf: String(c[4]),
      itens: Number(c[5] ?? 0),
      total: Number(c[6] ?? 0),
    })),
    doacoes,
    removidas,
    notas: notas.linhas,
  };
}

function Secao({ titulo, descricao, children }: { titulo: string; descricao: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{titulo}</CardTitle>
        <CardDescription>{descricao}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function CampoRFB({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{rotulo}</p>
      <p className="mt-0.5 text-sm">{valor}</p>
    </div>
  );
}

export function Fornecedor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dados, setDados] = useState<DadosFornecedor | null | 'carregando' | 'nao-encontrado'>('carregando');
  const [idReal, setIdReal] = useState<string | null>(null);

  useEffect(() => {
    if (!id || !/^(\d{6,14}|pf-[0-9a-f]{16})$/.test(id)) {
      setDados('nao-encontrado');
      return;
    }
    // URL antiga com CPF cru: segue funcionando, mas normaliza para a opaca
    // (o número sai da barra de endereço, do histórico e de compartilhamentos)
    if (/^\d{11}$/.test(id)) {
      navigate(urlFornecedor(id), { replace: true });
      return;
    }
    setDados('carregando');
    resolverId(id)
      .then(async (real) => {
        if (!real) return 'nao-encontrado' as const;
        setIdReal(real);
        return (await carregarFornecedor(real)) ?? ('nao-encontrado' as const);
      })
      .then((d) => setDados(d))
      .catch(() => setDados('nao-encontrado'));
  }, [id]);

  // Ficha de pessoa física fica fora dos buscadores (minimização de exposição)
  useEffect(() => {
    if (!idReal || idReal.length !== 11) return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [idReal]);

  if (dados === 'carregando') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="h-5 w-5" /> Consultando os dados do fornecedor no seu navegador…
      </div>
    );
  }
  if (dados === 'nao-encontrado' || dados === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>Fornecedor não encontrado (ou ainda sem despesas declaradas).</p>
        <Link to="/explorar" className="text-[#264E9B] underline underline-offset-4">Voltar ao Explorar</Link>
      </div>
    );
  }

  const p = dados.perfil;
  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Ficha do fornecedor</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{p.nome}</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          {cnpjCpf(idReal ?? '')}
          {p.tipo && <> · {p.tipo.toLowerCase()}</>}
          {p.cnae && <> · {p.cnae.toLowerCase()}</>}
          {p.sqCandidato && (
            <>
              {' '}·{' '}
              <Link to={`/candidato/${p.sqCandidato}`} className="text-[#264E9B] underline underline-offset-4">
                ver a ficha de candidato deste fornecedor
              </Link>
            </>
          )}
        </p>
        {p.flags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {p.flags.map((f) => (
              <span key={f} className="inline-flex items-center gap-1.5 rounded-full border border-[#B45309]/40 bg-[#B45309]/10 px-3 py-1 text-xs font-medium text-[#7c3a06]">
                <AlertTriangle className="h-3.5 w-3.5" /> {f}
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Indícios contáveis a partir do que foi declarado — para investigar, não para acusar.
          Fornecedores compartilhados podem ser mercado consolidado do ramo.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Total recebido', brl.format(p.total)],
          ['Candidatos atendidos', num.format(p.nCandidatos)],
          ['Partidos', num.format(p.nPartidos)],
          ['Itens declarados', num.format(p.itens)],
        ].map(([r, v]) => (
          <Card key={r}>
            <CardContent className="p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{r}</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">{v}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {dados.rfb && (
        <Secao titulo="Cadastro na Receita Federal" descricao="Dados públicos do CNPJ (via BrasilAPI), coletados pelo enriquecimento diário.">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <CampoRFB rotulo="Razão social" valor={dados.rfb.razaoSocial} />
            <CampoRFB rotulo="Abertura" valor={dataBR(dados.rfb.abertura) || null} />
            <CampoRFB rotulo="Situação" valor={dados.rfb.situacao} />
            <CampoRFB rotulo="Porte" valor={dados.rfb.mei ? `${dados.rfb.porte ?? ''} (MEI)`.trim() : dados.rfb.porte} />
            <CampoRFB rotulo="Sede" valor={dados.rfb.sede} />
            <CampoRFB rotulo="Capital social" valor={dados.rfb.capital ? brl.format(dados.rfb.capital) : null} />
            <CampoRFB rotulo="CNAE principal" valor={dados.rfb.cnae} />
            <div className="sm:col-span-2 lg:col-span-3">
              <CampoRFB rotulo="Sócios" valor={dados.rfb.socios} />
            </div>
          </div>
        </Secao>
      )}

      {dados.removidas.length > 0 && (
        <Secao titulo="Declarações removidas" descricao="Despesas com este fornecedor que estavam declaradas ao TSE e deixaram de estar. Pode ser correção legítima — é um indício, não uma acusação.">
          <Tabela colunas={[{ titulo: 'Candidato' }, { titulo: 'Partido/UF' }, { titulo: 'Descrição' }, { titulo: 'Valor', numerica: true }, { titulo: 'Visível de' }, { titulo: 'Até' }]}>
            {dados.removidas.map((l, i) => (
              <tr key={i}>
                <td>{celula(l[0])}</td><td className="text-muted-foreground">{celula(l[1])}</td><td>{celula(l[2])}</td>
                <CelulaNum>{brl.format(Number(l[3] ?? 0))}</CelulaNum>
                <td>{celula(l[4])}</td><td>{celula(l[5])}</td>
              </tr>
            ))}
          </Tabela>
        </Secao>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Secao titulo="Quem paga este fornecedor" descricao="Os dez candidatos com maior valor contratado.">
          <BarrasHorizontais dados={dados.topCandidatos} />
        </Secao>
        <Secao titulo="O que ele fornece" descricao="Categorias de gasto declaradas pelos candidatos.">
          <BarrasHorizontais dados={dados.categorias} />
        </Secao>
      </div>

      <Secao titulo="Recebimentos no tempo" descricao="Soma dos valores contratados pela data declarada da despesa.">
        <LinhaTemporal pontos={dados.porDia} />
      </Secao>

      <Secao titulo="Candidatos atendidos" descricao="Clique para abrir a ficha completa de cada candidato.">
        <Tabela colunas={[{ titulo: 'Candidato' }, { titulo: 'Cargo' }, { titulo: 'Partido/UF' }, { titulo: 'Itens', numerica: true }, { titulo: 'Total', numerica: true }]}>
          {dados.candidatos.map((c) => (
            <tr key={c.sq} className="hover:bg-muted/40">
              <td>
                <Link to={`/candidato/${c.sq}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                  {c.nome}
                </Link>
              </td>
              <td className="text-muted-foreground">{c.cargo}</td>
              <td>
                <Link to={`/partido/${encodeURIComponent(c.partido)}`} className="hover:underline">
                  {c.partido}
                </Link>/{c.uf}
              </td>
              <CelulaNum>{num.format(c.itens)}</CelulaNum>
              <CelulaNum>{brl.format(c.total)}</CelulaNum>
            </tr>
          ))}
        </Tabela>
      </Secao>

      {dados.doacoes.length > 0 && (
        <Secao titulo="Também aparece como doador" descricao="Doações declaradas com este mesmo CNPJ/CPF. Fornecedor que também doa para campanhas é o clássico 'dinheiro que volta' — vale conferir se doa para quem o contrata.">
          <Tabela colunas={[{ titulo: 'Candidato' }, { titulo: 'Partido/UF' }, { titulo: 'Data' }, { titulo: 'Origem' }, { titulo: 'Espécie' }, { titulo: 'Valor', numerica: true }]}>
            {dados.doacoes.map((l, i) => (
              <tr key={i} className="hover:bg-muted/40">
                <td>
                  <Link to={`/candidato/${celula(l[0])}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                    {celula(l[1])}
                  </Link>
                </td>
                <td className="text-muted-foreground">{celula(l[2])}</td>
                <td className="whitespace-nowrap">{celula(l[3])}</td>
                <td>{celula(l[4])}</td>
                <td>{celula(l[5])}</td>
                <CelulaNum>{brl.format(Number(l[6] ?? 0))}</CelulaNum>
              </tr>
            ))}
          </Tabela>
        </Secao>
      )}

      <Secao titulo="Despesas declaradas" descricao="As cinquenta maiores notas com este fornecedor no estado atual das declarações.">
        <Tabela colunas={[{ titulo: 'Data' }, { titulo: 'Candidato' }, { titulo: 'Categoria' }, { titulo: 'Descrição' }, { titulo: 'Documento' }, { titulo: 'Valor', numerica: true }]}>
          {dados.notas.map((l, i) => (
            <tr key={i} className="hover:bg-muted/40">
              <td className="whitespace-nowrap">{celula(l[0])}</td>
              <td>
                <Link to={`/candidato/${celula(l[1])}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                  {celula(l[2])}
                </Link>
              </td>
              <td className="text-muted-foreground">{celula(l[3])}</td>
              <td>{celula(l[4])}</td>
              <td className="text-muted-foreground">{celula(l[5]) || '—'}</td>
              <CelulaNum>{brl.format(Number(l[6] ?? 0))}</CelulaNum>
            </tr>
          ))}
        </Tabela>
      </Secao>
    </div>
  );
}
