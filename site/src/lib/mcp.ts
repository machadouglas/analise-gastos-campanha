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
