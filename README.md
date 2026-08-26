# Análise de Gastos de Campanha

Extrator e analisador de dados públicos de financiamento de campanhas eleitorais brasileiras (TSE), com foco em identificar indícios de irregularidades: fornecedores suspeitos, concentração de gastos, doadores-fornecedores, CNPJs recém-abertos, CNAE incompatível com o serviço prestado, entre outros.

**Este projeto foi desenhado para ser usado com uma IA** (Claude Code ou similar): você baixa o repositório, abre a IA na pasta e pergunta em linguagem natural — a IA usa os scripts para buscar, processar e analisar os dados. O arquivo [CLAUDE.md](CLAUDE.md) é o manual de operação da IA.

Todos os dados usados são **públicos e oficiais** (Portal de Dados Abertos do TSE, DivulgaCandContas, BrasilAPI/Receita Federal). O repositório não contém nenhum dado pessoal — os dados baixados ficam em `data/` (ignorado pelo git).

## Uso rápido (sem IA)

```bash
pip install -r requirements.txt

# 1. Baixar os dados do TSE (ano eleitoral)
python gastos.py baixar --ano 2026

# 2. Carregar em um banco DuckDB local
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

# 8. Exportar Parquet e publicar no GitHub Releases
python gastos.py exportar --publicar
```

## Dados prontos, sem instalar nada

Cada extração publica os dados em Parquet no [release `dados`](https://github.com/machadouglas/analise-gastos-campanha/releases/tag/dados), com colunas `dt_primeira_extracao`/`dt_ultima_extracao` que registram quando cada linha apareceu e até quando permaneceu declarada — dá para ver declarações removidas ou alteradas depois. Consulte direto da URL com [DuckDB](https://duckdb.org):

```sql
SELECT NM_CANDIDATO, SUM(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas) AS total
FROM 'https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/despesas.parquet'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

## Estrutura

```
gastos.py            CLI única (baixar / carregar / candidato / analisar / sql / enriquecer)
src/tse.py           Catálogo de fontes do TSE + download (contorna bloqueio TLS do CDN)
src/carga.py         Carga dos CSVs no DuckDB + views tipadas
src/analises.py      Catálogo de consultas de red flags
src/cnpj.py          Enriquecimento via BrasilAPI (Receita Federal), com cache
config/alvos.yaml    Candidatos-alvo do seu estudo (local, fora do git)
docs/fontes-de-dados.md   Onde estão os dados públicos e o que contêm
data/                Dados baixados e banco local (fora do git)
relatorios/          Relatórios gerados (fora do git)
```

## Fontes de dados

Ver [docs/fontes-de-dados.md](docs/fontes-de-dados.md). Principais:

- **Portal de Dados Abertos do TSE** — prestação de contas (receitas e despesas por candidato, com fornecedor, CNPJ, CNAE, valor e data), candidaturas, bens declarados.
- **DivulgaCandContas** — consulta individual por candidato (API JSON).
- **BrasilAPI / Receita Federal** — cadastro de CNPJ dos fornecedores (data de abertura, porte, sócios, CNAE real).

## Aviso

Os dados refletem o que os candidatos **declararam** ao TSE. Um "red flag" é um indício que merece investigação, **não** uma prova de irregularidade. Use com responsabilidade.

## Licença

Código sob licença MIT. Os dados pertencem às suas fontes públicas (TSE, Receita Federal).
