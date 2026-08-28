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
import { metrica } from '@/lib/metricas';

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
type Visao = 'atual' | 'fora-da-curva' | 'removidas' | 'compartilhados' | 'sem-nota' | 'pessoa-fisica';

const VISOES: { id: Visao; rotulo: string; descricao: string }[] = [
  {
    id: 'atual',
    rotulo: 'Todos os gastos',
    descricao: 'Estado atual das despesas declaradas ao TSE.',
  },
  {
    id: 'fora-da-curva',
    rotulo: 'Fora da curva',
    descricao:
      'Candidatos acima do p95 do próprio grupo de comparação (mesmo cargo e UF; âmbito nacional quando o grupo local é pequeno) em ao menos uma métrica. Estar fora da curva não é irregularidade — é onde vale perguntar. Refine por UF, cargo, partido ou nome.',
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

// espelha METRICAS_SINAL em src/resumo.py: sinal = métrica estritamente acima
// do p95 do grupo (cargo×UF; BR-TODAS quando o grupo local não existe)
const SINAIS_CTE = `
  metricas AS (
    SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'total_contratado' AS metrica, total_contratado AS valor
    FROM indicadores WHERE total_contratado > 0
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'razao_gasto_receita', razao_gasto_receita
    FROM indicadores WHERE razao_gasto_receita IS NOT NULL
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'pct_maior_fornecedor', pct_maior_fornecedor
    FROM indicadores WHERE n_fornecedores > 1
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'pct_sem_nota', pct_sem_nota
    FROM indicadores WHERE total_contratado > 0
    UNION ALL SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, 'pct_pessoa_fisica', pct_pessoa_fisica
    FROM indicadores WHERE total_contratado > 0),
  sinais AS (
    SELECT m.SQ_CANDIDATO, m.metrica, m.valor, COALESCE(buf.p95, bbr.p95) AS p95
    FROM metricas m
    LEFT JOIN benchmark_indicadores buf
      ON buf.DS_CARGO = m.DS_CARGO AND buf.SG_UF = m.SG_UF AND buf.metrica = m.metrica
    LEFT JOIN benchmark_indicadores bbr
      ON bbr.DS_CARGO = m.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.metrica = m.metrica
    WHERE COALESCE(buf.p95, bbr.p95) IS NOT NULL AND m.valor > COALESCE(buf.p95, bbr.p95))`;

// filtro de segundo nível da visão fora-da-curva: EM QUAL sinal a pessoa
// destoa ('' = qualquer). Ids espelham METRICAS_SINAL em src/resumo.py.
const SINAIS_FILTRO = [
  'total_contratado',
  'razao_gasto_receita',
  'pct_maior_fornecedor',
  'pct_sem_nota',
  'pct_pessoa_fisica',
] as const;
type SinalFiltro = (typeof SINAIS_FILTRO)[number] | '';

const ROTULO_SINAL_SQL = `CASE s.metrica
  WHEN 'total_contratado' THEN 'gasto total'
  WHEN 'razao_gasto_receita' THEN 'gasto ÷ arrecadado'
  WHEN 'pct_maior_fornecedor' THEN 'concentração no maior fornecedor'
  WHEN 'pct_sem_nota' THEN '% sem nota fiscal'
  WHEN 'pct_pessoa_fisica' THEN '% a pessoas físicas'
  ELSE s.metrica END`;

/** Filtros aplicáveis sobre `indicadores` (fornecedor/descrição não existem lá). */
function whereIndicadores(f: Filtros): string {
  const esc = (s: string) => s.replaceAll("'", "''");
  const partes = ['1=1'];
  if (f.uf) partes.push(`i.SG_UF = '${esc(f.uf)}'`);
  if (f.cargo) partes.push(`i.DS_CARGO ILIKE '${esc(f.cargo)}'`);
  if (f.partido) partes.push(`i.SG_PARTIDO = '${esc(f.partido)}'`);
  const cand = f.candidato.trim();
  if (cand) {
    partes.push(
      /^\d+$/.test(cand) ? `i.NR_CANDIDATO = '${cand}'` : `i.NM_CANDIDATO ILIKE '%${esc(cand)}%'`,
    );
  }
  return partes.join(' AND ');
}

/** CTE do fora-da-curva POR CATEGORIA: total do candidato na categoria contra
 *  o p95 do grupo em benchmark_categorias (UF, com fallback BR-TODAS). */
function cteCategoria(categoria: string): string {
  const cat = categoria.replaceAll("'", "''");
  return `
  gasto AS (
    SELECT SQ_CANDIDATO, SUM(valor) AS total
    FROM despesas_atual WHERE DS_ORIGEM_DESPESA = '${cat}' GROUP BY 1),
  estouro AS (
    SELECT g.SQ_CANDIDATO, g.total, COALESCE(buf.p95, bbr.p95) AS p95
    FROM gasto g
    JOIN indicadores i USING (SQ_CANDIDATO)
    LEFT JOIN benchmark_categorias buf
      ON buf.DS_CARGO = i.DS_CARGO AND buf.SG_UF = i.SG_UF AND buf.DS_ORIGEM_DESPESA = '${cat}'
    LEFT JOIN benchmark_categorias bbr
      ON bbr.DS_CARGO = i.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.DS_ORIGEM_DESPESA = '${cat}'
    WHERE COALESCE(buf.p95, bbr.p95) IS NOT NULL AND g.total > COALESCE(buf.p95, bbr.p95))`;
}

function whereDaVisao(visao: Visao, f: Filtros, sinal: SinalFiltro, categoria: string): { base: string; where: string } {
  const w = montarWhere(f);
  if (visao === 'removidas') return { base: 'despesas_removidas', where: w };
  if (visao === 'fora-da-curva') {
    // gráficos e KPIs mostram os gastos DOS candidatos fora da curva do recorte
    if (categoria) {
      return {
        base: 'despesas_atual',
        where:
          `${w} AND SQ_CANDIDATO IN (WITH ${cteCategoria(categoria)} ` +
          `SELECT e.SQ_CANDIDATO FROM estouro e ` +
          `JOIN indicadores i USING (SQ_CANDIDATO) WHERE ${whereIndicadores(f)})`,
      };
    }
    const porSinal = sinal ? ` AND s.metrica = '${sinal}'` : '';
    return {
      base: 'despesas_atual',
      where:
        `${w} AND SQ_CANDIDATO IN (WITH ${SINAIS_CTE} ` +
        `SELECT DISTINCT s.SQ_CANDIDATO FROM sinais s ` +
        `JOIN indicadores i USING (SQ_CANDIDATO) WHERE ${whereIndicadores(f)}${porSinal})`,
    };
  }
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
      const { base, where: w } = whereDaVisao(v, f, s, cat);
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
        v === 'fora-da-curva' && cat
          ? `WITH ${cteCategoria(cat)}
             SELECT i.SQ_CANDIDATO AS "_sq", '' AS "_cnpj",
                    i.NM_CANDIDATO AS "Candidato",
                    i.SG_PARTIDO || '/' || i.SG_UF AS "Partido/UF",
                    i.DS_CARGO AS "Cargo",
                    ROUND(e.total, 2) AS "Neste tipo de gasto",
                    ROUND(e.p95, 2) AS "p95 do grupo",
                    ROUND(i.total_contratado, 2) AS "Contratado",
                    ROUND(i.total_receitas, 2) AS "Arrecadado"
             FROM estouro e JOIN indicadores i USING (SQ_CANDIDATO)
             WHERE ${whereIndicadores(f)}
             ORDER BY "Neste tipo de gasto" DESC
             LIMIT ${POR_PAGINA} OFFSET ${pag * POR_PAGINA}`
          : v === 'fora-da-curva'
          ? `WITH ${SINAIS_CTE}
             SELECT i.SQ_CANDIDATO AS "_sq", '' AS "_cnpj",
                    i.NM_CANDIDATO AS "Candidato",
                    i.SG_PARTIDO || '/' || i.SG_UF AS "Partido/UF",
                    i.DS_CARGO AS "Cargo",
                    ROUND(i.total_contratado, 2) AS "Contratado",
                    ROUND(i.total_receitas, 2) AS "Arrecadado",
                    ${s ? `ROUND(MAX(CASE WHEN s.metrica = '${s}' THEN s.valor END), 2) AS "Neste sinal",
                    ROUND(MAX(CASE WHEN s.metrica = '${s}' THEN s.p95 END), 2) AS "p95 do grupo",` : ''}
                    COUNT(*) AS "Sinais",
                    STRING_AGG(${ROTULO_SINAL_SQL}, ' · ' ORDER BY s.metrica) AS "Acima do típico do grupo em"
             FROM sinais s JOIN indicadores i USING (SQ_CANDIDATO)
             WHERE ${whereIndicadores(f)}
             GROUP BY ALL
             ${s ? 'HAVING "Neste sinal" IS NOT NULL ORDER BY "Neste sinal" DESC' : 'ORDER BY "Sinais" DESC, "Contratado" DESC'}
             LIMIT ${POR_PAGINA} OFFSET ${pag * POR_PAGINA}`
          : v === 'compartilhados'
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
    const foraDaCurva = visao === 'fora-da-curva';
    void consultar(filtros, pagina, visao, foraDaCurva ? sinal : '', foraDaCurva ? categoria : '');
  }, [filtros, pagina, visao, sinal, categoria, consultar]);

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
        {visao === 'fora-da-curva' && (
          <div className="mt-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Fora da curva em">
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
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
                  disabled={carregando || dados.linhas.length < POR_PAGINA}
                  onClick={() => setPagina((p) => p + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
            <Tabela colunas={dados.colunas.filter((c) => !c.startsWith('_')).map((c) => ({
              titulo: c,
              numerica: ['Valor', 'Total', 'Candidatos', 'Partidos', 'Contratado', 'Arrecadado', 'Sinais', 'Neste sinal', 'Neste tipo de gasto', 'p95 do grupo'].includes(c),
            }))}>
              {dados.linhas.map((l, i) => (
                <tr key={i} className="hover:bg-muted/40">
                  {l.map((v, j) => {
                    const col = dados.colunas[j];
                    if (col.startsWith('_')) return null;
                    if (col === 'Valor' || col === 'Total' || col === 'Contratado')
                      return <CelulaNum key={j}>{brl.format(Number(v ?? 0))}</CelulaNum>;
                    if (col === 'Arrecadado')
                      return <CelulaNum key={j}>{v == null ? '—' : brl.format(Number(v))}</CelulaNum>;
                    if (col === 'Neste sinal' || col === 'Neste tipo de gasto' || col === 'p95 do grupo') {
                      const fmt = sinal ? metrica(sinal).formatar : (n: number) => brl.format(n);
                      return <CelulaNum key={j}>{v == null ? '—' : fmt(Number(v))}</CelulaNum>;
                    }
                    if (col === 'Candidatos' || col === 'Partidos' || col === 'Sinais')
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
