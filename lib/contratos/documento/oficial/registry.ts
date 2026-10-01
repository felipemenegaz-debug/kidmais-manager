import type { ContratoSnapshot } from "../../repositories/index.ts";
import { renderizarContratoOficialFestaCompletaV1 } from "./festa-completa-v1.ts";
import { renderizarContratoOficialFestasV2 } from './festas-v2.ts';
import { configuracaoModeloOficialV3, renderizarContratoOficialFestasV3 } from './festas-v3.ts';
import { configuracaoModeloOficialV4, renderizarContratoOficialFestasV4 } from './festas-v4.ts';
import { configuracaoModeloOficial } from './configuracao.ts';
import type { GerarContratoOficialInput, ModeloContratoOficial } from "./models.ts";

const FESTA_COMPLETA: ModeloContratoOficial = {
  modeloCodigo: "FESTA_COMPLETA_V1",
  pacoteCodigo: "COMPLETA",
  pacoteNome: "Festa Completa",
  templateVersao: 1,
  homologadoParaProducao: true,
  renderizar: renderizarContratoOficialFestaCompletaV1,
};

export function resolverModeloContratoOficial(snapshot: ContratoSnapshot, templateVersao?: number): ModeloContratoOficial | null {
  if (templateVersao === 1) return snapshot.evento.pacote.codigo === 'COMPLETA' ? FESTA_COMPLETA : null;
  if (templateVersao != null && templateVersao !== 2 && templateVersao !== 3 && templateVersao !== 4) return null;
  const versao = templateVersao ?? 4;
  const perfil = versao === 2
    ? configuracaoModeloOficial(snapshot.evento.pacote.codigo)
    : versao === 3
      ? configuracaoModeloOficialV3(snapshot.evento.pacote.codigo)
      : configuracaoModeloOficialV4(snapshot.evento.pacote.codigo);
  const renderizar = versao === 2
    ? renderizarContratoOficialFestasV2
    : versao === 3
      ? renderizarContratoOficialFestasV3
      : renderizarContratoOficialFestasV4;
  return perfil ? { ...perfil, pacoteCodigo: snapshot.evento.pacote.codigo, homologadoParaProducao: true, renderizar } : null;
}

export function renderizarContratoOficial(input: GerarContratoOficialInput) {
  const modelo = resolverModeloContratoOficial(input.snapshot, input.templateVersao);
  if (!modelo) return null;
  return modelo.renderizar({ ...input, templateVersao: modelo.templateVersao });
}
