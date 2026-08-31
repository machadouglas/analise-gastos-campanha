import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Bloco de conteúdo com título e uma linha explicando o que ele mostra.
 *  Estava duplicado nas fichas de candidato e de fornecedor; virou compartilhado
 *  quando a seção de declarações corrigidas passou a servir as duas. */
export function Secao({
  titulo,
  descricao,
  children,
}: {
  titulo: string;
  descricao: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{titulo}</CardTitle>
        <CardDescription>{descricao}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
