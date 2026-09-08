import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Bot,
  Cable,
  Check,
  ClipboardCopy,
  Database,
  Download,
  MessageSquareText,
  Play,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { executarSQL, garantirTabelasCompletas, type ResultadoConsulta } from '@/lib/duckdb';
import { validarLeitura } from '@/lib/sql-gate';
import { PROMPT_IA, IAS_SUGERIDAS } from '@/lib/prompt';
import { CLIENTES_MCP, FERRAMENTAS_MCP, URL_MCP } from '@/lib/mcp';
import { CONSULTA_INICIAL, GRUPOS_EXEMPLOS, GRUPOS_PERGUNTAS } from '@/lib/exemplos';
import { carregarResumo, type Resumo } from '@/lib/resumo';
import { celula, brl, num } from '@/lib/format';
import { BarrasHorizontais, LinhaTemporal } from '@/components/app/graficos';
import { ConversaMCP } from '@/components/app/conversa-mcp';
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

function copiar(texto: string, ok: string) {
  const area = navigator.clipboard;
  if (!area) {
    toast.error('Não foi possível copiar. Selecione o texto manualmente.');
    return Promise.resolve(false);
  }
  return area.writeText(texto).then(
    () => {
      toast.success(ok);
      return true;
    },
    () => {
      toast.error('Não foi possível copiar. Selecione o texto manualmente.');
      return false;
    },
  );
}

/** A porta principal: o servidor MCP, com a URL, os clientes e a conversa
 *  simulada com os dados do dia. */
function BlocoMCP({ resumo }: { resumo: Resumo | null }) {
  return (
    <Card id="conecte-sua-ia" className="scroll-mt-24 border-[#264E9B]/25" data-testid="conecte-sua-ia">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Cable className="h-5 w-5 text-[#264E9B]" />
          Conecte a sua IA aos dados (servidor MCP)
        </CardTitle>
        <CardDescription className="leading-relaxed">
          Cole uma URL no seu cliente de IA e ela passa a consultar os dados sozinha: fichas de
          candidato, fornecedor e partido, as red flags e uma consulta SQL livre — as mesmas regras
          e os mesmos números deste site. Público, só leitura, sem cadastro.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded border bg-background px-2 py-1 text-xs">{URL_MCP}</code>
          <Button
            size="sm"
            className="gap-1"
            onClick={() => void copiar(URL_MCP, 'URL do servidor MCP copiada.')}
          >
            <ClipboardCopy className="h-3.5 w-3.5" /> Copiar URL
          </Button>
        </div>

        {/* grid-cols-1 + min-w-0: sem eles a coluna da conversa cresce até a
            linha mais longa do JSON e o celular ganha rolagem lateral */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="min-w-0 space-y-3 lg:col-span-3">
            <p className="text-sm font-semibold">
              Como fica, na prática{' '}
              <span className="font-normal text-muted-foreground">
                — a IA chama as ferramentas e responde com os dados
              </span>
            </p>
            <ConversaMCP resumo={resumo} />
          </div>
          <div className="min-w-0 space-y-5 lg:col-span-2">
            <div className="space-y-3">
              <p className="text-sm font-semibold">Onde colar a URL</p>
              <ul className="grid gap-2">
                {CLIENTES_MCP.map((c) => (
                  <li key={c.nome} className="rounded-lg border bg-background/60 p-3">
                    <p className="text-sm font-medium">{c.nome}</p>
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
            <div className="space-y-3">
              <p className="text-sm font-semibold">
                <Wrench className="mr-1.5 inline h-4 w-4 text-[#264E9B]" />
                As {FERRAMENTAS_MCP.length} ferramentas que a IA ganha
              </p>
              <ul className="grid gap-1.5">
                {FERRAMENTAS_MCP.map((f) => (
                  <li key={f.nome} className="rounded-md border bg-background/60 px-2.5 py-1.5">
                    <code className="text-xs font-semibold text-[#264E9B]">{f.nome}</code>
                    <span className="block text-xs text-muted-foreground">{f.descricao}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** A alternativa sem conector: copiar o prompt e trazer o SQL para o console. */
function BlocoPrompt() {
  const [copiado, setCopiado] = useState(false);

  async function copiarPrompt() {
    if (await copiar(PROMPT_IA, 'Prompt copiado! Cole na sua IA favorita.')) {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="h-5 w-5 text-[#264E9B]" />
          Sem conector? Copie o prompt
        </CardTitle>
        <CardDescription className="leading-relaxed">
          Cole o prompt na sua IA ({IAS_SUGERIDAS.join(', ')}…), pergunte em português —{' '}
          <em>"quanto o candidato X gastou com carro de som?"</em> — e traga o SQL que ela devolver
          para o console abaixo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={copiarPrompt} className="gap-2">
          {copiado ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
          {copiado ? 'Copiado!' : 'Copiar prompt para a sua IA'}
        </Button>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">Ver o prompt</summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed">
            {PROMPT_IA}
          </pre>
        </details>
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
  // o resumo do dia alimenta a conversa simulada (mesma fonte da Home; não é DuckDB)
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let vivo = true;
    void carregarResumo().then((r) => {
      if (vivo) setResumo(r);
    });
    return () => {
      vivo = false;
    };
  }, []);

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
    editorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    editorRef.current?.focus({ preventScroll: true });
    // a cópia é um extra (colar na IA para adaptar): só prometemos se deu certo
    const area = navigator.clipboard;
    if (!area) {
      toast.success('SQL pronto no console — é só executar.');
      return;
    }
    area.writeText(consulta).then(
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
    a.download = 'consulta-radar-dos-gastos.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6 sm:py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">
          A sua IA + os dados
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          Pergunte à sua IA — ela consulta os dados sozinha
        </h1>
        <p className="mt-3 max-w-3xl leading-relaxed text-muted-foreground">
          Claude, ChatGPT, Cursor e qualquer cliente que fale MCP ligam direto no nosso servidor
          público e respondem em português com os números do dia. Prefere as mãos na massa? O
          console SQL continua aqui embaixo, rodando{' '}
          <strong className="text-foreground">no seu navegador</strong> (DuckDB WebAssembly) —
          nada é enviado a servidor nenhum.
        </p>
      </div>

      <BlocoMCP resumo={resumo} />

      <BlocoPrompt />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Database className="h-5 w-5 text-[#264E9B]" />
            Console SQL
          </CardTitle>
          <CardDescription>
            Perguntas prontas com o SQL que as responde, atalhos por tabela e um editor livre. Na
            primeira execução o navegador baixa o motor e os dados necessários; as seguintes são
            rápidas.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {GRUPOS_PERGUNTAS.map((grupo) => (
            <div key={grupo.titulo}>
              <p className="mb-2 text-sm font-semibold">
                {grupo.titulo}{' '}
                <span className="font-normal text-muted-foreground">
                  (clique e o SQL pronto vai para o editor)
                </span>
              </p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {grupo.perguntas.map((p) => (
                  <li key={p.pergunta}>
                    <button
                      onClick={() => levarAoConsole(p.sql)}
                      className="group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-[#264E9B] opacity-60 group-hover:opacity-100" />
                      {p.pergunta}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}

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

          <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">
              Clique numa tabela para ver as colunas. Os atalhos já vêm sem linhas-placeholder e
              com a coluna <code>valor</code> numérica pronta.
            </p>
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
