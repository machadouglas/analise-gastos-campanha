import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Bot,
  Check,
  ClipboardCopy,
  Database,
  Download,
  MessageSquareText,
  Play,
  TerminalSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { executarSQL, type ResultadoConsulta } from '@/lib/duckdb';
import { PROMPT_IA, IAS_SUGERIDAS } from '@/lib/prompt';
import { celula, brl, num } from '@/lib/format';
import { BarrasHorizontais, LinhaTemporal } from '@/components/app/graficos';
import { detectarGrafico } from '@/lib/grafico-auto';

const CONSULTA_INICIAL = `-- Pergunte à sua IA e cole o SQL aqui, ou edite à vontade.
SELECT SG_PARTIDO, ROUND(SUM(valor), 2) AS total_contratado
FROM despesas_atual
GROUP BY 1
ORDER BY total_contratado DESC
LIMIT 20`;

const EXEMPLOS: { rotulo: string; sql: string }[] = [
  {
    rotulo: 'Gastos por partido',
    sql: CONSULTA_INICIAL,
  },
  {
    rotulo: 'Maiores fornecedores do país',
    sql: `SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
GROUP BY 1
ORDER BY total DESC
LIMIT 30`,
  },
  {
    rotulo: 'Declarações removidas',
    sql: `-- a view já filtra retransmissões renumeradas e linhas-placeholder
SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF,
       COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       DS_DESPESA, ROUND(valor, 2) AS valor,
       dt_primeira_extracao, dt_ultima_extracao
FROM despesas_removidas
ORDER BY valor DESC
LIMIT 50`,
  },
  {
    rotulo: 'Dinheiro público por partido',
    sql: `SELECT SG_PARTIDO,
       ROUND(SUM(fundos_publicos), 2) AS fundos_publicos,
       ROUND(SUM(total_receitas), 2) AS arrecadado,
       ROUND(100.0 * SUM(fundos_publicos) / SUM(total_receitas), 1) AS pct_publico
FROM indicadores
GROUP BY 1
HAVING arrecadado > 0
ORDER BY fundos_publicos DESC
LIMIT 30`,
  },
  {
    rotulo: 'Fora da curva do grupo',
    sql: `-- candidatos acima do p95 do grupo (mesmo cargo e UF) em gasto ÷ arrecadado
SELECT i.NM_CANDIDATO, i.SG_PARTIDO, i.SG_UF, i.DS_CARGO,
       i.razao_gasto_receita, b.p95 AS p95_do_grupo, b.candidatos AS tamanho_do_grupo
FROM indicadores i
JOIN benchmark_indicadores b
  ON b.DS_CARGO = i.DS_CARGO AND b.SG_UF = i.SG_UF AND b.metrica = 'razao_gasto_receita'
WHERE i.razao_gasto_receita > b.p95
ORDER BY i.razao_gasto_receita DESC
LIMIT 30`,
  },
  {
    rotulo: 'Gasto com carro de som por UF',
    sql: `SELECT SG_UF, COUNT(DISTINCT SQ_CANDIDATO) AS candidatos, ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE DS_ORIGEM_DESPESA ILIKE '%carro%som%'
GROUP BY 1
ORDER BY total DESC
LIMIT 30`,
  },
];

const LIMITE_EXIBICAO = 500;

const PERGUNTAS_EXEMPLO = [
  'Quanto cada candidato a governador do meu estado já gastou, e com o quê?',
  'Quais empresas estão recebendo de 5 ou mais candidatos ao mesmo tempo?',
  'Algum candidato removeu ou alterou despesas que já tinha declarado?',
  'Quem está contratando muito acima do que declarou ter arrecadado?',
  'Quanto do Fundo Eleitoral já chegou aos candidatos, por partido?',
  'Quais os maiores gastos com impulsionamento de redes sociais até agora?',
  'Existem doações de valores idênticos, do mesmo dia, para o mesmo candidato?',
  'Que candidatos usam a mesma gráfica ou o mesmo carro de som?',
  'Quais pessoas físicas (sem empresa) mais receberam dinheiro de campanha?',
  'Quanto os candidatos à Presidência gastaram com advogados e contadores?',
  'Há despesas registradas com valores redondos repetidos (R$ 10 mil, R$ 50 mil)?',
  'Qual candidato mais gastou com combustível no meu estado?',
  'Quais doadores aparecem doando para candidatos de partidos rivais?',
  'Algum fornecedor de campanha também é doador do mesmo candidato?',
] as const;

function BlocoIA() {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(PROMPT_IA);
      setCopiado(true);
      toast.success('Prompt copiado! Cole na sua IA favorita.');
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto manualmente.');
    }
  }

  return (
    <Card className="border-[#264E9B]/25">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="h-5 w-5 text-[#264E9B]" />
          Use a sua IA — qualquer uma
        </CardTitle>
        <CardDescription className="leading-relaxed">
          Você não precisa saber SQL. Copie o prompt abaixo, cole na sua IA de preferência (
          {IAS_SUGERIDAS.join(', ')}…), faça a sua pergunta em português — <em>"quanto o candidato
          X gastou com carro de som?"</em> — e cole aqui a consulta que ela devolver.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="grid gap-3 text-sm sm:grid-cols-3">
          {[
            { icone: ClipboardCopy, texto: 'Copie o prompt e cole no chat da sua IA' },
            { icone: MessageSquareText, texto: 'Pergunte em português o que quiser saber' },
            { icone: TerminalSquare, texto: 'Cole o SQL gerado no console abaixo e execute' },
          ].map((passo, i) => (
            <li key={i} className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#10244A] to-[#264E9B] text-xs font-bold text-white">
                {i + 1}
              </span>
              <span className="leading-snug">
                <passo.icone className="mb-1 h-4 w-4 text-[#264E9B]" />
                <br />
                {passo.texto}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={copiar} className="gap-2">
            {copiado ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
            {copiado ? 'Copiado!' : 'Copiar prompt para a sua IA'}
          </Button>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">
              Ver o prompt
            </summary>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed">
              {PROMPT_IA}
            </pre>
          </details>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">
            Perguntas que você pode fazer{' '}
            <span className="font-normal text-muted-foreground">(clique para copiar)</span>
          </p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {PERGUNTAS_EXEMPLO.map((pergunta) => (
              <li key={pergunta}>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(pergunta);
                    toast.success('Pergunta copiada — cole na sua IA depois do prompt.');
                  }}
                  className="group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-[#264E9B] opacity-60 group-hover:opacity-100" />
                  {pergunta}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export function Consultar() {
  const [sql, setSql] = useState(CONSULTA_INICIAL);
  const [executando, setExecutando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoConsulta | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const executar = useCallback(async (consulta: string) => {
    setExecutando(true);
    setErro(null);
    try {
      const r = await executarSQL(consulta);
      setResultado(r);
    } catch (e) {
      setResultado(null);
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setExecutando(false);
    }
  }, []);

  useEffect(() => {
    function atalho(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const atual = editorRef.current?.value;
        if (atual) void executar(atual);
      }
    }
    window.addEventListener('keydown', atalho);
    return () => window.removeEventListener('keydown', atalho);
  }, [executar]);

  function baixarCSV() {
    if (!resultado) return;
    const esc = (v: unknown) => `"${celula(v).replaceAll('"', '""')}"`;
    const csv = [
      resultado.colunas.map(esc).join(';'),
      ...resultado.linhas.map((l) => l.map(esc).join(';')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'consulta-radar-das-contas.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">
          Console aberto
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          Consulte os dados você mesmo
        </h1>
        <p className="mt-3 max-w-3xl leading-relaxed text-muted-foreground">
          As consultas rodam <strong className="text-foreground">no seu navegador</strong> (DuckDB
          WebAssembly), direto sobre os dados públicos que extraímos diariamente do TSE — nada é
          enviado a servidor nenhum. Na primeira execução o navegador baixa o motor e os dados
          necessários; as seguintes são rápidas.
        </p>
      </div>

      <BlocoIA />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Database className="h-5 w-5 text-[#264E9B]" />
            Console SQL
          </CardTitle>
          <CardDescription>
            Atalhos: <code>despesas_atual</code>, <code>receitas_atual</code> (estado atual, coluna{' '}
            <code>valor</code> pronta), <code>despesas_removidas</code>, <code>receitas_removidas</code> · Histórico:{' '}
            <code>despesas</code>, <code>receitas</code> · Agregados: <code>indicadores</code>,{' '}
            <code>benchmark_indicadores</code>, <code>benchmark_precos</code>,{' '}
            <code>serie_diaria</code>, <code>rede</code>, <code>fornecedores</code> · Brutas:{' '}
            <code>despesas_pagas</code>, <code>receitas_doador_originario</code>,{' '}
            <code>candidatos</code> — o prompt da IA acima descreve todas.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {EXEMPLOS.map((ex) => (
              <button
                key={ex.rotulo}
                onClick={() => setSql(ex.sql)}
                className="rounded-full border border-[#264E9B]/20 bg-[#264E9B]/5 px-3 py-1 text-xs font-medium text-[#264E9B] transition-colors hover:border-[#264E9B]/40"
              >
                {ex.rotulo}
              </button>
            ))}
          </div>
          <textarea
            ref={editorRef}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            spellCheck={false}
            rows={9}
            className="w-full resize-y rounded-lg border bg-muted/30 p-4 font-mono text-sm leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Editor SQL"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void executar(sql)} disabled={executando} className="gap-2">
              {executando ? <Spinner /> : <Play className="h-4 w-4" />}
              {executando ? 'Executando…' : 'Executar'}
            </Button>
            <span className="text-xs text-muted-foreground">Ctrl+Enter também executa</span>
            {resultado && (
              <Button variant="outline" size="sm" onClick={baixarCSV} className="ml-auto gap-2">
                <Download className="h-4 w-4" /> Baixar CSV
              </Button>
            )}
          </div>

          {erro && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive-foreground">
              {erro}
            </div>
          )}

          {resultado && (() => {
            const grafico = detectarGrafico(resultado.colunas, resultado.linhas);
            const fmt = grafico?.moeda ? (v: number) => brl.format(v) : (v: number) => num.format(v);
            return (
            <div className="space-y-2">
              {grafico && (
                <div className="rounded-xl border bg-card p-5 shadow-sm">
                  <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {grafico.titulo}
                  </p>
                  {grafico.tipo === 'barras' ? (
                    <BarrasHorizontais dados={grafico.dados} formatar={fmt} />
                  ) : (
                    <LinhaTemporal pontos={grafico.dados} formatar={fmt} />
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {resultado.total} linha{resultado.total === 1 ? '' : 's'} em{' '}
                {Math.round(resultado.ms)} ms
                {resultado.total > LIMITE_EXIBICAO &&
                  ` — exibindo as primeiras ${LIMITE_EXIBICAO} (baixe o CSV para tudo)`}
              </p>
              <div className="max-h-[32rem] overflow-auto rounded-xl border bg-card shadow-sm">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-card">
                    <tr>
                      {resultado.colunas.map((c) => (
                        <th
                          key={c}
                          className="border-b px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="[&_td]:border-b [&_td]:px-3 [&_td]:py-1.5 [&_tr:last-child_td]:border-b-0">
                    {resultado.linhas.slice(0, LIMITE_EXIBICAO).map((linha, i) => (
                      <tr key={i} className="hover:bg-muted/40">
                        {linha.map((v, j) => (
                          <td key={j} className="whitespace-nowrap tabular-nums">
                            {celula(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}
