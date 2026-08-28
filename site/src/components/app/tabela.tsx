import { cn } from '@/lib/utils';

interface Coluna {
  titulo: string;
  numerica?: boolean;
}

export function Tabela({
  colunas,
  children,
  className,
}: {
  colunas: Coluna[];
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('overflow-x-auto rounded-xl border bg-card shadow-sm', className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {colunas.map((c) => (
              <th
                key={c.titulo}
                className={cn(
                  'border-b px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground',
                  c.numerica && 'text-right',
                )}
              >
                {c.titulo}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:px-4 [&_td]:py-2.5 [&_td]:align-top [&_tr:last-child_td]:border-b-0">
          {children}
        </tbody>
      </table>
    </div>
  );
}

/** Célula numérica; com `frac` (0–1, valor ÷ maior da coluna) desenha uma
 *  micro-barra proporcional atrás do número — a coluna vira legível de relance,
 *  sem precisar comparar dígitos linha a linha. */
export function CelulaNum({ children, frac }: { children: React.ReactNode; frac?: number }) {
  if (frac == null || !isFinite(frac)) {
    return <td className="text-right tabular-nums whitespace-nowrap">{children}</td>;
  }
  const pct = Math.min(Math.max(frac, 0), 1) * 100;
  return (
    <td className="text-right tabular-nums whitespace-nowrap">
      <span className="relative inline-block min-w-[7rem]">
        <span
          aria-hidden
          className="absolute inset-y-[-2px] right-0 rounded-sm bg-[#264E9B]/10"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
        <span className="relative pr-1">{children}</span>
      </span>
    </td>
  );
}

/** Texto livre (descrições de contrato etc.): a coluna elástica da tabela —
 *  absorve o espaço que sobra (w-full) em vez de exigir largura própria, com
 *  no máximo duas linhas e o texto completo no title. Sem isso, uma única
 *  descrição enorme alarga a coluna e empurra o Valor para fora da tela. */
export function CelulaTexto({ children, title }: { children: React.ReactNode; title?: string }) {
  const texto = title ?? (typeof children === 'string' ? children : undefined);
  return (
    <td className="w-full">
      {/* overflow-wrap:anywhere (e não break-words): só ele entra no cálculo
          de largura mínima da coluna — um token gigante sem espaços deixa de
          ditar a largura da tabela inteira */}
      <div className="line-clamp-2 max-w-[36rem] [overflow-wrap:anywhere]" title={texto}>
        {children}
      </div>
    </td>
  );
}
