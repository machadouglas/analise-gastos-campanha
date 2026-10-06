# Manual de operação (IA)

Este projeto extrai e analisa dados públicos de financiamento de campanha do TSE para identificar indícios de irregularidades. O usuário conversa com você; você opera os scripts e responde com análises.

## Regras

1. **Nunca** grave dados pessoais do usuário no repositório. Dados baixados ficam em `data/` (gitignored).
2. Os dados do TSE são declaratórios. Ao reportar, trate achados como **indícios**, nunca como prova de fraude. Não acuse pessoas ou empresas; descreva os fatos ("fornecedor X recebeu R$ Y de N candidatos").
3. Respeite as APIs públicas: os scripts já têm cache e rate limit — não os remova.
4. A prestação de contas do TSE traz **CPF completo** de doadores/fornecedores PF (a anonimização `-4` vale para outros arquivos). O banco local mantém o CPF cru (necessário para as análises), mas **tudo que é publicado** (Parquet/resumo.json) sai pseudonimizado como `pf-<16 hex>` via `src/privacidade.py` (sal secreto em `RADAR_SAL_CPF` — estável, fora do repo). O TSE também grava CPF nas colunas de **número de documento** (`NR_DOCUMENTO`, `NR_DOCUMENTO_DOACAO`) e às vezes no campo de **nome** — por isso a pseudonimização cobre qualquer valor de exatamente 11 dígitos nessas colunas também, e o `hash_linha` publicado vira código salgado `h-…` (o md5 cru permitiria confirmar um CPF conhecido). Nunca exponha CPF cru em relatório/site. CNPJs de empresas são dados públicos e podem ser reportados.

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
python gastos.py rotina --ano 2026       # pipeline diário completo (baixar+carregar+exportar+publicar; só publica se algo mudou — dado do TSE OU código do pipeline, via stamp_codigo no fingerprint)
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

Votos (`carga.carregar_votos`, do conjunto `votacao` = `votacao_candidato_munzona_{ano}.zip`) — a única tabela de origem TSE que **não** é bruta nem VARCHAR:

- `votos` — uma linha por `SQ_CANDIDATO`: `votos_1t`/`votos_2t` (QT_VOTOS_NOMINAIS somado de todos os municípios e zonas; `votos_2t` NULL para quem não foi ao 2º turno), `votos_validos_1t`/`votos_validos_2t` (QT_VOTOS_NOMINAIS_VALIDOS — candidatura indeferida tem nominais e zero válidos) e `resultado` (DS_SIT_TOT_TURNO do último turno disputado). O arquivo do TSE é por candidato × município × zona: o zip de uma eleição geral passa de 600 MB e o consolidado `_BRASIL` de 4 GB — por isso ele fica fora do `extrair_zips`, é lido de dentro do zip, agregado e apagado. Até a totalização o TSE publica o zip **só com o cabeçalho**: a tabela existe vazia e `verificar` avisa (não barra). Zip quebrado não derruba a carga da prestação — a tabela anterior é mantida e o log diz `[erro] votos`.

Views tipadas (use nas análises — valores `VR` são DOUBLE, datas `DT` são DATE):

- `v_despesas` (de despesas_contratadas), `v_despesas_pagas`, `v_receitas`, `v_bens` — mesmas colunas + `VR` e `DT` convertidos.
- `v_prestadores` — uma linha por `SQ_PRESTADOR_CONTAS` (candidato, número, nome, partido, cargo, UF colapsados com MIN, de despesas ∪ receitas). É o que dá candidato a `v_despesas_pagas` (o arquivo de pagas não traz SQ_CANDIDATO); `verificar` aborta se um prestador apontar para dois candidatos.
- `publicacoes` (`src/exportar.py`) — uma linha só: fingerprint e md5 por arquivo da última publicação; é o que faz a `rotina` publicar apenas o que mudou.

Histórico de extrações (`src/historico.py`, alimentado automaticamente pelo `carregar`):

- `hist_despesas_contratadas`, `hist_receitas` — uma linha por **conteúdo único** (os arquivos do TSE são por item de nota e têm linhas idênticas legítimas; `qt_linhas` guarda a contagem). `dt_primeira_extracao`/`dt_ultima_extracao` marcam a janela em que o conteúdo esteve declarado. Conteúdo que some e **volta** ganha janela nova (o dia de ausência é preservado — reabrir a janela reescreveria a série de dias já publicados). Limitação conhecida: queda de `qt_linhas` (uma cópia idêntica apagada) mata a linha antiga e cria a nova, mas é invisível às views de mudança — o hash continua vivo.
- `v_removidas_*` — conteúdo que estava declarado, sumiu e **não voltou de outra forma** (red flag forte: declaração apagada).
- `v_alteradas_*` — a versão morta E a viva de uma declaração corrigida (linhas soltas).
- `v_alteradas_pares_*` — o antes/depois pronto: **uma linha por declaração morta**, com `campo_alterado` (descricao/valor/data) e `sucessores`. Quando mais de uma declaração viva serve de sucessora (24% dos casos), o pareamento é ambíguo: o representante é determinístico (valor mais próximo, desempate por hash) e `sucessores` diz quantas eram — o site mostra "1 de N possíveis" em vez de eleger uma. Sem isso o JOIN devolvia N×M combinações (uma nota corrigida virava 12 linhas na tela). É o que alimenta `despesas_alteradas.parquet`/`receitas_alteradas.parquet` e a seção "Declarações corrigidas" das fichas — **sem derivação de fallback no site**: parear é a mesma régua que decide o que não é remoção, e uma terceira cópia dela seria a divergência silenciosa de sempre. Sem o parquet, a seção não aparece.
- As duas são **mutuamente exclusivas por construção** (`v_removidas` exclui o que está em `v_alteradas`): uma retificação nunca pode aparecer no site como declaração apagada. A régua está em `historico.ESSENCIA`, que se divide em `IDENTIDADE` (candidato ↔ contraparte — mudou aqui, é outro fato) e `VARIAVEIS` (descrição, valor, data — o que uma retificadora mexe): mesma identidade com **3 de 3** variáveis iguais é retransmissão, com **2 de 3** é edição, e só o resto é remoção. Toda a comparação usa `IS NOT DISTINCT FROM` (nunca `=`): campo NULL precisa casar, senão retransmissão com data vazia viraria falsa remoção — 21% das linhas reais têm `DT_DESPESA` nula. O erro residual é assimétrico de propósito — errar para "editada" enfraquece um indício, errar para "removida" afirma que alguém apagou declaração.
- `SQ_DESPESA`/`SQ_RECEITA` **não são únicos nem estáveis** (repetem por item; `-1` = sem id; o SPCE os **regenera a cada retransmissão** — nos dados publicados, 10.112 notas já trocaram de SQ e 3.489 SQ apontam para mais de uma nota). Nunca use como chave primária nem para parear versões.

Valores originais usam vírgula decimal e datas `DD/MM/AAAA`; as views já convertem.

Tabelas materializadas (`src/agregados.py`, recriadas a cada `carregar` e exportadas em Parquet — exceções marcadas):

- `extracoes` (`src/historico.py`, alimentada pelo `versionar`; **não é exportada** — `scripts/previa-local.py` a reconstrói das janelas do histórico) — registro de cada dia de extração já visto (alimenta a série).
- `serie_diaria` — por dia de extração × candidato: total_contratado, total_receitas, itens_despesa (reconstruída das janelas do histórico — "como estava declarado naquele dia"); metadados do candidato vêm de despesas OU receitas.
- `benchmark_precos` — distribuição de preços (p25/mediana/p75/p95) **por nota** (soma dos itens de mesma SQ_DESPESA; `-1` conta linha a linha) por DS_ORIGEM_DESPESA × UF (e `SG_UF='BR-TODAS'` nacional); mínimo 5 notas.
- `indicadores` — scorecard por candidato (base: quem tem despesa OU receita): `NM_URNA_CANDIDATO` (do registro; NULL sem o parquet/coluna — é o nome principal do site), totais, total_pago/pct_pago, razao_gasto_receita, fundos_publicos/pct_fundos_publicos (por DS_FONTE_RECEITA), recursos_proprios, total_bens, pct_maior_fornecedor, fornecedores_cnpj/fornecedores_consultados (cobertura do enriquecimento), valor_sem_nota/pct_sem_nota, valor_pessoa_fisica/pct_pessoa_fisica, grupos_valor_repetido (3+ notas de mesmo valor **no mesmo fornecedor**), valor_removido, fornecedores_recem_abertos (abertura >= out do ano anterior à eleição, derivado dos dados), e o **custo por voto**: `votos` (= `votos_1t`), `votos_2t`, `resultado`, `custo_por_voto` (total_contratado ÷ votos), `custo_publico_por_voto`, `custo_proprio_por_voto` e `custo_terceiros_por_voto` (o custo por voto **repartido na proporção da receita** — fundos públicos por fonte, recursos próprios por origem, o resto é terceiros; as três somam o custo e `verificar` confere). O denominador é sempre o **1º turno** — o único que todo candidato disputou; o gasto do 2º turno entra no numerador de quem foi a ele, e o texto que citar o número tem de dizer isso. A repartição assume dinheiro **fungível** (não há como saber qual real pagou qual nota); a versão anterior dividia a receita pelos votos e dava "público por voto" maior que o custo total em quem arrecadou mais do que gastou — certo e ilegível (05/10/2026). NULL sem receita declarada (composição desconhecida). Guardados com **4 casas**: com 2, R$ 1 declarado ÷ 2.280 votos virava "R$ 0,00" — quem exibe arredonda (`custoVoto()` em `format.ts` mostra "< R$ 0,01"). Não há ranking de "voto mais barato" (site nem MCP): R$ 1 declarado ÷ milhares de votos não diz nada, e R$ 0 contratado com receita declarada é despesa ainda não lançada. NULL sem totalização, sem o candidato no arquivo de votação (não chegou à urna) ou com zero voto. A eleição **presidencial** não está no consolidado `_BRASIL`: vem no membro `_BR` do mesmo zip (que o TSE publica vazio até totalizar o país — em 05/10/2026 as demais já estavam totalizadas e ele não), e `carregar_votos` o lê sempre, só para quem o consolidado não tem; `verificar` avisa enquanto nenhum presidenciável tem voto. `resumo.votacao` registra o estado (`totalizada`, `presidencial_totalizada`, candidatos com voto e no 2º turno).
- `benchmark_indicadores` — distribuição de cada métrica de `indicadores` por grupo de comparação DS_CARGO × SG_UF (e 'BR-TODAS'); mínimo 20 candidatos (inclui `custo_por_voto` e `votos`, só entre quem tem voto — a régua da ferramenta `custo_por_voto` do MCP; a ficha do site calcula a faixa direto de `indicadores`). Alimenta o "fora da curva" (sinal = acima do p95 do grupo; a razão gasto÷arrecadado só é sinal acima de `MARGEM_GASTO_ACIMA` = 1,1× — estourar por poucos por cento é descompasso de calendário) do site e do `resumo.json`.
- `norma_documento` — por DS_ORIGEM_DESPESA: quanto do valor é declarado com documento fiscal (só entre fornecedores PJ) e `exige_documento` (a categoria tem nota como norma). É a régua do indicador `valor_sem_nota`: sem ela, marcar "sem nota" pegava metade do dinheiro do país, porque em impulsionamento/honorários/militância quase ninguém emite nota. Categoria com menos de 30 notas (itens agrupados por SQ_DESPESA; `-1` conta linha a linha) cai na lista fixa de `analises.py` (que é sempre o piso).
- `benchmark_categorias` — distribuição do TOTAL gasto por candidato em cada DS_ORIGEM_DESPESA, por grupo cargo×UF (e 'BR-TODAS'); só entre quem gasta na categoria, mínimo 20. Alimenta o "fora da curva por tipo de gasto" do Explorar (`?visao=fora-da-curva&categoria=`).
- `cota_fefc` — Fundo Especial que **chegou a candidato**, por partido × cargo × gênero × cor/raça (`genero`/`cor_raca` normalizados em MAIÚSCULAS — a prestação vem 'Feminino', o registro 'FEMININO'): `candidatos_fefc`, `fefc`, e `candidaturas` (registros do consulta_cand no mesmo recorte, inclusive quem não recebeu nada; NULL quando o recorte não existe no registro). Réguas legais: mínimo de 30% do FEFC para mulheres (EC 117/2022) e proporcionalidade às candidaturas negras — `COR_RACA_NEGRA` = pretas + pardas (Res. TSE 23.607, art. 17). Alimenta a ficha `/partido/:sigla` e `resumo.cota_fefc`. **É termômetro, não a conta oficial**: a lei mede o total aplicado pelo partido (inclui gasto direto do diretório) e a prestação está aberta — a Metodologia diz isso, e todo texto que citar o número tem de dizer também.
- `rede` — arestas agregadas candidato↔contraparte (tipos: despesa, doacao, doacao_originaria).
- `fornecedores` — cadastro RFB dos CNPJs (**persistente e incremental**, nunca recriada: via `cnpj.enriquecer_em_massa`, chamado na rotina com limite diário — o subcomando `enriquecer` só imprime uma tabela, não grava aqui). Pendentes novos primeiro (maiores valores); a folga do limite reconsulta os cadastros mais antigos (`dt_consulta`, vencidos há 30+ dias, ciclo de ~30 dias pela base). Mudança de situação cadastral preserva `situacao_anterior`/`dt_situacao_anterior` (base da futura red flag "baixado após receber"). CNPJ 404 vira cache negativo + linha 'NAO ENCONTRADO NA BASE PUBLICA' (reconsultado só no ciclo, como os demais).

## Testes e verificação

- `python -m pytest tests/` — cenários sintéticos do versionamento (removida/alterada/idempotência) + integridade do banco real + **E2E do pipeline** (`test_e2e_pipeline.py`: zip com CSV no formato do TSE → `carregar` → `versionar` → agregados → `verificar` → `exportar` → as consultas do console rodam sobre os parquets **pseudonimizados** — as duas emendas que nenhuma outra suíte cobre: o parse real do CSV e o consumo do dado mascarado) + **sincronia backend↔site** (`test_sincronia_site.py` lê `site/src/lib/consultas.ts`/`duckdb.ts` e falha se as regras espelhadas divergirem do Python) + **consultas prontas do console** (`test_consultas_do_site.py` executa cada SQL de `site/src/lib/exemplos.ts` contra o banco real, com as views que o release publica; exige que devolvam linhas, salvo os monitores declarados). Rode após mudar `src/` OU as regras/consultas do site.
- `npm test` (em `site/`) — vitest em duas frentes, num comando só (ambiente jsdom global, setup em `site/src/test/setup.ts`): **funções puras** — construtores de SQL (`lib/consultas.ts`), detecção de gráfico (`lib/grafico-auto.ts`), formatação/mascaramento (`lib/format.ts`) — e **renderização das páginas** com @testing-library/react (`src/pages/*.test.tsx`), cobrindo os estados condicionais: lápide de CNPJ não encontrado (ficha do fornecedor e tabela do candidato, com a coluna oculta `_situacao` que nunca pode ser renderizada), seção de declarações removidas que some sem remoção e cartões da Home, colunas da visão "Quem mais gastou" do Explorar. As páginas são isoladas da camada de dados pelo dublê `src/test/duckdb-falso.ts` (`vi.mock('@/lib/dados', …)` nas fichas/Explorar, `vi.mock('@/lib/duckdb', …)` no console; respostas por trecho do SQL) e da Home pelo mock de `lib/resumo`; o grafo de conexões (canvas) é substituído por um stub. `lib/dados.test.ts` cobre a escada API → WASM (5xx/rede/timeout caem e grudam; 400 propaga; sem `VITE_RADAR_API` é só WASM). Rode após mudar `site/src/lib/` ou `site/src/pages/`.
- `python gastos.py verificar` — checagens de integridade (conversão de valores, datas dentro do ciclo eleitoral em despesas E receitas, reconciliação agregados×fonte, janelas coerentes, decomposição das linhas mortas). A `rotina` roda isso automaticamente e **não publica** se falhar. Há também **avisos** (`[verificacao] aviso`), que nunca barram: data posterior à própria extração (150 despesas e 32 receitas em 03/09/2026, uma em 24/11) é erro de quem declarou, e o dado é publicado como veio — barrar a série inteira por um typo alheio seria pior. Pela mesma régua, data **fora do ciclo** só barra em MASSA (acima de `LIMITE_DATAS_FORA_DO_CICLO_PCT` = 0,5% das datas preenchidas, que é parse quebrado — a coluna inteira sai junto); linha solta ('10/08/2016') vira aviso com a data à mostra, depois de 1 linha em 104.878 ter barrado a rotina de 09/09/2026. Idem para **valor que não converte em número**: só barra acima de `LIMITE_VALORES_INVALIDOS_PCT` = 0,5% (separador trocado, coluna deslocada); linha solta vira aviso com o texto cru (`repr`) à mostra e vai publicada com `VR` nulo, fora das somas. O caso que barrou a rotina de 29/09/2026 (1 receita em 137.728) era `'##############'`: o próprio TSE grava esse marcador quando o valor não cabe no formato de saída do arquivo — o valor real não está no CSV, não há parse a corrigir do nosso lado, e ele é maior que qualquer valor legível da base (o maior tem 11 caracteres, o marcador 14). Nulo é a saída certa: se entrasse, seria o maior valor do país e distorceria as somas.
- `python scripts/previa-local.py` — monta um banco a partir dos **Parquet já publicados**, roda o pipeline do código atual por cima (views + agregados + `verificar` + export) e entrega em `site/public/dados/`. É o único jeito de ver o efeito de uma mudança na base inteira antes de subir — bug de volume e de dado sujo não aparece em fixture. Também é o caminho curto para quem só quer mexer no site: dispensa `baixar` (200+ MB) e `carregar`. Sobrescreve `site/public/dados/` (gitignorado); `RADAR_SAL_CPF` pode ser qualquer valor, porque os CPFs publicados já vêm `pf-…` e a pseudonimização é idempotente sobre eles.

## Catálogo de red flags (implementadas em `src/analises.py`)

| # | Análise | Sinal |
|---|---------|-------|
| 1 | Resumo financeiro | total receita × contratado × pago; % fundo eleitoral |
| 2 | Concentração de fornecedores | 1 fornecedor com % alto do total do candidato |
| 3 | Fornecedores compartilhados | mesmo fornecedor atendendo vários candidatos (esquema/rateio) |
| 4 | Doador que também é fornecedor | dinheiro que "volta" — **exclui** o repasse de plataforma de financiamento coletivo (`ORIGEM_FINANCIAMENTO_COLETIVO`): a vaquinha doa o que arrecadou e cobra a taxa do mesmo candidato, por construção; sem a exclusão, 22 das 25 maiores ocorrências eram plataforma |
| 5 | CNAE incompatível | ex.: loja de roupas fornecendo carro de som |
| 6 | Fornecedor pessoa física | serviços relevantes prestados por PF |
| 7 | Valores redondos/repetidos | notas fracionadas (indicador exige mesmo fornecedor + 3 notas distintas) |
| 8 | Fornecedor que é candidato | negócio entre candidatos |
| 9 | Despesas sem documento fiscal | documento não fiscal (nem nota nem cupom) + fornecedor PJ + categoria em que a nota é a norma (`norma_documento`); a lista fixa de categorias sem NF esperada é o piso |
| 10 | CNPJ recém-aberto (indicador `fornecedores_recem_abertos`, alimentado pela tabela `fornecedores` que só a `rotina` preenche) | empresa criada às vésperas da eleição (reportar sempre com a cobertura: fornecedores_consultados/fornecedores_cnpj) |
| 11 | Fora da curva do grupo | métrica acima do p95 dos candidatos ao mesmo cargo na mesma UF (`benchmark_indicadores`) |
| 12 | Nota fiscal sem número | documento fiscal cujo `NR_DOCUMENTO` não tem um dígito (ex.: 'SN') — nota afirmada e não localizável |
| 13 | Mesmo nº de nota em candidatos diferentes | mesmo fornecedor declarando o mesmo `NR_DOCUMENTO` (3+ dígitos) para 2+ candidatos — nota reaproveitada ou erro. **Exclui** impulsionamento (`CATEGORIA_IMPULSIONAMENTO`): a plataforma não emite nota sequencial e o número é digitado à mão ('001', '12345') — 16 dos 17 pares eram isso |
| 14 | Fundo Eleitoral × gênero e cor/raça (`cota_fefc`) | partido cuja fatia do FEFC que chegou a candidatas está abaixo de 30%, ou cuja fatia para candidaturas negras está abaixo da proporção delas — ficha do partido e `resumo.cota_fefc`; sempre com a ressalva de termômetro |

**Sem fallback para o que não acontece mais**: o release publicado sempre traz `arquivos`, todos os
parquet listados acima, `candidatos` com urna/gênero/cor/`CD_ELEICAO`/`SG_UE`, `receitas` com gênero/cor e
`NM_*_RFB`; o banco de produção tem `publicacoes.arquivos` e as colunas do refresh de `fornecedores`. Código
que "degradava" nessas ausências foi removido em 08/09/2026 — as fixtures de teste trazem as colunas reais.
O que fica é a degradação por tabela NOVA ainda não publicada (janela entre deploy e rotina) e a contingência
de rede do site (API → WASM, resumo.json indisponível).

Para análises novas, prefira `gastos.py sql` — e se a consulta for útil de forma recorrente, adicione-a em `src/analises.py`.

## Fontes e detalhes técnicos

- URLs e conteúdo de cada dataset: `docs/fontes-de-dados.md`.
- O CDN do TSE bloqueia clientes HTTP comuns por fingerprint TLS (Akamai). `src/tse.py` usa `curl_cffi` com `impersonate="chrome"` — **não troque por requests/urllib, não funciona**.
- CSVs do TSE: o TSE diz `latin-1`, mas grava **Windows-1252** (’ “ ” – … nos bytes 0x80–0x9F, que a ISO-8859-1 reserva a controles) — o `encoding='latin-1'` do DuckDB recusa o arquivo inteiro por um byte desses (derrubou a rotina em 12/09/2026), então `carga.transcodificar_para_utf8` converte cada CSV para UTF-8 antes do `read_csv` (cp1252, com os 5 bytes que nem o cp1252 define caindo no latin-1; nunca descarta linha). Separador `;`, aspas duplas. `#NULO`/`-1`/`-4` significam nulo/anonimizado.
- O SPCE emite **linhas-placeholder** (contraparte `-1`/`#NULO` **e** valor zero = prestação sem movimento). Não são fatos: `carga.filtro_placeholder` as exclui das views tipadas, das `v_removidas_*`, da série e dos atalhos do site. Contraparte anônima **com** valor é fato (e indício) — nunca filtrar.
- Os zips de prestação de contas têm arquivos por UF e um `_BRASIL.csv` consolidado; a carga usa o BRASIL.
- `consulta_cand_{ano}.zip` é nacional com um CSV por UF (não existe zip por UF em 2026).

## Dados públicos (GitHub Releases)

`exportar --publicar` mantém o release `dados` com os Parquet do banco (histórico incluso). Qualquer pessoa consulta sem baixar o repo:

```sql
SELECT * FROM 'https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/despesas.parquet'
WHERE NR_CANDIDATO = '12345'
```

Arquivos: `despesas.parquet`, `receitas.parquet` (com versionamento), `despesas_atual.parquet`, `receitas_atual.parquet` (só a extração mais recente, sem placeholders e com a coluna `valor` pronta — é o que o site e o MCP leem; ninguém deriva do histórico), `despesas_removidas.parquet`, `receitas_removidas.parquet` (resultado pronto das `v_removidas_*`), `despesas_alteradas.parquet`, `receitas_alteradas.parquet` (antes/depois pronto das `v_alteradas_pares_*`), `despesas_pagas.parquet`, `receitas_doador_originario.parquet`, `candidatos.parquet` (sem CPF/e-mail/título), `votos.parquet`, `bens.parquet`, `norma_documento.parquet`, `cota_fefc.parquet`. CPFs saem pseudonimizados (`pf-…`); o `resumo.json` leva `arquivos` (md5 por parquet — cache-buster por arquivo do site) e a publicação só sobe o que mudou.

## Site público (`site/`)

SPA Vite + React + Tailwind v4. Se existir uma pasta local de padrão visual
(referência interna, fora do git — o nome está em `.git/info/exclude`), leia o
`00-INDEX.md` dela antes de mexer no front; sem ela, siga o estilo do código
existente (tema único papel/creme, acentos navy, lucide-react, componentes em
`site/src/components/ui`). Páginas: Radar (lê `resumo.json` do release —
inclui `serie_nacional` para os sparklines dos cartões e `custo_por_voto` — `nacional` (soma ÷
soma do país), `partidos` (custo AGREGADO por sigla, `resumo.sql_custo_por_voto_partido`, piso de
`MIN_CANDIDATOS_CUSTO_PARTIDO`) e quatro listas de candidatos com os `POR_CARGO_NA_HOME` primeiros
de CADA cargo (`LISTAS_CUSTO_POR_VOTO`: eleitos mais caros, quem mais gastou sem se eleger, quem mais
contratou) e o gráfico de barras empilhadas por partido (custo por voto repartido em público,
bolso dos candidatos e terceiros) — a Home filtra por aba de cargo sem consultar nada. Com
totalização, a Home gira em torno do custo: abertura com o custo nacional, cartões de custo e
dinheiro público por voto, a seção de custo em primeiro, fora da curva reduzido a 3, e sem
"maiores despesas do dia", "declarações removidas", "fornecedores compartilhados" e "quem mais
contratou" (05/10/2026 — tudo isso continua no Explorar e nas fichas); sem totalização, a Home
anterior segue. A Home NÃO carrega DuckDB-WASM),
Explorar (visões prontas via `?visao=` — ranking, custo-por-voto (com `&ordem=` mais-caro |
gastou-sem-eleger | eleitos-mais-caros — `ORDENS_CUSTO` em `consultas.ts`; a tabela lê
as colunas prontas de `indicadores`, os cartões trazem o custo AGREGADO do recorte via
`sqlCustoDoRecorte`, e "gastou sem se eleger" exclui quem ainda disputa o 2º turno), fora-da-curva
(com `&sinal=` para filtrar a métrica; sem categoria vira lista de cards com foto e chips),
removidas, removidas-receitas, compartilhados, sem-nota, pessoa-fisica — combináveis com os
filtros; mapa de tiles por UF clicável) e Consultar
(MCP-first: URL do servidor, clientes, a lista de ferramentas — `FERRAMENTAS_MCP` em
`lib/mcp.ts`, conferida contra `servidor.py` pelo teste de sincronia — e uma conversa
simulada, `components/app/conversa-mcp.tsx`, em que a IA chama as ferramentas com os
números do `resumo.json` do dia e cai num exemplo declaradamente fictício sem ele; depois
o prompt copiável para a IA pessoal gerar SQL — `site/src/lib/prompt.ts`; mantenha esse
prompt sincronizado com o schema — e o console DuckDB-WASM, com as consultas prontas de
`lib/exemplos.ts` reduzidas ao que traz resultado forte ou que nenhuma outra página responde). Fichas
`/candidato/:sq` (composição da receita, sankey do fluxo, beeswarm do grupo, grafo de conexões,
cartão de compartilhamento em PNG via `lib/cartao.ts`), `/partido/:sigla` (inclui o custo por voto agregado da sigla, no total e por cargo — o
MESMO SQL de `resumo.sql_custo_por_voto_partido`, conferido por `test_custo_por_voto_do_partido_e_o_mesmo_sql_no_site`)
e `/fornecedor/:id`
(id = NR_CPF_CNPJ_FORNECEDOR; linke só ids com `temFichaFornecedor`) consomem os Parquet
agregados (indicadores, serie_diaria, benchmark_precos, rede, fornecedores) com degradação
graciosa se algum ainda não foi publicado.

Comparar (`/comparar`, `pages/comparar.tsx` + `components/app/comparacao.tsx`): até
`MAX_COMPARADOS` (4) candidaturas (`?c=sq1,sq2`) ou partidos (`?modo=partidos&p=PT,PL&cargo=&uf=`)
lado a lado — arrecadado × contratado na mesma escala, composição da receita em barras 100%,
matriz tipo de gasto × item (fatia do gasto de cada um; as linhas são escolhidas pela soma das
FATIAS, para o menor não ficar sem as categorias dele), custo por voto repartido e a tabela com
tudo. Candidato lê as colunas prontas de `indicadores` (`sqlCompararCandidatos`); partido soma
`indicadores` e usa `sqlCustoPorVotoAgregado` — o MESMO SQL da ficha do partido e de
`resumo.sql_custo_por_voto_partido` (conferido por `test_custo_por_voto_do_partido_e_o_mesmo_sql_no_site`).
A identidade de cada item vem do rótulo da linha, nunca de cor: as cores mantêm o significado do
resto do site. As fichas de candidato e de partido têm botão "Comparar" que abre a tela já com o item.

As red flags **por nota** (7, 12 e 13) são marcas nas fichas, não páginas: a linha
de fornecedor da ficha do candidato abre e mostra as notas que ela esconde
(`sqlNotasDoCandidato`), e as flags 12/13 viram chip no cabeçalho da ficha do
fornecedor — numeração de nota é sequencial por emitente, então "mesmo número em
2+ candidatos" é fato DO fornecedor, e a tabela dele mostra só as 50 maiores.
Não há rota `/despesa/:id`: 88% dos pares candidato×fornecedor têm uma única
nota, então a página seria uma repetição da linha — e `SQ_DESPESA` não serve de
chave (o SPCE regenera).

**Nome do candidato no site: o de urna é o principal** (é como a campanha divulga e
como o eleitor procura — metade das candidaturas com movimento usa na urna um nome que
não está no civil), e o civil aparece como secundário quando difere. A prestação só traz
`NM_CANDIDATO`, então: `duckdb.ts` registra a view `nomes_urna` (do parquet de
candidatos, mesma definição de `src/mcp/dados.py`), toda consulta
que mostra candidato junta `JOIN_NOMES_URNA` e projeta `nomeExibicao()` (`consultas.ts`),
e o que vem do `resumo.json` (Home, conversa MCP) passa por `nomeCandidato()` em
`format.ts` — o backend grava `NM_URNA_CANDIDATO` em `indicadores` e em todo registro
de candidato do `resumo.json` (`resumo._join_urna`).

Regras espelhadas do backend vivem centralizadas em `site/src/lib/consultas.ts`
(categorias sem NF ↔ `src/analises.py`; SINAIS_CTE/SINAIS_FILTRO ↔ `METRICAS_SINAL` em
`src/resumo.py`; CONDICAO_NOTA_SEM_NUMERO/CONDICAO_DOCUMENTO_NUMERADO ↔ as análises 12 e
13 de `src/analises.py`; MINIMO_NOTAS_VALOR_REPETIDO ↔ `rep` em `src/agregados.py`;
SITUACAO_NAO_ENCONTRADA ↔ `SITUACAO_NAO_ENCONTRADO` em `src/cnpj.py` —
a lápide de CNPJ que a Receita respondeu 404, que vira aviso na ficha do fornecedor e
marca a linha na tabela de fornecedores do candidato; ORIGEM_FINANCIAMENTO_COLETIVO/CONDICAO_DOACAO_DIRETA
e CATEGORIA_IMPULSIONAMENTO ↔ as exclusões das flags 4 e 13 em `src/analises.py` — o anel
"dinheiro que volta" das fichas só fecha com doação direta; COR_RACA_NEGRA em `partido.tsx` ↔
`src/agregados.py`; `sqlBuscaCandidatos` ↔ `sql_buscar_candidato` em `src/mcp/consultas.py` —
a busca parte do **registro** (`candidatos`, único que tem NM_URNA_CANDIDATO) e pega os
totais de `indicadores` por LEFT JOIN: metade das candidaturas com movimento usa na urna um
nome que não está no nome civil, e é por ele que o eleitor procura; partir de
`indicadores`/`despesas_atual` escondia essas e também quem só declarou receita) e
`site/src/lib/duckdb.ts` (view `nomes_urna` ↔ `src/mcp/dados.py`);
`tests/test_sincronia_site.py` cobre essa sincronia — remoções NUNCA se calculam "na unha"
nas páginas, sempre pelo parquet `*_removidas` publicado. Componentes de visualização: `components/app/graficos.tsx`
(barras, linhas, faixas/beeswarm, sparkline, composição), `sankey.tsx` (rótulos com
anti-colisão + linhas-guia), `grafo.tsx` (layout de força via d3-force, estático e
determinístico; aceita `secundarios` para o 2º nível de conexões — que exclui as
contrapartes-infraestrutura, senão o anel externo de qualquer ficha vira "os três
maiores anunciantes do país". O eixo X é o do dinheiro: doação à esquerda,
despesa à direita, quem é os dois papéis no meio, e o 2º nível ALÉM do nó que o
trouxe, do lado dele — daí a leitura de fluxo. O rótulo sai para fora do centro e
entra no raio da colisão, senão o texto se empilha sem que a física perceba), `mapa.tsx`;
blocos colapsáveis via `components/app/recolhivel.tsx` (SecaoRecolhivel — com muitos
gráficos por página, declare `aberta` só no que é essencial) e zoom via
`components/app/ampliavel.tsx` (Ampliavel — re-renderiza o gráfico num `<dialog>` de
~96vw; envolva qualquer SVG responsivo denso). Deploy: Cloudflare Pages
(`docs/deploy-cloudflare.md`). Os dados chegam ao site via Pages Function `/dados/*` que faz
proxy do GitHub Releases (sem CORS lá).

**Onde a consulta roda** (`site/src/lib/dados.ts`): as fichas e o Explorar importam
`executarSQL`/`obterConexao`/`tabelasDisponiveis` de `@/lib/dados` — mesma assinatura de
`@/lib/duckdb`, mas o SQL vai primeiro para a API do servidor (`GET /api/v1/consulta`,
`src/mcp/api.py`; base em `VITE_RADAR_API`, variável de build do Pages) num GET com a
consulta comprimida (`q` = deflate-raw + base64url) e a versão do dado (`v` =
`publicado_em` do `resumo.json`) na URL — a borda cacheia a resposta imutável e o visitante
recebe ~10 KB em vez do motor (~10 MB) + pedaços dos Parquet. `tabelasDisponiveis` vem do
mapa `arquivos` do resumo, sem bootar motor nenhum — do `resumo.json` pela Function
(`carregarResumo` tenta duas vezes: o GitHub por trás dela responde 429 em hora de pico)
ou, se ela falhar, de `GET /api/v1/resumo` no servidor. A Function busca cada arquivo
inteiro no GitHub uma vez por data center e serve do cache o GET, o HEAD e os `Range` do
WASM (a Cache API fatia em 206) — cada `Range` ia ao GitHub e virava 429 em cascata;
uma cópia de reserva de 7 dias sai marcada (`X-Radar-Copia`) quando o GitHub falha.
429 da borda (rate limit por IP) não é contingência: `viaApi` espera o `Retry-After` e
repete até 3 vezes. O hostname da
API tem de estar no `connect-src` da CSP (`site/public/_headers`). Se a API não responde (rede, 5xx,
timeout de 4 s, 404 de imagem antiga), a página importa o `duckdb.ts` sob demanda e roda o
**mesmo texto de SQL** sobre os Parquet — o caminho de sempre, que não depende do host — e
a contingência gruda por 5 min (faixa amarela no layout). 400 é erro da própria consulta e
propaga (o Explorar tenta uma variante e recua no catch). Sem `VITE_RADAR_API` (fork,
prévia local) tudo roda no WASM como antes. O console SQL livre NÃO passa por aí:
`consultar.tsx` importa `@/lib/duckdb` direto — SQL livre roda no CPU de quem digita.
Paridade por construção: um texto de consulta, dois executores; `tests/test_mcp_api.py`
roda cada consulta de `exemplos.ts` pela rota e exige o resultado do cursor cru.

## Servidor MCP público (`src/mcp/`)

Container Python (SDK oficial `mcp` 2.x, classe `MCPServer`; Streamable HTTP **stateless**, `json_response`; negocia a revisão 2026-07-28 e atende o `initialize` clássico)
que lê **só os Parquet publicados** no release — nunca o banco da extração — e
os carrega como tabelas num DuckDB local só-leitura (`dados.py`: boot, poll do
md5 do `resumo.json` a cada 5 min, troca atômica do banco). Ferramentas em
`servidor.py`: `buscar_candidato`/`buscar_fornecedor` (acham o código que as
fichas consomem), fichas de candidato/fornecedor/partido, `fora_da_curva`,
`notas_fora_do_preco`, `candidatos_conectados`, `declaracoes_removidas`,
`novidades` (o que ENTROU, por `dt_primeira_extracao` — o contrário das
removidas), `custo_por_voto` (gasto ÷ votos do 1º turno com as parcelas pública
e própria, resultado e mediana/p95 do grupo; `visao_geral.votacao` diz se a
totalização — e a presidencial, que chega depois — já entrou), `fornecedores_compartilhados`, `fornecedores_por_cadastro` (cruza
com a tabela `fornecedores` e devolve a COBERTURA do enriquecimento junto: sem o
denominador, "poucas empresas baixadas" se confunde com "poucas empresas
verificadas"), `sem_nota`, `gastos_por_categoria`, `visao_geral` e `sql` livre. Toda resposta traz `versao_dado` (data da
extração) e `versao_codigo` (commit da imagem, `RADAR_GIT_SHA`, ou
`stamp_codigo`).

- **As ferramentas medem, não julgam.** As de recorte devolvem posição numa
  distribuição (métrica × p95 do grupo; nota × p95 da categoria) e
  característica formal do declarado (documento não fiscal, número sem dígito,
  declaração que saiu do ar) — nenhuma classifica irregularidade, e nada aqui
  foi calibrado contra caso julgado. Por isso: docstring descreve a medida (e
  não promete veredito), payload traz `o_que_esta_medido`/`criterios_das_notas`/
  `ressalvas`, e as `instructions` dizem ao modelo que "acima do p95" marca 5%
  de qualquer grupo por construção. O modelo **pode** concluir por conta
  própria via `sql`, desde que mostre o cálculo; o que não pode é emprestar
  rótulo da ferramenta. `test_sincronia_site.py::test_ferramentas_de_recorte_nao_entregam_veredito`
  falha se uma docstring voltar a prometer fraude/irregularidade/superfaturamento.
- **`notas_fora_do_preco`** compara a nota contra `benchmark_precos` montando-a
  com `agregados.CHAVE_NOTA` — a MESMA chave que gerou os percentis (itens de
  mesma `SQ_DESPESA` somados, `-1` linha a linha). Montada de outro jeito, o
  número teria uma forma e a régua outra. Exige recorte (UF/cargo/partido/
  candidato/categoria): sem ele varreria o país nota a nota.
- **`candidatos_conectados`** anda pela `rede` (até 3 níveis) e devolve
  `por_meio_de` — sem a contraparte que fez a ponte, uma lista de nível 3 não é
  conferível. Contraparte que atende mais de `MAX_CANDIDATOS_CONTRAPARTE_COMUM`
  (20) candidatos é infraestrutura, não gera ligação, e vai declarada em
  `contrapartes_ignoradas`; o teto é afrouxável por parâmetro. **O site usa o
  mesmo corte** no 2º nível do grafo (`sqlContrapartesInfraestrutura` em
  `consultas.ts`, espelhando a constante — `test_corte_de_infraestrutura_igual_no_front`);
  o que ainda diverge é o top-N por contraparte (`QUALIFY ROW_NUMBER()`), cap de
  DESENHO que o MCP não aplica porque esconderia quem divide fornecedor gastando
  pouco — o padrão de rateio. Registrado em
  `test_top_n_do_grafo_e_cap_de_desenho_que_o_mcp_nao_aplica`, como a exceção do
  PIVOT no gate. Medido em 07/09/2026: sem o corte, o nível 1 de um candidato
  qualquer já alcança 42% do país por uma única plataforma de anúncio; com ele,
  5 níveis completos custam ~50 ms.

- **Mesmos números do site**: o SQL das ferramentas (`consultas.py`) espelha
  `site/src/lib/consultas.ts` e as fichas; as réguas vêm **importadas** de
  `analises.py`/`resumo.py`/`agregados.py`, nunca copiadas. `instructions` =
  o trecho CONTEXTO…REGRAS de `site/src/lib/prompt.ts` (`esquema.py`).
  `tests/test_sincronia_site.py` cobre tudo isso; `test_mcp_ferramentas.py`
  roda cada consulta de `exemplos.ts` pela ferramenta `sql` e exige resultado
  idêntico ao cursor cru.
- **Guarda-corpos da `sql`** (`gate.py` + `dados.Executor`): parser do DuckDB
  (um statement, tipo SELECT — PIVOT/UNPIVOT recusados, exceção documentada),
  conexão `read_only` com `enable_external_access=false` e `lock_configuration`,
  timeout por `interrupt()`, teto de 500 linhas e ~200 KB, **célula limitada a
  2.000 caracteres e 100 colunas por uma projeção externa montada dentro do DuckDB**
  (o `memory_limit` não cobre a conversão para Python nem o `json.dumps`, e o
  `interrupt()` não os interrompe — 20 strings de 50 MB levavam o processo a 2 GB),
  SQL de até 50 mil caracteres, duas filas (8 vagas
  para as ferramentas curadas, 4 para a `sql` livre — medido: uma fila só deixava
  cross joins esgotarem as vagas das fichas).
- **Deploy**: `Dockerfile.mcp` (testes no build), aplicação separada no mesmo
  host da rotina, sem volume nem segredo, atrás de túnel — `docs/deploy-mcp.md`
  (genérico). Local: `python -m src.mcp.servidor` → `http://localhost:8000/mcp`.
- **Rota do site** (`api.py`, `GET /api/v1/consulta?q|sql=…&v=…`): executa o SQL que as
  páginas montam, na fila `site` (8 vagas, `MCP_MAX_SIMULTANEAS_SITE`; timeout de 5 s,
  `MCP_TIMEOUT_SITE`; teto de 2.000 linhas/1 MB — a dispersão do Explorar pede 1.500),
  com os mesmos guarda-corpos da `sql` e o resultado no formato do console (`colunas` +
  `linhas` como listas). `Cache-Control` imutável de 1 dia **só** quando `v` bate com o
  `publicado_em` do banco; senão `no-store` — e `v` mais novo que o banco dispara
  `Servico.pedir_verificacao()` (debounce de 60 s), porque o site vê o release novo
  antes do poll de 5 min. CORS `*` fixo (a borda ignora `Vary`). 400 = consulta errada
  (gate, DuckDB), 503 = fila cheia (`Retry-After`), 504 = timeout — o site cai para o
  WASM nos 5xx, nunca no 400. `tests/test_mcp_api.py`.
- `tests/test_mcp_protocolo.py` fala com o app pelo cliente oficial do SDK
  (o `Client` 2.x negocia `LATEST_PROTOCOL_VERSION` via discover; o
  `ClientSession` clássico ainda inicializa; tools/list com `output_schema` e
  anotações só-leitura, `structured_content`, `is_error`, resources). Campos
  do SDK 2.x são snake_case; o transporte é configurado em
  `streamable_http_app()`, não no construtor. Rode após mudar `src/mcp/`,
  `prompt.ts`, `consultas.ts` ou `exemplos.ts`.

## Alvos do estudo atual

`config/alvos.yaml` (local, fora do git) guarda os candidatos em foco do usuário — leia-o no início da sessão para saber o contexto. Se não existir, copie de `config/alvos.exemplo.yaml` e pergunte ao usuário quem acompanhar. Não cite candidatos específicos na documentação nem em arquivos versionados.
