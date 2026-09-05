/* Consultar: a página é MCP-first e o quadro da conversa simulada precisa
 * (1) usar os dados do dia quando o resumo carrega — com o nome do candidato
 * linkando para a ficha — e (2) cair num exemplo declaradamente fictício
 * quando não carrega, nunca num quadro vazio. O console SQL continua
 * funcionando: clicar numa pergunta pronta põe o SQL no editor. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Resumo } from '@/lib/resumo';
import { renderizarRota } from '@/test/render';
import { limparDuckDBFalso } from '@/test/duckdb-falso';
import { FERRAMENTAS_MCP } from '@/lib/mcp';
import { GRUPOS_PERGUNTAS } from '@/lib/exemplos';

const { carregarResumoFalso } = vi.hoisted(() => ({ carregarResumoFalso: vi.fn() }));
vi.mock('@/lib/resumo', () => ({ carregarResumo: carregarResumoFalso }));
vi.mock('@/lib/duckdb', () => import('@/test/duckdb-falso'));

const { Consultar } = await import('@/pages/consultar');

const RESUMO: Resumo = {
  gerado_em: '2026-08-30',
  primeira_extracao: false,
  totais: {
    candidatos_com_gastos: 1200,
    total_contratado: 5_000_000,
    total_receitas: 7_000_000,
    itens_declarados: 40_000,
    candidaturas_registradas: 9000,
  },
  mudancas: {
    despesas_removidas_qtd: 12,
    despesas_removidas_valor: 90_000,
    receitas_removidas_qtd: 0,
    receitas_removidas_valor: 0,
  },
  novas_despesas: [],
  despesas_removidas: [],
  receitas_removidas: [],
  fornecedores_compartilhados: [],
  top_candidatos: [],
  fora_da_curva: [
    {
      SQ_CANDIDATO: '900000000002',
      NM_CANDIDATO: 'CARLA FICTÍCIA DE OLIVEIRA',
      SG_PARTIDO: 'PXX',
      DS_CARGO: 'Deputado Federal',
      SG_UF: 'PR',
      total_contratado: 1_262_278,
      total_receitas: 1_100_000,
      sinais: [
        { metrica: 'razao_gasto_receita', valor: 1.15, mediana: 0, p95: 0.9, grupo_n: 40, grupo_ambito: 'PR' },
      ],
    },
  ],
};

describe('Consultar', () => {
  beforeEach(() => {
    limparDuckDBFalso();
    sessionStorage.clear();
  });

  it('a conversa simulada usa os dados do dia e linka o candidato à ficha', async () => {
    carregarResumoFalso.mockResolvedValue(RESUMO);
    renderizarRota(<Consultar />, { caminho: '/consultar', url: '/consultar' });
    const link = await screen.findByRole('link', { name: 'CARLA FICTÍCIA DE OLIVEIRA' });
    expect(link).toHaveAttribute('href', '/candidato/900000000002');
    const conversa = screen.getByTestId('conversa-mcp');
    expect(conversa).toHaveTextContent('dados reais de 30/08/2026');
    expect(conversa).toHaveTextContent('Gastou 1,15× o que arrecadou');
    expect(conversa).toHaveTextContent('12 despesas sumiram');
    // as chamadas de ferramenta aparecem com o nome que o servidor expõe
    const chamadas = screen.getAllByTestId('chamada-mcp').map((c) => c.textContent).join(' ');
    expect(chamadas).toContain('visao_geral');
    expect(chamadas).toContain('fora_da_curva');
    expect(chamadas).toContain('ficha_candidato');
    expect(conversa).not.toHaveTextContent('ilustrativo');
  });

  it('sem resumo, o quadro é um exemplo fictício e diz isso — sem link para ficha', async () => {
    carregarResumoFalso.mockResolvedValue(null);
    renderizarRota(<Consultar />, { caminho: '/consultar', url: '/consultar' });
    const conversa = await screen.findByTestId('conversa-mcp');
    await waitFor(() => expect(conversa).toHaveTextContent('exemplo ilustrativo'));
    expect(conversa).toHaveTextContent('ANA EXEMPLO DA SILVA');
    expect(screen.queryByRole('link', { name: 'ANA EXEMPLO DA SILVA' })).toBeNull();
  });

  it('lista todas as ferramentas do servidor e mantém a âncora da Home', async () => {
    carregarResumoFalso.mockResolvedValue(null);
    renderizarRota(<Consultar />, { caminho: '/consultar', url: '/consultar' });
    const bloco = await screen.findByTestId('conecte-sua-ia');
    expect(bloco).toHaveAttribute('id', 'conecte-sua-ia');
    for (const f of FERRAMENTAS_MCP) expect(bloco).toHaveTextContent(f.nome);
  });

  it('clicar numa pergunta pronta põe o SQL dela no editor', async () => {
    carregarResumoFalso.mockResolvedValue(null);
    renderizarRota(<Consultar />, { caminho: '/consultar', url: '/consultar' });
    const primeira = GRUPOS_PERGUNTAS[0].perguntas[0];
    fireEvent.click(await screen.findByRole('button', { name: primeira.pergunta }));
    expect(screen.getByRole('textbox', { name: 'Editor SQL' })).toHaveValue(primeira.sql);
  });
});
