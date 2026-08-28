import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Download } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
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
import { executarSQL, tabelasDisponiveis } from '@/lib/duckdb';
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

interface DadosCandidato {
  perfil: Perfil;
  serieRotulos: string[];
  series: Serie[];
  marcas: MarcaLinha[];
  categorias: ItemBarra[];
  origensReceita: NoFluxo[];
  conexoes: NoConexao[];
  conexoesSecundarias: NoSecundario[];
  fornecedores: unknown[][];
  colunasFornecedores: string[];
  faixas: FaixaPreco[];
  comparacao: FaixaPreco[];
  receitas: unknown[][];
  colunasReceitas: string[];
  removidas: unknown[][];
}

function esc(s: string) {
  return s.replaceAll("'", "''");
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
  const w = `SQ_CANDIDATO = '${esc(sq)}'`;

  const ind = await executarSQL(`SELECT * FROM indicadores WHERE ${w}`);
  if (!ind.total) return null;
  const linha = Object.fromEntries(ind.colunas.map((c, i) => [c, ind.linhas[0][i]])) as Record<string, unknown>;

  const flags: string[] = [];
  const razao = Number(linha.razao_gasto_receita ?? 0);
  // mesma régua do sinal do backend (razão > 1): gastou mais do que arrecadou
  if (razao > 1) flags.push(`contratou ${razao.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}× o que declarou arrecadar`);
  if (Number(linha.pct_maior_fornecedor ?? 0) >= 50 && Number(linha.n_fornecedores) > 1)
    flags.push(`${linha.pct_maior_fornecedor}% do gasto em um único fornecedor`);
  if (Number(linha.valor_sem_nota ?? 0) > 0)
    flags.push(`${brl.format(Number(linha.valor_sem_nota))} sem nota fiscal`);
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
  let cdEleicao: string | null = null;
  let sgUe: string | null = null;
  if (tabelasDisponiveis.has('candidatos')) {
    try {
      const r = await executarSQL(
        `SELECT ANY_VALUE(CD_ELEICAO), ANY_VALUE(SG_UE) FROM candidatos WHERE ${w}`,
      );
      const l = r.linhas[0];
      if (l && l[0] != null && l[1] != null) {
        cdEleicao = String(l[0]);
        sgUe = String(l[1]);
      }
    } catch {
      // sem as colunas no parquet publicado — segue sem foto
    }
  }

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

  const serie = tabelasDisponiveis.has('serie_diaria')
    ? await executarSQL(`
        SELECT STRFTIME(dt_extracao, '%d/%m') AS dia, total_contratado, total_receitas
        FROM serie_diaria WHERE ${w} ORDER BY dt_extracao`)
    : { linhas: [] as unknown[][] };

  const categorias = await executarSQL(`
      SELECT DS_ORIGEM_DESPESA, ROUND(SUM(valor), 2) AS total
      FROM despesas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC LIMIT 10`);

  const origens = await executarSQL(`
      SELECT DS_ORIGEM_RECEITA, ROUND(SUM(valor), 2) AS total
      FROM receitas_atual WHERE ${w} GROUP BY 1 ORDER BY total DESC`);

  const temForn = tabelasDisponiveis.has('fornecedores');
  const fornecedores = await executarSQL(`
      SELECT COALESCE(NULLIF(d.NM_FORNECEDOR_RFB, '#NULO'), NULLIF(d.NM_FORNECEDOR, '#NULO'),
                      'Não identificado (declarado sem contraparte)') AS "Fornecedor",
             d.NR_CPF_CNPJ_FORNECEDOR AS "CNPJ/CPF",
             ROUND(SUM(d.valor), 2) AS "Total",
             COUNT(*) AS "Itens"
             ${temForn ? `, ANY_VALUE(f.data_abertura) AS "Empresa aberta em",
             ANY_VALUE(f.municipio || '/' || f.uf) AS "Sede"` : ''}
      FROM despesas_atual d
      ${temForn ? 'LEFT JOIN fornecedores f ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj' : ''}
      WHERE d.${w} GROUP BY 1, 2 ORDER BY "Total" DESC LIMIT 30`);

  // grafo de conexões: maiores fornecedores + maiores doadores, com destaque
  // para quem aparece nos dois papéis (red flag nº 4, "dinheiro que volta")
  const doadores = await executarSQL(`
      SELECT NR_CPF_CNPJ_DOADOR,
             COALESCE(NULLIF(NM_DOADOR_RFB, '#NULO'), NULLIF(NM_DOADOR, '#NULO'),
                      'Doador não identificado') AS nome,
             ROUND(SUM(valor), 2) AS total
      FROM receitas_atual WHERE ${w}
      GROUP BY 1, 2 ORDER BY total DESC LIMIT 12`);
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
  const faixasRes = tabelasDisponiveis.has('benchmark_precos')
    ? await executarSQL(`
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
    : { colunas: [] as string[], linhas: [] as unknown[][] };

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

  const receitas = await executarSQL(`
      SELECT DT_RECEITA AS "Data", NM_DOADOR AS "Doador", DS_ORIGEM_RECEITA AS "Origem",
             DS_ESPECIE_RECEITA AS "Espécie", ROUND(valor, 2) AS "Valor"
      FROM receitas_atual WHERE ${w} ORDER BY valor DESC LIMIT 50`);

  // mesma régua do backend: sem retransmissões renumeradas, sem placeholders
  const removidas = tabelasDisponiveis.has('despesas_removidas')
    ? await executarSQL(`
        SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NULLIF(NM_FORNECEDOR, '#NULO'),
                        'Não identificado (declarado sem contraparte)') AS "Fornecedor",
               DS_DESPESA AS "Descrição",
               ROUND(valor, 2) AS "Valor",
               STRFTIME(dt_primeira_extracao, '%d/%m/%Y') AS "Visível de",
               STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS "Até"
        FROM despesas_removidas
        WHERE ${w}
        ORDER BY 3 DESC LIMIT 30`)
    : { linhas: [] as unknown[][] };

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

  return {
    perfil,
    serieRotulos,
    series: [
      { nome: 'Contratado', valores: serie.linhas.map((l) => Number(l[1] ?? 0)) },
      { nome: 'Arrecadado', valores: serie.linhas.map((l) => Number(l[2] ?? 0)) },
    ],
    marcas,
    categorias: categorias.linhas.map((l) => ({ rotulo: String(l[0]), valor: Number(l[1]) })),
    origensReceita,
    conexoes: [...conexoes.values()],
    conexoesSecundarias,
    colunasFornecedores: fornecedores.colunas,
    fornecedores: fornecedores.linhas,
    faixas: [...faixasPorCategoria.values()].slice(0, 8),
    comparacao,
    colunasReceitas: receitas.colunas,
    receitas: receitas.linhas,
    removidas: removidas.linhas,
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

export function Candidato() {
  const { sq } = useParams<{ sq: string }>();
  const navigate = useNavigate();
  const [dados, setDados] = useState<DadosCandidato | null | 'carregando' | 'nao-encontrado'>('carregando');
  const [gerandoCartao, setGerandoCartao] = useState(false);

  useEffect(() => {
    if (!sq || !/^\d+$/.test(sq)) {
      setDados('nao-encontrado');
      return;
    }
    setDados('carregando');
    carregarCandidato(sq)
      .then((d) => setDados(d ?? 'nao-encontrado'))
      .catch(() => setDados('nao-encontrado'));
  }, [sq]);

  if (dados === 'carregando') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3 text-muted-foreground">
        <Spinner className="h-5 w-5" /> Consultando os dados do candidato no seu navegador…
      </div>
    );
  }
  if (dados === 'nao-encontrado' || dados === null) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>Candidato não encontrado (ou ainda sem movimentação declarada).</p>
        <Link to="/explorar" className="text-[#264E9B] underline underline-offset-4">Voltar ao Explorar</Link>
      </div>
    );
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
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Ficha do candidato</p>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <FotoCandidato
            cdEleicao={p.cdEleicao}
            sq={sq ?? null}
            sgUe={p.sgUe}
            nome={p.nome}
            className="h-16 w-16 text-lg sm:h-20 sm:w-20"
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{p.nome}</h1>
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
            className="inline-flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:border-[#264E9B]/40 hover:text-foreground disabled:opacity-60"
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
          ['Gasto ÷ arrecadado', p.receitas ? `${(p.contratado / p.receitas).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}×` : '—'],
        ].map(([r, v]) => (
          <Card key={r}>
            <CardContent className="p-5">
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
              saidas={dados.categorias.slice(0, 8)}
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

      {dados.removidas.length > 0 && (
        <Secao titulo="Declarações removidas" descricao="Conteúdo que estava declarado ao TSE e deixou de estar. Pode ser correção legítima — é um indício, não uma acusação.">
          <Tabela colunas={[{ titulo: 'Fornecedor' }, { titulo: 'Descrição' }, { titulo: 'Valor', numerica: true }, { titulo: 'Visível de' }, { titulo: 'Até' }]}>
            {dados.removidas.map((l, i) => (
              <tr key={i}>
                <td>{celula(l[0])}</td><CelulaTexto>{celula(l[1])}</CelulaTexto>
                <CelulaNum>{brl.format(Number(l[2] ?? 0))}</CelulaNum>
                <td>{celula(l[3])}</td><td>{celula(l[4])}</td>
              </tr>
            ))}
          </Tabela>
        </Secao>
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
        <Tabela colunas={dados.colunasFornecedores.map((c) => ({ titulo: c, numerica: c === 'Total' || c === 'Itens' }))}>
          {dados.fornecedores.map((l, i) => (
            <tr key={i} className="hover:bg-muted/40">
              {l.map((v, j) => {
                const col = dados.colunasFornecedores[j];
                if (col === 'Total')
                  return (
                    <CelulaNum key={j} frac={maxFornecedor > 0 ? Number(v ?? 0) / maxFornecedor : undefined}>
                      {brl.format(Number(v ?? 0))}
                    </CelulaNum>
                  );
                if (col === 'Itens') return <CelulaNum key={j}>{num.format(Number(v ?? 0))}</CelulaNum>;
                if (col === 'Empresa aberta em') return <td key={j}>{dataBR(celula(v))}</td>;
                if (col === 'CNPJ/CPF') return <td key={j} className="whitespace-nowrap text-muted-foreground">{cnpjCpf(celula(v))}</td>;
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
    </div>
  );
}
