import { describe, expect, it } from 'vitest';
import { METRICAS, metrica } from './metricas';

describe('metrica', () => {
  it('conhece as métricas do benchmark com formatação própria', () => {
    expect(metrica('pct_sem_nota').rotulo).toBe('% sem nota fiscal');
    expect(metrica('pct_sem_nota').formatar(12.34)).toBe('12,3%');
    expect(metrica('razao_gasto_receita').formatar(2)).toBe('2×');
    expect(metrica('total_contratado').formatar(1000)).toContain('1.000');
  });

  it('métrica desconhecida degrada com rótulo próprio (schema pode evoluir antes do front)', () => {
    const m = metrica('metrica_futura');
    expect(m.rotulo).toBe('metrica_futura');
    expect(m.formatar(1234.5)).toBe('1.234,5');
  });

  it('todas as METRICAS têm rótulo e formatador', () => {
    for (const [nome, info] of Object.entries(METRICAS)) {
      expect(info.rotulo.length, nome).toBeGreaterThan(0);
      expect(typeof info.formatar(1)).toBe('string');
    }
  });
});
