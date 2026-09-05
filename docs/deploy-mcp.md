# Servidor MCP em produção

O servidor MCP (`src/mcp/`, imagem `Dockerfile.mcp`) roda como **aplicação
separada** no mesmo host Docker da rotina, atrás de um túnel de saída — sem
volume, sem segredo, sem porta pública. Ele só baixa os Parquet do release
`dados`; nada nele alcança o banco da extração. O desenho está em
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
   (4, fila própria da `sql` livre), `MCP_MEMORIA` (`512MB`), `MCP_THREADS` (2),
   `MCP_INTERVALO` (s entre verificações do release, 300).
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
- Sem cache na borda: MCP é POST JSON-RPC. O cache é no processo.

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

## Observações

- O container roda como usuário sem privilégio (uid 10001) e só tem `GH_REPO`
  no ambiente. Não existe token, sal de CPF nem acesso ao banco da extração.
- Quando a rotina publica um release novo, o MCP percebe em até 5 minutos
  (`MCP_INTERVALO`) e troca o banco inteiro sem reiniciar; `versao_dado` muda
  na resposta seguinte.
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
