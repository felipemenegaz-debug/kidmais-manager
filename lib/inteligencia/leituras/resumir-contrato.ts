import { resumoContratoDoTenant, type ResumoContratoTenant } from "../../contratos/services/leitura-tenant.ts";
import { InteligenciaError } from "../politica.ts";
import type { RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, UUID, ausencia, comEntidade, dataCurta, diasEntre, evidencia, fato, montarResposta } from "./comum.ts";

/**
 * `resumir_contrato`: situação da versão vigente, a partir do snapshot congelado.
 * Nada é recalculado com catálogo ou preço atual; o valor é o `valorFinalContrato` do snapshot.
 */
const FONTE = "contratos.versao_vigente";
const STATUS: Readonly<Record<string, string>> = { ASSINADO: "assinado", AGUARDANDO_ASSINATURA: "aguardando assinatura", CANCELADO: "cancelado" };
const FORMAS: Readonly<Record<string, string>> = { PIX_AVISTA: "PIX à vista", PIX_PARCELADO: "PIX parcelado", CARTAO_CREDITO: "cartão de crédito", BOLETO: "boleto", DINHEIRO: "dinheiro" };

function reais(valor: number) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function montarResumoContrato(r: ResumoContratoTenant, contexto: ContextoFerramenta): RespostaLeitura {
  const destino = "/admin/contratos";
  // Contrato histórico assinado em papel: não há assinatura eletrônica a esperar (nem a apontar como pendente).
  const faltaAssinar = r.assinadoEmPapel ? [] : ["KIDMAIS", "CLIENTE"].filter((parte) => !r.assinaturas.includes(parte));
  const fatos = [
    fato(`Contrato ${STATUS[r.status] ?? r.status}${r.versaoVigente ? `, versão vigente V${r.versaoVigente}` : ""}.`, FONTE),
    r.dataEvento ? fato(`Festa em ${dataCurta(r.dataEvento)}${r.horarioInicio ? `, das ${r.horarioInicio}${r.horarioFim ? ` às ${r.horarioFim}` : ""}` : ""}.`, FONTE) : ausencia("Data da festa não registrada no snapshot.", FONTE),
    r.pacote ? fato(`Pacote contratado: ${r.pacote}${r.convidados ? `, ${r.convidados} convidados` : ""}.`, FONTE) : ausencia("Pacote não registrado no snapshot.", FONTE),
    r.valorFinalContrato != null ? fato(`Valor contratado (snapshot, sem recálculo): ${reais(r.valorFinalContrato)}.`, FONTE) : ausencia("Valor final não registrado no snapshot.", FONTE),
    ...(r.formaPagamento ? [fato(`Forma de pagamento: ${FORMAS[r.formaPagamento] ?? r.formaPagamento}.`, FONTE)] : []),
    ...(r.assinadoEmPapel ? [fato("Contrato histórico assinado em papel, conferido na importação; sem assinatura eletrônica.", FONTE)] : []),
    ...(r.buffetStatus ? [fato(`Buffet ${r.buffetStatus === "DEFINIDO" ? "definido" : "pendente"} na versão vigente.`, FONTE)] : []),
    ...(r.status !== "CANCELADO" && faltaAssinar.length ? [fato(`Falta assinatura: ${faltaAssinar.map((p) => (p === "KIDMAIS" ? "Kidmais" : "cliente")).join(" e ")}.`, FONTE)] : []),
    ...(r.versaoEmPreparacao ? [fato("Existe uma nova versão em preparação, ainda não vigente.", FONTE)] : []),
  ];
  const itens = [];
  if (r.status === "AGUARDANDO_ASSINATURA") {
    const dias = r.dataEvento ? diasEntre(contexto.hoje, r.dataEvento) : null;
    itens.push({ id: "assinatura", prioridade: dias != null && dias <= 7 ? "alta" as const : "media" as const, titulo: "Aguardando assinatura", detalhe: dias == null ? "Data da festa não registrada" : dias < 0 ? "A festa já passou" : `Festa em ${dias} dias`, destino });
  }
  if (r.buffetStatus && r.buffetStatus !== "DEFINIDO" && r.status !== "CANCELADO") {
    itens.push({ id: "buffet", prioridade: "media" as const, titulo: "Buffet pendente", detalhe: "Escolhas do buffet ainda não definidas na versão vigente.", destino });
  }
  return montarResposta("resumir_contrato", contexto, {
    estado: itens.length ? "atencao" : "informativo",
    resumo: `Contrato ${STATUS[r.status] ?? r.status}${r.pacote ? ` · ${r.pacote}` : ""}${r.dataEvento ? ` · ${dataCurta(r.dataEvento)}` : ""}${r.valorFinalContrato != null ? ` · ${reais(r.valorFinalContrato)}` : ""}.`,
    fatos,
    itens,
    evidencias: [
      evidencia(FONTE, "Versão vigente", r.versaoVigente ? `V${r.versaoVigente}` : "Não identificada", destino),
      evidencia(FONTE, "Assinaturas registradas", r.assinaturas.length, destino),
    ],
    fontes: [FONTE],
    // AI V1.1 (PR 5): o próprio contrato, para o foco da conversa.
    ...(UUID.test(r.contratoId) ? { entidades: [{ tipo: "CONTRATO" as const, id: r.contratoId, rotulo: `Contrato${r.pacote ? ` · ${r.pacote}` : ""}${r.dataEvento ? ` · ${dataCurta(r.dataEvento)}` : ""}`.slice(0, 120), tela: "contrato" as const }] } : {}),
  });
}

export const resumirContrato: Ferramenta<RespostaLeitura> = {
  nome: "contratos.resumir",
  capacidade: "resumir_contrato",
  classe: "READ",
  grupo: "READ",
  entrada: comEntidade,
  papeis: PAPEIS_ADMIN,
  descricao: "Situação, valor contratado, assinaturas e pendências da versão vigente do contrato.",
  entidade: "contrato",
  preparar(parametros) {
    const { id } = comEntidade.parse(parametros);
    return async (tx, tenant, contexto) => {
      const resumo = await resumoContratoDoTenant(tx, tenant.empresaComprovada, id);
      // Inexistente e de outra empresa respondem igual.
      if (!resumo) throw new InteligenciaError("NAO_ENCONTRADO", "Contrato não encontrado.", 404);
      return montarResumoContrato(resumo, contexto);
    };
  },
};
