/** Consultas prontas do console (Consultar): exemplos por grupo e perguntas
 *  em português com o SQL que as responde. Dados puros, sem React — o script
 *  de verificação e os testes leem este arquivo para validar cada consulta. */

export interface Exemplo {
  rotulo: string;
  sql: string;
}

export const CONSULTA_INICIAL = `-- Pergunte à sua IA e cole o SQL aqui, ou edite à vontade.
SELECT SG_PARTIDO, ROUND(SUM(valor), 2) AS total_contratado
FROM despesas_atual
GROUP BY 1
ORDER BY total_contratado DESC
LIMIT 20`;

const SQL_DOADOR_FORNECEDOR = `-- dinheiro que "volta": a mesma contraparte doa E fornece ao mesmo candidato
SELECT d.NM_CANDIDATO, d.SG_PARTIDO, d.SG_UF, d.contraparte,
       ROUND(d.valor, 2) AS recebeu_como_fornecedor,
       ROUND(o.valor, 2) AS doou_ao_candidato
FROM rede d
JOIN rede o
  ON o.SQ_CANDIDATO = d.SQ_CANDIDATO
 AND o.contraparte_id = d.contraparte_id
 AND o.tipo = 'doacao'
WHERE d.tipo = 'despesa' AND d.contraparte_id NOT IN ('-1', '#NULO')
ORDER BY recebeu_como_fornecedor DESC
LIMIT 50`;

const SQL_FORA_DA_CURVA_CATEGORIA = `-- quem gasta numa categoria muito acima do p95 do grupo (mesmo cargo e UF)
WITH gasto AS (
  SELECT SQ_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF, DS_ORIGEM_DESPESA,
         SUM(valor) AS total_categoria
  FROM despesas_atual
  GROUP BY ALL
)
SELECT g.NM_CANDIDATO, g.SG_PARTIDO, g.SG_UF, g.DS_ORIGEM_DESPESA,
       ROUND(g.total_categoria, 2) AS gastou,
       ROUND(b.p95, 2) AS p95_do_grupo, b.candidatos AS tamanho_do_grupo
FROM gasto g
JOIN benchmark_categorias b
  ON b.DS_CARGO = g.DS_CARGO AND b.SG_UF = g.SG_UF
 AND b.DS_ORIGEM_DESPESA = g.DS_ORIGEM_DESPESA
WHERE g.total_categoria > b.p95
ORDER BY g.total_categoria - b.p95 DESC
LIMIT 30`;

export const GRUPOS_EXEMPLOS: { rotulo: string; exemplos: Exemplo[] }[] = [
  {
    rotulo: 'Comece por aqui',
    exemplos: [
      {
        rotulo: 'Gastos por partido',
        sql: CONSULTA_INICIAL,
      },
      {
        rotulo: 'Maiores fornecedores do país',
        sql: `SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
GROUP BY 1
ORDER BY total DESC
LIMIT 30`,
      },
      {
        rotulo: 'Gasto com carro de som por UF',
        sql: `SELECT SG_UF, COUNT(DISTINCT SQ_CANDIDATO) AS candidatos, ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE DS_ORIGEM_DESPESA ILIKE '%carro%som%'
GROUP BY 1
ORDER BY total DESC
LIMIT 30`,
      },
      {
        rotulo: 'Dinheiro público por partido',
        sql: `SELECT SG_PARTIDO,
       ROUND(SUM(fundos_publicos), 2) AS fundos_publicos,
       ROUND(SUM(total_receitas), 2) AS arrecadado,
       ROUND(100.0 * SUM(fundos_publicos) / SUM(total_receitas), 1) AS pct_publico
FROM indicadores
GROUP BY 1
HAVING arrecadado > 0
ORDER BY fundos_publicos DESC
LIMIT 30`,
      },
    ],
  },
  {
    rotulo: 'Red flags',
    exemplos: [
      {
        rotulo: 'Declarações removidas',
        sql: `-- a view já filtra retransmissões renumeradas e linhas-placeholder
SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF,
       COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       DS_DESPESA, ROUND(valor, 2) AS valor,
       dt_primeira_extracao, dt_ultima_extracao
FROM despesas_removidas
ORDER BY valor DESC
LIMIT 50`,
      },
      {
        rotulo: 'Fora da curva do grupo',
        sql: `-- candidatos acima do p95 do grupo (mesmo cargo e UF) em gasto ÷ arrecadado
SELECT i.NM_CANDIDATO, i.SG_PARTIDO, i.SG_UF, i.DS_CARGO,
       i.razao_gasto_receita, b.p95 AS p95_do_grupo, b.candidatos AS tamanho_do_grupo
FROM indicadores i
JOIN benchmark_indicadores b
  ON b.DS_CARGO = i.DS_CARGO AND b.SG_UF = i.SG_UF AND b.metrica = 'razao_gasto_receita'
WHERE i.razao_gasto_receita > b.p95
ORDER BY i.razao_gasto_receita DESC
LIMIT 30`,
      },
      {
        rotulo: 'Doador que também é fornecedor',
        sql: SQL_DOADOR_FORNECEDOR,
      },
      {
        rotulo: 'Situação cadastral alterada',
        sql: `-- fornecedores cujo CNPJ mudou de situação na Receita entre as nossas consultas
-- (ex.: ATIVA que virou BAIXADA depois de receber da campanha).
-- Monitor contínuo: vem vazio enquanto nenhuma mudança tiver sido detectada.
SELECT f.cnpj, f.razao_social, f.situacao_anterior, f.situacao, f.dt_situacao_anterior,
       COUNT(DISTINCT d.SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(d.valor), 2) AS recebido_na_campanha
FROM fornecedores f
JOIN despesas_atual d ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj
WHERE f.situacao_anterior IS NOT NULL
GROUP BY 1, 2, 3, 4, 5
ORDER BY recebido_na_campanha DESC
LIMIT 30`,
      },
      {
        rotulo: 'Fornecedores recém-abertos',
        sql: `-- empresas abertas às vésperas da eleição (out/2025 em diante) já recebendo de campanha
SELECT f.cnpj, f.razao_social, f.data_abertura, f.uf AS uf_da_empresa,
       COUNT(DISTINCT d.SQ_CANDIDATO) AS candidatos,
       COUNT(DISTINCT d.SG_UF) AS ufs_atendidas,
       ROUND(SUM(d.valor), 2) AS total
FROM fornecedores f
JOIN despesas_atual d ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj
WHERE f.data_abertura >= '2025-10-01'
GROUP BY 1, 2, 3, 4
ORDER BY total DESC
LIMIT 30`,
      },
    ],
  },
  {
    rotulo: 'Cruzamentos avançados',
    exemplos: [
      {
        rotulo: 'Fornecedor em vários estados',
        sql: `-- o mesmo fornecedor recebendo de candidatos em 3+ estados (rateio? esquema nacional?)
SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       NR_CPF_CNPJ_FORNECEDOR AS cnpj,
       COUNT(DISTINCT SG_UF) AS ufs,
       STRING_AGG(DISTINCT SG_UF, ', ' ORDER BY SG_UF) AS estados,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
GROUP BY 1, 2
HAVING COUNT(DISTINCT SG_UF) >= 3
ORDER BY total DESC
LIMIT 30`,
      },
      {
        rotulo: 'Preço de impulsionamento por UF',
        sql: `-- mediana do preço POR NOTA em cada estado; 'BR-TODAS' é a régua nacional
SELECT SG_UF, notas, ROUND(mediana, 2) AS mediana, ROUND(p95, 2) AS p95
FROM benchmark_precos
WHERE DS_ORIGEM_DESPESA ILIKE '%impulsionamento%'
ORDER BY mediana DESC
LIMIT 30`,
      },
      {
        rotulo: 'Fora da curva por tipo de gasto',
        sql: SQL_FORA_DA_CURVA_CATEGORIA,
      },
      {
        rotulo: 'Gasto × patrimônio declarado',
        sql: `-- recursos próprios altos vindos de quem declarou patrimônio baixo no registro
SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF, DS_CARGO,
       ROUND(recursos_proprios, 2) AS recursos_proprios,
       ROUND(total_bens, 2) AS patrimonio_declarado,
       ROUND(recursos_proprios / NULLIF(total_bens, 0), 1) AS proprio_sobre_patrimonio
FROM indicadores
WHERE recursos_proprios > 50000
ORDER BY proprio_sobre_patrimonio DESC NULLS FIRST
LIMIT 30`,
      },
    ],
  },
];

export interface PerguntaPronta {
  pergunta: string;
  sql: string;
}

/** Clicar numa pergunta leva o SQL pronto ao console (e copia). As consultas
 *  com "meu estado" usam uma UF de exemplo — o comentário na 1ª linha avisa. */
export const GRUPOS_PERGUNTAS: { titulo: string; perguntas: PerguntaPronta[] }[] = [
  {
    titulo: 'Perguntas prontas',
    perguntas: [
      {
        pergunta: 'Quanto cada candidato a governador do meu estado já gastou, e com o quê?',
        sql: `-- troque 'SP' pela sua UF
SELECT NM_CANDIDATO, SG_PARTIDO, DS_ORIGEM_DESPESA, ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE DS_CARGO ILIKE '%governador%' AND SG_UF = 'SP'
GROUP BY 1, 2, 3
ORDER BY NM_CANDIDATO, total DESC
LIMIT 200`,
      },
      {
        pergunta: 'Quais empresas estão recebendo de 5 ou mais candidatos ao mesmo tempo?',
        sql: `SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       NR_CPF_CNPJ_FORNECEDOR AS cnpj,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14
GROUP BY 1, 2
HAVING COUNT(DISTINCT SQ_CANDIDATO) >= 5
ORDER BY candidatos DESC, total DESC
LIMIT 50`,
      },
      {
        pergunta: 'Algum candidato removeu ou alterou despesas que já tinha declarado?',
        sql: `-- a view já filtra retransmissões renumeradas (não são remoções de verdade)
SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF,
       COUNT(*) AS itens_removidos, ROUND(SUM(valor), 2) AS valor_removido
FROM despesas_removidas
GROUP BY 1, 2, 3
ORDER BY valor_removido DESC
LIMIT 50`,
      },
      {
        pergunta: 'Quem está contratando muito acima do que declarou ter arrecadado?',
        sql: `SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF, DS_CARGO,
       ROUND(total_contratado, 2) AS contratado,
       ROUND(total_receitas, 2) AS arrecadado,
       razao_gasto_receita
FROM indicadores
WHERE razao_gasto_receita > 1 AND total_contratado > 10000
ORDER BY razao_gasto_receita DESC
LIMIT 50`,
      },
      {
        pergunta: 'Quanto do Fundo Eleitoral já chegou aos candidatos, por partido?',
        sql: `SELECT SG_PARTIDO,
       ROUND(SUM(valor), 2) AS fundo_eleitoral,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos
FROM receitas_atual
WHERE DS_FONTE_RECEITA ILIKE '%FUNDO ESPECIAL%'
GROUP BY 1
ORDER BY fundo_eleitoral DESC
LIMIT 50`,
      },
      {
        pergunta: 'Quais os maiores gastos com impulsionamento de redes sociais até agora?',
        sql: `SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF,
       COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       DS_DESPESA, ROUND(valor, 2) AS valor
FROM despesas_atual
WHERE DS_ORIGEM_DESPESA ILIKE '%impulsionamento%'
ORDER BY valor DESC
LIMIT 50`,
      },
      {
        pergunta: 'Existem doações de valores idênticos, do mesmo dia, para o mesmo candidato?',
        sql: `-- qt_linhas conta repetições exatas; o agrupamento pega doações iguais no mesmo dia
SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF, DT_RECEITA, VR_RECEITA,
       SUM(qt_linhas) AS doacoes,
       COUNT(DISTINCT NR_CPF_CNPJ_DOADOR) AS doadores_distintos,
       ROUND(SUM(valor), 2) AS total
FROM receitas_atual
GROUP BY 1, 2, 3, 4, 5
HAVING SUM(qt_linhas) >= 3 AND SUM(valor) > 0
ORDER BY total DESC
LIMIT 50`,
      },
      {
        pergunta: 'Que candidatos usam a mesma gráfica ou o mesmo carro de som?',
        sql: `SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       DS_ORIGEM_DESPESA,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       STRING_AGG(DISTINCT NM_CANDIDATO, ' | ' ORDER BY NM_CANDIDATO) AS quem,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE (DS_ORIGEM_DESPESA ILIKE '%impresso%' OR DS_ORIGEM_DESPESA ILIKE '%carro%som%')
  AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
GROUP BY 1, 2
HAVING COUNT(DISTINCT SQ_CANDIDATO) >= 2
ORDER BY candidatos DESC, total DESC
LIMIT 50`,
      },
      {
        pergunta: 'Quais pessoas físicas (sem empresa) mais receberam dinheiro de campanha?',
        sql: `-- o CPF não é publicado: pessoa física aparece com código estável 'pf-…'
SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS pessoa,
       NR_CPF_CNPJ_FORNECEDOR AS codigo,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE DS_TIPO_FORNECEDOR ILIKE 'PESSOA F%'
GROUP BY 1, 2
ORDER BY total DESC
LIMIT 50`,
      },
      {
        pergunta: 'Quanto os candidatos à Presidência gastaram com advogados e contadores?',
        sql: `SELECT NM_CANDIDATO, SG_PARTIDO, DS_ORIGEM_DESPESA, ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE DS_CARGO ILIKE '%presidente%'
  AND (DS_ORIGEM_DESPESA ILIKE '%advoc%' OR DS_ORIGEM_DESPESA ILIKE '%contab%')
GROUP BY 1, 2, 3
ORDER BY total DESC
LIMIT 50`,
      },
      {
        pergunta: 'Há despesas registradas com valores redondos repetidos (R$ 10 mil, R$ 50 mil)?',
        sql: `-- notas de valor redondo (múltiplo de R$ 1.000) repetidas 3+ vezes no mesmo fornecedor
SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF,
       COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS fornecedor,
       valor / qt_linhas AS valor_da_nota,
       SUM(qt_linhas) AS notas,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE (valor / qt_linhas) >= 1000 AND (valor / qt_linhas) % 1000 = 0
GROUP BY ALL
HAVING SUM(qt_linhas) >= 3
ORDER BY total DESC
LIMIT 50`,
      },
      {
        pergunta: 'Qual candidato mais gastou com combustível no meu estado?',
        sql: `-- troque 'SP' pela sua UF
SELECT NM_CANDIDATO, SG_PARTIDO, DS_CARGO, ROUND(SUM(valor), 2) AS total
FROM despesas_atual
WHERE SG_UF = 'SP' AND DS_ORIGEM_DESPESA ILIKE '%combust%'
GROUP BY 1, 2, 3
ORDER BY total DESC
LIMIT 30`,
      },
      {
        pergunta: 'Quais doadores aparecem doando para candidatos de partidos rivais?',
        sql: `-- doadores identificados com doações diretas a 2+ partidos
SELECT COALESCE(NULLIF(NM_DOADOR_RFB, '#NULO'), NM_DOADOR) AS doador,
       NR_CPF_CNPJ_DOADOR AS codigo,
       COUNT(DISTINCT SG_PARTIDO) AS partidos,
       STRING_AGG(DISTINCT SG_PARTIDO, ', ' ORDER BY SG_PARTIDO) AS quais,
       ROUND(SUM(valor), 2) AS total_doado
FROM receitas_atual
WHERE NR_CPF_CNPJ_DOADOR NOT IN ('-1', '#NULO')
  AND DS_ORIGEM_RECEITA NOT ILIKE '%partid%'
GROUP BY 1, 2
HAVING COUNT(DISTINCT SG_PARTIDO) >= 2
ORDER BY partidos DESC, total_doado DESC
LIMIT 50`,
      },
      {
        pergunta: 'Algum fornecedor de campanha também é doador do mesmo candidato?',
        sql: SQL_DOADOR_FORNECEDOR,
      },
    ],
  },
  {
    titulo: 'Investigações avançadas — cruzando estados e tabelas',
    perguntas: [
      {
        pergunta: 'Quais empresas atendem candidatos em três ou mais estados — e quanto recebem em cada um?',
        sql: `-- empresas presentes em 3+ estados, com o total recebido em cada um
WITH multi AS (
  SELECT NR_CPF_CNPJ_FORNECEDOR AS cnpj
  FROM despesas_atual
  WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14
  GROUP BY 1
  HAVING COUNT(DISTINCT SG_UF) >= 3
)
SELECT COALESCE(NULLIF(d.NM_FORNECEDOR_RFB, '#NULO'), d.NM_FORNECEDOR) AS fornecedor,
       d.NR_CPF_CNPJ_FORNECEDOR AS cnpj, d.SG_UF,
       COUNT(DISTINCT d.SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(d.valor), 2) AS total_na_uf
FROM despesas_atual d
JOIN multi ON multi.cnpj = d.NR_CPF_CNPJ_FORNECEDOR
GROUP BY 1, 2, 3
ORDER BY fornecedor, total_na_uf DESC
LIMIT 200`,
      },
      {
        pergunta: 'Compare o preço mediano de impulsionamento digital entre SP, RJ e a mediana nacional.',
        sql: `-- troque as UFs à vontade; 'BR-TODAS' é a régua nacional
SELECT SG_UF, DS_ORIGEM_DESPESA, notas,
       ROUND(mediana, 2) AS mediana, ROUND(p75, 2) AS p75, ROUND(p95, 2) AS p95
FROM benchmark_precos
WHERE DS_ORIGEM_DESPESA ILIKE '%impulsionamento%'
  AND SG_UF IN ('SP', 'RJ', 'BR-TODAS')
ORDER BY SG_UF
LIMIT 30`,
      },
      {
        pergunta: 'Quais empresas abertas depois de outubro de 2025 já recebem de campanha — e em quantos estados?',
        sql: `-- empresas criadas às vésperas da eleição; as que atendem vários estados vêm primeiro
SELECT f.cnpj, f.razao_social, f.data_abertura, f.uf AS uf_da_empresa,
       COUNT(DISTINCT d.SG_UF) AS ufs,
       STRING_AGG(DISTINCT d.SG_UF, ', ' ORDER BY d.SG_UF) AS estados,
       COUNT(DISTINCT d.SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(d.valor), 2) AS total
FROM fornecedores f
JOIN despesas_atual d ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj
WHERE f.data_abertura >= '2025-10-01'
GROUP BY 1, 2, 3, 4
ORDER BY ufs DESC, total DESC
LIMIT 30`,
      },
      {
        pergunta: 'Monte o ranking de estados por percentual de gasto sem nota fiscal, só entre quem gastou acima de R$ 100 mil.',
        sql: `-- percentual do gasto sem documento fiscal por UF (candidatos com R$ 100 mil+ contratados)
SELECT SG_UF,
       COUNT(*) AS candidatos,
       ROUND(SUM(valor_sem_nota), 2) AS sem_nota,
       ROUND(SUM(total_contratado), 2) AS contratado,
       ROUND(100.0 * SUM(valor_sem_nota) / NULLIF(SUM(total_contratado), 0), 1) AS pct_sem_nota
FROM indicadores
WHERE total_contratado > 100000
GROUP BY 1
ORDER BY pct_sem_nota DESC
LIMIT 30`,
      },
      {
        pergunta: 'Algum fornecedor teve o CNPJ baixado na Receita depois de começar a receber da campanha?',
        sql: `-- situação cadastral que mudou para BAIXADA entre as nossas consultas à Receita.
-- Monitor contínuo: vem vazio enquanto nenhuma baixa tiver sido detectada.
SELECT f.cnpj, f.razao_social, f.situacao_anterior, f.situacao, f.dt_situacao_anterior,
       COUNT(DISTINCT d.SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(d.valor), 2) AS recebido
FROM fornecedores f
JOIN despesas_atual d ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj
WHERE f.situacao_anterior IS NOT NULL AND f.situacao ILIKE '%BAIX%'
GROUP BY 1, 2, 3, 4, 5
ORDER BY recebido DESC
LIMIT 30`,
      },
      {
        pergunta: 'Quais doadores originários estão por trás de repasses partidários a candidatos de estados diferentes?',
        sql: `-- doador originário = a origem real do dinheiro que chegou via partido/outro candidato
SELECT contraparte AS doador_originario, contraparte_id,
       COUNT(DISTINCT SG_UF) AS ufs,
       STRING_AGG(DISTINCT SG_UF, ', ' ORDER BY SG_UF) AS estados,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor), 2) AS total
FROM rede
WHERE tipo = 'doacao_originaria' AND contraparte_id NOT IN ('-1', '#NULO')
GROUP BY 1, 2
HAVING COUNT(DISTINCT SG_UF) >= 2
ORDER BY total DESC
LIMIT 30`,
      },
      {
        pergunta: 'Qual a evolução do gasto declarado dos candidatos a governador, comparando três estados?',
        sql: `-- "como estava declarado em cada dia de extração" — troque as UFs à vontade
SELECT dt_extracao, SG_UF, ROUND(SUM(total_contratado), 2) AS total_declarado
FROM serie_diaria
WHERE DS_CARGO ILIKE '%governador%' AND SG_UF IN ('SP', 'RJ', 'MG')
GROUP BY 1, 2
ORDER BY 1, 2
LIMIT 500`,
      },
      {
        pergunta: 'Quem gasta com uma categoria muito acima do p95 do seu grupo de comparação?',
        sql: SQL_FORA_DA_CURVA_CATEGORIA,
      },
    ],
  },
];
