# Rodando a extração diária no Coolify

O repositório tem um `Dockerfile` pensado para isso: o container fica ocioso
(`sleep infinity`) e uma **Scheduled Task** do Coolify executa a rotina diária
dentro dele. O banco fica num volume persistente; os Parquet são publicados no
GitHub Releases do próprio repo.

## 1. Token do GitHub

A publicação usa o `gh` CLI, que autentica pela variável de ambiente `GH_TOKEN`.
Crie um **fine-grained personal access token** em
https://github.com/settings/personal-access-tokens/new com:

- **Repository access**: somente o repositório do projeto;
- **Permissions → Contents: Read and write** (releases entram em Contents).

Nada além disso — se o token vazar, o estrago fica limitado a este repo.

## 2. Aplicação no Coolify

1. **+ New → Application → Public Repository** (ou GitHub App, se conectado) e
   aponte para o repositório. Build Pack: **Dockerfile**.
2. Em **Storages**, adicione um volume: destino `/app/data` (ex.: nome
   `gastos-data`). Sem isso o banco e o histórico somem a cada redeploy.
3. Em **Environment Variables**, crie `GH_TOKEN` com o token do passo 1
   (marque como *Build Variable* = não; é só runtime). Se estiver rodando um
   **fork**, crie também `GH_REPO` com `seu-usuario/seu-fork` (o padrão da
   imagem aponta para o repositório original).
4. Deploy. O container sobe e fica ocioso consumindo ~0 recursos.

## 3. Scheduled Task

Na aplicação, aba **Scheduled Tasks → + Add**:

- **Command**: `python gastos.py rotina --ano 2026`
- **Frequency**: `0 7 * * *` no fuso de Brasília (o TSE gera os arquivos por
  volta das 04h; 07h dá folga). Se o servidor estiver em UTC: `0 10 * * *`.

A saída de cada execução fica registrada no Coolify; a linha `[mudancas]`
resume quantos conteúdos foram removidos/alterados na extração do dia.

## 4. Conferindo

- Release `dados` do repo deve ganhar arquivos novos diariamente (verifique o
  timestamp dos assets).
- Para investigar as mudanças de um dia: entre no terminal do container no
  Coolify e rode `python gastos.py mudancas` (ou consulte os Parquet publicados
  de qualquer máquina).

## Observações

- A rotina é idempotente: rodar duas vezes no mesmo dia não duplica nada (a
  última extração do dia vence).
- Volume projetado para o fim do período: ~5–8 GB no `/app/data` (CSVs
  extraídos são a maior fatia). Um volume de 20 GB dá folga confortável.
- Se a rotina falhar num dia (rede, TSE fora), a próxima execução continua de
  onde parou — mas o retrato daquele dia se perde; vale monitorar as falhas.
- Execução manual longa pelo Terminal do painel: a sessão web expira e mata
  processos em foreground — use `nohup python gastos.py rotina ... > /app/data/rotina.log 2>&1 &`
  (retomável de qualquer forma: cada etapa persiste o que concluiu).
