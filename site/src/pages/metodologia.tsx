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
    <div className="mx-auto max-w-3xl px-6 py-12">
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
          Federal, consultado via BrasilAPI. Nenhum dado é coletado de fontes privadas.
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
          Distinguimos remoção real de reprocessamento técnico: quando o sistema do TSE renumera
          notas ao receber uma retransmissão, o fato (candidato, fornecedor, descrição, valor e
          data) continua declarado — e não contamos como remoção.
        </p>
      </Bloco>

      <Bloco titulo="O que as palavras significam">
        <p>
          <strong>Indício não é acusação.</strong> Tudo que este site marca — concentração em um
          fornecedor, gasto acima do arrecadado, valores repetidos, declarações removidas, CNPJ
          recém-aberto — é um <strong>fato contável</strong> extraído do que foi declarado, que
          pode ter explicação perfeitamente legítima. Um valor removido pode ser correção de erro
          de digitação; um fornecedor compartilhado pode ser simplesmente a melhor gráfica da
          cidade. O papel do radar é tornar os fatos visíveis para que cidadãos, jornalistas e
          órgãos de controle façam as perguntas — nunca afirmar irregularidade, fraude ou crime.
        </p>
        <p>
          <strong>"Fora da curva"</strong> significa estar acima do percentil 95 do{' '}
          <strong>grupo de comparação</strong>: candidatos ao mesmo cargo na mesma UF (ou no país,
          quando o grupo local tem menos de 20 candidatos). Nunca comparamos um candidato a
          presidente com um a deputado estadual, nem um número absoluto com um limiar inventado —
          cada sinal informa o valor do candidato, a mediana e o p95 do grupo, todos conferíveis
          na página Consultar.
        </p>
        <p>
          Detalhes de cálculo que evitam falsos positivos: <strong>preços</strong> são comparados
          por <em>nota</em> (soma dos itens de uma mesma nota), não por item, para que notas
          fatiadas não distorçam a régua; <strong>"sem nota fiscal"</strong> exclui categorias em
          que a nota não é o documento próprio (transferências, tributos, tarifas, aluguel de
          imóveis, pessoal); <strong>valores repetidos</strong> só contam quando aparecem em 3+
          notas distintas <em>do mesmo fornecedor</em>; a razão{' '}
          <strong>gasto ÷ arrecadado</strong> só conta como sinal quando o candidato contratou
          mais do que declarou arrecadar (razão acima de 1×) — no início da campanha o p95 de
          muitos grupos é próximo de zero, e quem gastou menos do que arrecadou não merece
          marca por isso; <strong>"dinheiro público"</strong> soma
          Fundo Especial e Fundo Partidário pela fonte oficial da receita; e o indicador de{' '}
          <strong>CNPJ recém-aberto</strong> (empresa criada a partir de outubro do ano anterior à
          eleição) sempre informa quantos dos fornecedores do candidato já foram verificados na
          Receita — o cadastro é consultado aos poucos, e "nenhum encontrado" só vale para o que
          já foi olhado.
        </p>
      </Bloco>

      <Bloco titulo="Privacidade">
        <p>
          CPFs de candidatos já chegam anonimizados pelo próprio TSE. CPFs de pessoas físicas que
          aparecem como fornecedoras ou doadoras são públicos nos arquivos oficiais, mas aqui são
          exibidos <strong>mascarados</strong> e suas fichas ficam fora dos buscadores — pessoa
          física não é figura pública, e mostramos apenas o necessário para conferência (princípio
          da minimização). CNPJs de empresas são dados públicos plenos e aparecem completos.
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
