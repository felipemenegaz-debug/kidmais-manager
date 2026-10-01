import { contratosAguardandoAssinatura, type ContratoPendente } from "../../contratos/services/leitura-tenant.ts";
import type { RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, ausencia, dataCurta, diasEntre, evidencia, fato, montarResposta, plural, semParametros } from "./comum.ts";

/** `contratos_pendentes`: contratos aguardando assinatura, pela data da festa. */
const FONTE = "contratos.aguardando_assinatura";
const DESTINO = "/admin/contratos";

export function montarContratosPendentes(dados: { total: number; contratos: ContratoPendente[] }, contexto: ContextoFerramenta): RespostaLeitura {
  if (dados.total === 0) {
    return montarResposta("contratos_pendentes", contexto, {
      estado: "em_dia",
      resumo: "Nenhum contrato aguardando assinatura.",
      fatos: [fato("Nenhum contrato com status Aguardando assinatura.", FONTE)],
      fontes: [FONTE],
    });
  }
  const proximos = dados.contratos.filter((c) => diasEntre(contexto.hoje, c.dataEvento) >= 0 && diasEntre(contexto.hoje, c.dataEvento) <= 15);
  const passados = dados.contratos.filter((c) => diasEntre(contexto.hoje, c.dataEvento) < 0);
  return montarResposta("contratos_pendentes", contexto, {
    estado: "atencao",
    resumo: `${dados.total} ${plural(dados.total, "contrato aguarda", "contratos aguardam")} assinatura${proximos.length ? `; ${proximos.length} ${plural(proximos.length, "tem festa", "têm festa")} nos próximos 15 dias` : ""}.`,
    fatos: [
      fato(`${dados.total} ${plural(dados.total, "contrato", "contratos")} com status Aguardando assinatura.`, FONTE),
      ...(proximos.length ? [fato(`${proximos.length} com festa em até 15 dias.`, FONTE)] : []),
      ...(passados.length ? [fato(`${passados.length} com data de festa já passada e ainda sem assinatura.`, FONTE)] : []),
      ...(dados.total > dados.contratos.length ? [ausencia(`Mostrando ${dados.contratos.length} de ${dados.total}; os demais estão em Contratos.`, FONTE)] : []),
    ],
    itens: dados.contratos.map((c) => {
      const dias = diasEntre(contexto.hoje, c.dataEvento);
      return {
        id: c.contratoId,
        prioridade: dias < 0 || dias <= 7 ? "alta" as const : dias <= 15 ? "media" as const : "baixa" as const,
        titulo: `${c.cliente} · ${dataCurta(c.dataEvento)}`,
        detalhe: `${c.pacote} · ${dias < 0 ? `festa há ${-dias} ${plural(-dias, "dia", "dias")}` : dias === 0 ? "festa hoje" : `festa em ${dias} ${plural(dias, "dia", "dias")}`}`,
        destino: DESTINO,
      };
    }),
    evidencias: [evidencia(FONTE, "Aguardando assinatura", dados.total, DESTINO)],
    fontes: [FONTE],
  });
}

export const contratosPendentes: Ferramenta<RespostaLeitura> = {
  nome: "contratos.pendentes.listar",
  capacidade: "contratos_pendentes",
  classe: "READ",
  grupo: "READ",
  entrada: semParametros,
  papeis: PAPEIS_ADMIN,
  descricao: "Contratos que aguardam assinatura, começando pelas festas mais próximas.",
  preparar(parametros) {
    semParametros.parse(parametros);
    return async (tx, tenant, contexto) => montarContratosPendentes(await contratosAguardandoAssinatura(tx, tenant.empresaComprovada, 20), contexto);
  },
};
