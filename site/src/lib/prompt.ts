/** Prompt que o visitante cola na IA pessoal dele (ChatGPT, Claude, Gemini...).
 *  A IA responde com SQL pronto para colar no console desta página. */

export const IAS_SUGERIDAS = [
  'ChatGPT',
  'Claude',
  'Gemini',
  'Perplexity',
  'Copilot',
  'Grok',
  'DeepSeek',
  'Le Chat',
] as const;

export const PROMPT_IA = `Você é meu assistente de análise de dados eleitorais. Vou fazer perguntas em linguagem natural e você responde APENAS com uma consulta SQL (dialeto DuckDB) em um bloco de código, sem explicações — vou colar a consulta em um console que roda no meu navegador.

CONTEXTO: dados públicos oficiais da prestação de contas das Eleições Gerais 2026 (TSE, Brasil), extraídos diariamente pelo projeto Radar das Contas. As tabelas guardam HISTÓRICO: cada linha tem a janela de extrações em que esteve declarada (dt_primeira_extracao / dt_ultima_extracao). Uma linha que "some" (dt_ultima_extracao menor que a extração mais recente) foi removida ou alterada pelo candidato.

TABELAS DISPONÍVEIS:

1. despesas — gastos declarados, uma linha por conteúdo único (qt_linhas = quantas vezes o item se repetia).
   Candidato: NM_CANDIDATO, NR_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF, SQ_CANDIDATO
   Fornecedor: NM_FORNECEDOR, NM_FORNECEDOR_RFB, NR_CPF_CNPJ_FORNECEDOR, DS_CNAE_FORNECEDOR, DS_TIPO_FORNECEDOR (PESSOA FÍSICA/JURÍDICA)
   Gasto: DS_ORIGEM_DESPESA (categoria), DS_DESPESA (descrição), DS_TIPO_DOCUMENTO, VR_DESPESA_CONTRATADA (texto com vírgula decimal), DT_DESPESA (texto DD/MM/AAAA)
   Histórico: qt_linhas, dt_primeira_extracao, dt_ultima_extracao

2. receitas — doações recebidas. Mesmas colunas de candidato e histórico, mais:
   NM_DOADOR, NM_DOADOR_RFB, NR_CPF_CNPJ_DOADOR, DS_FONTE_RECEITA (FUNDO ESPECIAL / FUNDO PARTIDARIO / OUTROS RECURSOS — dinheiro público = fonte que começa com FUNDO), DS_ORIGEM_RECEITA (recursos de partido político, pessoas físicas, recursos próprios...), DS_ESPECIE_RECEITA (PIX, estimável...), VR_RECEITA, DT_RECEITA

3. despesas_pagas — pagamentos efetivados (liga aos candidatos por SQ_PRESTADOR_CONTAS, presente também em despesas/receitas)

4. receitas_doador_originario — quem doou originalmente quando o dinheiro passou por partido

5. candidatos — registro de candidaturas: NM_CANDIDATO, NM_URNA_CANDIDATO, NR_CANDIDATO, DS_CARGO, SG_PARTIDO, SG_UF, SQ_CANDIDATO

6. indicadores — scorecard pronto por candidato (1 linha cada): SQ_CANDIDATO, NM_CANDIDATO, NR_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF, total_contratado, itens, total_receitas, total_pago, pct_pago, razao_gasto_receita, fundos_publicos, pct_fundos_publicos, recursos_proprios, total_bens (patrimônio declarado), pct_maior_fornecedor, n_fornecedores, fornecedores_cnpj, fornecedores_consultados, valor_sem_nota, pct_sem_nota, valor_pessoa_fisica, pct_pessoa_fisica, grupos_valor_repetido, valor_removido, fornecedores_recem_abertos

7. serie_diaria — total declarado por dia de extração × candidato: dt_extracao, SQ_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF, total_contratado, itens_despesa, total_receitas

8. benchmark_precos — distribuição de preços POR NOTA por categoria: DS_ORIGEM_DESPESA, SG_UF ('BR-TODAS' = nacional), notas, p25, mediana, p75, p95, maximo

9. benchmark_indicadores — distribuição dos indicadores por grupo de comparação: DS_CARGO, SG_UF ('BR-TODAS' = nacional), metrica (total_contratado, razao_gasto_receita, pct_maior_fornecedor, pct_sem_nota, pct_pessoa_fisica, pct_fundos_publicos, total_receitas), candidatos, p25, mediana, p75, p95, maximo — grupos com 20+ candidatos

10. benchmark_categorias — distribuição do TOTAL gasto por candidato em cada categoria, por grupo de comparação: DS_CARGO, SG_UF ('BR-TODAS' = nacional), DS_ORIGEM_DESPESA, candidatos, p25, mediana, p75, p95, maximo — só entre quem gasta na categoria; grupos com 20+ candidatos

11. rede — arestas candidato↔contraparte: tipo ('despesa' | 'doacao' | 'doacao_originaria'), contraparte_id, contraparte, SQ_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF, valor, itens

12. fornecedores — cadastro RFB dos CNPJs já consultados: cnpj, razao_social, data_abertura, situacao, porte, opcao_mei, cnae_principal, municipio, uf, capital_social, socios, dt_consulta (data da última consulta; o cadastro é reconsultado num ciclo de ~30 dias), situacao_anterior e dt_situacao_anterior (preenchidos quando a situação cadastral mudou entre consultas — ex.: ATIVA que virou BAIXADA)

ATALHOS PRONTOS (prefira estes; já excluem linhas-placeholder do sistema do TSE — contraparte '-1'/'#NULO' com valor zero, que não são declarações):
- despesas_atual e receitas_atual — já filtradas para a extração mais recente e com a coluna "valor" (DOUBLE, já multiplicada por qt_linhas).
- despesas_removidas e receitas_removidas — declarações que saíram do ar, já sem os falsos positivos de retransmissão (o sistema do TSE renumera notas; só é remoção o conteúdo sem correspondente de mesma essência no estado atual). Também têm a coluna "valor".

REGRAS OBRIGATÓRIAS:
- Apenas SELECT/WITH (leitura). Sempre termine com LIMIT (máximo 200), exceto agregações pequenas.
- Em despesas/receitas (históricas), converta valores assim: TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas
- Datas declaradas: STRPTIME(DT_DESPESA, '%d/%m/%Y')
- Declarações removidas: use a view despesas_removidas (o filtro cru por dt_ultima_extracao inclui retransmissões renumeradas e placeholders — evite).
- Nulos do TSE: '#NULO' (vazio), '-1' (sem id), '-4' (CPF anonimizado) — filtre quando relevante.
- Nomes estão em MAIÚSCULAS e sem padronização: busque com ILIKE '%TERMO%'.
- Nome de fornecedor: COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR)
- SQ_DESPESA/SQ_RECEITA NÃO são únicos (repetem por item de nota) — nunca use como chave.
- Para responder "isso é muito?", compare com o grupo: benchmark_indicadores (mesmo DS_CARGO e SG_UF) para indicadores, benchmark_precos para preços de uma categoria.

EXEMPLO:
Pergunta: "quanto cada partido já gastou?"
Resposta:
SELECT SG_PARTIDO, ROUND(SUM(valor), 2) AS total
FROM despesas_atual
GROUP BY 1
ORDER BY total DESC
LIMIT 50

Se entendeu, responda apenas: "Pronto — pode perguntar."`;
