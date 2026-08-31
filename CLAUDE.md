# Manual de operação (IA)

Este projeto extrai e analisa dados públicos de financiamento de campanha do TSE para identificar indícios de irregularidades. O usuário conversa com você; você opera os scripts e responde com análises.

## Regras

1. **Nunca** grave dados pessoais do usuário no repositório. Dados baixados ficam em `data/` (gitignored).
2. Os dados do TSE são declaratórios. Ao reportar, trate achados como **indícios**, nunca como prova de fraude. Não acuse pessoas ou empresas; descreva os fatos ("fornecedor X recebeu R$ Y de N candidatos").
3. Respeite as APIs públicas: os scripts já têm cache e rate limit — não os remova.
4. A prestação de contas do TSE traz **CPF completo** de doadores/fornecedores PF (a anonimização `-4` vale para outros arquivos). O banco local mantém o CPF cru (necessário para as análises), mas **tudo que é publicado** (Parquet/resumo.json) sai pseudonimizado como `pf-<16 hex>` via `src/privacidade.py` (sal secreto em `RADAR_SAL_CPF` — estável, fora do repo). Nunca exponha CPF cru em relatório/site. CNPJs de empresas são dados públicos e podem ser reportados.

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
python gastos.py rotina --ano 2026       # pipeline diário completo (baixar+carregar+exportar+publicar; só publica se algo mudou desde a última publicação)
```

A rotina diária roda agendada em servidor próprio via Docker (`Dockerfile` +
`docs/deploy-coolify.md` — guia genérico, sem citar infra de ninguém); o site é
publicado no Cloudflare Pages (`docs/deploy-cloudflare.md`). Publicação nos
releases exige `GH_TOKEN`, `RADAR_SAL_CPF` (e `GH_REPO` em container) como
variáveis de ambiente — nunca em arquivo versionado.

Durante a campanha (agosto–outubro do ano eleitoral) o TSE atualiza os arquivos diariamente — rode `baixar --forcar` para atualizar.

## Banco (DuckDB em `data/db/gastos.duckdb`)

Tabelas brutas (todas as colunas VARCHAR, nomes originais do TSE):

- `despesas_contratadas` — cada despesa contratada por candidato: candidato (SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF), fornecedor (NR_CPF_CNPJ_FORNECEDOR, NM_FORNECEDOR, NM_FORNECEDOR_RFB, CD/DS_CNAE_FORNECEDOR, tipo PF/PJ, município), despesa (SQ_DESPESA, DT_DESPESA, DS_ORIGEM_DESPESA, DS_DESPESA, VR_DESPESA_CONTRATADA), documento fiscal (DS_TIPO_DOCUMENTO, NR_DOCUMENTO).
- `despesas_pagas` — pagamentos efetivados (VR_PAGTO_DESPESA, fonte do recurso).
- `receitas` — doações: doador (NR_CPF_CNPJ_DOADOR, NM_DOADOR, NM_DOADOR_RFB, CNAE), fonte (DS_FONTE_RECEITA: FUNDO ESPECIAL / FUNDO PARTIDARIO / OUTROS RECURSOS — **dinheiro público se mede aqui**, não na origem), origem (DS_ORIGEM_RECEITA: recursos de partido político, pessoas físicas, recursos próprios...), espécie (PIX, transferência, estimável), VR_RECEITA, DT_RECEITA.
- `receitas_doador_originario` — quem doou originalmente quando o dinheiro passou por partido/outro candidato (rastreio da origem real).
- `candidatos` — registro de candidaturas (consulta_cand): SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO, NM_URNA_CANDIDATO, cargo, partido, coligação, situação do registro.
- `bens` — patrimônio declarado no registro (bem_candidato): SQ_CANDIDATO, DS_TIPO_BEM_CANDIDATO, DS_BEM_CANDIDATO, VR_BEM_CANDIDATO.

Views tipadas (use nas análises — valores `VR` são DOUBLE, datas `DT` são DATE):

- `v_despesas` (de despesas_contratadas), `v_despesas_pagas`, `v_receitas`, `v_bens` — mesmas colunas + `VR` e `DT` convertidos.

Histórico de extrações (`src/historico.py`, alimentado automaticamente pelo `carregar`):

- `hist_despesas_contratadas`, `hist_receitas` — uma linha por **conteúdo único** (os arquivos do TSE são por item de nota e têm linhas idênticas legítimas; `qt_linhas` guarda a contagem). `dt_primeira_extracao`/`dt_ultima_extracao` marcam a janela em que o conteúdo esteve declarado.
- `v_removidas_*` — conteúdo que estava declarado, sumiu e **não voltou de outra forma** (red flag forte: declaração apagada).
- `v_alteradas_*` — a versão morta E a viva de uma declaração corrigida (linhas soltas).
- `v_alteradas_pares_*` — o antes/depois pronto: **uma linha por declaração morta**, com `campo_alterado` (descricao/valor/data) e `sucessores`. Quando mais de uma declaração viva serve de sucessora (24% dos casos), o pareamento é ambíguo: o representante é determinístico (valor mais próximo, desempate por hash) e `sucessores` diz quantas eram — o site mostra "1 de N possíveis" em vez de eleger uma. Sem isso o JOIN devolvia N×M combinações (uma nota corrigida virava 12 linhas na tela). É o que alimenta `despesas_alteradas.parquet`/`receitas_alteradas.parquet` e a seção "Declarações corrigidas" das fichas — **sem derivação de fallback no site**: parear é a mesma régua que decide o que não é remoção, e uma terceira cópia dela seria a divergência silenciosa de sempre. Sem o parquet, a seção não aparece.
- As duas são **mutuamente exclusivas por construção** (`v_removidas` exclui o que está em `v_alteradas`): uma retificação nunca pode aparecer no site como declaração apagada. A régua está em `historico.ESSENCIA`, que se divide em `IDENTIDADE` (candidato ↔ contraparte — mudou aqui, é outro fato) e `VARIAVEIS` (descrição, valor, data — o que uma retificadora mexe): mesma identidade com **3 de 3** variáveis iguais é retransmissão, com **2 de 3** é edição, e só o resto é remoção. O erro residual é assimétrico de propósito — errar para "editada" enfraquece um indício, errar para "removida" afirma que alguém apagou declaração.
- `SQ_DESPESA`/`SQ_RECEITA` **não são únicos nem estáveis** (repetem por item; `-1` = sem id; o SPCE os **regenera a cada retransmissão** — nos dados publicados, 10.112 notas já trocaram de SQ e 3.489 SQ apontam para mais de uma nota). Nunca use como chave primária nem para parear versões.

Valores originais usam vírgula decimal e datas `DD/MM/AAAA`; as views já convertem.

Tabelas materializadas (`src/agregados.py`, recriadas a cada `carregar`; todas exportadas em Parquet):

- `extracoes` — registro de cada dia de extração já visto (alimenta a série).
- `serie_diaria` — por dia de extração × candidato: total_contratado, total_receitas, itens (reconstruída das janelas do histórico — "como estava declarado naquele dia"); metadados do candidato vêm de despesas OU receitas.
- `benchmark_precos` — distribuição de preços (p25/mediana/p75/p95) **por nota** (soma dos itens de mesma SQ_DESPESA; `-1` conta linha a linha) por DS_ORIGEM_DESPESA × UF (e `SG_UF='BR-TODAS'` nacional); mínimo 5 notas.
- `indicadores` — scorecard por candidato (base: quem tem despesa OU receita): totais, total_pago/pct_pago, razao_gasto_receita, fundos_publicos/pct_fundos_publicos (por DS_FONTE_RECEITA), recursos_proprios, total_bens, pct_maior_fornecedor, fornecedores_cnpj/fornecedores_consultados (cobertura do enriquecimento), valor_sem_nota/pct_sem_nota, valor_pessoa_fisica/pct_pessoa_fisica, grupos_valor_repetido (3+ notas de mesmo valor **no mesmo fornecedor**), valor_removido, fornecedores_recem_abertos (abertura >= out do ano anterior à eleição, derivado dos dados).
- `benchmark_indicadores` — distribuição de cada métrica de `indicadores` por grupo de comparação DS_CARGO × SG_UF (e 'BR-TODAS'); mínimo 20 candidatos. Alimenta o "fora da curva" (sinal = acima do p95 do grupo; a razão gasto÷arrecadado só é sinal acima de `MARGEM_GASTO_ACIMA` = 1,1× — estourar por poucos por cento é descompasso de calendário) do site e do `resumo.json`.
- `norma_documento` — por DS_ORIGEM_DESPESA: quanto do valor é declarado com documento fiscal (só entre fornecedores PJ) e `exige_documento` (a categoria tem nota como norma). É a régua do indicador `valor_sem_nota`: sem ela, marcar "sem nota" pegava metade do dinheiro do país, porque em impulsionamento/honorários/militância quase ninguém emite nota. Categoria com menos de 30 linhas cai na lista fixa de `analises.py` (que é sempre o piso).
- `benchmark_categorias` — distribuição do TOTAL gasto por candidato em cada DS_ORIGEM_DESPESA, por grupo cargo×UF (e 'BR-TODAS'); só entre quem gasta na categoria, mínimo 20. Alimenta o "fora da curva por tipo de gasto" do Explorar (`?visao=fora-da-curva&categoria=`).
- `rede` — arestas agregadas candidato↔contraparte (tipos: despesa, doacao, doacao_originaria).
- `fornecedores` — cadastro RFB dos CNPJs (via `cnpj.enriquecer_em_massa`, chamado na rotina com limite diário). Pendentes novos primeiro (maiores valores); a folga do limite reconsulta os cadastros mais antigos (`dt_consulta`, vencidos há 30+ dias, ciclo de ~30 dias pela base). Mudança de situação cadastral preserva `situacao_anterior`/`dt_situacao_anterior` (base da futura red flag "baixado após receber"). CNPJ 404 vira cache negativo + linha 'NAO ENCONTRADO NA BASE PUBLICA' (reconsultado só no ciclo, como os demais).

## Testes e verificação

- `python -m pytest tests/` — cenários sintéticos do versionamento (removida/alterada/idempotência) + integridade do banco real + **sincronia backend↔site** (`test_sincronia_site.py` lê `site/src/lib/consultas.ts`/`duckdb.ts` e falha se as regras espelhadas divergirem do Python) + **consultas prontas do console** (`test_consultas_do_site.py` executa cada SQL de `site/src/lib/exemplos.ts` contra o banco real, com as views que o release publica; exige que devolvam linhas, salvo os monitores declarados). Rode após mudar `src/` OU as regras/consultas do site.
- `npm test` (em `site/`) — vitest em duas frentes, num comando só (ambiente jsdom global, setup em `site/src/test/setup.ts`): **funções puras** — construtores de SQL (`lib/consultas.ts`), detecção de gráfico (`lib/grafico-auto.ts`), formatação/mascaramento (`lib/format.ts`) — e **renderização das páginas** com @testing-library/react (`src/pages/*.test.tsx`), cobrindo os estados condicionais: lápide de CNPJ não encontrado (ficha do fornecedor e tabela do candidato, com a coluna oculta `_situacao` que nunca pode ser renderizada), seção de declarações removidas que some sem remoção e cartões da Home, colunas da visão "Quem mais gastou" do Explorar. As páginas são isoladas do DuckDB-WASM pelo dublê `src/test/duckdb-falso.ts` (`vi.mock('@/lib/duckdb', …)`, respostas por trecho do SQL) e da Home pelo mock de `lib/resumo`; o grafo de conexões (canvas) é substituído por um stub. Rode após mudar `site/src/lib/` ou `site/src/pages/`.
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
| 7 | Valores redondos/repetidos | notas fracionadas (indicador exige mesmo fornecedor + 3 notas distintas) |
| 8 | Fornecedor que é candidato | negócio entre candidatos |
| 9 | Despesas sem documento fiscal | documento não fiscal (nem nota nem cupom) + fornecedor PJ + categoria em que a nota é a norma (`norma_documento`); a lista fixa de categorias sem NF esperada é o piso |
| 10 | CNPJ recém-aberto (via `enriquecer`) | empresa criada às vésperas da eleição (reportar sempre com a cobertura: fornecedores_consultados/fornecedores_cnpj) |
| 11 | Fora da curva do grupo | métrica acima do p95 dos candidatos ao mesmo cargo na mesma UF (`benchmark_indicadores`) |
| 12 | Nota fiscal sem número | documento fiscal cujo `NR_DOCUMENTO` não tem um dígito (ex.: 'SN') — nota afirmada e não localizável |
| 13 | Mesmo nº de nota em candidatos diferentes | mesmo fornecedor declarando o mesmo `NR_DOCUMENTO` (3+ dígitos) para 2+ candidatos — nota reaproveitada ou erro |

Para análises novas, prefira `gastos.py sql` — e se a consulta for útil de forma recorrente, adicione-a em `src/analises.py`.

## Fontes e detalhes técnicos

- URLs e conteúdo de cada dataset: `docs/fontes-de-dados.md`.
- O CDN do TSE bloqueia clientes HTTP comuns por fingerprint TLS (Akamai). `src/tse.py` usa `curl_cffi` com `impersonate="chrome"` — **não troque por requests/urllib, não funciona**.
- CSVs do TSE: `latin-1`, separador `;`, aspas duplas. `#NULO`/`-1`/`-4` significam nulo/anonimizado.
- O SPCE emite **linhas-placeholder** (contraparte `-1`/`#NULO` **e** valor zero = prestação sem movimento). Não são fatos: `carga.filtro_placeholder` as exclui das views tipadas, das `v_removidas_*`, da série e dos atalhos do site. Contraparte anônima **com** valor é fato (e indício) — nunca filtrar.
- Os zips de prestação de contas têm arquivos por UF e um `_BRASIL.csv` consolidado; a carga usa o BRASIL.
- `consulta_cand_{ano}.zip` é nacional com um CSV por UF (não existe zip por UF em 2026).

## Dados públicos (GitHub Releases)

`exportar --publicar` mantém o release `dados` com os Parquet do banco (histórico incluso). Qualquer pessoa consulta sem baixar o repo:

```sql
SELECT * FROM 'https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/despesas.parquet'
WHERE NR_CANDIDATO = '12345'
```

Arquivos: `despesas.parquet`, `receitas.parquet` (com versionamento), `despesas_atual.parquet`, `receitas_atual.parquet` (só a extração mais recente, sem placeholders e com a coluna `valor` pronta — o site prefere estes e cai para o histórico se faltarem), `despesas_removidas.parquet`, `receitas_removidas.parquet` (resultado pronto das `v_removidas_*`, mesma lógica de preferência), `despesas_alteradas.parquet`, `receitas_alteradas.parquet` (antes/depois pronto das `v_alteradas_pares_*`), `despesas_pagas.parquet`, `receitas_doador_originario.parquet`, `candidatos.parquet` (sem CPF/e-mail/título), `bens.parquet`, `norma_documento.parquet`. CPFs saem pseudonimizados (`pf-…`); o `resumo.json` leva `arquivos` (md5 por parquet — cache-buster por arquivo do site) e a publicação só sobe o que mudou.

## Site público (`site/`)

SPA Vite + React + Tailwind v4. Se existir uma pasta local de padrão visual
(referência interna, fora do git — o nome está em `.git/info/exclude`), leia o
`00-INDEX.md` dela antes de mexer no front; sem ela, siga o estilo do código
existente (tema único papel/creme, acentos navy, lucide-react, componentes em
`site/src/components/ui`). Páginas: Radar (lê `resumo.json` do release —
inclui `serie_nacional` para os sparklines dos cartões; a Home NÃO carrega DuckDB-WASM),
Explorar (visões prontas via `?visao=` — fora-da-curva (com `&sinal=` para filtrar a métrica; sem
categoria vira lista de cards com foto e chips), removidas, removidas-receitas, compartilhados,
sem-nota, pessoa-fisica — combináveis com os filtros; mapa de tiles por UF clicável) e Consultar
(DuckDB-WASM no navegador + prompt copiável para a IA pessoal do visitante gerar SQL —
`site/src/lib/prompt.ts`; mantenha esse prompt sincronizado com o schema). Fichas
`/candidato/:sq` (composição da receita, sankey do fluxo, beeswarm do grupo, grafo de conexões,
cartão de compartilhamento em PNG via `lib/cartao.ts`), `/partido/:sigla` e `/fornecedor/:id`
(id = NR_CPF_CNPJ_FORNECEDOR; linke só ids com `temFichaFornecedor`) consomem os Parquet
agregados (indicadores, serie_diaria, benchmark_precos, rede, fornecedores) com degradação
graciosa se algum ainda não foi publicado.

As red flags **por nota** (7, 12 e 13) são marcas nas fichas, não páginas: a linha
de fornecedor da ficha do candidato abre e mostra as notas que ela esconde
(`sqlNotasDoCandidato`), e as flags 12/13 viram chip no cabeçalho da ficha do
fornecedor — numeração de nota é sequencial por emitente, então "mesmo número em
2+ candidatos" é fato DO fornecedor, e a tabela dele mostra só as 50 maiores.
Não há rota `/despesa/:id`: 88% dos pares candidato×fornecedor têm uma única
nota, então a página seria uma repetição da linha — e `SQ_DESPESA` não serve de
chave (o SPCE regenera).

Regras espelhadas do backend vivem centralizadas em `site/src/lib/consultas.ts`
(categorias sem NF ↔ `src/analises.py`; SINAIS_CTE/SINAIS_FILTRO ↔ `METRICAS_SINAL` em
`src/resumo.py`; CONDICAO_NOTA_SEM_NUMERO/CONDICAO_DOCUMENTO_NUMERADO ↔ as análises 12 e
13 de `src/analises.py`; MINIMO_NOTAS_VALOR_REPETIDO ↔ `rep` em `src/agregados.py`;
SITUACAO_NAO_ENCONTRADA ↔ `SITUACAO_NAO_ENCONTRADO` em `src/cnpj.py` —
a lápide de CNPJ que a Receita respondeu 404, que vira aviso na ficha do fornecedor e
marca a linha na tabela de fornecedores do candidato) e `site/src/lib/duckdb.ts` (views `despesas_atual`/`receitas_atual`/
`despesas_removidas`/`receitas_removidas` ↔ `src/carga.py`/`src/historico.py`);
`tests/test_sincronia_site.py` cobre essa sincronia — remoções NUNCA se calculam "na unha"
nas páginas, sempre pelas views. Componentes de visualização: `components/app/graficos.tsx`
(barras, linhas, faixas/beeswarm, sparkline, composição), `sankey.tsx` (rótulos com
anti-colisão + linhas-guia), `grafo.tsx` (layout de força via d3-force, estático e
determinístico; aceita `secundarios` para o 2º nível de conexões), `mapa.tsx`;
blocos colapsáveis via `components/app/recolhivel.tsx` (SecaoRecolhivel — com muitos
gráficos por página, declare `aberta` só no que é essencial) e zoom via
`components/app/ampliavel.tsx` (Ampliavel — re-renderiza o gráfico num `<dialog>` de
~96vw; envolva qualquer SVG responsivo denso). Deploy: Cloudflare Pages
(`docs/deploy-cloudflare.md`). Os dados chegam ao site via Pages Function `/dados/*` que faz
proxy do GitHub Releases (sem CORS lá).

## Alvos do estudo atual

`config/alvos.yaml` (local, fora do git) guarda os candidatos em foco do usuário — leia-o no início da sessão para saber o contexto. Se não existir, copie de `config/alvos.exemplo.yaml` e pergunte ao usuário quem acompanhar. Não cite candidatos específicos na documentação nem em arquivos versionados.
