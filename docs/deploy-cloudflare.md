# Site no Cloudflare Pages

O diretório `site/` é uma SPA (Vite + React + Tailwind v4) com duas páginas:

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

## Plano de escala: migrar `/dados` para R2 público (não implementado)

Hoje os Parquet saem do GitHub Releases via Pages Function. Funciona e é grátis, mas tem
dois limites que podem apertar no pico da campanha: cada request paga um salto extra de
proxy (Function → GitHub) e o GitHub não é um CDN de dados (sem `Range` confiável em
qualquer situação, sem controle de cache fino, rate limit compartilhado).

Quando (se) o tráfego justificar, o caminho é:

1. Criar um bucket **R2** com [domínio público](https://developers.cloudflare.com/r2/buckets/public-buckets/)
   (ex.: `dados.<dominio>`), com CORS liberado para o domínio do site.
2. Na rotina diária, trocar/complementar o `gh release upload` por upload ao R2
   (`rclone` ou `aws s3api` com endpoint R2; credencial via variável de ambiente no
   container — nunca em arquivo versionado).
3. No site, apontar a origem dos dados para o domínio do bucket (hoje é
   `window.location.origin` + `/dados/` em `site/src/lib/duckdb.ts` e a Pages Function);
   com CORS correto a Function inteira deixa de ser necessária.
4. Manter o release `dados` como espelho público consultável por URL (reprodutibilidade —
   a metodologia promete os dados abertos lá).

Benefícios: leituras `Range` de Parquet direto do CDN (DuckDB-WASM baixa só as colunas
que usa), cache na borda, sem rate limit do GitHub. Custo: R2 cobra por armazenamento e
operações — com os volumes atuais (poucos MB/dia) fica na faixa gratuita.
