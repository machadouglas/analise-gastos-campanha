# Roadmap — próximos passos combinados

Itens já discutidos e aprovados em conceito, aguardando implementação. Nada aqui é
promessa pública; é memória de trabalho do projeto.

## 1. Red flag "fornecedor baixado/inapto após receber" (prioridade alta)

A **reconsulta contínua** do cadastro já está implementada (`cnpj.enriquecer_em_massa`):
pendentes novos primeiro (maiores valores), depois os cadastros mais antigos
(`dt_consulta` mais antiga, vencidos há 30+ dias), num ritmo que percorre a base num
ciclo de ~30 dias, dentro do `--limite-cnpj` diário. Os 404 (tombstones) entram no mesmo
ciclo por idade. Quando a situação cadastral muda, a anterior fica registrada em
`situacao_anterior` + `dt_situacao_anterior` — a matéria-prima da red flag já está
sendo colhida.

Falta a red flag em si:

- "fornecedor baixado/inapto/suspenso APÓS receber pagamento de campanha" — transição
  `ATIVA → BAIXADA/INAPTA/SUSPENSA` com despesa declarada antes da transição. Entra em
  `src/analises.py`, no `indicadores` (com cobertura explícita, como o recém-aberto) e
  na metodologia do site.
- **Testes**: transição legítima detectada; empresa já baixada antes do pagamento NÃO
  conta.
- Exige redeploy do container após implementado.

## 2. Migração dos `/dados` para R2 público (plano de escala)

Documentado em [deploy-cloudflare.md](deploy-cloudflare.md#plano-de-escala-migrar-dados-para-r2-público-não-implementado).
Só quando o tráfego justificar.

## 3. Servidor MCP público

No ar desde 05/09/2026 (`src/mcp/`, SDK 2.x, revisão 2026-07-28 do protocolo;
arquitetura em [arquitetura-mcp.md](arquitetura-mcp.md), deploy em
[deploy-mcp.md](deploy-mcp.md)), com rate limit na borda e host sem IP exposto.
Pendente: validação com clientes reais (Claude, ChatGPT) e registro no MCP Registry.
Medir após duas semanas: proporção de `sql`, latência, 429/timeout.

## 4. Onde a consulta roda (feito em 08/09/2026) e o modo arquivo

As fichas e o Explorar deixaram de montar um banco no navegador: o SQL das
páginas vai para `GET /api/v1/consulta` no container do MCP, a borda cacheia a
resposta por versão do dado, e o DuckDB-WASM fica como contingência (e como
motor do console). Desenho e medições em `arquitetura-mcp.md` §12; operação em
`deploy-mcp.md` §6.

Depois das prestações finais (novembro), o dado congela e a arquitetura ideal
muda: o mesmo SQL das páginas roda **uma vez** como gerador de JSON estático
(uma pasta por ficha e por visão do Explorar), publicado no Pages ou em R2, e o
servidor pode ser desligado — site 100% estático, sem fallback, `consultas.ts`
aposentado. A API construída na campanha é exatamente esse gerador com outro
gatilho. Não fazer antes: com o dado mudando todo dia seriam 20 mil fichas a
regerar e sincronizar diariamente, para resolver o que o cache de borda já
resolve.

## 5. Cópia de segurança do banco da extração (pendente)

`data/db/gastos.duckdb` guarda o histórico de extrações com o CPF cru — e o
TSE sobrescreve os arquivos todo dia, então esse histórico **não se reconstrói
da fonte**. Os Parquet publicados são uma cópia pseudonimizada: servem para
consulta, não para retomar o pipeline (o hash de identidade de uma linha com
CPF cru não bate com o da linha `pf-…`, e a próxima extração viraria uma
remoção em massa). Falta uma cópia periódica do banco (e do `data/raw/` do dia)
fora do host, **cifrada**, porque carrega CPF — por exemplo `rclone` para um
bucket com chave só no container da rotina, logo depois de cada `carregar`.
