import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Foto oficial do candidato, direto do serviço público de divulgação de
 *  candidaturas do TSE (hotlink — nada é copiado nem armazenado por nós).
 *  Se o TSE não responder (ou faltarem os metadados), caem as iniciais. */
export function FotoCandidato({
  cdEleicao,
  sq,
  sgUe,
  nome,
  className,
}: {
  cdEleicao?: string | null;
  sq?: string | null;
  sgUe?: string | null;
  nome: string;
  className?: string;
}) {
  const [erro, setErro] = useState(false);
  const url =
    cdEleicao && sq && sgUe
      ? `https://divulgacandcontas.tse.jus.br/divulga/rest/arquivo/img/${cdEleicao}/${sq}/${sgUe}`
      : null;

  if (!url || erro) {
    const partes = nome.trim().split(/\s+/);
    const iniciais = (partes.length > 1
      ? `${partes[0][0]}${partes[partes.length - 1][0]}`
      : partes[0]?.slice(0, 2) ?? '?'
    ).toUpperCase();
    return (
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 select-none items-center justify-center rounded-full border border-[#264E9B]/20 bg-[#264E9B]/10 font-semibold text-[#264E9B]',
          className,
        )}
      >
        {iniciais}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={`Foto oficial de ${nome} no registro de candidatura do TSE`}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setErro(true)}
      className={cn('shrink-0 rounded-full border object-cover', className)}
    />
  );
}
