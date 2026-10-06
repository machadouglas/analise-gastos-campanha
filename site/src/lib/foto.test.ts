import { describe, expect, it } from 'vitest';
import { urlFotoCandidato } from './foto';

describe('urlFotoCandidato', () => {
  it('traduz o CD_ELEICAO dos dados abertos para o id do DivulgaCand', () => {
    const base = 'https://divulgacandcontas.tse.jus.br/divulga/rest/arquivo/img/20322002026';
    expect(urlFotoCandidato('6259', '250002533666', 'SP')).toBe(`${base}/250002533666/SP`);
    expect(urlFotoCandidato('6257', '280002538811', 'BR')).toBe(`${base}/280002538811/BR`);
  });

  it('código desconhecido não vira URL (o TSE devolveria a silhueta com 200)', () => {
    expect(urlFotoCandidato('9999', '250002533666', 'SP')).toBeNull();
  });

  it('sem algum dos metadados, sem URL', () => {
    expect(urlFotoCandidato(null, '250002533666', 'SP')).toBeNull();
    expect(urlFotoCandidato('6259', null, 'SP')).toBeNull();
    expect(urlFotoCandidato('6259', '250002533666', undefined)).toBeNull();
  });
});
