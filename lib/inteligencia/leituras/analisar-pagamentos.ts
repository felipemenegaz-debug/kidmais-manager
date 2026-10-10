import { periodoSelecionado, reaisDe } from "../../financeiro/calculos.ts";
import { recebidoNoPeriodo } from "../../financeiro/servico.ts";
import type { RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, ausencia, calculo, evidencia, fato, montarResposta, semParametros } from "./comum.ts";

/**
 * `analisar_pagamentos`: recebido líquido no mês até hoje × mesmo intervalo do mês anterior.
 * Fonte: `recebidoNoPeriodo` (tenant comprovado; recebimentos confirmados + entradas manuais recebidas).
 * A comparação usa o mesmo número de dias para não comparar mês parcial com mês cheio.
 */
const FONTE = "financeiro.recebimentos";
const DESTINO = "/admin/financeiro/fluxo-caixa";
/** Plano sem fluxo de caixa (Essencial): a evidência aponta para Contas a receber, que é de todos os planos. */
const DESTINO_SEM_FLUXO = "/admin/financeiro/contas-receber";

export type Periodos = { atual: { inicio: string; fim: string }; anterior: { inicio: string; fim: string }; anteriorCheio: { inicio: string; fim: string } };

export function periodosComparaveis(hoje: string): Periodos {
  const atual = { inicio: periodoSelecionado(hoje, "mes").inicio, fim: hoje };
  const anteriorCheio = periodoSelecionado(hoje, "anterior");
  const dia = Number(hoje.slice(8, 10));
  const ultimoDiaAnterior = Number(anteriorCheio.fim.slice(8, 10));
  const fimAnterior = `${anteriorCheio.inicio.slice(0, 8)}${String(Math.min(dia, ultimoDiaAnterior)).padStart(2, "0")}`;
  return { atual, anterior: { inicio: anteriorCheio.inicio, fim: fimAnterior }, anteriorCheio };
}

export function montarAnalisePagamentos(
  valores: { atualCentavos: number; anteriorCentavos: number; anteriorCheioCentavos: number },
  periodos: Periodos,
  contexto: ContextoFerramenta,
  destino: string = DESTINO,
): RespostaLeitura {
  const { atualCentavos, anteriorCentavos, anteriorCheioCentavos } = valores;
  const intervalo = `${periodos.atual.inicio.slice(8)}–${periodos.atual.fim.slice(8)}`;
  if (atualCentavos === 0 && anteriorCheioCentavos === 0) {
    return montarResposta("analisar_pagamentos", contexto, {
      estado: "sem_dados",
      resumo: "Não há recebimentos registrados neste mês nem no mês anterior.",
      fatos: [ausencia("Nenhum recebimento confirmado nos dois períodos.", FONTE)],
      fontes: [FONTE],
    });
  }
  const fatos = [
    fato(`Recebido neste mês (dias ${intervalo}): ${reaisDe(atualCentavos)}.`, FONTE),
    fato(`Recebido no mês anterior, mesmo intervalo: ${reaisDe(anteriorCentavos)}.`, FONTE),
    fato(`Recebido no mês anterior inteiro: ${reaisDe(anteriorCheioCentavos)}.`, FONTE),
  ];
  let resumo: string;
  if (anteriorCentavos === 0) {
    fatos.push(ausencia("Sem base de comparação no mesmo intervalo do mês anterior; a variação percentual não é calculada.", FONTE));
    resumo = `Recebido neste mês até hoje: ${reaisDe(atualCentavos)}.`;
  } else {
    const variacao = Math.round(((atualCentavos - anteriorCentavos) / anteriorCentavos) * 1000) / 10;
    const sentido = variacao > 0 ? "acima" : variacao < 0 ? "abaixo" : "igual ao";
    fatos.push(calculo(`Variação sobre o mesmo intervalo do mês anterior: ${variacao.toLocaleString("pt-BR")}%.`, FONTE));
    resumo = variacao === 0
      ? `Recebido neste mês até hoje: ${reaisDe(atualCentavos)}, igual ao mesmo período do mês anterior.`
      : `Recebido neste mês até hoje: ${reaisDe(atualCentavos)}, ${Math.abs(variacao).toLocaleString("pt-BR")}% ${sentido} do mesmo período do mês anterior.`;
  }
  return montarResposta("analisar_pagamentos", contexto, {
    estado: "informativo",
    resumo,
    fatos,
    evidencias: [
      evidencia(FONTE, `Recebido ${periodos.atual.inicio} a ${periodos.atual.fim}`, reaisDe(atualCentavos), destino),
      evidencia(FONTE, `Recebido ${periodos.anterior.inicio} a ${periodos.anterior.fim}`, reaisDe(anteriorCentavos), destino),
    ],
    fontes: [FONTE],
  });
}

export const analisarPagamentos: Ferramenta<RespostaLeitura> = {
  nome: "financeiro.pagamentos.analisar",
  capacidade: "analisar_pagamentos",
  classe: "READ",
  grupo: "READ",
  entrada: semParametros,
  papeis: PAPEIS_ADMIN,
  descricao: "Quanto foi recebido neste mês, comparado ao mesmo período do mês anterior.",
  preparar(parametros) {
    semParametros.parse(parametros);
    return async (tx, tenant, contexto) => {
      const periodos = periodosComparaveis(contexto.hoje);
      const empresa = tenant.empresaComprovada;
      const atualCentavos = await recebidoNoPeriodo(tx, empresa, periodos.atual.inicio, periodos.atual.fim);
      const anteriorCentavos = await recebidoNoPeriodo(tx, empresa, periodos.anterior.inicio, periodos.anterior.fim);
      const anteriorCheioCentavos = await recebidoNoPeriodo(tx, empresa, periodos.anteriorCheio.inicio, periodos.anteriorCheio.fim);
      const fluxo = await contexto.portas.recursos?.financeiroCompleto(tx, empresa);
      return montarAnalisePagamentos({ atualCentavos, anteriorCentavos, anteriorCheioCentavos }, periodos, contexto, fluxo === false ? DESTINO_SEM_FLUXO : DESTINO);
    };
  },
};
