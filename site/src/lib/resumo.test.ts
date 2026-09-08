/* carregarResumo: a Function /dados/* busca no GitHub, que devolve 429 em hora
 * de pico. Uma segunda tentativa (depois de um instante) costuma passar; um
 * 404 de verdade não é reinsistido. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function carregar() {
  vi.resetModules();
  return import('@/lib/resumo');
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('carregarResumo', () => {
  it('tenta de novo depois de um 429 e devolve o resumo', async () => {
    const fetchFalso = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ gerado_em: '2026-09-07' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchFalso);
    const { carregarResumo } = await carregar();
    const pendente = carregarResumo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pendente).toEqual({ gerado_em: '2026-09-07' });
    expect(fetchFalso).toHaveBeenCalledTimes(2);
  });

  it('não insiste num 404 e devolve null', async () => {
    const fetchFalso = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchFalso);
    const { carregarResumo } = await carregar();
    const pendente = carregarResumo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pendente).toBeNull();
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it('dois 429 seguidos devolvem null (a camada de dados pede o resumo à API)', async () => {
    const fetchFalso = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetchFalso);
    const { carregarResumo } = await carregar();
    const pendente = carregarResumo();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pendente).toBeNull();
    expect(fetchFalso).toHaveBeenCalledTimes(2);
  });
});
