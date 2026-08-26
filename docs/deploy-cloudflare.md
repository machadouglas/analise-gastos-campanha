# Site no Cloudflare Pages

O diretório `site/` é uma SPA (Vite + React + Tailwind v4, padrão `trianox-front-standards/`)
com duas páginas:

- **Radar** — visão diária dos dados (lê o `resumo.json` do release);
- **Consultar** — console SQL com DuckDB-WASM rodando no navegador do visitante sobre os
  Parquet publicados, mais o prompt copiável para a pessoa usar a própria IA
  (ChatGPT, Claude, Gemini, Perplexity…) para gerar consultas.

Nenhum servidor próprio envolvido: uma *Pages Function* (`site/functions/dados/`) faz proxy
dos arquivos do GitHub Releases na mesma origem — necessário porque o GitHub não envia CORS
nos assets de release.

## Publicando

1. Painel Cloudflare: **Workers & Pages → Create → Pages → Connect to Git** → selecione o repo.
2. Configuração de build:
   - **Root directory**: `site`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - Variável de build: `NODE_VERSION = 22`
3. Deploy. A function em `site/functions/` é detectada automaticamente (rota `/dados/*`).

O site atualiza os DADOS sozinho todo dia (quem muda é o release); um novo deploy só é
necessário quando `site/` mudar no git — a integração com o GitHub já faz isso a cada push.

## Teste local

```powershell
cd site
npm install
npm run build
# copie os dados exportados para servir junto (em produção a function faz isso):
mkdir dist/dados; cp ../data/export/* dist/dados/
python -m http.server 8778 --directory dist
```

Obs.: navegação direta para /consultar num servidor estático simples dá 404 — em produção o
`_redirects` (SPA fallback) resolve.

## Fork

Troque a constante `BASE` em `site/functions/dados/[arquivo].js` para o seu repositório.
