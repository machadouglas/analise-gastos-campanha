import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ChevronRight, Download } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { SecaoCorrigidas, montarCorrigidas, type Corrigida } from '@/components/app/corrigidas';
import { Secao } from '@/components/app/secao';
import { Tabela, CelulaNum, CelulaTexto } from '@/components/app/tabela';
import { SecaoRecolhivel } from '@/components/app/recolhivel';
import {
  BarrasHorizontais,
  BarraComposicao,
  FaixasDePreco,
  LinhasComparadas,
  type FaixaPreco,
  type ItemBarra,
  type MarcaLinha,
  type Serie,
} from '@/components/app/graficos';
import { FluxoDinheiro, type NoFluxo } from '@/components/app/sankey';
import { GrafoConexoes, type NoConexao, type NoSecundario } from '@/components/app/grafo';
import { Ampliavel } from '@/components/app/ampliavel';
import { executarSQL, obterConexao, tabelasDisponiveis } from '@/lib/duckdb';
import {
  MARGEM_GASTO_ACIMA, SITUACAO_NAO_ENCONTRADA, escSQL, sqlCorrigidas, sqlNotasDoCandidato,
} from '@/lib/consultas';
import { brl, num, celula, cnpjCpf, dataBR, temFichaFornecedor, urlFornecedor } from '@/lib/format';
import { METRICAS, metrica } from '@/lib/metricas';
import { gerarCartaoCandidato } from '@/lib/cartao';
import { FotoCandidato } from '@/components/app/foto';

interface Perfil {
  nome: string;
  numero: string;
  partido: string;
  cargo: string;
  uf: string;
  /** metadados da foto oficial (registro de candidaturas); null se indisponíveis */
  cdEleicao: string | null;
  sgUe: string | null;
  contratado: number;
  receitas: number | null;
  pago: number | null;
  pctFundosPublicos: number | null;
  fundosPublicos: number;
  recursosProprios: number;
  nFornecedores: number;
  cnpjs: number;
  cnpjsConsultados: number;
  flags: string[];
}

interface Bem {
  tipo: string;
  descricao: string;
  valor: number;
}

/** Uma nota declarada, com as red flags que são por nota (12, 13 e 7 do
 *  catálogo) já resolvidas pela consulta — ver sqlNotasDoCandidato. */
interface Nota {
  data: string;
  categoria: string;
  descricao: string;
  documento: string;
  valor: number;
  itens: number;
  semNumero: boolean;
  valorRepetido: boolean;
  docDeOutro: boolean;
}

/** Agrupa as notas pelo CNPJ/CPF, que é a chave da linha de fornecedor. */
function agruparNotas(linhas: unknown[][]): Map<string, Nota[]> {
  const mapa = new Map<string, Nota[]>();
  for (const l of linhas) {
    const cnpj = celula(l[0]);
    const nota: Nota = {
      data: celula(l[1]),
      categoria: celula(l[2]),
      descricao: celula(l[3]),
      // já vem montado ("Nota Fiscal nº 1426"), com os dois marcadores de nulo
      // do TSE tratados — ver sqlDocumentoDaNota
      documento: celula(l[4]),
      valor: Number(l[5] ?? 0),
      itens: Number(l[6] ?? 0),
      semNumero: Number(l[7] ?? 0) === 1,
      valorRepetido: Number(l[8] ?? 0) === 1,
      docDeOutro: Number(l[9] ?? 0) === 1,
    };
    const atual = mapa.get(cnpj);
    if (atual) atual.push(nota);
    else mapa.set(cnpj, [nota]);
  }
  return mapa;
}

/** As notas de um fornecedor, abertas dentro da linha dele. Antes a ficha
 *  dizia "4 itens" e não deixava ver quais — e as red flags por nota só
 *  existiam como consulta de exemplo no console SQL.
 *
 *  Tabela aninhada, não lista corrida: com data, descrição, documento e valor
 *  soltos numa linha só, quatro notas viravam um bloco de texto impossível de
 *  varrer. Alinhadas em coluna, a comparação entre notas é imediata — que é o
 *  que denuncia fracionamento (mesmo valor, dias seguidos). */
function NotasDoFornecedor({ notas }: { notas: Nota[] }) {
  return (
    <div className="px-1 py-2">
      <p className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">
        {notas.length === 1 ? '1 nota declarada' : `${num.format(notas.length)} notas declaradas`}
      </p>
      <table className="w-full border-separate border-spacing-y-1 text-xs">
        <thead className="sr-only">
          <tr>
            <th>Data</th>
            <th>Descrição</th>
            <th>Documento</th>
            <th>Valor</th>
          </tr>
        </thead>
        <tbody>
          {notas.map((n, i) => (
            <tr key={i} className="align-top">
              <td className="w-[6.5rem] whitespace-nowrap py-1 pr-3 text-muted-foreground">
                {n.data}
              </td>
              <td className="py-1 pr-3">
                <span className="text-[#10244A]">{n.descricao}</span>
                {n.itens > 1 && (
                  <span className="text-muted-foreground/70"> · {n.itens} itens</span>
                )}
                {(n.semNumero || n.docDeOutro || n.valorRepetido) && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {n.semNumero && (
                      <MarcaNota titulo="O documento é fiscal, mas o número declarado não tem um só dígito — a nota é afirmada e não dá para localizar.">
                        nota sem número
                      </MarcaNota>
                    )}
                    {n.docDeOutro && (
                      <MarcaNota titulo="Este fornecedor declarou o mesmo número de documento para outro candidato. Numeração de nota é sequencial por emitente.">
                        nº repetido em outro candidato
                      </MarcaNota>
                    )}
                    {n.valorRepetido && (
                      <MarcaNota titulo="Este mesmo valor aparece em 3 ou mais notas distintas deste fornecedor — padrão de fracionamento.">
                        valor repetido
                      </MarcaNota>
                    )}
                  </span>
                )}
              </td>
              <td className="w-[11rem] py-1 pr-3 text-muted-foreground/80">
                {n.documento || '—'}
              </td>
              <td className="w-[7rem] whitespace-nowrap py-1 text-right font-medium tabular-nums text-[#10244A]">
                {brl.format(n.valor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MarcaNota({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <span
      title={titulo}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[#B45309]/40 bg-[#B45309]/10 px-2 py-0.5 text-[0.68rem] font-medium text-[#7c3a06]"
    >
      <AlertTriangle className="h-3 w-3" />
      {children}
    </span>
  );
}

interface DadosCandidato {
  perfil: Perfil;
  serieRotulos: string[];
  series: Serie[];
  marcas: MarcaLinha[];
  categorias: ItemBarra[];
  categoriasFluxo: ItemBarra[];
  origensReceita: NoFluxo[];
  conexoes: NoConexao[];
  conexoesSecundarias: NoSecundario[];
  fornecedores: unknown[][];
  colunasFornecedores: string[];
  /** notas de cada fornecedor, indexadas pelo CNPJ/CPF da linha da tabela */
  notasPorFornecedor: Map<string, Nota[]>;
  corrigidas: Corrigida[];
  corrigidasReceitas: Corrigida[];
  faixas: FaixaPreco[];
  comparacao: FaixaPreco[];
  receitas: unknown[][];
  colunasReceitas: string[];
  removidas: unknown[][];
  /** null = tabela de bens indisponível; [] = candidato sem bens declarados */
  bens: Bem[] | null;
}

const esc = escSQL;

/** Ficha mínima de quem se registrou mas não declarou nenhuma despesa/receita:
 *  72% das candidaturas no início da campanha. A ausência de movimento é, em
 *  si, a informação da página. */
interface FichaRegistro {
  registroSemMovimento: true;
  nomeUrna: string;
  nome: string;
  numero: string;
  partido: string;
  cargo: string;
  uf: string;
  situacao: string | null;
  cdEleicao: string | null;
  sgUe: string | null;
  dtExtracao: string | null;
  totalBens: number | null;
  bens: Bem[];
}

/** Bens declarados ao registrar a candidatura — usados tanto na ficha completa
 *  quanto na ficha sem movimento. Os dois chamadores já aguardaram a conexão,
 *  então a guarda abaixo lê um tabelasDisponiveis já populado.
 *  null = parquet ainda não publicado (a ficha omite a seção); [] = registro
 *  sem nenhum bem, que é um fato e a ficha declara como tal. */
async function carregarBens(w: string): Promise<Bem[] | null> {
  if (!tabelasDisponiveis.has('bens')) return null;
  const r = await executarSQL(`
      SELECT DS_TIPO_BEM_CANDIDATO, DS_BEM_CANDIDATO, ROUND(VR, 2)
      FROM bens WHERE ${w} ORDER BY VR DESC LIMIT 30`);
  return r.linhas.map((b) => ({
    tipo: String(b[0] ?? ''),
    descricao: String(b[1] ?? ''),
    valor: Number(b[2] ?? 0),
  }));
}

async function carregarRegistro(sq: string): Promise<FichaRegistro | null> {
  // tabelasDisponiveis só é populado quando o motor termina de iniciar; num
  // load direto desta rota nada o bootou antes e as guardas abaixo leriam um
  // Set vazio — aguarde a conexão antes de decidir. Não custa latência:
  // executarSQL já aguarda obterConexao, nenhuma consulta começaria antes.
  await obterConexao();
  if (!tabelasDisponiveis.has('candidatos')) return null;
  const w = `SQ_CANDIDATO = '${esc(sq)}'`;
  const [reg, extracao, bens] = await Promise.all([
    executarSQL(`
        SELECT ANY_VALUE(NM_URNA_CANDIDATO), ANY_VALUE(NM_CANDIDATO), ANY_VALUE(NR_CANDIDATO),
               ANY_VALUE(SG_PARTIDO), ANY_VALUE(DS_CARGO), ANY_VALUE(SG_UF),
               ANY_VALUE(NULLIF(NULLIF(DS_SITUACAO_CANDIDATURA, '#NE'), '#NULO')),
               ANY_VALUE(CD_ELEICAO), ANY_VALUE(SG_UE)
        FROM candidatos WHERE ${w}`),
    tabelasDisponiveis.has('serie_diaria')
      ? executarSQL(`SELECT STRFTIME(MAX(dt_extracao), '%d/%m/%Y') FROM serie_diaria`)
      : Promise.resolve({ linhas: [] as unknown[][] }),
    carregarBens(w),
  ]);
  const l = reg.linhas[0];
  if (!l || l[0] == null) return null;
  const listaBens = bens ?? [];
  return {
    registroSemMovimento: true,
    nomeUrna: String(l[0]),
    nome: String(l[1]),
    numero: String(l[2] ?? ''),
    partido: String(l[3] ?? ''),
    cargo: String(l[4] ?? ''),
    uf: String(l[5] ?? ''),
    situacao: l[6] == null ? null : String(l[6]),
    cdEleicao: l[7] == null ? null : String(l[7]),
    sgUe: l[8] == null ? null : String(l[8]),
    dtExtracao: extracao.linhas[0]?.[0] == null ? null : String(extracao.linhas[0][0]),
    totalBens: listaBens.length ? listaBens.reduce((s, b) => s + b.valor, 0) : null,
    bens: listaBens,
  };
}

/** Amostra dos indicadores do grupo de comparação para o beeswarm — uma linha
 *  por candidato do grupo, colunas = métricas comparáveis. */
async function amostraGrupo(cargo: string, uf: string | null): Promise<Record<string, number[]>> {
  const colunas = Object.keys(METRICAS);
  const ondeUf = uf ? `AND SG_UF = '${esc(uf)}'` : '';
  try {
    const r = await executarSQL(`
        SELECT ${colunas.join(', ')}, n_fornecedores
        FROM indicadores
        WHERE DS_CARGO ILIKE '${esc(cargo)}' ${ondeUf}
        USING SAMPLE 200 ROWS (reservoir, 42)`);
    const idx = Object.fromEntries(r.colunas.map((c, i) => [c, i]));
    const saida: Record<string, number[]> = {};
    for (const c of colunas) {
      saida[c] = r.linhas
        .filter((l) => l[idx[c]] != null &&
          // mesma régua do benchmark: concentração só faz sentido com 2+ fornecedores
          (c !== 'pct_maior_fornecedor' || Number(l[idx.n_fornecedores]) > 1))
        .map((l) => Number(l[idx[c]]));
    }
    return saida;
  } catch {
    return {};
  }
}

async function carregarCandidato(sq: string): Promise<DadosCandidato | null> {
  // tabelasDisponiveis só é populado quando o motor termina de iniciar; num
  // load direto desta rota nada o bootou antes e as guardas abaixo leriam um
  // Set vazio — aguarde a conexão antes de decidir. Não custa latência:
  // executarSQL já aguarda obterConexao, nenhuma consulta começaria antes.
  await obterConexao();
  const w = `SQ_CANDIDATO = '${esc(sq)}'`;
  const temForn = tabelasDisponiveis.has('fornecedores');

  // 1ª onda: tudo que não depende de resultado anterior, junto — o ganho é o
  // pipeline das leituras parciais dos parquet, o gargalo real da ficha
  const [ind, fotoRes, serie, categorias, origens, fornecedores, doadores, notasRes,
         corrigidasDesp, corrigidasRec, faixasRes, receitas, removidas, bens] =
    await Promise.all([
      executarSQL(`SELECT * FROM indicadores WHERE ${w}`),
      tabelasDisponiveis.has('candidatos')
        ? executarSQL(`SELECT ANY_VALUE(CD_ELEICAO), ANY_VALUE(SG_UE) FROM candidatos WHERE ${w}`)
            .catch(() => ({ linhas: [] as unknown[][] }))
        : Promise.resolve({ linhas: [] as unknown[][] }),
      tabelasDisponiveis.has('serie_diaria')
        ? executarSQL(`
        SELECT STRFTIME(dt_extracao, '%d/%m') AS dia, total_contratado, total_receitas
        FROM serie_diaria WHERE ${w} ORDER BY dt_extracao`)
        : Promise.resolve({ linhas: [] as unknown[][] }),
      // sem LIMIT: a cauda é agregada em "Outras" adiante — cortar aqui fazia o
      // sankey somar menos "contratado" do que o KPI da mesma página
      executarSQL(`
      SELECT DS_ORIGEM_DESPESA, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC`),
      executarSQL(`
      SELECT DS_ORIGEM_RECEITA, ROUND(SUM(valor), 2) AS total
      FROM receitas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC`),
      executarSQL(`
      SELECT COALESCE(NULLIF(d.NM_FORNECEDOR_RFB, '#NULO'), NULLIF(d.NM_FORNECEDOR, '#NULO'),
                      'Não identificado (declarado sem contraparte)') AS "Fornecedor",
             d.NR_CPF_CNPJ_FORNECEDOR AS "CNPJ/CPF",
             ROUND(SUM(d.valor), 2) AS "Total",
             COUNT(*) AS "Itens"
             ${temForn ? `, ANY_VALUE(f.data_abertura) AS "Empresa aberta em",
             ANY_VALUE(f.municipio || '/' || f.uf) AS "Sede",
             -- coluna oculta (prefixo _): 404 na Receita vem com tudo NULL e
             -- ficaria igual a "ainda não consultado" na tabela
             ANY_VALUE(f.situacao) AS "_situacao"` : ''}
      FROM despesas_atual d
      ${temForn ? 'LEFT JOIN fornecedores f ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj' : ''}
      WHERE d.${w} GROUP BY 1, 2 ORDER BY "Total" DESC LIMIT 30`),
      executarSQL(`
      SELECT NR_CPF_CNPJ_DOADOR,
             COALESCE(NULLIF(NM_DOADOR_RFB, '#NULO'), NULLIF(NM_DOADOR, '#NULO'),
                      'Doador não identificado') AS nome,
             ROUND(SUM(valor), 2) AS total
      FROM receitas_atual WHERE ${w}
      GROUP BY 1, 2 ORDER BY total DESC LIMIT 12`),
      // as notas que cada linha de fornecedor esconde (mediana de 2 por
      // candidato, p95 de 24 — cabe tudo de uma vez, sem consulta por clique)
      executarSQL(sqlNotasDoCandidato(w)),
      // retificações prontas do backend; sem o parquet, a seção não aparece
      tabelasDisponiveis.has('despesas_alteradas')
        ? executarSQL(sqlCorrigidas('despesas_alteradas', w))
        : Promise.resolve({ linhas: [] as unknown[][] }),
      tabelasDisponiveis.has('receitas_alteradas')
        ? executarSQL(sqlCorrigidas('receitas_alteradas', w))
        : Promise.resolve({ linhas: [] as unknown[][] }),
      tabelasDisponiveis.has('benchmark_precos')
        ? executarSQL(`
        WITH notas AS (
          SELECT DS_ORIGEM_DESPESA, SG_UF, SUM(valor) AS valor, MIN(DS_DESPESA) AS descricao
          FROM despesas_atual WHERE ${w} AND SQ_DESPESA <> '-1'
          GROUP BY DS_ORIGEM_DESPESA, SG_UF, SQ_DESPESA
          UNION ALL
          SELECT DS_ORIGEM_DESPESA, SG_UF, valor, DS_DESPESA
          FROM despesas_atual WHERE ${w} AND SQ_DESPESA = '-1')
        SELECT n.DS_ORIGEM_DESPESA, b.p25, b.mediana, b.p75, b.p95, n.valor, n.descricao
        FROM notas n
        JOIN benchmark_precos b
          ON b.DS_ORIGEM_DESPESA = n.DS_ORIGEM_DESPESA AND b.SG_UF = n.SG_UF
        WHERE n.valor IS NOT NULL AND n.valor > 0
        ORDER BY b.mediana DESC, n.valor DESC LIMIT 200`)
        : Promise.resolve({ colunas: [] as string[], linhas: [] as unknown[][] }),
      executarSQL(`
      SELECT DT_RECEITA AS "Data", NM_DOADOR AS "Doador", DS_ORIGEM_RECEITA AS "Origem",
             DS_ESPECIE_RECEITA AS "Espécie", ROUND(valor, 2) AS "Valor"
      FROM receitas_atual WHERE ${w} ORDER BY valor DESC LIMIT 50`),
      // mesma régua do backend: sem retransmissões renumeradas, sem placeholders
      tabelasDisponiveis.has('despesas_removidas')
        ? executarSQL(`
        SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NULLIF(NM_FORNECEDOR, '#NULO'),
                        'Não identificado (declarado sem contraparte)') AS "Fornecedor",
               DS_DESPESA AS "Descrição",
               ROUND(valor, 2) AS "Valor",
               STRFTIME(dt_primeira_extracao, '%d/%m/%Y') AS "Visível de",
               STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS "Até",
               NR_CPF_CNPJ_FORNECEDOR AS "_cnpj"
        FROM despesas_removidas
        WHERE ${w}
        ORDER BY 3 DESC LIMIT 30`)
        : Promise.resolve({ linhas: [] as unknown[][] }),
      carregarBens(w),
    ]);
  if (!ind.total) return null;
  const linha = Object.fromEntries(ind.colunas.map((c, i) => [c, ind.linhas[0][i]])) as Record<string, unknown>;

  const flags: string[] = [];
  const razao = Number(linha.razao_gasto_receita ?? 0);
  // mesma MARGEM do backend, mas régua deliberadamente mais simples que a do
  // sinal da home (que exige também estar acima do p95 do grupo): o chip da
  // ficha marca o fato "gastou mais do que arrecadou com folga", documentado
  // na Metodologia como duas réguas que não se misturam
  if (razao > MARGEM_GASTO_ACIMA) flags.push(metrica('razao_gasto_receita').frase(razao));
  if (Number(linha.pct_maior_fornecedor ?? 0) >= 50 && Number(linha.n_fornecedores) > 1)
    flags.push(`${linha.pct_maior_fornecedor}% do gasto em um único fornecedor`);
  if (Number(linha.valor_sem_nota ?? 0) > 0)
    flags.push(`${brl.format(Number(linha.valor_sem_nota))} sem documento fiscal`);
  if (Number(linha.valor_pessoa_fisica ?? 0) > 0)
    flags.push(`${brl.format(Number(linha.valor_pessoa_fisica))} pagos a pessoas físicas`);
  const repetidos = Number(linha.grupos_valor_repetido ?? 0);
  if (repetidos > 0)
    flags.push(repetidos === 1
      ? '1 valor repetido 3+ vezes no mesmo fornecedor'
      : `${repetidos} valores repetidos 3+ vezes no mesmo fornecedor`);
  if (Number(linha.valor_removido ?? 0) > 0)
    flags.push(`${brl.format(Number(linha.valor_removido))} removidos da declaração`);
  const recemAbertos = Number(linha.fornecedores_recem_abertos ?? 0);
  if (recemAbertos > 0)
    flags.push(
      (recemAbertos === 1
        ? '1 fornecedor com CNPJ recém-aberto'
        : `${recemAbertos} fornecedores com CNPJ recém-aberto`) +
      ` (${linha.fornecedores_consultados} de ${linha.fornecedores_cnpj} CNPJs verificados)`,
    );

  // foto oficial: precisa de CD_ELEICAO/SG_UE do registro de candidaturas
  // (parquet antigo pode não ter as colunas — a ficha degrada para iniciais)
  const foto = fotoRes.linhas[0];
  const cdEleicao = foto?.[0] == null ? null : String(foto[0]);
  const sgUe = foto?.[1] == null ? null : String(foto[1]);

  const perfil: Perfil = {
    nome: String(linha.NM_CANDIDATO),
    numero: String(linha.NR_CANDIDATO),
    partido: String(linha.SG_PARTIDO),
    cargo: String(linha.DS_CARGO),
    uf: String(linha.SG_UF),
    cdEleicao,
    sgUe,
    contratado: Number(linha.total_contratado ?? 0),
    receitas: linha.total_receitas == null ? null : Number(linha.total_receitas),
    pago: linha.total_pago == null ? null : Number(linha.total_pago),
    pctFundosPublicos: linha.pct_fundos_publicos == null ? null : Number(linha.pct_fundos_publicos),
    fundosPublicos: Number(linha.fundos_publicos ?? 0),
    recursosProprios: Number(linha.recursos_proprios ?? 0),
    nFornecedores: Number(linha.n_fornecedores ?? 0),
    cnpjs: Number(linha.fornecedores_cnpj ?? 0),
    cnpjsConsultados: Number(linha.fornecedores_consultados ?? 0),
    flags,
  };

  // faixa típica de cada indicador no grupo de comparação (mesmo cargo, mesma
  // UF; nacional quando o grupo local é pequeno) — responde "isso é muito?"
  const comparacao: FaixaPreco[] = [];
  if (tabelasDisponiveis.has('benchmark_indicadores')) {
    const grupos = await executarSQL(`
        SELECT metrica, SG_UF, candidatos, p25, mediana, p75, p95
        FROM benchmark_indicadores
        WHERE DS_CARGO = '${esc(perfil.cargo)}' AND SG_UF IN ('${esc(perfil.uf)}', 'BR-TODAS')`);
    const porMetrica = new Map<string, { ambito: string; n: number; p25: number; mediana: number; p75: number; p95: number }>();
    for (const l of grupos.linhas) {
      const nome = String(l[0]);
      const ambito = String(l[1]);
      if (!porMetrica.has(nome) || ambito !== 'BR-TODAS') {
        porMetrica.set(nome, {
          ambito, n: Number(l[2]),
          p25: Number(l[3]), mediana: Number(l[4]), p75: Number(l[5]), p95: Number(l[6]),
        });
      }
    }
    // beeswarm: pontos cinza = amostra dos candidatos do grupo de cada métrica
    const precisaLocal = [...porMetrica.values()].some((g) => g.ambito !== 'BR-TODAS');
    const precisaBr = [...porMetrica.values()].some((g) => g.ambito === 'BR-TODAS');
    const vazio: Record<string, number[]> = {};
    const [grupoLocal, grupoBr] = await Promise.all([
      precisaLocal ? amostraGrupo(perfil.cargo, perfil.uf) : Promise.resolve(vazio),
      precisaBr ? amostraGrupo(perfil.cargo, null) : Promise.resolve(vazio),
    ]);
    for (const nome of Object.keys(METRICAS)) {
      const grupo = porMetrica.get(nome);
      const valor = linha[nome];
      if (!grupo || valor == null) continue;
      if (nome === 'pct_maior_fornecedor' && Number(linha.n_fornecedores) <= 1) continue;
      const info = metrica(nome);
      const amostra = (grupo.ambito === 'BR-TODAS' ? grupoBr : grupoLocal)[nome] ?? [];
      comparacao.push({
        categoria: `${info.rotulo} · grupo: ${grupo.n} candidatos${grupo.ambito === 'BR-TODAS' ? ' (BR)' : ''}`,
        p25: grupo.p25, mediana: grupo.mediana, p75: grupo.p75, p95: grupo.p95,
        notas: [{ valor: Number(valor), descricao: perfil.nome }],
        grupo: amostra,
        formatar: info.formatar,
      });
    }
  }

  // grafo de conexões: maiores fornecedores + maiores doadores, com destaque
  // para quem aparece nos dois papéis (red flag nº 4, "dinheiro que volta")
  const conexoes = new Map<string, NoConexao>();
  for (const l of fornecedores.linhas.slice(0, 12)) {
    const id = String(l[1]);
    if (id === '-1' || id === '#NULO') continue;
    conexoes.set(id, { id, rotulo: String(l[0]), valor: Number(l[2] ?? 0), tipo: 'despesa' });
  }
  for (const l of doadores.linhas) {
    const id = String(l[0]);
    if (id === '-1' || id === '#NULO') continue;
    const existente = conexoes.get(id);
    if (existente) {
      existente.tipo = 'ambos';
      existente.detalhe = `pagamentos ${brl.format(existente.valor)} · doações ${brl.format(Number(l[2] ?? 0))}`;
      existente.valor += Number(l[2] ?? 0);
    } else {
      conexoes.set(id, { id, rotulo: String(l[1]), valor: Number(l[2] ?? 0), tipo: 'doacao' });
    }
  }

  // 2º nível do grafo: outros candidatos que pagam os MESMOS fornecedores
  // (fornecedor compartilhado — red flag nº 3 — visível na própria rede)
  const cnpjsGrafo = [...conexoes.keys()].filter((id) => id.length >= 11);
  let conexoesSecundarias: NoSecundario[] = [];
  if (cnpjsGrafo.length) {
    const lista = cnpjsGrafo.map((c) => `'${esc(c)}'`).join(', ');
    const outros = await executarSQL(`
        SELECT NR_CPF_CNPJ_FORNECEDOR, SQ_CANDIDATO,
               ANY_VALUE(NM_CANDIDATO) || ' (' || ANY_VALUE(SG_PARTIDO) || '/' || ANY_VALUE(SG_UF) || ')' AS rotulo,
               ROUND(SUM(valor), 2) AS total
        FROM despesas_atual
        WHERE NR_CPF_CNPJ_FORNECEDOR IN (${lista}) AND NOT ${w}
        GROUP BY 1, 2
        QUALIFY ROW_NUMBER() OVER (PARTITION BY NR_CPF_CNPJ_FORNECEDOR ORDER BY total DESC) <= 3`);
    const porCandidato = new Map<string, NoSecundario>();
    for (const l of outros.linhas) {
      const sqOutro = String(l[1]);
      const existente = porCandidato.get(sqOutro);
      if (existente) {
        existente.ligadoA.push(String(l[0]));
        existente.valor += Number(l[3] ?? 0);
      } else {
        porCandidato.set(sqOutro, {
          id: sqOutro,
          rotulo: String(l[2]),
          valor: Number(l[3] ?? 0),
          ligadoA: [String(l[0])],
          detalhe: 'também paga este fornecedor',
        });
      }
    }
    conexoesSecundarias = [...porCandidato.values()];
  }

  // a unidade é a nota (soma dos itens de mesma SQ_DESPESA), como no benchmark;
  // SQ_DESPESA = '-1' não permite reagrupar e cada linha conta como uma nota
  const faixasPorCategoria = new Map<string, FaixaPreco>();
  for (const l of faixasRes.linhas) {
    const cat = String(l[0]);
    if (!faixasPorCategoria.has(cat)) {
      faixasPorCategoria.set(cat, {
        categoria: cat,
        p25: l[1] == null ? null : Number(l[1]),
        mediana: l[2] == null ? null : Number(l[2]),
        p75: l[3] == null ? null : Number(l[3]),
        p95: l[4] == null ? null : Number(l[4]),
        notas: [],
      });
    }
    faixasPorCategoria.get(cat)!.notas.push({ valor: Number(l[5]), descricao: String(l[6] ?? '') });
  }

  // marca na linha do tempo: último dia em que cada conteúdo removido esteve visível
  const serieRotulos = serie.linhas.map((l) => String(l[0]));
  const diasRemocao = new Set(removidas.linhas.map((l) => String(l[4] ?? '').slice(0, 5)));
  const marcas: MarcaLinha[] = serieRotulos.flatMap((r, i) =>
    diasRemocao.has(r) ? [{ indice: i, rotulo: 'declaração removida — visível até este dia' }] : [],
  );

  // sankey: top origens e categorias, resto agregado em "Outras"
  const agruparCauda = (itens: NoFluxo[], teto: number): NoFluxo[] => {
    if (itens.length <= teto) return itens;
    const cauda = itens.slice(teto).reduce((s, n) => s + n.valor, 0);
    return [...itens.slice(0, teto), { rotulo: `Outras (${itens.length - teto})`, valor: cauda }];
  };
  const origensReceita = agruparCauda(
    origens.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1] ?? 0) })).filter((n) => n.valor > 0),
    6,
  );
  // os DOIS lados do sankey agregam a cauda: truncar as saídas fazia o rodapé
  // ("contratado R$ X" e a tesoura) divergir do KPI da própria página
  const todasCategorias = categorias.linhas.map(
    (l) => ({ rotulo: String(l[0]), valor: Number(l[1]) }));
  const categoriasFluxo = agruparCauda(todasCategorias, 8);

  return {
    perfil,
    serieRotulos,
    series: [
      { nome: 'Contratado', valores: serie.linhas.map((l) => Number(l[1] ?? 0)) },
      { nome: 'Arrecadado', valores: serie.linhas.map((l) => Number(l[2] ?? 0)) },
    ],
    marcas,
    categorias: agruparCauda(todasCategorias, 10),
    categoriasFluxo,
    origensReceita,
    conexoes: [...conexoes.values()],
    conexoesSecundarias,
    colunasFornecedores: fornecedores.colunas,
    fornecedores: fornecedores.linhas,
    notasPorFornecedor: agruparNotas(notasRes.linhas),
    corrigidas: montarCorrigidas(corrigidasDesp.linhas),
    corrigidasReceitas: montarCorrigidas(corrigidasRec.linhas),
    faixas: [...faixasPorCategoria.values()].slice(0, 8),
    comparacao,
    colunasReceitas: receitas.colunas,
    receitas: receitas.linhas,
    removidas: removidas.linhas,
    bens,
  };
}


function TabelaBens({ bens }: { bens: Bem[] }) {
  return (
    <Tabela colunas={[{ titulo: 'Tipo' }, { titulo: 'Descrição' }, { titulo: 'Valor', numerica: true }]}>
      {bens.map((b, i) => (
        <tr key={i}>
          <td className="whitespace-nowrap text-muted-foreground">{b.tipo}</td>
          <CelulaTexto>{b.descricao}</CelulaTexto>
          <CelulaNum>{brl.format(b.valor)}</CelulaNum>
        </tr>
      ))}
    </Tabela>
  );
}

function FichaSemMovimento({ ficha, sq }: { ficha: FichaRegistro; sq: string }) {
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6 sm:py-12">
      <div className="flex flex-wrap items-start gap-4 sm:gap-5">
        <FotoCandidato
          cdEleicao={ficha.cdEleicao}
          sq={sq}
          sgUe={ficha.sgUe}
          nome={ficha.nomeUrna}
          className="h-24 w-24 text-2xl"
        />
        <div className="min-w-[12rem] flex-1">
          <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Ficha do candidato</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{ficha.nomeUrna}</h1>
          <p className="mt-2 text-muted-foreground">
            {ficha.nome} · nº {ficha.numero} · {ficha.cargo} · {ficha.partido}/{ficha.uf}
            {ficha.situacao && <> · registro: {ficha.situacao.toLowerCase()}</>}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-6 sm:p-6">
          <p className="text-lg font-semibold text-[#10244A]">
            Nenhuma despesa ou receita declarada ao TSE
            {ficha.dtExtracao && <> até a extração de {ficha.dtExtracao}</>}.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            A candidatura está registrada, mas a prestação de contas ainda não traz nenhum
            movimento financeiro — nem gasto contratado, nem doação recebida. Durante a
            campanha os dados são atualizados diariamente; quando algo for declarado (ou
            declarado e depois removido), aparece aqui. Ausência de movimento a esta altura
            não é irregularidade — é um fato datado, registrado por esta página.
          </p>
        </CardContent>
      </Card>

      {ficha.totalBens != null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Patrimônio declarado no registro</CardTitle>
            <CardDescription>
              Bens declarados pelo próprio candidato ao registrar a candidatura —{' '}
              {brl.format(ficha.totalBens)} no total.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TabelaBens bens={ficha.bens} />
          </CardContent>
        </Card>
      )}

      <p className="text-sm text-muted-foreground">
        <Link to="/explorar" className="text-[#264E9B] underline-offset-4 hover:underline">
          Explorar quem já declarou movimentação
        </Link>
      </p>
    </div>
  );
}

export function Candidato() {
  const { sq } = useParams<{ sq: string }>();
  const navigate = useNavigate();
  const [dados, setDados] = useState<DadosCandidato | FichaRegistro | null | 'carregando' | 'nao-encontrado'>('carregando');
  const [gerandoCartao, setGerandoCartao] = useState(false);
  // linhas de fornecedor abertas (por CNPJ) — a ficha guarda o que o leitor
  // abriu enquanto navega pela tabela
  const [notasAbertas, setNotasAbertas] = useState<Set<string>>(new Set());
  const alternarNotas = (cnpj: string) =>
    setNotasAbertas((atual) => {
      const proximo = new Set(atual);
      if (!proximo.delete(cnpj)) proximo.add(cnpj);
      return proximo;
    });

  useEffect(() => {
    if (!sq || !/^\d+$/.test(sq)) {
      setDados('nao-encontrado');
      return;
    }
    setDados('carregando');
    // sem movimento declarado a ficha não morre: cai para o registro de
    // candidatura — a ausência de despesas/receitas é a informação da página
    carregarCandidato(sq)
      .then(async (d) => setDados(d ?? (await carregarRegistro(sq)) ?? 'nao-encontrado'))
      .catch(() => setDados('nao-encontrado'));
  }, [sq]);

  if (dados === 'carregando') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <Spinner className="h-5 w-5" /> Consultando os dados do candidato no seu navegador…
      </div>
    );
  }
  if (dados === 'nao-encontrado' || dados === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <p>Candidato não encontrado no registro de candidaturas desta eleição.</p>
        <Link to="/explorar" className="text-[#264E9B] underline underline-offset-4">Voltar ao Explorar</Link>
      </div>
    );
  }
  if ('registroSemMovimento' in dados) {
    return <FichaSemMovimento ficha={dados} sq={sq!} />;
  }

  const p = dados.perfil;
  const maxFornecedor = Math.max(...dados.fornecedores.map((l) => Number(l[2] ?? 0)), 0);
  const maxReceita = Math.max(...dados.receitas.map((l) => Number(l[4] ?? 0)), 0);
  const doacoesPrivadas = Math.max((p.receitas ?? 0) - p.fundosPublicos - p.recursosProprios, 0);

  async function baixarCartao() {
    setGerandoCartao(true);
    try {
      const blob = await gerarCartaoCandidato({
        nome: p.nome,
        numero: p.numero,
        cargo: p.cargo,
        partido: p.partido,
        uf: p.uf,
        arrecadado: p.receitas,
        contratado: p.contratado,
        pctPublico: p.pctFundosPublicos,
        flags: p.flags,
        fotoUrl: p.cdEleicao && sq && p.sgUe
          ? `https://divulgacandcontas.tse.jus.br/divulga/rest/arquivo/img/${p.cdEleicao}/${sq}/${p.sgUe}`
          : null,
        url: `${window.location.host}/candidato/${sq}`,
      });
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `radar-${p.numero}-${p.nome.toLowerCase().replace(/\s+/g, '-').normalize('NFD').replace(/[^\w-]/g, '')}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setGerandoCartao(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6 sm:py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Ficha do candidato</p>
        <div className="mt-2 flex flex-wrap items-center gap-3 sm:gap-4">
          <FotoCandidato
            cdEleicao={p.cdEleicao}
            sq={sq ?? null}
            sgUe={p.sgUe}
            nome={p.nome}
            className="h-16 w-16 text-lg sm:h-20 sm:w-20"
          />
          {/* min-w: sem um piso, o botão ao lado espremia o nome a ~120px e
              cada palavra virava uma linha */}
          <div className="min-w-[12rem] flex-1">
            <h1 className="text-2xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">{p.nome}</h1>
            <p className="mt-2 text-muted-foreground">
              nº {p.numero} · {p.cargo} ·{' '}
              <Link to={`/partido/${encodeURIComponent(p.partido)}`} className="text-[#264E9B] underline underline-offset-4">
                {p.partido}
              </Link>{' '}
              · {p.uf}
            </p>
          </div>
          <button
            onClick={() => void baixarCartao()}
            disabled={gerandoCartao}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:border-[#264E9B]/40 hover:text-foreground disabled:opacity-60 sm:w-auto"
            title="Gera uma imagem PNG com o resumo desta ficha, pronta para compartilhar"
          >
            {gerandoCartao ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />}
            Cartão para compartilhar
          </button>
        </div>
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
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ['Arrecadado', p.receitas == null ? '—' : brl.format(p.receitas)],
          ['Contratado', brl.format(p.contratado)],
          ['Pago até agora', p.pago == null ? '—' : brl.format(p.pago)],
          ['Dinheiro público', p.pctFundosPublicos == null ? '—' : `${p.pctFundosPublicos.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do arrecadado`],
          ['Fornecedores', num.format(p.nFornecedores)],
          ['Gasto ÷ arrecadado', p.receitas ? metrica('razao_gasto_receita').formatar(p.contratado / p.receitas) : '—'],
        ].map(([r, v]) => (
          <Card key={r}>
            <CardContent className="p-5 sm:p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{r}</p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-[#10244A]">{v}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {(p.receitas ?? 0) > 0 && (
        <Secao
          titulo="Composição da receita"
          descricao="De que tipo de dinheiro a campanha vive: fundos públicos (Fundo Eleitoral + Fundo Partidário), bolso do próprio candidato e doações de terceiros."
        >
          <BarraComposicao
            fatias={[
              { rotulo: 'Dinheiro público', valor: p.fundosPublicos, cor: '#264E9B' },
              { rotulo: 'Recursos próprios', valor: p.recursosProprios, cor: '#B45309' },
              { rotulo: 'Demais doações', valor: doacoesPrivadas, cor: '#6e6a60' },
            ]}
          />
        </Secao>
      )}

      {(dados.origensReceita.length > 0 || dados.categorias.length > 0) && (
        <SecaoRecolhivel
          aberta
          titulo="Fluxo do dinheiro"
          descricao="De onde a receita veio (esquerda) e em que tipos de gasto foi contratada (direita). Os lados podem somar valores diferentes — contratar acima do arrecadado aparece aqui."
        >
          <Ampliavel titulo="Fluxo do dinheiro">
            <FluxoDinheiro
              entradas={dados.origensReceita}
              saidas={dados.categoriasFluxo}
              centro={p.nome}
            />
          </Ampliavel>
        </SecaoRecolhivel>
      )}

      {dados.comparacao.length > 0 && (
        <SecaoRecolhivel
          aberta
          titulo={`Comparado aos candidatos a ${p.cargo}`}
          descricao="Cada linha é uma métrica: pontos cinza são os demais candidatos do grupo de comparação (mesmo cargo e UF; nacional quando o grupo local é pequeno), o ponto âmbar é este candidato. Estar fora da faixa não é irregularidade — é onde vale perguntar."
        >
          <FaixasDePreco faixas={dados.comparacao} rotuloPontos="este candidato" />
        </SecaoRecolhivel>
      )}

      {dados.conexoes.length > 0 && (
        <SecaoRecolhivel
          aberta
          titulo="Rede de conexões"
          resumo={`${dados.conexoes.length} contrapartes`}
          descricao="Maiores fornecedores e doadores deste candidato; em cinza, outros candidatos que pagam os mesmos fornecedores (fornecedor compartilhado). Anel vermelho marca quem aparece nos dois papéis — o clássico 'dinheiro que volta'. Clique num nó para abrir a ficha."
        >
          <GrafoConexoes
            centro={p.nome}
            nos={dados.conexoes}
            secundarios={dados.conexoesSecundarias}
            rotuloSecundarios="outros candidatos do mesmo fornecedor"
            aoClicar={(no) => {
              if (no.tipo !== 'doacao' && temFichaFornecedor(no.id)) navigate(urlFornecedor(no.id));
            }}
            aoClicarSecundario={(no) => navigate(`/candidato/${no.id}`)}
          />
        </SecaoRecolhivel>
      )}

      <SecaoRecolhivel
        titulo="Dinheiro no tempo"
        descricao="Evolução do declarado a cada extração diária: despesa contratada × receita arrecadada. Tesoura aberta = gasto sem origem declarada ainda."
      >
        <LinhasComparadas rotulos={dados.serieRotulos} series={dados.series} marcas={dados.marcas} />
      </SecaoRecolhivel>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SecaoRecolhivel titulo="Para onde vai o dinheiro" descricao="Categorias de gasto declaradas.">
          <BarrasHorizontais dados={dados.categorias} />
        </SecaoRecolhivel>
        <SecaoRecolhivel titulo="Preços × mercado" descricao="Cada ponto âmbar é uma nota deste candidato sobre a distribuição de preços da categoria na UF. Pontos muito à direita da faixa merecem pergunta.">
          <FaixasDePreco faixas={dados.faixas} />
        </SecaoRecolhivel>
      </div>

      <SecaoRecolhivel
        titulo="Fornecedores"
        resumo={`${num.format(p.nFornecedores)} · maior ${brl.format(maxFornecedor)}`}
        descricao={`Quem recebeu, quanto — e, quando disponível, a idade e a sede da empresa (${p.cnpjsConsultados} de ${p.cnpjs} CNPJs já verificados na Receita Federal). Clique no nome para abrir a ficha do fornecedor.`}
      >
        <Tabela colunas={dados.colunasFornecedores.filter((c) => !c.startsWith('_')).map((c) => ({ titulo: c, numerica: c === 'Total' || c === 'Itens' }))}>
          {dados.fornecedores.map((l, i) => {
          const cnpjLinha = celula(l[1]);
          const notas = dados.notasPorFornecedor.get(cnpjLinha) ?? [];
          const aberta = notasAbertas.has(cnpjLinha);
          const comMarca = notas.some((n) => n.semNumero || n.docDeOutro || n.valorRepetido);
          return (
            <Fragment key={i}>
            <tr
              className={notas.length ? 'cursor-pointer hover:bg-muted/40' : 'hover:bg-muted/40'}
              onClick={notas.length ? () => alternarNotas(cnpjLinha) : undefined}
            >
              {l.map((v, j) => {
                const col = dados.colunasFornecedores[j];
                if (col.startsWith('_')) return null;
                if (col === 'Total')
                  return (
                    <CelulaNum key={j} frac={maxFornecedor > 0 ? Number(v ?? 0) / maxFornecedor : undefined}>
                      {brl.format(Number(v ?? 0))}
                    </CelulaNum>
                  );
                if (col === 'Itens') return <CelulaNum key={j}>{num.format(Number(v ?? 0))}</CelulaNum>;
                if (col === 'Empresa aberta em') {
                  const naoEncontrado =
                    celula(l[dados.colunasFornecedores.indexOf('_situacao')]) === SITUACAO_NAO_ENCONTRADA;
                  return (
                    <td key={j}>
                      {naoEncontrado ? (
                        <span
                          className="whitespace-nowrap text-xs text-[#7c3a06]"
                          title="O CNPJ declarado ao TSE não corresponde a nenhum cadastro na base pública consultada. Abra a ficha do fornecedor para o detalhe."
                        >
                          CNPJ não encontrado na Receita
                        </span>
                      ) : (
                        dataBR(celula(v))
                      )}
                    </td>
                  );
                }
                if (col === 'CNPJ/CPF') return <td key={j} className="whitespace-nowrap text-muted-foreground">{cnpjCpf(celula(v))}</td>;
                if (col === 'Fornecedor')
                  return (
                    <td key={j}>
                      <span className="flex items-start gap-1">
                        {notas.length > 0 && (
                          <ChevronRight
                            aria-hidden
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${aberta ? 'rotate-90' : ''}`}
                          />
                        )}
                        <span>
                          {temFichaFornecedor(cnpjLinha) ? (
                            <Link
                              to={urlFornecedor(cnpjLinha)}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[#264E9B] underline-offset-4 hover:underline"
                            >
                              {celula(v)}
                            </Link>
                          ) : (
                            celula(v)
                          )}
                          {comMarca && !aberta && (
                            <AlertTriangle
                              aria-label="há notas com indício nesta linha"
                              className="ml-1.5 inline h-3.5 w-3.5 align-[-2px] text-[#B45309]"
                            />
                          )}
                        </span>
                      </span>
                    </td>
                  );
                return <td key={j}>{celula(v)}</td>;
              })}
            </tr>
            {aberta && (
              <tr>
                <td colSpan={dados.colunasFornecedores.filter((c) => !c.startsWith('_')).length}
                    className="bg-muted/30">
                  <NotasDoFornecedor notas={notas} />
                </td>
              </tr>
            )}
            </Fragment>
          );
          })}
        </Tabela>
      </SecaoRecolhivel>

      <SecaoRecolhivel
        titulo="Doações e repasses declarados"
        descricao="De onde vem o dinheiro, maiores primeiro."
      >
        <Tabela colunas={dados.colunasReceitas.map((c) => ({ titulo: c, numerica: c === 'Valor' }))}>
          {dados.receitas.map((l, i) => (
            <tr key={i}>
              {l.map((v, j) =>
                dados.colunasReceitas[j] === 'Valor'
                  ? (
                    <CelulaNum key={j} frac={maxReceita > 0 ? Number(v ?? 0) / maxReceita : undefined}>
                      {brl.format(Number(v ?? 0))}
                    </CelulaNum>
                  )
                  : <td key={j}>{celula(v)}</td>,
              )}
            </tr>
          ))}
        </Tabela>
      </SecaoRecolhivel>

      {dados.removidas.length > 0 && (
        <Secao titulo="Declarações removidas" descricao="Conteúdo que estava declarado ao TSE e deixou de estar — já descontadas as renumerações do sistema e as retificações de um campo. É um indício, não uma acusação.">
          <Tabela colunas={[{ titulo: 'Fornecedor' }, { titulo: 'Descrição' }, { titulo: 'Valor', numerica: true }, { titulo: 'Visível de' }, { titulo: 'Até' }]}>
            {dados.removidas.map((l, i) => (
              <tr key={i}>
                <td className="min-w-[12rem]">
                  {temFichaFornecedor(celula(l[5])) ? (
                    <Link to={urlFornecedor(celula(l[5]))} className="text-[#264E9B] underline-offset-4 hover:underline">
                      {celula(l[0])}
                    </Link>
                  ) : (
                    celula(l[0])
                  )}
                </td>
                <CelulaTexto>{celula(l[1])}</CelulaTexto>
                <CelulaNum>{brl.format(Number(l[2] ?? 0))}</CelulaNum>
                <td>{celula(l[3])}</td><td>{celula(l[4])}</td>
              </tr>
            ))}
          </Tabela>
        </Secao>
      )}

      <SecaoCorrigidas itens={dados.corrigidas} coluna="contraparte" tipo="despesa" />
      <SecaoCorrigidas itens={dados.corrigidasReceitas} coluna="contraparte" tipo="receita" />

      {dados.bens && (
        <SecaoRecolhivel
          titulo="Patrimônio declarado no registro"
          resumo={
            dados.bens.length
              ? brl.format(dados.bens.reduce((s, b) => s + b.valor, 0))
              : 'nenhum bem declarado'
          }
          descricao="Bens declarados pelo próprio candidato ao registrar a candidatura. Não é dinheiro de campanha — é o contexto patrimonial de quem gasta e arrecada acima."
        >
          {dados.bens.length > 0 ? (
            <TabelaBens bens={dados.bens} />
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">
              O candidato não declarou nenhum bem ao registrar a candidatura. Não é
              irregularidade — é o que consta no registro, e fica aqui ao lado do que a
              campanha contratou e arrecadou.
            </p>
          )}
        </SecaoRecolhivel>
      )}
    </div>
  );
}
