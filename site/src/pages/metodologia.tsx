const REPO = 'https://github.com/machadouglas/analise-gastos-campanha';

function Bloco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold tracking-tight">{titulo}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-muted-foreground [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

export function Metodologia() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
      <p className="text-sm font-semibold uppercase tracking-widest text-[#264E9B]">Metodologia</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
        Como este radar funciona
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
        Transparência exige método transparente. Esta página documenta de onde vêm os dados, o que
        fazemos com eles, o que as palavras significam — e como pedir correção.
      </p>

      <Bloco titulo="De onde vêm os dados">
        <p>
          Todos os dados exibidos vêm do{' '}
          <a className="text-[#264E9B] underline underline-offset-4" href="https://dadosabertos.tse.jus.br" rel="noopener">
            Portal de Dados Abertos do TSE
          </a>{' '}
          — a prestação de contas oficial das Eleições 2026 (despesas contratadas, despesas pagas,
          receitas, doadores originários) e o registro de candidaturas. O cadastro dos fornecedores
          (data de abertura, porte, sócios, sede) vem do cadastro público de CNPJ da Receita
          Federal, consultado via BrasilAPI. As fotos dos candidatos são carregadas diretamente
          do serviço oficial de divulgação de candidaturas do TSE (DivulgaCandContas), sem cópia
          nem armazenamento nosso. Nenhum dado é coletado de fontes privadas.
        </p>
        <p>
          <strong>Os dados são declaratórios</strong>: refletem o que os próprios candidatos
          informam ao TSE, com as imprecisões e atrasos que isso implica, e podem ser retificados
          por eles a qualquer momento.
        </p>
      </Bloco>

      <Bloco titulo="O que fazemos com eles">
        <p>
          Uma rotina automática baixa os arquivos do TSE <strong>todos os dias</strong> e guarda
          uma fotografia datada de cada extração. É isso que permite o diferencial deste radar:
          mostrar o que foi <strong>removido ou alterado</strong> nas declarações — informação que
          o portal oficial não exibe, porque só mostra o estado atual.
        </p>
        <p>
          Antes de publicar, a rotina passa por checagens automáticas de integridade (valores que
          não convertem, datas impossíveis, totais que não fecham entre visões independentes dos
          mesmos dados). Se qualquer checagem falha, <strong>nada é publicado</strong> naquele dia.
          Distinguimos remoção real de reprocessamento técnico e de correção. Quando o sistema do
          TSE renumera notas ao receber uma retransmissão, o fato (candidato, fornecedor,
          descrição, valor e data) continua declarado — não é remoção. E quando a declaração
          reaparece para o mesmo par candidato↔fornecedor com <strong>um</strong> desses campos
          corrigido — o valor, a descrição ou a data —, tratamos como{' '}
          <strong>alteração</strong>, não como declaração apagada. Só sobra como removido o que
          sumiu e não voltou de nenhuma dessas formas. Na dúvida entre as duas leituras ficamos
          com a mais branda de propósito: chamar de "apagada" uma linha que foi apenas corrigida
          seria afirmar algo mais grave do que os dados sustentam.
        </p>
        <p>
          Por que isso importa — e até onde. A Justiça Eleitoral trata a omissão de informação na
          prestação de contas como o caminho típico de ocultar contabilidade paralela (o “caixa 2”,
          art. 30-A da Lei 9.504/97), e classifica como falha grave a divergência não explicada
          entre o que foi declarado antes e depois de uma retificadora. Mas retificar é legítimo e
          corriqueiro: quando a correção é justificada, sem má-fé e sem prejuízo à fiscalização, os
          tribunais a tratam como falha formal ou simples ressalva. Por isso uma remoção isolada é
          só um ponto de partida — o que pesa é o volume, o valor e a explicação.
        </p>
      </Bloco>

      <Bloco titulo="O que as palavras significam">
        <p>
          <strong>Indício não é acusação.</strong> Tudo que este site marca — concentração em um
          fornecedor, gasto acima do arrecadado, valores repetidos, declarações removidas, CNPJ
          recém-aberto — é um <strong>fato contável</strong> extraído do que foi declarado, que
          pode ter explicação perfeitamente legítima. Um valor removido pode ter sido substituído
          por outra declaração que a nossa régua não conseguiu ligar à primeira; um fornecedor
          compartilhado pode ser simplesmente a melhor gráfica da cidade. O papel do radar é tornar os fatos visíveis para que cidadãos, jornalistas e
          órgãos de controle façam as perguntas — nunca afirmar irregularidade, fraude ou crime.
        </p>
        <p>
          Há duas réguas distintas no site, e elas não se misturam: os{' '}
          <strong>chips âmbar das fichas</strong> marcam fatos absolutos do próprio candidato
          (gastou mais do que arrecadou, tem valor sem nota, teve declaração removida), enquanto
          o <strong>"fora da curva"</strong> compara o candidato ao grupo — um candidato pode ter
          chips na ficha sem estar fora da curva, e vice-versa.
        </p>
        <p>
          <strong>"Fora da curva"</strong> significa estar acima do percentil 95 do{' '}
          <strong>grupo de comparação</strong>: candidatos ao mesmo cargo na mesma UF (ou no país,
          quando o grupo local tem menos de 20 candidatos). Nunca comparamos um candidato a
          presidente com um a deputado estadual, nem um número absoluto com um limiar inventado —
          cada sinal informa o valor do candidato, a mediana e o p95 do grupo, todos conferíveis
          na página Consultar. Sem letra miúda: quando uma métrica em porcentagem satura (5% ou
          mais do grupo em 100%, o que leva o próprio p95 a 100), "acima do p95" é impossível por
          definição — e o sinal simplesmente não dispara nesse grupo, em vez de marcar todo mundo
          que está no teto como se fosse exceção.
        </p>
        <p>
          Detalhes de cálculo que evitam falsos positivos: <strong>preços</strong> são comparados
          por <em>nota</em> (soma dos itens de uma mesma nota), não por item, para que notas
          fatiadas não distorçam a régua; <strong>"sem documento fiscal"</strong> só marca gasto com
          empresa, sem nota nem cupom fiscal, em tipo de gasto que costuma ter documento fiscal —
          a régua sai dos próprios dados (categoria em que menos da metade do valor tem nota,
          como impulsionamento ou honorários, não vira indício), e categorias em que a nota nunca
          é o documento próprio (transferências, tributos, tarifas, aluguel, pessoal) ficam
          sempre de fora; <strong>valores repetidos</strong> só contam quando aparecem em 3+
          notas distintas <em>do mesmo fornecedor</em>; a razão{' '}
          <strong>gasto ÷ arrecadado</strong> só conta como sinal quando o candidato contratou
          pelo menos 10% acima do que declarou arrecadar (razão acima de 1,10×) — no início da
          campanha o p95 de muitos grupos é próximo de zero, quem gastou menos do que arrecadou
          não merece marca por isso, e estourar por poucos por cento costuma ser descompasso de
          calendário (nota contratada antes de o repasse entrar), não indício; <strong>"dinheiro público"</strong> soma
          Fundo Especial e Fundo Partidário pela fonte oficial da receita; e o indicador de{' '}
          <strong>CNPJ recém-aberto</strong> (empresa criada a partir de outubro do ano anterior à
          eleição) sempre informa quantos dos fornecedores do candidato já foram verificados na
          Receita — o cadastro é consultado aos poucos, e "nenhum encontrado" só vale para o que
          já foi olhado. O cadastro também é <strong>reconsultado continuamente</strong> (os
          registros mais antigos primeiro, num ciclo de ~30 dias): se a situação cadastral de um
          fornecedor mudar — uma empresa ativa que é baixada, por exemplo —, a situação anterior e
          a data da mudança ficam registradas nos dados publicados. Quando o CNPJ declarado ao TSE
          não corresponde a <strong>nenhum cadastro</strong> na base pública consultada, a ficha do
          fornecedor diz isso explicitamente, com a data da consulta: pode ser erro de digitação na
          declaração, empresa aberta há poucos dias e ainda não replicada, ou número que nunca
          existiu — e o radar reconsulta periodicamente.
        </p>
      </Bloco>

      <Bloco titulo="Privacidade">
        <p>
          Os arquivos oficiais do TSE trazem o CPF completo de pessoas físicas que aparecem como
          doadoras ou fornecedoras. Pessoa física não é figura pública: nos dados que republicamos
          (Parquet e resumo), cada CPF é substituído por um <strong>código pseudonimizado</strong>{' '}
          (<code>pf-</code> + 16 caracteres), estável entre publicações — as análises, junções e
          contagens continuam possíveis, mas o número em si não é recuperável a partir dos nossos
          dados (a transformação usa um segredo que não é publicado). O site nunca exibe CPF e as
          fichas de pessoa física ficam fora dos buscadores (princípio da minimização). Quem
          precisar do dado bruto encontra na fonte primária, o próprio TSE. CNPJs de empresas são
          dados públicos plenos e aparecem completos.
        </p>
      </Bloco>

      <Bloco titulo="Reprodutibilidade">
        <p>
          Nada aqui exige confiança cega: o{' '}
          <a className="text-[#264E9B] underline underline-offset-4" href={REPO} rel="noopener">código-fonte</a>{' '}
          é aberto, os{' '}
          <a className="text-[#264E9B] underline underline-offset-4" href={`${REPO}/releases/tag/dados`} rel="noopener">
            dados em Parquet
          </a>{' '}
          (histórico incluso) são publicados diariamente, e a página Consultar permite refazer
          qualquer número deste site no seu próprio navegador. Se você chegar a um resultado
          diferente do nosso, um dos dois está errado — e queremos saber.
        </p>
      </Bloco>

      <Bloco titulo="Correções">
        <p>
          Encontrou um erro — número que não bate, dado desatualizado, algo que a metodologia
          deveria tratar melhor? Abra um relato público em{' '}
          <a className="text-[#264E9B] underline underline-offset-4" href={`${REPO}/issues`} rel="noopener">
            {REPO.replace('https://', '')}/issues
          </a>
          . Correções procedentes são aplicadas e ficam registradas no histórico público do
          projeto. Retificações feitas pelos candidatos junto ao TSE aparecem aqui automaticamente
          na extração seguinte.
        </p>
      </Bloco>
    </div>
  );
}
