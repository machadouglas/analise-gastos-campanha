# Roadmap — próximos passos combinados

Itens já discutidos e aprovados em conceito, aguardando implementação. Nada aqui é
promessa pública; é memória de trabalho do projeto.

## 1. Refresh mensal do cadastro de CNPJ (prioridade alta)

Hoje `fornecedores` é preenchido aos poucos pela rotina (`cnpj.enriquecer_em_massa`,
com `--limite-cnpj`) e nunca reconsultado — a situação cadastral fica congelada na
primeira consulta. Plano:

- **Validade de 30 dias**: guardar a data da consulta em cada linha de `fornecedores`
  (nova coluna `dt_consulta`); registro com mais de 30 dias conta como "vencido".
- **Fila com prioridade**, dentro do mesmo `--limite-cnpj` diário:
  1. pendentes novos (nunca consultados);
  2. 404 antigos (cache negativo com mais de 30 dias — a empresa pode ter sido incluída
     na base pública depois);
  3. vencidos, ordenados por valor recebido (quem recebe mais é reavaliado primeiro).
- **Guardar a situação anterior** ao atualizar (ex.: coluna `situacao_anterior` +
  `dt_situacao_anterior`) para detectar transição.
- **Nova red flag**: "fornecedor baixado/inapto/suspenso APÓS receber pagamento de
  campanha" — transição `ATIVA → BAIXADA/INAPTA/SUSPENSA` com despesa declarada antes da
  transição. Entra em `src/analises.py`, no `indicadores` (com cobertura explícita, como
  o recém-aberto) e na metodologia do site.
- **Testes** para a fila (ordem e limite), a validade e a red flag (transição legítima
  detectada; empresa já baixada antes do pagamento NÃO conta).
- Exige redeploy do container após implementado.

## 2. Migração dos `/dados` para R2 público (plano de escala)

Documentado em [deploy-cloudflare.md](deploy-cloudflare.md#plano-de-escala-migrar-dados-para-r2-público-não-implementado).
Só quando o tráfego justificar.
