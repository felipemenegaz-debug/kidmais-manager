import { renderizarContratoOficialFestaCompletaV1 } from './festa-completa-v1.ts';
import { configuracaoModeloOficial } from './configuracao.ts';
import { formatarDataContrato, formatarMoeda } from '../formatters.ts';
import type { GerarContratoOficialInput, ContratoOficialRenderizado } from './models.ts';

/** Mesmas 18 cláusulas aprovadas da Completa V1; somente pacote e excedente mudam. */
export function renderizarContratoOficialFestasV2(input: GerarContratoOficialInput): ContratoOficialRenderizado {
  const perfil = configuracaoModeloOficial(input.snapshot.evento.pacote.codigo);
  if (!perfil) throw new Error('Pacote sem configuração oficial.');
  const snapshot = structuredClone(input.snapshot);
  const nomeCongelado = snapshot.schemaVersao === 2 ? snapshot.pacoteAplicado.nome : null;
  if (!nomeCongelado) snapshot.evento.pacote.nome = perfil.pacoteNome;
  const nomeDocumento = nomeCongelado ?? perfil.pacoteNome;
  const documento = renderizarContratoOficialFestaCompletaV1({ ...input, snapshot });
  const antiga = /R\$ 120,00 por pessoa excedente/;
  if (!antiga.test(documento.clausulas[2].texto)) throw new Error('Base jurídica de excedentes divergente.');
  if (perfil.excedenteCentavos == null) {
    // Não transforma a taxa da Festa Completa em regra de outro pacote.
    // A ampliação prévia continua submetida à tabela vigente; a cobrança no dia
    // só aparece quando o pacote possui valor específico configurado.
    documento.clausulas[2].texto = documento.clausulas[2].texto.replace(
      / Caso o número de convidados pagantes exceda ao contratado no dia do evento, será cobrado o valor de R\$ 120,00 por pessoa excedente\./,
      '',
    );
    documento.clausulas[2].destaques = [];
  } else {
    const excedente = `${formatarMoeda(perfil.excedenteCentavos / 100)} por pessoa excedente`;
    documento.clausulas[2].texto = documento.clausulas[2].texto.replace(antiga, excedente);
    documento.clausulas[2].destaques = [excedente];
  }
  documento.clausulas[0].destaques = [nomeDocumento, formatarDataContrato(snapshot.evento.data), `${snapshot.evento.convidadosFaturados} pessoas`];
  return { ...documento, modeloCodigo: perfil.modeloCodigo, templateVersao: perfil.templateVersao, pacoteNome: nomeDocumento, subtitulo: nomeDocumento.toUpperCase() };
}
