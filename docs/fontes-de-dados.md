# Fontes de dados públicos

## 1. Portal de Dados Abertos do TSE — https://dadosabertos.tse.jus.br

Fonte primária. Arquivos CSV (latin-1, separador `;`) dentro de ZIPs no CDN `https://cdn.tse.jus.br/estatistica/sead/odsele/`. Atualizados diariamente durante a campanha (madrugada).

> O CDN bloqueia curl/requests por fingerprint TLS — use `curl_cffi` com `impersonate="chrome"` (já implementado em `src/tse.py`).

### Prestação de contas eleitorais de candidatos
`{CDN}/prestacao_contas/prestacao_de_contas_eleitorais_candidatos_{ano}.zip`

Contém, por UF e consolidado (`_BRASIL`):
- `despesas_contratadas_candidatos_*` — cada gasto declarado: fornecedor (nome, CPF/CNPJ, nome na Receita, CNAE, município), descrição, valor, data, documento fiscal.
- `despesas_pagas_candidatos_*` — pagamentos efetivados e fonte do recurso.
- `receitas_candidatos_*` — doações: doador, CPF/CNPJ, **fonte** (`DS_FONTE_RECEITA`: FUNDO ESPECIAL / FUNDO PARTIDARIO / OUTROS RECURSOS — é aqui que se mede dinheiro público; a origem declarada do repasse costuma ser "Recursos de partido político"), origem, espécie (PIX etc.), valor, data.

> Pegadinha dos arquivos: o sistema do TSE emite **linhas-placeholder** (contraparte `-1`/`#NULO` com valor zero) para prestação sem movimento — não são declarações. E os arquivos são detalhados por **item de nota**: `SQ_DESPESA` se repete e linhas 100% idênticas são legítimas.
- `receitas_candidatos_doador_originario_*` — origem real do recurso quando repassado por partido/candidato.
- PDFs `leiame_*` — dicionário de dados oficial de cada arquivo.

### Candidaturas
`{CDN}/consulta_cand/consulta_cand_{ano}.zip` — registro de todas as candidaturas: nome, nome de urna, número, cargo, partido, coligação, situação do registro, SQ_CANDIDATO (chave que liga tudo).

### Bens declarados
`{CDN}/bem_candidato/bem_candidato_{ano}.zip` — bens declarados por candidato (tipo, descrição, valor). Carregado na tabela `bens` (o indicador `total_bens` cruza patrimônio com recursos próprios injetados na campanha).

### CNPJ de campanha
`{CDN}/prestacao_contas/CNPJ_campanha_{ano}.zip` — CNPJs de campanha abertos por candidatos/partidos.

### Extratos bancários (!)
`{CDN}/prestacao_contas_anual_candidato/extrato_bancario_candidato_{ano}.zip` — movimentação bancária das contas de campanha. Volume grande; permite conferir se o declarado bate com o movimentado.

### Outros anos
Trocar `{ano}`: 2018, 2020, 2022, 2024 disponíveis no mesmo padrão (nomes de colunas variam levemente entre anos).

## 2. DivulgaCandContas — https://divulgacandcontas.tse.jus.br

Consulta individual por candidato (interface e API REST JSON). Útil para conferência pontual e para dados que ainda não chegaram ao CSV diário. Documentação não-oficial da API: https://github.com/augusto-herrmann/divulgacandcontas-doc. Usar com parcimônia (rate limit; risco de bloqueio de IP).

## 3. BrasilAPI (Receita Federal) — https://brasilapi.com.br/api/cnpj/v1/{cnpj}

Cadastro público de CNPJ: razão social, **data de abertura**, situação cadastral, porte (MEI/ME), CNAE principal e secundários, **quadro societário**, endereço. Sem chave de API. Implementado em `src/cnpj.py` com cache local e rate limit.

Alternativas: https://minhareceita.org (mesmos dados), arquivos completos da Receita em https://arquivos.receitafederal.gov.br/dados/cnpj/ (para cruzamentos em massa).

## 4. Cruzamentos úteis (não implementados ainda)

- **Sanções**: CEIS/CNEP/CEPIM via API do Portal da Transparência (https://api.portaldatransparencia.gov.br — requer cadastro de e-mail para chave gratuita): fornecedores punidos recebendo de campanha.
- **Resultados eleitorais** (TSE, `votacao_candidato_munzona_{ano}.zip`): custo por voto.
- **Contratos públicos municipais** (portais de transparência municipais / PNCP https://pncp.gov.br): fornecedor de campanha que depois ganha contrato da prefeitura — sinal clássico de retribuição.
- **Emendas parlamentares** (Portal da Transparência): para parlamentares candidatos à reeleição.
