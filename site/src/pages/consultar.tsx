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
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { executarSQL, garantirTabelasCompletas, type ResultadoConsulta } from '@/lib/duckdb';
import { validarLeitura } from '@/lib/sql-gate';
import { PROMPT_IA, IAS_SUGERIDAS } from '@/lib/prompt';
import { CLIENTES_MCP, URL_MCP } from '@/lib/mcp';
import { CONSULTA_INICIAL, GRUPOS_EXEMPLOS, GRUPOS_PERGUNTAS } from '@/lib/exemplos';
import { celula, brl, num } from '@/lib/format';
import { BarrasHorizontais, LinhaTemporal } from '@/components/app/graficos';
import { detectarGrafico } from '@/lib/grafico-auto';

/** Catálogo clicável: um clique roda DESCRIBE e mostra as colunas da tabela. */
const CATALOGO: { rotulo: string; tabelas: string[] }[] = [
  {
    rotulo: 'Atalhos',
    tabelas: ['despesas_atual', 'receitas_atual', 'despesas_removidas', 'receitas_removidas'],
  },
  { rotulo: 'Histórico', tabelas: ['despesas', 'receitas'] },
  {
    rotulo: 'Agregados',
    tabelas: [
      'indicadores',
      'benchmark_indicadores',
      'benchmark_precos',
      'benchmark_categorias',
      'serie_diaria',
      'rede',
      'fornecedores',
    ],
  },
  {
    rotulo: 'Brutas',
    tabelas: ['candidatos', 'bens', 'despesas_pagas', 'receitas_doador_originario'],
  },
];

const LIMITE_EXIBICAO = 500;
const CHAVE_SQL_SESSAO = 'consultar-sql';

function BlocoIA({ aoEscolher }: { aoEscolher: (sql: string) => void }) {
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

  const icones = [MessageSquareText, Sparkles] as const;

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
        <details
          id="conecte-sua-ia"
          className="scroll-mt-24 rounded-lg border bg-muted/30 p-3 text-sm"
          data-testid="conecte-sua-ia"
          // chegou pela âncora (cartão da Home): já abre no bloco certo
          open={typeof window !== 'undefined' && window.location.hash === '#conecte-sua-ia'}
        >
          <summary className="cursor-pointer select-none font-semibold">
            Ou conecte a sua IA direto (servidor MCP){' '}
            <span className="font-normal text-muted-foreground">
              — ela consulta os mesmos dados sozinha, sem copiar nada
            </span>
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-muted-foreground">
              Clientes que falam MCP (Claude, ChatGPT, Cursor, Claude Code…) ganham as fichas de
              candidato, fornecedor e partido, as red flags e uma consulta SQL livre — as mesmas
              regras e os mesmos números deste site. Público, só leitura, sem cadastro.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded border bg-background px-2 py-1 text-xs">{URL_MCP}</code>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => {
                  navigator.clipboard
                    .writeText(URL_MCP)
                    .then(() => toast.success('URL do servidor MCP copiada.'))
                    .catch(() => toast.error('Não foi possível copiar.'));
                }}
              >
                <ClipboardCopy className="h-3.5 w-3.5" /> Copiar URL
              </Button>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {CLIENTES_MCP.map((c) => (
                <li key={c.nome} className="rounded-lg border bg-background/60 p-3">
                  <p className="font-medium">{c.nome}</p>
                  <p className="text-xs text-muted-foreground">{c.passos}</p>
                  {c.codigo && (
                    <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-[11px] leading-relaxed">
                      {c.codigo}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </details>
        {GRUPOS_PERGUNTAS.map((grupo, g) => {
          const Icone = icones[g] ?? MessageSquareText;
          return (
            <div key={grupo.titulo}>
              <p className="mb-2 text-sm font-semibold">
                {grupo.titulo}{' '}
                <span className="font-normal text-muted-foreground">
                  (clique e o SQL pronto vai para o console)
                </span>
              </p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {grupo.perguntas.map((p) => (
                  <li key={p.pergunta}>
                    <button
                      onClick={() => aoEscolher(p.sql)}
                      className="group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Icone className="mt-0.5 h-4 w-4 shrink-0 text-[#264E9B] opacity-60 group-hover:opacity-100" />
                      {p.pergunta}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function Consultar() {
  // a consulta sobrevive à navegação entre páginas (aba fechada = limpa)
  const [sql, setSql] = useState<string>(() => {
    try {
      return sessionStorage.getItem(CHAVE_SQL_SESSAO) || CONSULTA_INICIAL;
    } catch {
      return CONSULTA_INICIAL;
    }
  });
  const [executando, setExecutando] = useState(false);
  const [jaExecutou, setJaExecutou] = useState(false);
  const [resultado, setResultado] = useState<ResultadoConsulta | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(CHAVE_SQL_SESSAO, sql);
    } catch {
      // navegação privada sem storage — segue sem persistir
    }
  }, [sql]);

  const executar = useCallback(async (consulta: string) => {
    // gate antes do boot: consulta rejeitada nem baixa o motor (~10 MB)
    const proibido = validarLeitura(consulta);
    if (proibido) {
      setResultado(null);
      setErro(proibido);
      return;
    }
    setExecutando(true);
    setErro(null);
    try {
      // o boot só registra o que as páginas usam; o console precisa de tudo
      await garantirTabelasCompletas();
      const r = await executarSQL(consulta);
      setResultado(r);
    } catch (e) {
      setResultado(null);
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setExecutando(false);
      setJaExecutou(true);
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

  function levarAoConsole(consulta: string) {
    setSql(consulta);
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    editorRef.current?.focus({ preventScroll: true });
    // a cópia é um extra (colar na IA para adaptar): só prometemos se deu certo
    navigator.clipboard.writeText(consulta).then(
      () => toast.success('SQL pronto no console (e copiado) — é só executar.'),
      () => toast.success('SQL pronto no console — é só executar.'),
    );
  }

  function descrever(tabela: string) {
    const consulta = `-- colunas e tipos de ${tabela} (troque DESCRIBE por SUMMARIZE para estatísticas)\nDESCRIBE ${tabela}`;
    setSql(consulta);
    void executar(consulta);
  }

  function baixarCSV() {
    if (!resultado) return;
    const esc = (v: unknown) => {
      let texto = celula(v);
      // dado declaratório é texto livre: célula começando com =, +, -, @, tab ou CR
      // viraria fórmula ao abrir no Excel (CSV injection) — o apóstrofo neutraliza.
      // Números ficam de fora para não corromper valores negativos.
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
      return `"${texto.replaceAll('"', '""')}"`;
    };
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
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6 sm:py-12">
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

      <BlocoIA aoEscolher={levarAoConsole} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Database className="h-5 w-5 text-[#264E9B]" />
            Console SQL
          </CardTitle>
          <CardDescription>
            Clique numa tabela para ver as colunas dela. Os atalhos já vêm filtrados (sem
            linhas-placeholder) e com a coluna <code>valor</code> numérica pronta — o prompt da IA
            acima descreve tudo em detalhe.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
            {CATALOGO.map((grupo) => (
              <div key={grupo.rotulo} className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                <span className="w-full text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:w-24 sm:shrink-0">
                  {grupo.rotulo}
                </span>
                {grupo.tabelas.map((tabela) => (
                  <button
                    key={tabela}
                    onClick={() => descrever(tabela)}
                    title={`Ver as colunas de ${tabela}`}
                    className="rounded-md border border-transparent bg-background px-1.5 py-0.5 font-mono text-xs text-foreground/80 shadow-sm transition-colors hover:border-[#264E9B]/40 hover:text-[#264E9B]"
                  >
                    {tabela}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            {GRUPOS_EXEMPLOS.map((grupo) => (
              <div key={grupo.rotulo} className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
                <span className="w-full text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:w-24 sm:shrink-0">
                  {grupo.rotulo}
                </span>
                {grupo.exemplos.map((ex) => (
                  <button
                    key={ex.rotulo}
                    onClick={() => {
                      setSql(ex.sql);
                      editorRef.current?.focus();
                    }}
                    className="rounded-full border border-[#264E9B]/20 bg-[#264E9B]/5 px-3 py-1 text-xs font-medium text-[#264E9B] transition-colors hover:border-[#264E9B]/40"
                  >
                    {ex.rotulo}
                  </button>
                ))}
              </div>
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
              {executando ? (jaExecutou ? 'Executando…' : 'Baixando motor e dados…') : 'Executar'}
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
                {/* o resultado tem tantas colunas quanto a consulta pedir: no
                    celular só cabem duas, e a rolagem lateral precisa ser dita */}
                {resultado.colunas.length > 2 && (
                  <span className="sm:hidden"> · role a tabela para o lado para ver as demais colunas →</span>
                )}
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
