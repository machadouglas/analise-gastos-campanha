# Manual de operação (IA)

Este projeto extrai e analisa dados públicos de financiamento de campanha do TSE para identificar indícios de irregularidades. O usuário conversa com você; você opera os scripts e responde com análises.

## Regras

1. **Nunca** grave dados pessoais do usuário no repositório. Dados baixados ficam em `data/` (gitignored).
2. Os dados do TSE são declaratórios. Ao reportar, trate achados como **indícios**, nunca como prova de fraude. Não acuse pessoas ou empresas; descreva os fatos ("fornecedor X recebeu R$ Y de N candidatos").
3. Respeite as APIs públicas: os scripts já têm cache e rate limit — não os remova.
4. CPFs vêm anonimizados do TSE (`-4`). CNPJs de empresas são dados públicos e podem ser reportados.

## Fluxo padrão

```bash
pip install -r requirements.txt          # 1ª vez
python gastos.py baixar --ano 2026       # baixa zips do TSE para data/raw/2026/
python gastos.py carregar --ano 2026     # extrai e carrega em data/db/gastos.duckdb
python gastos.py candidato --nome "FULANO" --uf XX    # localiza candidatos
python gastos.py analisar --numero 12345 --uf XX --saida relatorios/x.md
python gastos.py sql "SELECT ..."        # consulta livre (sua principal ferramenta)
python gastos.py enriquecer --numero 12345 --uf XX    # consulta CNPJs dos fornecedores na Receita
python gastos.py mudancas                # linhas removidas/alteradas entre extrações
python gastos.py exportar --publicar     # Parquet -> GitHub Release 'dados' (público)
python gastos.py rotina --ano 2026       # pipeline diário completo (baixar+carregar+exportar+publicar)
```

A rotina diária roda agendada em servidor próprio via Docker (`Dockerfile` +
`docs/deploy-coolify.md` — guia genérico, sem citar infra de ninguém); o site é
publicado no Cloudflare Pages (`docs/deploy-cloudflare.md`). Publicação nos
releases exige `GH_TOKEN` (e `GH_REPO` em container) como variáveis de ambiente —
nunca em arquivo versionado.

Durante a campanha (agosto–outubro do ano eleitoral) o TSE atualiza os arquivos diariamente — rode `baixar --forcar` para atualizar.

## Banco (DuckDB em `data/db/gastos.duckdb`)

Tabelas brutas (todas as colunas VARCHAR, nomes originais do TSE):

- `despesas_contratadas` — cada despesa contratada por candidato: candidato (SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF), fornecedor (NR_CPF_CNPJ_FORNECEDOR, NM_FORNECEDOR, NM_FORNECEDOR_RFB, CD/DS_CNAE_FORNECEDOR, tipo PF/PJ, município), despesa (SQ_DESPESA, DT_DESPESA, DS_ORIGEM_DESPESA, DS_DESPESA, VR_DESPESA_CONTRATADA), documento fiscal (DS_TIPO_DOCUMENTO, NR_DOCUMENTO).
- `despesas_pagas` — pagamentos efetivados (VR_PAGTO_DESPESA, fonte do recurso).
- `receitas` — doações: doador (NR_CPF_CNPJ_DOADOR, NM_DOADOR, NM_DOADOR_RFB, CNAE), origem (DS_ORIGEM_RECEITA: Fundo Especial, Fundo Partidário, pessoas físicas, recursos próprios...), espécie (PIX, transferência, estimável), VR_RECEITA, DT_RECEITA.
- `receitas_doador_originario` — quem doou originalmente quando o dinheiro passou por partido/outro candidato (rastreio da origem real).
- `candidatos` — registro de candidaturas (consulta_cand): SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO, NM_URNA_CANDIDATO, cargo, partido, coligação, situação do registro.

Views tipadas (use nas análises — valores `VR` são DOUBLE, datas `DT` são DATE):

- `v_despesas` (de despesas_contratadas), `v_despesas_pagas`, `v_receitas` — mesmas colunas + `VR` e `DT` convertidos.

Histórico de extrações (`src/historico.py`, alimentado automaticamente pelo `carregar`):

- `hist_despesas_contratadas`, `hist_receitas` — uma linha por **conteúdo único** (os arquivos do TSE são por item de nota e têm linhas idênticas legítimas; `qt_linhas` guarda a contagem). `dt_primeira_extracao`/`dt_ultima_extracao` marcam a janela em que o conteúdo esteve declarado.
- `v_removidas_*` — conteúdo que estava declarado e sumiu (red flag forte: declaração apagada/editada).
- `v_alteradas_*` — notas (SQ) com versão antiga e nova (provável edição).
- `SQ_DESPESA`/`SQ_RECEITA` **não são únicos** (repetem por item; `-1` = sem id). Nunca use como chave primária.

Valores originais usam vírgula decimal e datas `DD/MM/AAAA`; as views já convertem.

Tabelas materializadas (`src/agregados.py`, recriadas a cada `carregar`; todas exportadas em Parquet):

- `extracoes` — registro de cada dia de extração já visto (alimenta a série).
- `serie_diaria` — por dia de extração × candidato: total_contratado, total_receitas, itens (reconstruída das janelas do histórico — "como estava declarado naquele dia").
- `benchmark_precos` — distribuição de preços (p25/mediana/p75/p95) por DS_ORIGEM_DESPESA × UF (e `SG_UF='BR-TODAS'` nacional); mínimo 5 notas.
- `indicadores` — scorecard por candidato: totais, razao_gasto_receita, pct_maior_fornecedor, valor_sem_nota, valor_pessoa_fisica, grupos_valor_repetido, valor_removido, fornecedores_recem_abertos.
- `rede` — arestas agregadas candidato↔contraparte (tipos: despesa, doacao, doacao_originaria).
- `fornecedores` — cadastro RFB dos CNPJs (via `cnpj.enriquecer_em_massa`, chamado na rotina com limite diário; completa aos poucos).

## Testes e verificação

- `python -m pytest tests/` — cenários sintéticos do versionamento (removida/alterada/idempotência) + integridade do banco real. Rode após mudar `src/`.
- `python gastos.py verificar` — checagens de integridade (conversão de valores, reconciliação agregados×fonte, janelas coerentes). A `rotina` roda isso automaticamente e **não publica** se falhar.

## Catálogo de red flags (implementadas em `src/analises.py`)

| # | Análise | Sinal |
|---|---------|-------|
| 1 | Resumo financeiro | total receita × contratado × pago; % fundo eleitoral |
| 2 | Concentração de fornecedores | 1 fornecedor com % alto do total do candidato |
| 3 | Fornecedores compartilhados | mesmo fornecedor atendendo vários candidatos (esquema/rateio) |
| 4 | Doador que também é fornecedor | dinheiro que "volta" |
| 5 | CNAE incompatível | ex.: loja de roupas fornecendo carro de som |
| 6 | Fornecedor pessoa física | serviços relevantes prestados por PF |
| 7 | Valores redondos/repetidos | notas fracionadas ou combinadas |
| 8 | Fornecedor que é candidato | negócio entre candidatos |
| 9 | Despesas sem documento fiscal | DS_TIPO_DOCUMENTO vazio/recibo |
| 10 | CNPJ recém-aberto (via `enriquecer`) | empresa criada às vésperas da eleição |

Para análises novas, prefira `gastos.py sql` — e se a consulta for útil de forma recorrente, adicione-a em `src/analises.py`.

## Fontes e detalhes técnicos

- URLs e conteúdo de cada dataset: `docs/fontes-de-dados.md`.
- O CDN do TSE bloqueia clientes HTTP comuns por fingerprint TLS (Akamai). `src/tse.py` usa `curl_cffi` com `impersonate="chrome"` — **não troque por requests/urllib, não funciona**.
- CSVs do TSE: `latin-1`, separador `;`, aspas duplas. `#NULO`/`-1`/`-4` significam nulo/anonimizado.
- Os zips de prestação de contas têm arquivos por UF e um `_BRASIL.csv` consolidado; a carga usa o BRASIL.
- `consulta_cand_{ano}.zip` é nacional com um CSV por UF (não existe zip por UF em 2026).

## Dados públicos (GitHub Releases)

`exportar --publicar` mantém o release `dados` com os Parquet do banco (histórico incluso). Qualquer pessoa consulta sem baixar o repo:

```sql
SELECT * FROM 'https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/despesas.parquet'
WHERE NR_CANDIDATO = '12345'
```

Arquivos: `despesas.parquet`, `receitas.parquet` (com versionamento), `despesas_pagas.parquet`, `receitas_doador_originario.parquet`, `candidatos.parquet`.

## Site público (`site/`)

SPA Vite + React + Tailwind v4. Se existir uma pasta local `trianox-front-standards/`
(referência de padrão visual, fora do git), leia o `00-INDEX.md` dela antes de mexer no front;
sem ela, siga o estilo do código existente (tema único papel/creme, acentos navy, lucide-react,
componentes em `site/src/components/ui`). Páginas: Radar (lê `resumo.json` do release) e Consultar (DuckDB-WASM no
navegador + prompt copiável para a IA pessoal do visitante gerar SQL — `site/src/lib/prompt.ts`;
mantenha esse prompt sincronizado com o schema). Fichas `/candidato/:sq`, `/partido/:sigla` e
`/fornecedor/:id` (id = NR_CPF_CNPJ_FORNECEDOR; linke só ids com `temFichaFornecedor`)
consomem os Parquet agregados (indicadores, serie_diaria, benchmark_precos, rede, fornecedores)
com degradação graciosa se algum ainda não foi publicado. Deploy: Cloudflare Pages
(`docs/deploy-cloudflare.md`). Os dados chegam ao site via Pages Function `/dados/*` que faz
proxy do GitHub Releases (sem CORS lá).

## Alvos do estudo atual

`config/alvos.yaml` (local, fora do git) guarda os candidatos em foco do usuário — leia-o no início da sessão para saber o contexto. Se não existir, copie de `config/alvos.exemplo.yaml` e pergunte ao usuário quem acompanhar. Não cite candidatos específicos na documentação nem em arquivos versionados.
