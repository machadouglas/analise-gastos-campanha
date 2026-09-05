# Servidor MCP público — arquitetura

Um servidor [MCP](https://modelcontextprotocol.io) público permite que qualquer
pessoa conecte a IA que já usa (Claude, ChatGPT, Cursor…) diretamente aos dados
do projeto, sem copiar prompt nem colar SQL no console. Este documento fixa o
desenho; a implementação vive em `src/mcp/` e o guia de produção em
[deploy-mcp.md](deploy-mcp.md). Nada aqui é promessa pública; é decisão de projeto.

Critérios que guiaram o desenho, em ordem: **simplicidade**, **custo zero**,
**privacidade por construção**, e só depois escala. A versão anterior deste
documento apostava em autoescala numa plataforma paga; foi substituída porque
o volume esperado não a justifica e o container é portátil — se um dia
precisar, muda o host, não o código (§7).

## 1. Princípio: o MCP consome o release, nunca o banco da extração

A rotina diária guarda o banco com **CPF cru** e as credenciais de
publicação. Nenhum serviço público pode enxergá-los — nem por rede, nem por
volume, nem por variável de ambiente. O MCP lê **exclusivamente os Parquet
publicados** no release `dados` (pseudonimizados, os mesmos que o site consome).

Consequências:

- **Isolamento por construção.** A rotina publica; o MCP baixa do release,
  como qualquer visitante. Não existe rota entre os dois, mesmo que rodem no
  mesmo host: o container da rotina não expõe porta nem domínio, e o do MCP
  não monta volume nem recebe segredo.
- **Privacidade herdada.** O MCP só conhece `pf-…`. Nenhum bug de consulta
  expõe CPF, porque o dado não está lá.
- **Paridade com o site.** Mesmos arquivos, mesmas views, mesma régua de
  leitura. O que o console mostra, o MCP mostra.

## 2. Visão geral

| Peça | Onde | Papel |
|---|---|---|
| **Container MCP** | o mesmo host Docker que roda a rotina, como aplicação separada | Python + DuckDB em memória sobre os Parquet publicados. Implementa o protocolo MCP e as ferramentas. Stateless. |
| **Borda** | Cloudflare (plano gratuito) + túnel | DNS do domínio público, TLS, rate limit por IP, IP de origem invisível. |
| **Dado** | GitHub Releases | Os Parquet e o `resumo.json` que a rotina já publica. Nada novo a publicar. |

Não há banco externo, fila, cache distribuído nem serviço pago. O dado inteiro
publicado tem ~26 MB; o DuckDB embutido no processo o carrega no boot e
responde em milissegundos. Estado compartilhado só seria necessário para
sincronizar réplicas, e com um host não há réplicas: o cache é em memória do
processo e o limite de concorrência é um semáforo.

### Exposição do host

O host **não expõe IP**: todo tráfego público entra por um túnel de saída
(Cloudflare Tunnel, gratuito) e o firewall do host fecha as portas 80/443. O
DNS de `mcp.<domínio>` aponta para o túnel, nunca para um endereço. Isso é
propriedade do host inteiro, não do MCP — qualquer outro serviço servido pelo
mesmo host precisa entrar pelo mesmo túnel, senão o IP continua descobrível
por ele. O guia genérico de deploy (a escrever, `docs/deploy-mcp.md`) descreve
o túnel sem citar infra de ninguém.

### Alternativas descartadas

- **Cloudflare Workers puro**: não roda DuckDB (bundle de poucos MB, 128 MB de
  memória). Só serviria com o dado em D1/SQLite, e a ferramenta `sql` em
  dialeto DuckDB é requisito.
- **Cloudflare Containers / Cloud Run**: autoescala e conta própria, mas
  custo fixo mensal e mais peças (Worker, KV, workflow de deploy). É o caminho
  de escala de §7, não o ponto de partida.
- **Rodar dentro do container da rotina**: menos um container, mas o
  processo público passaria a viver junto do banco com CPF cru e dos
  segredos. Inaceitável por §1.

## 3. O container

### Boot e atualização do dado

1. Baixa `resumo.json` do release e lê `arquivos` (md5 por Parquet).
2. Baixa cada Parquet **para disco local** e cria uma tabela DuckDB por
   arquivo (`CREATE TABLE despesas AS SELECT * FROM 'despesas.parquet'`).
3. Passa a servir. A cada 5 minutos repete o passo 1; se algum md5 mudou,
   monta um banco **novo** em paralelo e troca a conexão de forma atômica.
   Consultas em andamento terminam no banco antigo.

Não há recomputação de agregados: `indicadores`, `rede`, `benchmark_*`,
`despesas_atual`, `despesas_removidas` etc. já chegam prontos do release
(`src/exportar.py`). O MCP carrega os arquivos como tabelas e **não define
view nenhuma** — a regra de remoção/retificação vive em `src/historico.py`, é
exportada pronta, e assim nem o site nem o MCP a reimplementam. Só o
`resumo.json` entra como documento (metadados, `serie_nacional`, versão do dado).

### Stateless

Transporte **Streamable HTTP em modo stateless** (SDK oficial `mcp` em Python,
`stateless_http=True`). Sem sessão presa a processo, o servidor pode rodar com
vários workers (um por vCPU) e, se um dia houver réplicas, nenhuma delas
precisa conhecer as outras. O transporte SSE legado não é oferecido.

### Protocolo: sempre a revisão mais recente da especificação

O MCP segue a **última revisão publicada** da especificação
(https://modelcontextprotocol.io/specification) e nada de transporte ou
comportamento legado. Compromissos verificáveis, não intenção:

- **SDK oficial `mcp` 2.x (Python, classe `MCPServer`) fixado por faixa** em
  `requirements-mcp.txt`. A 2.1 implementa a revisão **2026-07-28**; patches e
  minors chegam por PR do Dependabot, majors são migração deliberada (o
  Dependabot os ignora). `tests/test_mcp_protocolo.py` compara a revisão
  negociada com `LATEST_PROTOCOL_VERSION` do SDK: um bump que traga revisão
  nova é cobrado ali.
- **Duas eras ao mesmo tempo**: o cliente novo negocia a revisão mais recente
  por `server/discover`; clientes antigos seguem pelo `initialize` clássico
  (2025-11-25). O mesmo servidor atende os dois, sem transporte legado (SSE).
- **Streamable HTTP** com negociação de versão pelo cabeçalho
  `MCP-Protocol-Version`. O proxy do host repassa esse cabeçalho e o
  `Mcp-Session-Id` sem tocar.
- **Ferramentas com `inputSchema` e `outputSchema`** e resposta em
  `structuredContent` (além do texto). **Anotações** em todas:
  `readOnlyHint=true`, `idempotentHint=true`, `destructiveHint=false`,
  `openWorldHint=false` — o cliente sabe que pode chamar sem confirmar.
- **Recursos** com `mimeType` correto (`radar://esquema` como
  `text/markdown`, `radar://resumo` como `application/json`) e **paginação**
  nas listagens com cursor, mesmo que hoje caibam numa página.
- **Erros no padrão JSON-RPC**, com o erro de execução da ferramenta (SQL
  inválido, timeout) devolvido como `isError=true` no resultado — é o que a
  especificação distingue de erro de protocolo.
- **Conformidade em CI**: `test_mcp_protocolo.py` fala com o app pelo
  cliente oficial do SDK, em processo (Streamable HTTP de verdade sobre ASGI):
  discover/initialize, `tools/list`, `tools/call`, `resources/read` e `/saude`.
  O build da imagem roda essa suíte; imagem quebrada não sobe.
- **Autenticação, quando vier** (chave para cota maior): OAuth 2.1 como
  *resource server*, com metadados de recurso protegido (RFC 9728) e
  `WWW-Authenticate` no 401. Nada de chave em query string.

### Esquema visível ao modelo

As mesmas tabelas listadas no prompt do console (`site/src/lib/prompt.ts`),
com os mesmos nomes. O texto do prompt vira o campo `instructions` do servidor
e um recurso MCP `radar://esquema`. Um teste garante que o texto servido é o
mesmo do site (§9 e §10).

## 4. Ferramentas

Ferramentas curadas para o comum, `sql` para o que ninguém previu. Nomes e
descrições em português; respostas em JSON compacto, com `versao_dado` (data
da extração) e `versao_codigo` (commit) em toda resposta.

| Ferramenta | Argumentos | Retorna | Fonte |
|---|---|---|---|
| `buscar_candidato` | `nome` (parcial), `uf?`, `cargo?`, `partido?` | até 20 candidatos (SQ, nome, urna, número, cargo, partido, UF, totais) | `candidatos` ⋈ `indicadores` |
| `ficha_candidato` | `sq_candidato` | scorecard, sinais fora da curva, maiores fornecedores, composição da receita, declarações removidas/corrigidas | `indicadores`, `benchmark_indicadores`, `rede`, `despesas_removidas`, `despesas_alteradas` |
| `ficha_fornecedor` | `id` (CNPJ ou `pf-…`) | cadastro RFB (se CNPJ), candidatos atendidos, totais, flags 12/13 | `fornecedores`, `rede`, `despesas_atual` |
| `ficha_partido` | `sigla`, `uf?` | totais, candidatos, fundos públicos, cota do FEFC | `indicadores`, `cota_fefc` |
| `fora_da_curva` | `sinal?`, `uf?`, `cargo?`, `limite?` | candidatos acima do p95 do grupo, por métrica | `indicadores` ⋈ `benchmark_indicadores` |
| `declaracoes_removidas` | `uf?`, `cargo?`, `sq_candidato?`, `tipo` (despesa/receita) | declarações que saíram do ar de verdade | `despesas_removidas` / `receitas_removidas` |
| `fornecedores_compartilhados` | `uf?`, `minimo_candidatos?` | fornecedores atendendo N+ candidatos | `rede` |
| `sql` | `consulta` | linhas (máx. 500) ou erro explicativo | banco inteiro, leitura |

As ferramentas curadas reutilizam as consultas do site (`site/src/lib/
consultas.ts`), reescritas em Python em `src/mcp/consultas.py`; o teste de
sincronia (§10) compara as constantes espelhadas como já faz com o site.

Não expor: nada que devolva CPF (não existe no dado), nada que escreva, nada
que consulte serviço externo (Receita, TSE) em tempo de request.

## 5. Guarda-corpos da ferramenta `sql`

Liberdade para o usuário, não para o processo. Nenhum guarda-corpo depende do
modelo se comportar; todos ficam no DuckDB e no container.

**No banco (configurado uma vez, no boot, e travado):**

- Conexão somente leitura: as tabelas são criadas numa conexão de montagem;
  as consultas rodam numa conexão `read_only=True` sobre o mesmo arquivo.
- `SET enable_external_access = false` — mata `read_csv`, `read_parquet` de
  URL, `httpfs`, `glob`, `getenv`. `SET lock_configuration = true` depois.
- `SET memory_limit` (ex.: 512 MB) e `SET threads` (ex.: 2) por conexão.
- Extensões: só as que o boot carregou. Sem `INSTALL`/`LOAD` em runtime.

**Na requisição:**

- **Só leitura, um statement.** Validação pelo **parser do próprio DuckDB**
  (`duckdb.extract_statements`): exatamente um statement, do tipo `SELECT`.
  Conferido no DuckDB 1.5.5: `WITH`, `DESCRIBE`, `SUMMARIZE`, `SHOW` e `FROM`
  são classificados como `SELECT`; `COPY`, `SET`, `INSTALL` (vira `LOAD`) e
  `EXPLAIN` são recusados pelo tipo. **Exceção documentada**: o parser
  reescreve `PIVOT`/`UNPIVOT` como um par `CREATE` + `SELECT` (macro
  temporária), então a regra os recusa. O console do site os aceita
  (`VERBOS_LEITURA` em `site/src/lib/sql-gate.ts`); na fase 1 o MCP fica sem
  `PIVOT`, e o teste de sincronia registra essa diferença explicitamente.
- **Timeout por interrupção** (ex.: 10 s): a consulta roda numa thread;
  passado o prazo, `con.interrupt()`. O processo sobrevive; o modelo recebe
  "consulta demorou demais — restrinja por UF/cargo ou use as views prontas".
- **Teto de linhas e bytes**: `LIMIT 500` imposto por subconsulta
  (`SELECT * FROM (<consulta>) LIMIT 500`) e resposta truncada em ~200 KB
  com aviso.
- **Erros voltam como texto útil**, não como stack: mensagem do DuckDB +
  lembrete do esquema + dica das views prontas.
- **Concorrência limitada** por processo, em **duas filas**: as ferramentas
  curadas (consultas conhecidas, baratas; 8 vagas) e a `sql` livre (custo
  imprevisível; 4 vagas). Medido em 05/09/2026 com uma fila só: 40 chamadas
  simultâneas, as 8 vagas tomadas por cross joins, e todas as leves recusadas
  — a `sql` não pode esgotar o que as fichas usam. O excedente espera até 5 s
  e recebe "ocupado". Sob 8 consultas pesadas simultâneas o processo foi de
  179 MB para 344 MB e voltou; o timeout de 10 s interrompe cada uma e o
  servidor segue respondendo em milissegundos.

## 6. A borda

Tudo no plano gratuito do Cloudflare; nenhum código próprio na borda:

- **DNS** de `mcp.<domínio>` apontando para o túnel (registro gerenciado
  pelo próprio túnel). TLS terminado na borda.
- **Rate limit** por IP (uma regra de Rate Limiting, incluída no plano):
  ex.: 60 chamadas/min. Público e anônimo, como o site.
- **WAF gerenciado** gratuito ligado; nada além do padrão.
- **Sem cache na borda**: MCP é POST JSON-RPC, o CDN não cacheia. O cache é
  em memória do processo, por ferramenta + argumentos + md5 do dado.

## 7. Escala e capacidade

- Dado de 26 MB em memória: um processo por vCPU responde **centenas** de
  consultas simples por segundo; consultas pesadas (joins na `rede`
  inteira) em dezenas de ms.
- Cem mil chamadas/dia são ~1,2/s em média. Cabe com folga num host modesto,
  ao lado da rotina, que roda uma vez por dia por alguns minutos.
- **Sob carga extrema** o comportamento é 429 (semáforo + rate limit), nunca
  vazamento nem derrubar a rotina.
- **Caminho de escala, se um dia vier**: a imagem é a mesma que roda em
  Cloudflare Containers ou Cloud Run. Mudar de host não muda código, testes
  nem o desenho de dado. A decisão de hoje é reversível.
- **Dado em R2**: independente deste desenho; já planejado em
  [deploy-cloudflare.md](deploy-cloudflare.md#plano-de-escala-migrar-dados-para-r2-público-não-implementado).

## 8. Segurança e privacidade

- **Dado**: só Parquet publicados (`pf-…`). Nenhum sal, token ou CPF entra
  no container. Variáveis de ambiente: `GH_REPO` e nada mais.
- **Processo**: usuário sem privilégio (uid 10001, como o `Dockerfile` da
  rotina), sem volume, sem `gh`, sem `curl_cffi`, sem chave nenhuma.
- **Rede de saída**: só o release. O DuckDB não consegue abrir URL
  (`enable_external_access=false`).
- **Rede de entrada**: só pelo túnel; o host não tem porta pública. Mesmo
  que outro serviço do host seja comprometido, o container da rotina não
  escuta em porta alguma.
- **Abuso**: rate limit na borda + semáforo + timeout. Um modelo em loop
  bate no 429 antes de encher a fila.
- **Logs**: nunca gravam o SQL completo com valores; gravam ferramenta,
  duração, linhas, status e hash da consulta. Sem IP em log de aplicação.
- **Repositório**: nenhum arquivo versionado cita host, provedor, IP ou
  nome de máquina. Os guias de deploy são genéricos, como o da rotina.

## 9. Versão: o MCP responde sempre como a última versão do repo

"Igual ao repo" tem dois sentidos, e os dois são compromissos:

**Mesmo código.** O container é construído do mesmo commit que o site e a
rotina, pelo mesmo mecanismo que já constrói a rotina: a plataforma do host
observa a `main` e reconstrói a aplicação a cada push (build do
`Dockerfile.mcp`, testes no build, imagem quebrada não sobe). Sem deploy
manual, o MCP nunca fica um commit atrás. A imagem carrega o hash do commit
(`ARG GIT_SHA`), e toda resposta traz `versao_codigo` ao lado de
`versao_dado`.

**Mesmas respostas.** As regras que o MCP aplica são as do repo, sem cópia
própria:

- O dado chega pronto do release, calculado por `src/`. O MCP não recalcula.
- As consultas das ferramentas curadas são cobertas por
  `tests/test_sincronia_site.py` e por `tests/test_mcp_ferramentas.py`, que
  roda as consultas prontas de `site/src/lib/exemplos.ts` pela ferramenta
  `sql` e compara com a execução direta — gate, `LIMIT` e formatação não
  podem alterar o resultado.
- O texto de `instructions` é o de `site/src/lib/prompt.ts`, verificado por
  teste.

**Janela entre código e dado.** O release só é republicado quando o dado
muda **ou** o pipeline muda (`stamp_codigo` em `src/exportar.py`). Logo após
um deploy que altera o esquema exportado, o MCP pode rodar código novo sobre
Parquet do dia anterior até a rotina republicar. Regra: **degradar
graciosamente** como o site — tabela ou coluna ausente vira campo nulo ou
"indisponível nesta versão do dado", nunca erro de boot. O `resumo.json`
ganha `versao_codigo` (o próprio `stamp_codigo`) para o MCP e o site
exporem com qual pipeline o dado foi gerado.

## 10. Código, testes e imagem

```
src/publicado.py  # download do release (extraído de scripts/previa-local.py)
src/mcp/
  servidor.py     # FastMCP, transporte, instructions, recursos
  dados.py        # boot, poll de md5, troca atômica
  gate.py         # validação de statement, timeout, LIMIT, teto de bytes
  consultas.py    # SQL das ferramentas curadas (espelho de consultas.ts)
  ferramentas.py  # registro das ferramentas e formatação das respostas
Dockerfile.mcp    # python:3.12-slim + duckdb + mcp; sem gh; ARG GIT_SHA; uid 10001
tests/
  test_mcp_gate.py        # statements aceitos/recusados, timeout, LIMIT, bytes
  test_mcp_ferramentas.py # cada ferramenta contra o banco montado do fixture E2E;
                          # exemplos.ts pela ferramenta sql == execução direta
  test_mcp_protocolo.py   # MCP Inspector (CLI) contra o container
  test_sincronia_site.py  # ganha: VERBOS_LEITURA <-> gate.py (exceção do PIVOT);
                          # prompt.ts <-> instructions; constantes de consultas.ts
.github/dependabot.yml    # pip: mcp, duckdb — o teste de protocolo autoriza o bump
```

- A montagem do banco é diferente da prévia local de propósito: a prévia
  reconstrói o pipeline (precisa dos brutos); o MCP só carrega os
  publicados.
- O `test_e2e_pipeline.py` já produz Parquet pseudonimizados a partir de um
  zip sintético; os testes do MCP montam o banco a partir deles.
- Desenvolvimento local: `docker run -p 8000:8000 radar-mcp` e apontar o
  Claude Desktop/Code para `http://localhost:8000/mcp`. Todo o MCP é
  construído e testado antes de existir no host.

## 11. Fases

1. **Host sem IP exposto** (pré-requisito, manual, fora do repo): túnel de
   saída ligado, todos os serviços públicos do host entrando por ele,
   portas 80/443 fechadas no firewall, deploy automático testado através do
   túnel. Sem isso o MCP não sobe.
2. **Container local** — `src/mcp/`, ferramentas curadas + `sql` com todos
   os guarda-corpos, testes, `Dockerfile.mcp`, `versao_codigo`. Validar com
   clientes MCP reais apontando para localhost.
3. **Deploy** — aplicação nova na plataforma do host (mesmo repositório,
   `Dockerfile.mcp`, sem volume, só `GH_REPO`), hostname `mcp.<domínio>` no
   túnel, regra de rate limit. `docs/deploy-mcp.md` genérico.
4. **Publicação** — bloco "Conecte sua IA" na página Consultar, README,
   registro no MCP Registry (`server.json`).
5. **Medir** após duas semanas: ferramentas mais usadas, proporção de `sql`,
   latência p95, taxa de 429 e de timeout. Decidir com dado se vale chave
   de API, mais ferramentas curadas, ou mudar de host.

## 12. Decisões em aberto

- **Domínio**: dedicado ao MCP, na conta Cloudflare (registrado lá ou com
  os nameservers lá, para o túnel gerenciar o DNS).
- **Limites iniciais** (60/min por IP, 10 s de timeout, 500 linhas, 200 KB,
  8 consultas simultâneas): chutes razoáveis, para ajustar com a medição.
- **Idioma das descrições das ferramentas**: português (público-alvo), com
  o esquema em inglês onde o TSE já usa siglas.
