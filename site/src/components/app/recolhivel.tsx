import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/** Seção recolhível no estilo dos Cards: com muitos gráficos por página, cada
 *  bloco declara se abre por padrão — o leitor expande o que quiser sem a
 *  página virar um paredão. Usa <details> nativo (acessível, sem JS): o
 *  atributo open só é aplicado quando `aberta` (default), e o toggle do
 *  usuário fica com o navegador — o React não o sobrescreve em re-render.
 *  O conteúdo só monta na primeira abertura (gráficos densos não pagam custo
 *  de render enquanto a seção nunca foi aberta) e depois permanece montado. */
export function SecaoRecolhivel({
  titulo,
  descricao,
  resumo,
  aberta = false,
  children,
}: {
  titulo: string;
  descricao?: string;
  /** número-síntese exibido ao lado do título mesmo fechada (ex.: "23 · R$ 1,2 mi") */
  resumo?: string;
  aberta?: boolean;
  children: React.ReactNode;
}) {
  const [jaAbriu, setJaAbriu] = useState(aberta);
  return (
    <details
      {...(aberta && { open: true })}
      onToggle={(e) => {
        if (e.currentTarget.open) setJaAbriu(true);
      }}
      className="group rounded-xl border bg-card shadow-sm"
    >
      <summary className="flex cursor-pointer select-none items-start justify-between gap-3 rounded-xl p-4 transition-colors hover:bg-muted/30 sm:gap-4 sm:p-6 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <p className="font-semibold leading-snug">
            {titulo}
            {resumo && (
              <span className="block text-sm font-normal tabular-nums text-muted-foreground sm:ml-2 sm:inline">{resumo}</span>
            )}
          </p>
          {descricao && (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{descricao}</p>
          )}
        </div>
        <ChevronDown className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4 sm:px-6 sm:pb-6">{jaAbriu && children}</div>
    </details>
  );
}
