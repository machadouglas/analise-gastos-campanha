# Servidor MCP em produção

O servidor MCP (`src/mcp/`, imagem `Dockerfile.mcp`) roda como **aplicação
separada** no mesmo host Docker da rotina, atrás de um túnel de saída — sem
volume, sem segredo, sem porta pública. Ele só baixa os Parquet do release
`dados`; nada nele alcança o banco da extração. O mesmo processo atende o
**site** em `GET /api/v1/consulta` (§6): as fichas e o Explorar mandam o SQL
para cá em vez de montar um banco no navegador, e caem para o DuckDB-WASM se
esta rota não responder. O desenho está em
[arquitetura-mcp.md](arquitetura-mcp.md). Este guia é genérico: não cita host,
provedor nem domínio de infraestrutura de ninguém.

## 0. Pré-requisito: host sem IP exposto

Todo tráfego público entra por Cloudflare Tunnel (gratuito) e o firewall do
host fecha 80/443. No Coolify, o host onde ele mesmo roda não usa o bloco
"Cloudflare Tunnels" das configurações do servidor (esse é para servidores
remotos): o conector sobe como **serviço Cloudflared** com o token do túnel
em `CLOUDFLARE_TUNNEL_TOKEN`, e a rota publicada no túnel aponta para o proxy
(`http://localhost:80`, tipo HTTP). Os domínios das aplicações ficam em
`http://` no Coolify — o TLS é do Cloudflare. Guia completo na documentação
do Coolify ("Cloudflare Tunnels → All resources").

Checagem antes de fechar o firewall: `nslookup` de qualquer hostname devolve
só endereços do Cloudflare; o webhook do GitHub (deploy automático) responde
pelo túnel.

## 1. Domínio

Uma zona no Cloudflare para o MCP (ex.: `mcp.<domínio>`). No túnel, aba
**Published application routes**: hostname `mcp.<domínio>`, tipo HTTP, URL
`localhost:80`. Para hostname sem curinga o Cloudflare cria o CNAME sozinho.
Nunca crie registro A/AAAA na zona: o objetivo é o IP não aparecer.

## 2. Aplicação no Coolify

1. **+ New → Application**, mesmo repositório da rotina, branch `main`.
   Build Pack **Dockerfile**, **Dockerfile Location** `/Dockerfile.mcp`.
   Pode ficar no mesmo projeto do extrator: projeto no Coolify é agrupamento,
   não isolamento; o que importa é ser uma aplicação separada (sem os segredos
   e o volume da rotina). Não use "Clone" da aplicação do extrator — o clone
   copia as variáveis de ambiente.
2. **Ports exposes**: `8000`. **Domain**: `http://mcp.<domínio>` (HTTP — ver
   §0), **sem porta no fim**: no Coolify, porta escrita no domínio
   (`http://host:80`) significa "roteie para esta porta do container" e
   sobrepõe o Ports exposes — o Traefik passa a bater na porta 80 do container
   e o site responde 502. Mudou porta ou domínio? Só vale no próximo deploy.
3. **Environment Variables**: nenhuma obrigatória. Num fork, `GH_REPO` com
   `usuario/fork`. Limites opcionais: `MCP_TIMEOUT` (s por consulta, padrão
   10), `MCP_MAX_SIMULTANEAS` (8, ferramentas curadas), `MCP_MAX_SIMULTANEAS_SQL`
   (4, fila própria da `sql` livre), `MCP_MAX_SIMULTANEAS_SITE` (8, fila da rota
   do site) e `MCP_TIMEOUT_SITE` (5 s), `MCP_MEMORIA` (`512MB`), `MCP_THREADS` (2),
   `MCP_INTERVALO` (s entre verificações do release, 300).
   Num host de **2 vCPU** que também serve o site, aperte a `sql` livre:
   `MCP_MAX_SIMULTANEAS_SQL=2` e `MCP_TIMEOUT=5`. As filas separam vagas, não
   CPU — medido em 06/09/2026 com 2 núcleos: 4 consultas pesadas simultâneas
   na `sql` derrubam a vazão das fichas de 26 para 8 páginas/s (p95 de 95 ms
   para 311 ms; degrada, não cai). Duas vagas deixam um núcleo para os leitores.
4. **Storages**: nenhum. O cache de Parquet vive no container e é rebaixado
   no boot (~30 MB); um redeploy nunca perde nada.
5. **Health check**: caminho `/saude`, porta 8000, start period de 2 minutos
   (o boot baixa o release e monta o banco). O Coolify executa o check com
   `curl` DENTRO do container — por isso a imagem instala `curl` (sem ele o
   deploy é revertido com o servidor saudável). O Dockerfile declara um
   `HEALTHCHECK` equivalente.
6. **Auto Deploy** ligado (webhook do GitHub App). O build roda os testes do
   MCP (`tests/test_mcp_*.py`); imagem quebrada não sobe. O Coolify injeta
   `SOURCE_COMMIT` no container em runtime (não como build arg), e é dele que
   sai o `versao_codigo` de toda resposta.
7. Deploy. Primeiro boot: ~1 min (download + montagem do banco).

Watch paths sugeridos (só reconstrói quando o MCP muda):

```
src/**
site/src/lib/prompt.ts
site/src/lib/consultas.ts
site/src/lib/exemplos.ts
requirements.txt
requirements-mcp.txt
Dockerfile.mcp
tests/test_mcp_*.py
```

## 3. Cloudflare: borda

- **Rate Limiting** (Security → WAF → Rate limiting rules), uma regra para
  o hostname do MCP: ex.: 60 requisições/min por IP, ação Block por 1 min.
- **WAF gerenciado** gratuito ligado.
- Sem cache na borda: MCP é POST JSON-RPC. O cache é no processo. (A rota do
  site é outra história — §6.)

## 4. Conferindo

```bash
curl -s https://mcp.<domínio>/saude
```

Deve devolver `{"ok": true, "versao_dado": "AAAA-MM-DD", ...}`. Depois, num
cliente MCP (Claude, ChatGPT, Cursor, Claude Code), adicione
`https://mcp.<domínio>/mcp` e peça "visão geral" — a resposta traz
`versao_dado` (data da extração) e `versao_codigo` (commit).

Claude Code:

```bash
claude mcp add --transport http radar-dos-gastos https://mcp.<domínio>/mcp
```

## 5. Rodando local

```bash
pip install -r requirements.txt -r requirements-mcp.txt
python -m src.mcp.servidor          # http://localhost:8000/mcp
```

O boot baixa o release para `data/mcp/` (gitignorado). Com Docker:

```bash
docker build -f Dockerfile.mcp --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t radar-mcp .
docker run --rm -p 8000:8000 radar-mcp
```

## 6. A rota do site: hostname próprio, cache na borda, fallback no navegador

O site (`site/src/lib/dados.ts`) chama `GET /api/v1/consulta` deste mesmo
container — pelo **hostname próprio** `api.<domínio>`, direto no túnel, e não
por uma Pages Function. Motivo: a resposta é imutável por versão do dado
(`v` na URL) e a Cloudflare a serve do cache **sem invocar Worker e sem tocar
no host** — Pages Functions contam invocação (100 mil/dia no plano gratuito)
mesmo quando respondem do cache, e o `/dados/*` já gasta dessa cota. No pico,
o servidor só vê o *miss*.

1. **Túnel**: nova rota publicada, hostname `api.<domínio>`, tipo HTTP, URL
   `localhost:80` (o mesmo proxy que já atende `mcp.<domínio>`; o Coolify
   roteia pelo Host). No Coolify, adicione `http://api.<domínio>` como
   segundo domínio da mesma aplicação (Domains aceita vários, separados por
   vírgula). Nada de registro A/AAAA.
2. **Cache Rule** (Caching → Cache Rules), hostname `api.<domínio>`:
   *Eligible for cache*, Edge TTL *Respect origin* (a rota manda
   `public, max-age=86400, immutable` só quando `v` bate com a versão que o
   processo serve; o resto sai `no-store`), e **query string na chave do
   cache** (o padrão "standard" inclui — confira: sem a query na chave, todos
   os candidatos viram a mesma entrada). Sem essa regra a Cloudflare não
   cacheia JSON de rota dinâmica, e cada visita desce ao servidor.
3. **Rate Limiting**: o plano gratuito dá **uma** regra. Faça-a cobrir os
   dois hostnames — expressão
   `(http.host in {"mcp.<domínio>" "api.<domínio>"})`, por IP, **200
   requisições por 10 s**, Block pela duração mínima. A conta: uma ficha
   dispara ~16 GETs e o Explorar ~8; quem navega rápido por meia dúzia de
   fichas em dez segundos ainda passa, e 200 chamadas em 10 s no MCP não é
   uso, é loop. Cem por 10 s bloqueou navegação normal em 08/09/2026. O site
   trata o 429 esperando o `Retry-After` e repetindo (até 3 vezes) antes de
   cair para o WASM — o bloqueio dura segundos, e o WASM custa o motor inteiro.
4. **CORS e CSP**: a rota responde `Access-Control-Allow-Origin: *` (dado
   público, sem credencial; GET simples, sem preflight). Nada a configurar na
   borda — mas o hostname da API precisa estar no `connect-src` da
   Content-Security-Policy do site (`site/public/_headers`), senão o
   navegador bloqueia o `fetch` em silêncio e o site cai para o WASM.
5. **Pages**: variável de build `VITE_RADAR_API = https://api.<domínio>` e um
   novo deploy do site (`docs/deploy-cloudflare.md`). Sem ela o site continua
   100% WASM — e é assim que se faz o rollback: apagar a variável e
   redeployar, sem tocar no servidor.

Conferindo:

```bash
curl -si "https://api.<domínio>/api/v1/consulta?sql=SELECT%201&v=$(curl -s https://api.<domínio>/saude | python -c 'import json,sys; print(json.load(sys.stdin)["publicado_em"])')"
```

Primeira chamada: `cf-cache-status: MISS`, `Cache-Control: public, max-age=86400…`;
a segunda, `HIT`. Sem `v` (ou com `v` errado) tem de vir `no-store`.

`GET /api/v1/resumo` devolve a versão do dado e o mapa de arquivos: é de onde o
site os lê quando a Pages Function `/dados/resumo.json` falha (o GitHub, por
trás dela, responde 429 em hora de pico — medido em 08/09/2026). Com a API no
ar, as fichas não dependem do GitHub em nada.

Fallback: derrube o container e abra uma ficha — a faixa amarela "servidor de
consultas indisponível" aparece, a página carrega pelo WASM em alguns segundos
e some da faixa até 5 minutos depois de o container voltar.

## Observações

- O container roda como usuário sem privilégio (uid 10001) e só tem `GH_REPO`
  no ambiente. Não existe token, sal de CPF nem acesso ao banco da extração.
- Quando a rotina publica um release novo, o MCP percebe em até 5 minutos
  (`MCP_INTERVALO`) e troca o banco inteiro sem reiniciar; `versao_dado` muda
  na resposta seguinte. O site costuma perceber antes (o `resumo.json` dele
  tem cache de 5 min na borda): a primeira requisição com `v` mais novo que o
  banco dispara uma verificação imediata (debounce de 60 s) e sai sem cache.
- Logo após um deploy que muda o esquema exportado, o MCP pode rodar código
  novo sobre o Parquet do dia anterior até a rotina republicar: tabelas
  ausentes viram campos nulos, nunca erro de boot.
- **Dê um limite de memória ao container** (no Coolify: Advanced → Resources,
  ex.: 1 GB) — é o último guarda-corpo, e o único que o processo não consegue
  furar. O `memory_limit` do DuckDB (`MCP_MEMORIA`) só cobre o buffer manager:
  medido em 05/09/2026, `SELECT range(5000000) FROM range(20)` chegou a 511 MB
  de RSS com `memory_limit=64MB`. A projeção limitada do executor (célula de
  2.000 caracteres, 100 colunas) impede que isso vaze para o Python, mas a
  materialização dentro do DuckDB continua sem teto rígido. Com o limite no
  container, o pior caso é o Docker reiniciar o processo (health check em
  `/saude`) — sem ele, é o host inteiro que sente.
