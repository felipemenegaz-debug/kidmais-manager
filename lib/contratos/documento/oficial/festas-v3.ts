import { configuracaoModeloOficial } from './configuracao.ts';
import { renderizarContratoOficialFestasV2 } from './festas-v2.ts';
import type { ContratoOficialRenderizado, GerarContratoOficialInput } from './models.ts';

export function configuracaoModeloOficialV3(codigo: string) {
  const anterior = configuracaoModeloOficial(codigo);
  return anterior ? { ...anterior, modeloCodigo: anterior.modeloCodigo.replace(/_V2$/, '_V3'), templateVersao: 3 as const } : null;
}

/** Acabamento aprovado: singular da idade e três correções de concordância. */
export function renderizarContratoOficialFestasV3(input: GerarContratoOficialInput): ContratoOficialRenderizado {
  const perfil = configuracaoModeloOficialV3(input.snapshot.evento.pacote.codigo);
  if (!perfil) throw new Error('Pacote sem configuração oficial.');
  const documento = renderizarContratoOficialFestasV2(input);
  const a = input.snapshot.aniversariante;
  if (a.idadeNoEvento === 1) {
    documento.contratante[2] = documento.contratante[2].replace(`Aniversariante: ${a.nome}, 1 anos.`, `Aniversariante: ${a.nome}, 1 ano.`);
  }
  documento.clausulas[4].texto = documento.clausulas[4].texto.replace('se houve estoque disponível', 'se houver estoque disponível');
  documento.clausulas[7].texto = documento.clausulas[7].texto
    .replace('O espaço do subsolo e o buffet terminará', 'O funcionamento do espaço do subsolo e do buffet terminará')
    .replace('os parabéns será cantado', 'os parabéns serão cantados');
  return { ...documento, modeloCodigo: perfil.modeloCodigo, templateVersao: perfil.templateVersao };
}
