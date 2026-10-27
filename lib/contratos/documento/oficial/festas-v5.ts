import { rotuloSalao, salaoDoSnapshot } from '../../repositories/models.ts';
import { configuracaoModeloOficialV4, renderizarContratoOficialFestasV4 } from './festas-v4.ts';
import type { ContratoOficialRenderizado, GerarContratoOficialInput } from './models.ts';

export function configuracaoModeloOficialV5(codigo: string) {
  const anterior = configuracaoModeloOficialV4(codigo);
  return anterior ? { ...anterior, modeloCodigo: anterior.modeloCodigo.replace(/_V4$/, '_V5'), templateVersao: 5 as const } : null;
}

/** Fim da frase do evento na Cláusula 1 (V1–V4): "... na KidMais Festas localizada na <endereço>." */
const FIM_LOCAL_EVENTO = /na KidMais Festas localizada na .+\.$/;

/**
 * S-E (plano S-E/S-D rev. 4.1): V4 + o salão fixado no snapshot V3, acrescentado ao fim da frase do evento na
 * Cláusula 1 (em destaque). Sem salão (V1/V2, V3 nulo) o texto é exatamente o da V4; só o código/versão mudam.
 */
export function renderizarContratoOficialFestasV5(input: GerarContratoOficialInput): ContratoOficialRenderizado {
  const perfil = configuracaoModeloOficialV5(input.snapshot.evento.pacote.codigo);
  if (!perfil) throw new Error('Pacote sem configuração oficial.');
  const documento = renderizarContratoOficialFestasV4(input);
  const salao = salaoDoSnapshot(input.snapshot);
  if (salao) {
    const objeto = documento.clausulas[0];
    if (!FIM_LOCAL_EVENTO.test(objeto.texto)) throw new Error('Base jurídica da Cláusula 1 divergente.');
    const destaque = rotuloSalao(salao.nome);
    documento.clausulas[0] = {
      ...objeto,
      texto: `${objeto.texto.slice(0, -1)}, no ${destaque}.`,
      destaques: [...(objeto.destaques ?? []), destaque],
    };
  }
  return { ...documento, modeloCodigo: perfil.modeloCodigo, templateVersao: perfil.templateVersao };
}
