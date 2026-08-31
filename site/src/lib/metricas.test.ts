import { describe, expect, it } from 'vitest';
import { METRICAS, metrica } from './metricas';

describe('metrica', () => {
  it('conhece as métricas do benchmark com formatação própria', () => {
    expect(metrica('pct_sem_nota').rotulo).toBe('% sem documento fiscal');
    expect(metrica('pct_sem_nota').formatar(12.34)).toBe('12,3%');
    expect(metrica('razao_gasto_receita').formatar(2)).toBe('2,00×');
    expect(metrica('total_contratado').formatar(1000)).toContain('1.000');
  });

  it('a razão mantém as 2 casas do banco — 1,03 não pode virar "1×"', () => {
    // com 1 casa o chip dizia "1×" contra um corte de "0,9×" e parecia
    // implicância; o leitor precisa ver o quanto o candidato estourou
    expect(metrica('razao_gasto_receita').formatar(1.03)).toBe('1,03×');
  });

  it('a razão vira frase, porque "Gasto ÷ arrecadado: 1,15×" faz o leitor fazer a conta', () => {
    expect(metrica('razao_gasto_receita').frase(1.15)).toBe('Gastou 1,15× o que arrecadou');
  });

  it('métrica sem frase própria cai no par rótulo: valor', () => {
    expect(metrica('pct_sem_nota').frase(62.4)).toBe('% sem documento fiscal: 62,4%');
  });

  it('métrica desconhecida degrada com rótulo próprio (schema pode evoluir antes do front)', () => {
    const m = metrica('metrica_futura');
    expect(m.rotulo).toBe('metrica_futura');
    expect(m.formatar(1234.5)).toBe('1.234,5');
    expect(m.frase(1234.5)).toBe('metrica_futura: 1.234,5');
  });

  it('todas as METRICAS têm rótulo, formatador e frase', () => {
    for (const nome of Object.keys(METRICAS)) {
      const m = metrica(nome);
      expect(m.rotulo.length, nome).toBeGreaterThan(0);
      expect(typeof m.formatar(1)).toBe('string');
      expect(m.frase(1).length, nome).toBeGreaterThan(0);
    }
  });
});
