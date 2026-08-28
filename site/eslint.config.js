// Lint focado em erro real (hooks mal declarados, código morto, promessas
// soltas) — estilo/formatação ficam com o tsconfig strict e a revisão humana.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // padrão deliberado das páginas: resetar 'carregando' quando o parâmetro
      // de rota muda, com o fetch assíncrono no próprio efeito
      'react-hooks/set-state-in-effect': 'off',
      // grafo/sankey mutam arrays locais durante o layout (d3-force) dentro de
      // useMemo — mutação contida, resultado determinístico
      'react-hooks/immutability': 'off',
      // dados do DuckDB chegam como unknown[][] de propósito — cast pontual ok
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
