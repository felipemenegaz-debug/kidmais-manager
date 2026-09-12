import { renderizarContratoOficialFestaCompletaV1 } from './festa-completa-v1.ts';
import { configuracaoModeloOficial } from './configuracao.ts';
import { formatarDataContrato, formatarMoeda } from '../formatters.ts';
import type { GerarContratoOficialInput, ContratoOficialRenderizado } from './models.ts';

/** Mesmas 18 cláusulas aprovadas da Completa V1; somente pacote e excedente mudam. */
export function renderizarContratoOficialFestasV2(input: GerarContratoOficialInput): ContratoOficialRenderizado {
  const perfil = configuracaoModeloOficial(input.snapshot.evento.pacote.codigo);
  if (!perfil) throw new Error('Pacote sem configuração oficial.');
  const snapshot = structuredClone(input.snapshot);
  snapshot.evento.pacote.nome = perfil.pacoteNome;
  const documento = renderizarContratoOficialFestaCompletaV1({ ...input, snapshot });
  const excedente = `${formatarMoeda(perfil.excedenteCentavos / 100)} por pessoa excedente`;
  // Substituição delimitada da única condição comercial alterada pela aprovação.
  const antiga = /R\$ 120,00 por pessoa excedente/;
  if (!antiga.test(documento.clausulas[2].texto)) throw new Error('Base jurídica de excedentes divergente.');
  documento.clausulas[2].texto = documento.clausulas[2].texto.replace(antiga, excedente);
  documento.clausulas[2].destaques = [excedente];
  documento.clausulas[0].destaques = [perfil.pacoteNome, formatarDataContrato(snapshot.evento.data), `${snapshot.evento.convidadosFaturados} pessoas`];
  return { ...documento, modeloCodigo: perfil.modeloCodigo, templateVersao: perfil.templateVersao, pacoteNome: perfil.pacoteNome, subtitulo: perfil.pacoteNome.toUpperCase() };
}
