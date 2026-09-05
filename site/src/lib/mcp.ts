/** O servidor MCP público: a mesma base do site, para a IA do visitante
 *  consultar direto (sem copiar prompt nem colar SQL). O backend está em
 *  src/mcp/ (Python) e devolve o que estas páginas mostram. */

export const URL_MCP = 'https://mcp.radardosgastos.com.br/mcp';

export interface ClienteMCP {
  nome: string;
  passos: string;
  /** trecho copiável (comando ou JSON) quando o cliente pede configuração em texto */
  codigo?: string;
}

export const CLIENTES_MCP: ClienteMCP[] = [
  {
    nome: 'Claude (claude.ai e app)',
    passos: 'Configurações → Conectores → Adicionar conector personalizado → cole a URL.',
  },
  {
    nome: 'ChatGPT',
    passos: 'Configurações → Conectores → Criar (modo desenvolvedor) → cole a URL, sem autenticação.',
  },
  {
    nome: 'Claude Code',
    passos: 'No terminal:',
    codigo: `claude mcp add --transport http radar-dos-gastos ${URL_MCP}`,
  },
  {
    nome: 'Cursor, VS Code e outros',
    passos: 'No arquivo de servidores MCP do cliente:',
    codigo: `{ "mcpServers": { "radar-dos-gastos": { "url": "${URL_MCP}" } } }`,
  },
];

export interface FerramentaMCP {
  nome: string;
  descricao: string;
}

/** As ferramentas que a IA ganha ao conectar — mesmos nomes de src/mcp/servidor.py
 *  (tests/test_sincronia_site.py confere a lista). */
export const FERRAMENTAS_MCP: FerramentaMCP[] = [
  { nome: 'visao_geral', descricao: 'Totais do dia, o que mudou desde a última extração e a data do dado.' },
  { nome: 'buscar_candidato', descricao: 'Localiza candidaturas por nome ou número de urna, com UF, cargo e partido.' },
  { nome: 'ficha_candidato', descricao: 'A ficha completa: indicadores, sinais fora da curva, fornecedores, doadores, removidas e corrigidas.' },
  { nome: 'ficha_fornecedor', descricao: 'Quem o fornecedor atende, quanto recebeu, cadastro na Receita e notas marcadas.' },
  { nome: 'ficha_partido', descricao: 'Totais, dinheiro público, fornecedores compartilhados e a cota do Fundo Eleitoral.' },
  { nome: 'fora_da_curva', descricao: 'Candidatos acima do p95 do próprio grupo (mesmo cargo e UF), sinal por sinal.' },
  { nome: 'declaracoes_removidas', descricao: 'O que estava na prestação, sumiu e não voltou de outra forma.' },
  { nome: 'fornecedores_compartilhados', descricao: 'Fornecedores que atendem vários candidatos no recorte.' },
  { nome: 'sem_nota', descricao: 'Quem mais gasta sem documento fiscal onde a nota é a norma.' },
  { nome: 'gastos_por_categoria', descricao: 'Total por tipo de despesa, com a mediana nacional do preço por nota.' },
  { nome: 'sql', descricao: 'Consulta livre em SQL (DuckDB), só leitura, sobre todas as tabelas publicadas.' },
];
