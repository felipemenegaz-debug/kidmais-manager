import type { RespostaLeitura } from "../contratos.ts";
import type { Ferramenta, VersaoContratoDominio } from "../ferramentas.ts";
import { InteligenciaError } from "../politica.ts";
import { PAPEIS_ADMIN, ausencia, calculo, comEntidade, dataCurta, evidencia, fato, montarResposta } from "./comum.ts";

/**
 * `comparar_versoes_contrato` (Agente de Documentos): compara a versão mais recente com a anterior, campo a
 * campo, a partir dos SNAPSHOTS congelados (nada recalculado com catálogo ou preço atual). Posse do contrato
 * comprovada na empresa pelo domínio (outra empresa responde como inexistente). Não assina nem altera nada.
 */
const FONTE = "contratos.versoes";

function reais(valor: number) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

type Campo = { rotulo: string; ler: (v: VersaoContratoDominio) => string | null };

const CAMPOS: readonly Campo[] = [
  { rotulo: "Data da festa", ler: (v) => (v.snapshot?.evento?.data ? dataCurta(v.snapshot.evento.data) : null) },
  { rotulo: "Horário", ler: (v) => (v.snapshot?.evento?.horarioInicio ? `${v.snapshot.evento.horarioInicio.slice(0, 5)}${v.snapshot.evento.horarioFim ? `–${v.snapshot.evento.horarioFim.slice(0, 5)}` : ""}` : null) },
  { rotulo: "Pacote", ler: (v) => v.snapshot?.evento?.pacote?.nome ?? null },
  { rotulo: "Convidados", ler: (v) => (v.snapshot?.evento?.convidados != null ? String(v.snapshot.evento.convidados) : null) },
  { rotulo: "Valor contratado", ler: (v) => (v.snapshot?.comercial?.valorFinalContrato != null ? reais(v.snapshot.comercial.valorFinalContrato) : null) },
  { rotulo: "Forma de pagamento", ler: (v) => v.snapshot?.comercial?.condicaoPagamento?.forma ?? v.snapshot?.comercial?.formaPagamentoPretendida ?? null },
];

export function montarComparacao(versoes: readonly VersaoContratoDominio[], contratoId: string, contexto: Parameters<typeof montarResposta>[1]): RespostaLeitura {
  const destino = `/admin/contratos?contratoId=${contratoId}`;
  const ordenadas = [...versoes].sort((a, b) => b.numero - a.numero);
  const [atual, anterior] = ordenadas;
  if (!atual || !anterior) {
    return montarResposta("comparar_versoes_contrato", contexto, {
      estado: "sem_dados",
      resumo: "Este contrato tem uma única versão: não há o que comparar.",
      fatos: [ausencia("Só existe uma versão deste contrato.", FONTE)],
      evidencias: [evidencia(FONTE, "Versões", ordenadas.length, destino)],
      fontes: [FONTE],
    });
  }
  const mudancas = CAMPOS.map((c) => ({ rotulo: c.rotulo, antes: c.ler(anterior), depois: c.ler(atual) })).filter((m) => m.antes !== m.depois);
  return montarResposta("comparar_versoes_contrato", contexto, {
    estado: "informativo",
    resumo: `V${atual.numero} × V${anterior.numero}: ${mudancas.length ? `${mudancas.length} ${mudancas.length === 1 ? "campo mudou" : "campos mudaram"}` : "nenhum campo principal mudou"}.`,
    fatos: [
      fato(`Versão V${atual.numero} (${atual.status.toLowerCase()}) comparada com V${anterior.numero} (${anterior.status.toLowerCase()}).`, FONTE),
      ...(mudancas.length
        ? mudancas.map((m) => calculo(`${m.rotulo}: ${m.antes ?? "—"} → ${m.depois ?? "—"}.`, FONTE))
        : [fato("Data, horário, pacote, convidados, valor e forma de pagamento são iguais nas duas versões.", FONTE)]),
    ],
    itens: mudancas.map((m, i) => ({ id: `mudanca_${i}`, prioridade: "media" as const, titulo: m.rotulo, detalhe: `${m.antes ?? "—"} → ${m.depois ?? "—"}`, destino })),
    evidencias: [evidencia(FONTE, "Versões", ordenadas.length, destino), evidencia(FONTE, "Campos alterados", mudancas.length, destino)],
    fontes: [FONTE],
  });
}

export const compararVersoesContrato: Ferramenta<RespostaLeitura> = {
  nome: "contratos.versoes.comparar",
  capacidade: "comparar_versoes_contrato",
  classe: "READ",
  grupo: "READ",
  papeis: PAPEIS_ADMIN,
  descricao: "Compara a versão mais recente do contrato aberto com a anterior (snapshots, sem recálculo).",
  entidade: "contrato",
  preparar(parametros) {
    const { id } = comEntidade.parse(parametros);
    return async (tx, tenant, contexto) => {
      if (!contexto.portas.contratos) {
        return montarResposta("comparar_versoes_contrato", contexto, { estado: "sem_dados", resumo: "A comparação de versões não está disponível agora.", fatos: [ausencia("Serviço de contratos indisponível para a IA.", FONTE)], fontes: [FONTE] });
      }
      const versoes = await contexto.portas.contratos.versoes(tx, tenant.empresaComprovada, id);
      if (!versoes) throw new InteligenciaError("NAO_ENCONTRADO", "Contrato não encontrado.", 404);
      return montarComparacao(versoes, id, contexto);
    };
  },
};
