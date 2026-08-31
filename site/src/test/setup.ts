/* Setup do vitest para os testes de renderização: matchers do jest-dom,
 * desmontagem entre casos e os poucos pedaços de navegador que o jsdom não
 * traz e os componentes usam (ResizeObserver nas tabelas e nos gráficos). */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// o jsdom não implementa ResizeObserver, e tabela.tsx/graficos.tsx observam
// o contêiner para decidir rolagem lateral e largura do viewBox
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
});
