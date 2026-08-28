import { describe, expect, it } from 'vitest';
import { detectarGrafico } from './grafico-auto';

describe('detectarGrafico', () => {
  it('texto + número vira barras', () => {
    const g = detectarGrafico(['partido', 'total'], [['PL', 10], ['PT', 20]]);
    expect(g?.tipo).toBe('barras');
    expect(g?.dados).toEqual([
      { rotulo: 'PL', valor: 10 },
      { rotulo: 'PT', valor: 20 },
    ]);
  });

  it('rótulos com cara de data viram linha temporal', () => {
    const g = detectarGrafico(['dia', 'total'], [['2026-08-20', 1], ['2026-08-21', 2]]);
    expect(g?.tipo).toBe('linha');
  });

  it('coluna com nome monetário liga a formatação de moeda', () => {
    expect(detectarGrafico(['uf', 'total_contratado'], [['SP', 1], ['RJ', 2]])?.moeda).toBe(true);
    expect(detectarGrafico(['uf', 'candidatos'], [['SP', 1], ['RJ', 2]])?.moeda).toBe(false);
  });

  it('não inventa gráfico sem forma reconhecível', () => {
    expect(detectarGrafico(['a'], [[1], [2]])).toBeNull(); // uma coluna só
    expect(detectarGrafico(['a', 'b'], [['x', 1]])).toBeNull(); // uma linha só
    // 31+ linhas não-temporais: barras ficariam ilegíveis
    const muitas = Array.from({ length: 31 }, (_, i) => [`cat ${i}`, i] as unknown[]);
    expect(detectarGrafico(['cat', 'n'], muitas)).toBeNull();
  });

  it('bigint (COUNT do DuckDB) conta como número', () => {
    const g = detectarGrafico(['uf', 'n'], [['SP', 1n], ['RJ', 2n]]);
    expect(g?.dados[0].valor).toBe(1);
  });
});
