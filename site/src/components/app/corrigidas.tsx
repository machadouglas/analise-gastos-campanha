import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Secao } from '@/components/app/secao';
import { Tabela } from '@/components/app/tabela';
import { brl, celula, temFichaFornecedor, urlFornecedor } from '@/lib/format';

/** Uma retificação, já pareada pelo backend (v_alteradas_pares_*): a versão que
 *  saiu do ar e a que está no lugar dela. */
export interface Corrigida {
  campo: string;
  nomeContraparte: string;
  contraparte: string;
  sqCandidato: string;
  nomeCandidato: string;
  descricaoAntes: string;
  descricaoDepois: string;
  valorAntes: number;
  valorDepois: number;
  dataAntes: string;
  dataDepois: string;
  visivelDe: string;
  visivelAte: string;
  /** quantas declarações vivas serviriam de sucessora desta. 1 = o antes/depois
   *  é certo; mais que isso, não dá para saber qual substituiu qual. */
  sucessores: number;
}

/** Constrói as linhas a partir do resultado de sqlCorrigidas (ordem das colunas
 *  fixada lá) — as duas fichas consomem a mesma consulta. */
export function montarCorrigidas(linhas: unknown[][]): Corrigida[] {
  return linhas.map((l) => ({
    campo: celula(l[0]),
    nomeContraparte: celula(l[1]),
    contraparte: celula(l[2]),
    sqCandidato: celula(l[3]),
    nomeCandidato: celula(l[4]),
    descricaoAntes: celula(l[7]),
    descricaoDepois: celula(l[8]),
    valorAntes: Number(l[9] ?? 0),
    valorDepois: Number(l[10] ?? 0),
    dataAntes: celula(l[11]),
    dataDepois: celula(l[12]),
    visivelDe: celula(l[13]),
    visivelAte: celula(l[14]),
    sucessores: Number(l[15] ?? 1),
  }));
}

const ROTULO: Record<string, string> = {
  valor: 'Valor',
  descricao: 'Descrição',
  data: 'Data',
};

/** O par antes/depois do campo que mudou. Só um campo muda por retificação —
 *  é a própria régua do pareamento (2 de 3 campos iguais). */
function parDoCampo(c: Corrigida): [antes: string, depois: string] {
  if (c.campo === 'valor') return [brl.format(c.valorAntes), brl.format(c.valorDepois)];
  if (c.campo === 'data') return [c.dataAntes, c.dataDepois];
  return [c.descricaoAntes, c.descricaoDepois];
}

/** Quantas vezes o valor mudou — "corrigiu de R$ 1 bi para R$ 1 mi" é outra
 *  história que "ajustou R$ 12". Só faz sentido para o campo valor. */
function fator(c: Corrigida): number | null {
  if (c.campo !== 'valor') return null;
  const [menor, maior] = [Math.min(c.valorAntes, c.valorDepois), Math.max(c.valorAntes, c.valorDepois)];
  if (menor <= 0 || maior / menor < 2) return null;
  return maior / menor;
}

/**
 * Retificações da prestação: o que foi declarado, saiu do ar e voltou com um
 * campo diferente. Corrigir é legítimo e corriqueiro — o que interessa aqui é o
 * tamanho da correção, e por isso a lista vem ordenada por ela.
 *
 * Esta seção é irmã da de declarações removidas, e existe em parte para tornar
 * a régua auditável: sem ela, o site dizia quantas declarações sumiram sem
 * mostrar as que deixou de contar como sumidas.
 */
export function SecaoCorrigidas({
  itens,
  coluna,
  tipo,
}: {
  itens: Corrigida[];
  /** quem identifica a linha: a ficha do candidato mostra a contraparte, a do
   *  fornecedor mostra o candidato */
  coluna: 'contraparte' | 'candidato';
  /** as duas fichas mostram os dois lados do dinheiro, e cada um vira sua
   *  própria seção — dois blocos "Declarações corrigidas" na mesma página não
   *  dariam para distinguir */
  tipo: 'despesa' | 'receita';
}) {
  if (!itens.length) return null;
  const oQue = tipo === 'despesa' ? 'Despesas' : 'Receitas';
  return (
    <Secao
      titulo={`${oQue} corrigidas`}
      descricao={
        `${oQue} que saíram do ar e voltaram com um campo diferente — valor, descrição ou data.`
        + ' Retificar a prestação é legítimo e comum; o que pede explicação é o tamanho da'
        + ' correção. Estas NÃO entram na conta de declarações removidas.'
      }
    >
      <Tabela
        colunas={[
          {
            titulo:
              coluna === 'candidato' ? 'Candidato' : tipo === 'despesa' ? 'Fornecedor' : 'Doador',
          },
          { titulo: 'O que mudou' },
          { titulo: 'Antes' },
          { titulo: 'Depois' },
          { titulo: 'Visível de' },
          { titulo: 'Até' },
        ]}
      >
        {itens.map((c, i) => {
          const [antes, depois] = parDoCampo(c);
          const f = fator(c);
          return (
            <tr key={i}>
              <td className="min-w-[11rem]">
                {coluna === 'contraparte' ? (
                  temFichaFornecedor(c.contraparte) ? (
                    <Link
                      to={urlFornecedor(c.contraparte)}
                      className="text-[#264E9B] underline-offset-4 hover:underline"
                    >
                      {c.nomeContraparte}
                    </Link>
                  ) : (
                    c.nomeContraparte
                  )
                ) : (
                  <Link
                    to={`/candidato/${c.sqCandidato}`}
                    className="text-[#264E9B] underline-offset-4 hover:underline"
                  >
                    {c.nomeCandidato}
                  </Link>
                )}
              </td>
              <td className="whitespace-nowrap text-muted-foreground">
                {ROTULO[c.campo] ?? c.campo}
                {f && (
                  <span
                    className="ml-1.5 rounded-full border border-[#B45309]/40 bg-[#B45309]/10 px-2 py-0.5 text-[0.68rem] font-medium text-[#7c3a06]"
                    title="Quantas vezes o valor mudou entre a declaração antiga e a atual."
                  >
                    {f >= 10
                      ? `${Math.round(f).toLocaleString('pt-BR')}×`
                      : `${f.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}×`}
                  </span>
                )}
              </td>
              {/* line-through no "antes": o que está riscado é o que saiu do ar */}
              <td className="min-w-[9rem] text-muted-foreground line-through decoration-muted-foreground/50">
                {antes}
              </td>
              <td className="min-w-[9rem] font-medium text-[#10244A]">
                <ArrowRight aria-hidden className="mr-1 inline h-3 w-3 align-[-1px] text-muted-foreground" />
                {depois}
                {/* quando várias declarações atuais servem de sucessora, dizer
                    isso é obrigatório: escolher uma e mostrá-la sozinha
                    afirmaria um pareamento que os dados não sustentam */}
                {c.sucessores > 1 && (
                  <span
                    className="ml-1.5 whitespace-nowrap text-[0.68rem] font-normal text-muted-foreground"
                    title={`Esta declaração saiu do ar e ${c.sucessores} declarações atuais deste mesmo par candidato↔contraparte diferem dela em um só campo. Não dá para saber qual substituiu qual — esta é uma delas.`}
                  >
                    (1 de {c.sucessores} possíveis)
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap text-muted-foreground">{c.visivelDe}</td>
              <td className="whitespace-nowrap text-muted-foreground">{c.visivelAte}</td>
            </tr>
          );
        })}
      </Tabela>
    </Secao>
  );
}
