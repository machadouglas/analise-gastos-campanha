import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { SecaoCorrigidas, montarCorrigidas, type Corrigida } from '@/components/app/corrigidas';
import { Secao } from '@/components/app/secao';
import { Tabela, CelulaNum, CelulaTexto } from '@/components/app/tabela';
import { SecaoRecolhivel } from '@/components/app/recolhivel';
import { BarrasHorizontais, LinhaTemporal, type ItemBarra, type PontoLinha } from '@/components/app/graficos';
import { GrafoConexoes, type NoConexao, type NoSecundario } from '@/components/app/grafo';
import { executarSQL, obterConexao, tabelasDisponiveis } from '@/lib/duckdb';
import {
  CONDICAO_DOCUMENTO_NUMERADO,
  CONDICAO_NOTA_SEM_NUMERO,
  SITUACAO_NAO_ENCONTRADA,
  condicaoSemNota,
  escSQL,
  sqlCorrigidas,
  sqlDocumentoDaNota,
} from '@/lib/consultas';
import { brl, num, celula, cnpjCpf, dataBR, ePessoaFisica, temFichaFornecedor, urlFornecedor } from '@/lib/format';

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
  /** data da última consulta à base pública — data o aviso de CNPJ não encontrado */
  consultadoEm: string | null;
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
  conexoes: NoConexao[];
  conexoesSecundarias: NoSecundario[];
  candidatos: { sq: string; nome: string; cargo: string; partido: string; uf: string; itens: number; total: number }[];
  doacoes: unknown[][];
  removidas: unknown[][];
  corrigidas: Corrigida[];
  corrigidasReceitas: Corrigida[];
  notas: unknown[][];
}

const esc = escSQL;

/** Resolve o identificador da URL para o id usado nos dados. Nos Parquet novos
 *  o próprio `pf-<hash>` É o valor da coluna (pseudonimizado no backend); em
 *  publicações antigas a coluna traz o CPF cru e o hash é revertido via md5. */
async function resolverId(param: string): Promise<string | null> {
  if (/^\d{6,14}$/.test(param)) return param;
  const m = /^pf-([0-9a-f]{16})$/.exec(param);
  if (!m) return null;
  const direto = await executarSQL(`
      SELECT 1 FROM despesas_atual WHERE NR_CPF_CNPJ_FORNECEDOR = 'pf-${m[1]}' LIMIT 1`);
  if (direto.total) return `pf-${m[1]}`;
  const r = await executarSQL(`
      SELECT DISTINCT NR_CPF_CNPJ_FORNECEDOR FROM despesas_atual
      WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 11
        AND md5(NR_CPF_CNPJ_FORNECEDOR) LIKE '${m[1]}%' LIMIT 1`);
  return r.total ? String(r.linhas[0][0]) : null;
}

async function carregarFornecedor(id: string): Promise<DadosFornecedor | null> {
  // guardas de tabelasDisponiveis só valem depois do boot (ver candidato.tsx)
  await obterConexao();
  const w = `NR_CPF_CNPJ_FORNECEDOR = '${esc(id)}'`;

  // consultas independentes disparadas juntas: o ganho é o pipeline das
  // leituras parciais dos parquet (rede), não paralelismo de CPU no worker
  const [perfilRes, docRepetidoRes, rfbRes, doacaoAgg, removidasAgg, candidatos, categorias,
         porDia, notas, doacoes, removidasRes, corrigidasDesp, corrigidasRec] =
    await Promise.all([
      executarSQL(`
      SELECT ANY_VALUE(COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR)),
             ANY_VALUE(NULLIF(DS_TIPO_FORNECEDOR, '#NULO')),
             ANY_VALUE(NULLIF(DS_CNAE_FORNECEDOR, '#NULO')),
             ANY_VALUE(CASE WHEN SQ_CANDIDATO_FORNECEDOR NOT IN ('-1', '#NULO')
                            THEN SQ_CANDIDATO_FORNECEDOR END),
             COUNT(DISTINCT SQ_CANDIDATO), COUNT(DISTINCT SG_PARTIDO), COUNT(DISTINCT SG_UF),
             ROUND(SUM(valor), 2), COUNT(*),
             -- mesma régua do backend (cond_sem_documento_fiscal em src/analises.py):
             -- documento não fiscal + PJ + categoria em que a nota é a norma
             ROUND(SUM(valor) FILTER (WHERE ${condicaoSemNota(tabelasDisponiveis.has('norma_documento'))}), 2),
             -- red flag 12: notas fiscais afirmadas sem número localizável
             COUNT(*) FILTER (WHERE ${CONDICAO_NOTA_SEM_NUMERO})
      FROM despesas_atual WHERE ${w}`),
      // red flag 13: quantos números de nota este fornecedor declarou para mais
      // de um candidato. É fato DO FORNECEDOR (numeração é sequencial por
      // emitente), então vira chip do cabeçalho — a tabela mostra só as 50
      // maiores notas e esconderia o achado.
      executarSQL(`
      SELECT COUNT(*), COALESCE(SUM(candidatos), 0) FROM (
        SELECT NR_DOCUMENTO, COUNT(DISTINCT SQ_CANDIDATO) AS candidatos
        FROM despesas_atual WHERE ${w} AND ${CONDICAO_DOCUMENTO_NUMERADO}
        GROUP BY 1 HAVING COUNT(DISTINCT SQ_CANDIDATO) > 1)`),
      tabelasDisponiveis.has('fornecedores')
        ? executarSQL(`
        SELECT razao_social, data_abertura, situacao, porte, opcao_mei, cnae_principal,
               NULLIF(municipio || '/' || uf, '/') AS sede, capital_social, socios,
               STRFTIME(dt_consulta, '%d/%m/%Y')
        FROM fornecedores WHERE cnpj = '${esc(id)}'`)
        : Promise.resolve({ linhas: [] as unknown[][] }),
      executarSQL(`
      SELECT ROUND(SUM(valor), 2), COUNT(DISTINCT SQ_CANDIDATO)
      FROM receitas_atual WHERE NR_CPF_CNPJ_DOADOR = '${esc(id)}'`),
      tabelasDisponiveis.has('despesas_removidas')
        ? executarSQL(`
        SELECT COUNT(*), ROUND(SUM(valor), 2)
        FROM despesas_removidas WHERE ${w}`)
        : Promise.resolve({ linhas: [] as unknown[][] }),
      executarSQL(`
      SELECT SQ_CANDIDATO, ANY_VALUE(NM_CANDIDATO), ANY_VALUE(DS_CARGO),
             ANY_VALUE(SG_PARTIDO), ANY_VALUE(SG_UF),
             COUNT(*) AS itens, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 50`),
      executarSQL(`
      SELECT DS_ORIGEM_DESPESA, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`),
      executarSQL(`
      SELECT STRFTIME(STRPTIME(DT_DESPESA, '%d/%m/%Y'), '%d/%m') AS dia,
             MIN(STRPTIME(DT_DESPESA, '%d/%m/%Y')) AS ord, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} AND DT_DESPESA <> '#NULO'
      GROUP BY 1 ORDER BY ord`),
      executarSQL(`
      SELECT DT_DESPESA AS "Data", SQ_CANDIDATO AS "_sq", NM_CANDIDATO AS "Candidato",
             DS_ORIGEM_DESPESA AS "Categoria", DS_DESPESA AS "Descrição",
             ${sqlDocumentoDaNota('DS_TIPO_DOCUMENTO', 'NR_DOCUMENTO')} AS "Documento",
             ROUND(valor, 2) AS "Valor",
             -- red flag 12: documento fiscal cujo número não tem um só dígito
             CASE WHEN ${CONDICAO_NOTA_SEM_NUMERO} THEN 1 ELSE 0 END AS "_semNumero",
             -- red flag 13: este fornecedor declarou o MESMO número para outro
             -- candidato. É um fato do fornecedor — esta é a página dele.
             CASE WHEN ${CONDICAO_DOCUMENTO_NUMERADO} AND EXISTS (
                    SELECT 1 FROM despesas_atual o
                    WHERE o.NR_CPF_CNPJ_FORNECEDOR = despesas_atual.NR_CPF_CNPJ_FORNECEDOR
                      AND o.NR_DOCUMENTO = despesas_atual.NR_DOCUMENTO
                      AND o.SQ_CANDIDATO <> despesas_atual.SQ_CANDIDATO)
                  THEN 1 ELSE 0 END AS "_docDeOutro"
      FROM despesas_atual WHERE ${w} ORDER BY valor DESC LIMIT 50`),
      executarSQL(`
        SELECT SQ_CANDIDATO AS "_sq", NM_CANDIDATO AS "Candidato",
               SG_PARTIDO || '/' || SG_UF AS "Partido/UF", DT_RECEITA AS "Data",
               DS_ORIGEM_RECEITA AS "Origem", DS_ESPECIE_RECEITA AS "Espécie",
               ROUND(valor, 2) AS "Valor"
        FROM receitas_atual WHERE NR_CPF_CNPJ_DOADOR = '${esc(id)}'
        ORDER BY valor DESC LIMIT 30`).then((x) => x.linhas),
      tabelasDisponiveis.has('despesas_removidas')
        ? executarSQL(`
        SELECT NM_CANDIDATO AS "Candidato", SG_PARTIDO || '/' || SG_UF AS "Partido/UF",
               DS_DESPESA AS "Descrição",
               ROUND(valor, 2) AS "Valor",
               STRFTIME(dt_primeira_extracao, '%d/%m/%Y') AS "Visível de",
               STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS "Até",
               SQ_CANDIDATO AS "_sq"
        FROM despesas_removidas
        WHERE ${w}
        ORDER BY 4 DESC LIMIT 30`).then((x) => x.linhas)
        : Promise.resolve([] as unknown[][]),
      // retificações prontas do backend; sem o parquet, a seção não aparece
      tabelasDisponiveis.has('despesas_alteradas')
        ? executarSQL(sqlCorrigidas('despesas_alteradas', w))
        : Promise.resolve({ linhas: [] as unknown[][] }),
      tabelasDisponiveis.has('receitas_alteradas')
        ? executarSQL(sqlCorrigidas('receitas_alteradas', `NR_CPF_CNPJ_DOADOR = '${esc(id)}'`))
        : Promise.resolve({ linhas: [] as unknown[][] }),
    ]);

  const l = perfilRes.linhas[0] ?? [];
  if (!Number(l[4])) return null;
  const semNota = Number(l[9] ?? 0);
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
        consultadoEm: r[9] == null ? null : String(r[9]),
      }
    : null;

  const totalDoado = Number(doacaoAgg.linhas[0]?.[0] ?? 0);
  // MESMA régua do resto do site (view despesas_removidas): retransmissões
  // renumeradas pelo TSE, retificações de um campo e linhas-placeholder não
  // contam como remoção — a consulta crua em `despesas` contava as três e
  // contradizia a Metodologia
  const valorRemovido = Number(removidasAgg.linhas[0]?.[1] ?? 0);
  const removidas = valorRemovido > 0 ? removidasRes : [];

  const flags: string[] = [];
  const nCandidatos = Number(l[4]);
  const nPartidos = Number(l[5] ?? 0);
  if (nCandidatos > 1)
    flags.push(`recebe de ${num.format(nCandidatos)} candidatos de ${num.format(nPartidos)} partido${nPartidos > 1 ? 's' : ''}`);
  if (totalDoado > 0) flags.push(`também aparece como doador: ${brl.format(totalDoado)}`);
  if (/f.sica/i.test(String(l[1] ?? ''))) flags.push('pessoa física prestando serviços de campanha');
  if (semNota > 0) flags.push(`${brl.format(semNota)} sem documento fiscal`);
  const notasSemNumero = Number(l[10] ?? 0);
  if (notasSemNumero > 0)
    flags.push(notasSemNumero === 1
      ? '1 nota fiscal declarada sem número'
      : `${num.format(notasSemNumero)} notas fiscais declaradas sem número`);
  const docsRepetidos = Number(docRepetidoRes.linhas[0]?.[0] ?? 0);
  if (docsRepetidos > 0)
    flags.push(docsRepetidos === 1
      ? '1 número de nota declarado para mais de um candidato'
      : `${num.format(docsRepetidos)} números de nota declarados para mais de um candidato`);
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

  // grafo: candidatos que pagam (despesa) e que recebem doação deste CNPJ/CPF;
  // quem faz as duas coisas com a mesma contraparte ganha o anel do "dinheiro que volta"
  const conexoes = new Map<string, NoConexao>();
  for (const c of candidatos.linhas.slice(0, 14)) {
    const sq = String(c[0]);
    conexoes.set(sq, {
      id: sq,
      rotulo: `${c[1]} (${c[3]}/${c[4]})`,
      valor: Number(c[6] ?? 0),
      tipo: 'despesa',
    });
  }
  const doadoPorSq = new Map<string, number>();
  for (const d of doacoes) {
    const sq = String(d[0]);
    doadoPorSq.set(sq, (doadoPorSq.get(sq) ?? 0) + Number(d[6] ?? 0));
  }
  for (const [sq, valorDoado] of doadoPorSq) {
    const existente = conexoes.get(sq);
    if (existente) {
      existente.tipo = 'ambos';
      existente.detalhe = `pagamentos ${brl.format(existente.valor)} · doações ${brl.format(valorDoado)}`;
      existente.valor += valorDoado;
    } else {
      const d = doacoes.find((x) => String(x[0]) === sq);
      conexoes.set(sq, {
        id: sq,
        rotulo: `${d?.[1] ?? 'Candidato'} (${d?.[2] ?? ''})`,
        valor: valorDoado,
        tipo: 'doacao',
      });
    }
  }

  // 2º nível do grafo: os outros maiores fornecedores de cada candidato — mostra
  // o ecossistema em que este fornecedor está inserido (parceiros de rateio?)
  const sqsGrafo = [...conexoes.keys()].slice(0, 10);
  let conexoesSecundarias: NoSecundario[] = [];
  if (sqsGrafo.length) {
    const lista = sqsGrafo.map((s) => `'${esc(s)}'`).join(', ');
    const outros = await executarSQL(`
        SELECT SQ_CANDIDATO, NR_CPF_CNPJ_FORNECEDOR,
               ANY_VALUE(COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR)) AS nome,
               ROUND(SUM(valor), 2) AS total
        FROM despesas_atual
        WHERE SQ_CANDIDATO IN (${lista})
          AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO', '${esc(id)}')
        GROUP BY 1, 2
        QUALIFY ROW_NUMBER() OVER (PARTITION BY SQ_CANDIDATO ORDER BY total DESC) <= 2`);
    const porFornecedor = new Map<string, NoSecundario>();
    for (const l of outros.linhas) {
      const cnpj = String(l[1]);
      const existente = porFornecedor.get(cnpj);
      if (existente) {
        existente.ligadoA.push(String(l[0]));
        existente.valor += Number(l[3] ?? 0);
      } else {
        porFornecedor.set(cnpj, {
          id: cnpj,
          rotulo: String(l[2]),
          valor: Number(l[3] ?? 0),
          ligadoA: [String(l[0])],
          detalhe: 'outro fornecedor do mesmo candidato',
        });
      }
    }
    conexoesSecundarias = [...porFornecedor.values()];
  }

  return {
    perfil,
    rfb,
    topCandidatos: candidatos.linhas.slice(0, 10).map((c) => ({
      rotulo: `${c[1]} (${c[3]}/${c[4]})`,
      valor: Number(c[6] ?? 0),
    })),
    conexoes: [...conexoes.values()],
    conexoesSecundarias,
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
    corrigidas: montarCorrigidas(corrigidasDesp.linhas),
    corrigidasReceitas: montarCorrigidas(corrigidasRec.linhas),
    notas: notas.linhas,
  };
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


/** Marca âmbar de indício numa célula de tabela — mesma linguagem visual dos
 *  chips das fichas, em escala de nota. */
function MarcaNota({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <span
      title={titulo}
      className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[#B45309]/40 bg-[#B45309]/10 px-2 py-0.5 text-[0.68rem] font-medium text-[#7c3a06]"
    >
      <AlertTriangle className="h-3 w-3" />
      {children}
    </span>
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
  }, [id, navigate]);

  // Ficha de pessoa física fica fora dos buscadores (minimização de exposição)
  useEffect(() => {
    if (!idReal || !ePessoaFisica(idReal)) return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [idReal]);

  if (dados === 'carregando') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <Spinner className="h-5 w-5" /> Consultando os dados do fornecedor no seu navegador…
      </div>
    );
  }
  if (dados === 'nao-encontrado' || dados === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <p>Fornecedor não encontrado (ou ainda sem despesas declaradas).</p>
        <Link to="/explorar" className="text-[#264E9B] underline underline-offset-4">Voltar ao Explorar</Link>
      </div>
    );
  }

  const p = dados.perfil;
  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6 sm:py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Ficha do fornecedor</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{p.nome}</h1>
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
            <CardContent className="p-5 sm:p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{r}</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">{v}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 404 na base pública é fato sobre o CADASTRO, não sobre o gasto: sem este
          aviso o bloco abaixo renderizava só "Situação: NAO ENCONTRADO NA BASE
          PUBLICA" em caixa alta, sob um título prometendo dados da Receita */}
      {dados.rfb?.situacao === SITUACAO_NAO_ENCONTRADA ? (
        <Secao
          titulo="Cadastro na Receita Federal"
          descricao="O que a consulta automática encontrou sobre este CNPJ."
        >
          <div className="rounded-xl border border-[#B45309]/40 bg-[#B45309]/5 p-5">
            <p className="flex items-start gap-2 font-semibold text-[#7c3a06]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                CNPJ não encontrado na base pública da Receita Federal
                {dados.rfb.consultadoEm && <> — consulta de {dados.rfb.consultadoEm}</>}.
              </span>
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              O número acima está declarado ao TSE, mas não corresponde a nenhum cadastro na
              base pública consultada. As explicações possíveis vão do trivial ao relevante:
              erro de digitação na declaração, CNPJ aberto há poucos dias e ainda não
              replicado, ou número que nunca existiu. O radar reconsulta periodicamente — se
              o cadastro aparecer, os dados passam a ser exibidos aqui.
            </p>
          </div>
        </Secao>
      ) : dados.rfb && (
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

      {dados.conexoes.length > 0 && (
        <SecaoRecolhivel
          aberta
          titulo="Rede de conexões"
          resumo={`${num.format(p.nCandidatos)} candidatos`}
          descricao="Candidatos que pagam este fornecedor (navy) e que recebem doações dele (âmbar); em cinza, os outros maiores fornecedores desses candidatos. Anel vermelho: os dois papéis ao mesmo tempo — o clássico 'dinheiro que volta'. Clique num nó para abrir a ficha."
        >
          <GrafoConexoes
            centro={p.nome}
            nos={dados.conexoes}
            secundarios={dados.conexoesSecundarias}
            rotuloSecundarios="outros fornecedores dos mesmos candidatos"
            aoClicar={(no) => navigate(`/candidato/${no.id}`)}
            aoClicarSecundario={(no) => {
              if (temFichaFornecedor(no.id)) navigate(urlFornecedor(no.id));
            }}
          />
        </SecaoRecolhivel>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Secao titulo="Quem paga este fornecedor" descricao="Os dez candidatos com maior valor contratado.">
          <BarrasHorizontais dados={dados.topCandidatos} />
        </Secao>
        <Secao titulo="O que ele fornece" descricao="Categorias de gasto declaradas pelos candidatos.">
          <BarrasHorizontais dados={dados.categorias} />
        </Secao>
      </div>

      <SecaoRecolhivel titulo="Recebimentos no tempo" descricao="Soma dos valores contratados pela data declarada da despesa.">
        <LinhaTemporal pontos={dados.porDia} />
      </SecaoRecolhivel>

      <SecaoRecolhivel
        titulo="Candidatos atendidos"
        resumo={`${num.format(dados.candidatos.length)} listados`}
        descricao="Clique para abrir a ficha completa de cada candidato."
      >
        <Tabela colunas={[{ titulo: 'Candidato' }, { titulo: 'Cargo' }, { titulo: 'Partido/UF' }, { titulo: 'Itens', numerica: true }, { titulo: 'Total', numerica: true }]}>
          {dados.candidatos.map((c) => {
            const maxTotal = dados.candidatos[0]?.total ?? 0;
            return (
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
              <CelulaNum frac={maxTotal > 0 ? c.total / maxTotal : undefined}>{brl.format(c.total)}</CelulaNum>
            </tr>
            );
          })}
        </Tabela>
      </SecaoRecolhivel>

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

      <SecaoRecolhivel
        titulo="Despesas declaradas"
        resumo={`${num.format(p.itens)} itens · ${brl.format(p.total)}`}
        descricao="As cinquenta maiores notas com este fornecedor no estado atual das declarações."
      >
        <Tabela colunas={[{ titulo: 'Data' }, { titulo: 'Candidato' }, { titulo: 'Categoria' }, { titulo: 'Descrição' }, { titulo: 'Documento' }, { titulo: 'Valor', numerica: true }]}>
          {dados.notas.map((l, i) => {
            const maxNota = Number(dados.notas[0]?.[6] ?? 0);
            return (
            <tr key={i} className="hover:bg-muted/40">
              <td className="whitespace-nowrap">{celula(l[0])}</td>
              <td>
                <Link to={`/candidato/${celula(l[1])}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                  {celula(l[2])}
                </Link>
              </td>
              <td className="text-muted-foreground">{celula(l[3])}</td>
              <CelulaTexto>{celula(l[4])}</CelulaTexto>
              <td className="text-muted-foreground">
                {celula(l[5]) || '—'}
                {Number(l[7] ?? 0) === 1 && (
                  <MarcaNota titulo="O documento é fiscal, mas o número declarado não tem um só dígito — a nota é afirmada e não dá para localizar.">
                    sem número
                  </MarcaNota>
                )}
                {Number(l[8] ?? 0) === 1 && (
                  <MarcaNota titulo="Este mesmo número de documento foi declarado para outro candidato. Numeração de nota é sequencial por emitente: repetir entre campanhas sugere nota reaproveitada — ou erro de digitação.">
                    nº repetido em outro candidato
                  </MarcaNota>
                )}
              </td>
              <CelulaNum frac={maxNota > 0 ? Number(l[6] ?? 0) / maxNota : undefined}>
                {brl.format(Number(l[6] ?? 0))}
              </CelulaNum>
            </tr>
            );
          })}
        </Tabela>
      </SecaoRecolhivel>
      {dados.removidas.length > 0 && (
        <Secao titulo="Declarações removidas" descricao="Despesas com este fornecedor que estavam declaradas ao TSE e deixaram de estar. Pode ser correção legítima — é um indício, não uma acusação.">
          <Tabela colunas={[{ titulo: 'Candidato' }, { titulo: 'Partido/UF' }, { titulo: 'Descrição' }, { titulo: 'Valor', numerica: true }, { titulo: 'Visível de' }, { titulo: 'Até' }]}>
            {dados.removidas.map((l, i) => (
              <tr key={i}>
                <td className="min-w-[13rem]">
                  <Link to={`/candidato/${celula(l[6])}`} className="text-[#264E9B] underline-offset-4 hover:underline">
                    {celula(l[0])}
                  </Link>
                </td>
                <td className="text-muted-foreground">{celula(l[1])}</td>
                <CelulaTexto>{celula(l[2])}</CelulaTexto>
                <CelulaNum>{brl.format(Number(l[3] ?? 0))}</CelulaNum>
                <td>{celula(l[4])}</td><td>{celula(l[5])}</td>
              </tr>
            ))}
          </Tabela>
        </Secao>
      )}

      <SecaoCorrigidas itens={dados.corrigidas} coluna="candidato" tipo="despesa" />
      <SecaoCorrigidas itens={dados.corrigidasReceitas} coluna="candidato" tipo="receita" />
    </div>
  );
}
