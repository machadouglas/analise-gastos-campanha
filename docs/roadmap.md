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

Implementado em `src/mcp/` (arquitetura em [arquitetura-mcp.md](arquitetura-mcp.md),
deploy em [deploy-mcp.md](deploy-mcp.md)). Pendente: aplicação no host (Dockerfile.mcp,
domínio `mcp.<domínio>` no túnel), regra de rate limit, validação com clientes reais
em produção e registro no MCP Registry. Medir após duas semanas: proporção de `sql`,
latência, 429/timeout.
