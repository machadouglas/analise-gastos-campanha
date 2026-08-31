/* Declarações corrigidas: a seção irmã das removidas. O ponto delicado é o
 * pareamento ambíguo — quando várias declarações atuais servem de sucessora,
 * mostrar uma delas sozinha afirmaria algo que os dados não sustentam. */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SecaoCorrigidas, montarCorrigidas } from './corrigidas';

/** Mesma ordem de colunas de sqlCorrigidas. */
function linha(over: Partial<Record<number, unknown>> = {}): unknown[] {
  const base: unknown[] = [
    'valor', 'PARTIDO FICTÍCIO', '11222333000144', '900000000001', 'ANA FICTÍCIA',
    'PXX', 'PR', 'Doação', 'Doação', 1_000_000_000, 1_000_000,
    '20/08/2026', '20/08/2026', '26/08/2026', '26/08/2026', 1,
  ];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
  return base;
}

function montar(linhas: unknown[][], coluna: 'contraparte' | 'candidato' = 'contraparte') {
  render(
    <MemoryRouter>
      <SecaoCorrigidas itens={montarCorrigidas(linhas)} coluna={coluna} tipo="receita" />
    </MemoryRouter>,
  );
}

describe('SecaoCorrigidas', () => {
  it('mostra o antes riscado e o depois, com o fator da correção', () => {
    montar([linha()]);

    expect(screen.getByText('R$ 1.000.000.000')).toBeInTheDocument();
    expect(screen.getByText(/R\$ 1\.000\.000$/)).toBeInTheDocument();
    // 1000× é o que separa "erro de digitação" de "ajuste de centavos"
    expect(screen.getByText('1.000×')).toBeInTheDocument();
  });

  it('some por completo quando não há retificação', () => {
    montar([]);
    expect(screen.queryByText(/corrigidas/)).not.toBeInTheDocument();
  });

  it('avisa quando o pareamento é ambíguo, em vez de eleger um sucessor', () => {
    montar([linha({ 15: 3 })]);
    expect(screen.getByText('(1 de 3 possíveis)')).toBeInTheDocument();
  });

  it('sem ambiguidade não polui a linha com o aviso', () => {
    montar([linha()]);
    expect(screen.queryByText(/possíveis/)).not.toBeInTheDocument();
  });

  it('o par antes/depois acompanha o campo que mudou', () => {
    // descrição corrigida: as datas e os valores não podem aparecer no lugar
    montar([linha({ 0: 'descricao', 7: '300 unidades', 8: '300.000 unidades' })]);

    expect(screen.getByText('300 unidades')).toBeInTheDocument();
    expect(screen.getByText(/300\.000 unidades/)).toBeInTheDocument();
    expect(screen.queryByText('R$ 1.000.000.000')).not.toBeInTheDocument();
    // fator é só para valor — em descrição não faz sentido
    expect(screen.queryByText(/×$/)).not.toBeInTheDocument();
  });

  it('a coluna de identidade muda com a ficha que hospeda a seção', () => {
    montar([linha()], 'candidato');
    const tabela = screen.getByRole('table');
    expect(within(tabela).getByText('ANA FICTÍCIA')).toBeInTheDocument();
    expect(within(tabela).queryByText('PARTIDO FICTÍCIO')).not.toBeInTheDocument();
  });
});
