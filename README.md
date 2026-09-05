# Análise de Gastos de Campanha

Extrator, analisador e **radar público** de dados de financiamento de campanhas eleitorais brasileiras (TSE). O diferencial: uma rotina diária fotografa as declarações e guarda o histórico — o que foi **removido ou alterado** fica registrado, algo que o portal oficial não mostra (ele só exibe o estado atual).

O que o projeto identifica são **indícios** para investigação, nunca prova de irregularidade: declarações removidas, candidatos **fora da curva** do próprio grupo de comparação (mesmo cargo e UF), concentração de gastos em um fornecedor, doador que também é fornecedor, CNPJ recém-aberto, despesas sem documento fiscal esperado, valores repetidos no mesmo fornecedor, CNAE incompatível com o serviço.

**Este projeto foi desenhado para ser usado com uma IA** (Claude Code ou similar): você baixa o repositório, abre a IA na pasta e pergunta em linguagem natural — a IA usa os scripts para buscar, processar e analisar os dados. O arquivo [CLAUDE.md](CLAUDE.md) é o manual de operação da IA.

Todos os dados usados são **públicos e oficiais** (Portal de Dados Abertos do TSE, BrasilAPI/Receita Federal). O repositório não contém nenhum dado pessoal — os dados baixados ficam em `data/` (ignorado pelo git).

## As três formas de usar

1. **Site público** (`site/`) — SPA com o radar diário: declarações removidas, fora da curva por grupo de comparação, fichas de candidato/partido/fornecedor com benchmarks, e um console SQL (DuckDB-WASM) que roda no navegador do visitante, com prompt copiável para a IA pessoal dele gerar consultas.
2. **CLI local** (abaixo) — para estudo próprio, com ou sem IA.
3. **Dados prontos em Parquet** — publicados diariamente no GitHub Releases, consultáveis de qualquer lugar sem instalar nada.

## Uso rápido (CLI)

```bash
pip install -r requirements.txt

# 1. Baixar os dados do TSE (ano eleitoral)
python gastos.py baixar --ano 2026

# 2. Carregar em um banco DuckDB local (extrai, versiona e materializa agregados)
python gastos.py carregar --ano 2026

# 3. Procurar candidatos
python gastos.py candidato --nome "FULANO DA SILVA" --uf XX

# 4. Rodar as análises de red flags (todos ou candidatos específicos)
python gastos.py analisar --numero 12345 --numero 678 --uf XX --saida relatorios/analise.md

# 5. Consultas SQL livres sobre o banco
python gastos.py sql "SELECT DS_CARGO, SUM(VR) FROM v_despesas GROUP BY 1 ORDER BY 2 DESC"

# 6. Enriquecer fornecedores com dados da Receita Federal (data de abertura, sócios, CNAE)
python gastos.py enriquecer --numero 12345 --uf XX

# 7. Ver o que foi removido/alterado nas declarações entre extrações
python gastos.py mudancas

# 8. Checagens de integridade (a rotina roda isso e não publica se falhar)
python gastos.py verificar

# 9. Exportar Parquet e publicar no GitHub Releases
python gastos.py exportar --publicar

# 10. Subir o site com dados REAIS sem baixar nada do TSE: monta o banco a
#     partir dos Parquet já publicados e roda o pipeline do código atual por
#     cima. É o caminho curto para quem quer só mexer no site.
python scripts/previa-local.py

# Tudo de uma vez (pipeline diário, agendável em servidor — ver docs/deploy-coolify.md)
python gastos.py rotina --ano 2026
```

## Dados prontos, sem instalar nada

Cada extração publica os dados em Parquet no [release `dados`](https://github.com/machadouglas/analise-gastos-campanha/releases/tag/dados). As tabelas brutas trazem o versionamento (`dt_primeira_extracao`/`dt_ultima_extracao` registram quando cada linha apareceu e até quando permaneceu declarada), e os agregados vêm prontos: `indicadores` (scorecard por candidato), `benchmark_precos` (distribuição de preços por nota, categoria×UF), `benchmark_indicadores` (distribuição dos indicadores por grupo cargo×UF — a régua do "fora da curva"), `serie_diaria`, `rede`, `fornecedores`. Consulte direto da URL com [DuckDB](https://duckdb.org):

```sql
SELECT NM_CANDIDATO, SUM(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas) AS total
FROM 'https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/despesas.parquet'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

## Conecte a sua IA (servidor MCP)

Clientes que falam [MCP](https://modelcontextprotocol.io) — Claude, ChatGPT, Cursor, Claude Code — consultam os mesmos dados direto, sem copiar prompt nem colar SQL:

```
https://mcp.radardosgastos.com.br/mcp
```

Ferramentas: `buscar_candidato`, `ficha_candidato`, `ficha_fornecedor`, `ficha_partido`, `fora_da_curva`, `declaracoes_removidas`, `fornecedores_compartilhados`, `sem_nota`, `gastos_por_categoria`, `visao_geral` e `sql` (DuckDB, só leitura). As fichas devolvem o que o site mostra, com as mesmas regras; toda resposta traz a data do dado e a versão do código. O servidor lê só os Parquet publicados (`src/mcp/`, [arquitetura](docs/arquitetura-mcp.md), [deploy](docs/deploy-mcp.md)).

## Estrutura

```
gastos.py            CLI única (baixar / carregar / analisar / sql / verificar / rotina ...)
src/tse.py           Catálogo de fontes do TSE + download (contorna bloqueio TLS do CDN)
src/carga.py         Carga dos CSVs no DuckDB + views tipadas (sem linhas-placeholder)
src/historico.py     Versionamento por conteúdo: remoções e alterações entre extrações
src/agregados.py     Tabelas materializadas: série diária, benchmarks, indicadores, rede
src/analises.py      Catálogo de consultas de red flags
src/cnpj.py          Enriquecimento via BrasilAPI (Receita Federal), com cache (inclusive de 404)
src/verificacao.py   Checagens de integridade que bloqueiam publicação se falharem
src/resumo.py        resumo.json do site (totais, remoções, fora da curva)
src/exportar.py      Parquet + publicação no GitHub Releases
site/                Site público (Vite + React + DuckDB-WASM) — docs/deploy-cloudflare.md
tests/               Cenários sintéticos + integridade do banco real (pytest)
config/alvos.yaml    Candidatos-alvo do seu estudo (local, fora do git)
docs/                Fontes de dados e guias de deploy (genéricos)
data/                Dados baixados e banco local (fora do git)
```

## Metodologia em uma linha por decisão

- **Remoção** só conta quando o conteúdo não reaparece com a mesma essência (retransmissões renumeradas pelo sistema do TSE não são remoções) e nunca a partir de arquivo suspeito de truncamento (queda >20% bloqueia a publicação).
- **Linhas-placeholder** do sistema (contraparte `-1`/`#NULO` **e** valor zero = prestação sem movimento) não são fatos declarados e ficam fora de tudo; contraparte anônima **com** valor entra — é fato e indício.
- **"Fora da curva"** = acima do p95 do grupo de comparação (mesmo cargo e UF; nacional quando o grupo local tem menos de 20 candidatos). Nunca um limiar absoluto inventado.
- **Preços** comparados por **nota** (soma dos itens), para nota fatiada não distorcer a régua; **valores repetidos** exigem 3+ notas do mesmo fornecedor; **"sem nota fiscal"** exclui categorias em que a nota não é o documento próprio (transferências, tributos, aluguel de imóvel, pessoal); **dinheiro público** se mede pela fonte oficial da receita (`DS_FONTE_RECEITA`), não pela origem declarada.

A página `/metodologia` do site documenta tudo em linguagem de visitante; `python -m pytest tests/` prova cada regra em cenário sintético.

## Fontes de dados

Ver [docs/fontes-de-dados.md](docs/fontes-de-dados.md). Principais:

- **Portal de Dados Abertos do TSE** — prestação de contas (receitas e despesas por candidato, com fornecedor, CNPJ, CNAE, valor e data), candidaturas, bens declarados.
- **BrasilAPI / Receita Federal** — cadastro de CNPJ dos fornecedores (data de abertura, porte, sócios, CNAE real).

## Aviso

Os dados refletem o que os candidatos **declararam** ao TSE. Um "red flag" é um indício que merece investigação, **não** uma prova de irregularidade. Use com responsabilidade.

## Licença

Código sob licença MIT. Os dados pertencem às suas fontes públicas (TSE, Receita Federal).
