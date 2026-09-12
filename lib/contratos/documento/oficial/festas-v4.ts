import { configuracaoModeloOficialV3, renderizarContratoOficialFestasV3 } from './festas-v3.ts';
import type { ContratoOficialRenderizado, GerarContratoOficialInput } from './models.ts';

export const CLAUSULA_QUATRO_V4 = 'Crianças de 0 a 5 anos e 11 meses não contarão como convidados. Essa cortesia é limitada a um terço do total de pagantes. Se o aniversariante for menor de 16 anos, o pai, a mãe e os irmãos participarão como cortesia.';

export function configuracaoModeloOficialV4(codigo: string) {
  const anterior = configuracaoModeloOficialV3(codigo);
  return anterior ? { ...anterior, modeloCodigo: anterior.modeloCodigo.replace(/_V3$/, '_V4'), templateVersao: 4 as const } : null;
}

/** Revisão jurídica oficial: somente a faixa etária da Cláusula 4 mudou. */
export function renderizarContratoOficialFestasV4(input: GerarContratoOficialInput): ContratoOficialRenderizado {
  const perfil = configuracaoModeloOficialV4(input.snapshot.evento.pacote.codigo);
  if (!perfil) throw new Error('Pacote sem configuração oficial.');
  const documento = renderizarContratoOficialFestasV3(input);
  documento.clausulas[3] = { ...documento.clausulas[3], texto: CLAUSULA_QUATRO_V4 };
  return { ...documento, modeloCodigo: perfil.modeloCodigo, templateVersao: perfil.templateVersao };
}
