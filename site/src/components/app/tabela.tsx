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

export function CelulaNum({ children }: { children: React.ReactNode }) {
  return <td className="text-right tabular-nums whitespace-nowrap">{children}</td>;
}
