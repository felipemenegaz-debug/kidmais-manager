import { reaisDe } from "../../financeiro/calculos.ts";
import { listarRecebiveis, type Recebivel } from "../../financeiro/servico.ts";
import type { ItemResposta, RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, ausencia, calculo, diasEntre, evidencia, fato, montarResposta, plural, semParametros } from "./comum.ts";

/**
 * `analisar_recebiveis`: aging dos valores em aberto. Fonte única: `listarRecebiveis` (tenant comprovado).
 * Evidência agregada; o detalhamento é a tela Contas a receber.
 */
const FONTE = "financeiro.recebiveis";
const DESTINO = "/admin/financeiro/contas-receber";
const ABERTOS: ReadonlySet<Recebivel["status"]> = new Set(["A receber", "Parcialmente pago", "Vencido"]);

const soma = (lista: readonly Recebivel[]) => lista.reduce((total, item) => total + item.saldoCentavos, 0);

export function montarAnaliseRecebiveis(recebiveis: readonly Recebivel[], contexto: ContextoFerramenta): RespostaLeitura {
  const abertos = recebiveis.filter((item) => ABERTOS.has(item.status));
  if (abertos.length === 0) {
    return montarResposta("analisar_recebiveis", contexto, {
      estado: recebiveis.length === 0 ? "sem_dados" : "em_dia",
      resumo: recebiveis.length === 0 ? "Não há recebíveis registrados para esta empresa." : "Nenhum valor em aberto a receber.",
      fatos: [recebiveis.length === 0 ? ausencia("Nenhum recebível registrado.", FONTE) : fato("Todos os recebíveis estão quitados, cancelados ou estornados.", FONTE)],
      fontes: [FONTE],
    });
  }
  const vencidos = abertos.filter((item) => item.status === "Vencido");
  const faixas = [
    { id: "ate_30", titulo: "Vencidos há até 30 dias", lista: vencidos.filter((i) => i.diasAtraso <= 30), prioridade: "media" as const },
    { id: "31_60", titulo: "Vencidos de 31 a 60 dias", lista: vencidos.filter((i) => i.diasAtraso > 30 && i.diasAtraso <= 60), prioridade: "alta" as const },
    { id: "mais_60", titulo: "Vencidos há mais de 60 dias", lista: vencidos.filter((i) => i.diasAtraso > 60), prioridade: "alta" as const },
  ];
  const proximos7 = abertos.filter((i) => i.status !== "Vencido" && diasEntre(contexto.hoje, i.vencimento) >= 0 && diasEntre(contexto.hoje, i.vencimento) <= 7);
  const aVencer = abertos.filter((i) => i.status !== "Vencido");
  const itens: ItemResposta[] = [];
  for (const faixa of faixas) {
    if (faixa.lista.length === 0) continue;
    itens.push({
      id: `vencidos_${faixa.id}`,
      prioridade: faixa.prioridade,
      titulo: faixa.titulo,
      detalhe: `${faixa.lista.length} ${plural(faixa.lista.length, "recebível", "recebíveis")} · ${reaisDe(soma(faixa.lista))}`,
      destino: DESTINO,
    });
  }
  if (proximos7.length) {
    itens.push({ id: "proximos_7_dias", prioridade: "media", titulo: "Vencem nos próximos 7 dias", detalhe: `${proximos7.length} · ${reaisDe(soma(proximos7))}`, destino: DESTINO });
  }
  const resumo = vencidos.length
    ? `${reaisDe(soma(abertos))} em aberto, dos quais ${reaisDe(soma(vencidos))} ${plural(vencidos.length, "está vencido", "estão vencidos")}.`
    : `${reaisDe(soma(abertos))} em aberto, nenhum vencido.`;
  return montarResposta("analisar_recebiveis", contexto, {
    estado: vencidos.length ? "atencao" : "em_dia",
    resumo,
    fatos: [
      fato(`${abertos.length} ${plural(abertos.length, "recebível em aberto", "recebíveis em aberto")}.`, FONTE),
      calculo(`Saldo em aberto somado: ${reaisDe(soma(abertos))}.`, FONTE),
      calculo(`Vencidos: ${reaisDe(soma(vencidos))}; a vencer: ${reaisDe(soma(aVencer))}.`, FONTE),
      ...(vencidos.length ? [fato(`Maior atraso: ${Math.max(...vencidos.map((i) => i.diasAtraso))} dias.`, FONTE)] : []),
    ],
    itens,
    evidencias: [
      evidencia(FONTE, "Em aberto", `${abertos.length} · ${reaisDe(soma(abertos))}`, DESTINO),
      evidencia(FONTE, "Vencidos", `${vencidos.length} · ${reaisDe(soma(vencidos))}`, DESTINO),
      evidencia(FONTE, "A vencer", `${aVencer.length} · ${reaisDe(soma(aVencer))}`, DESTINO),
    ],
    fontes: [FONTE],
  });
}

export const analisarRecebiveis: Ferramenta<RespostaLeitura> = {
  nome: "financeiro.recebiveis.resumir",
  capacidade: "analisar_recebiveis",
  classe: "READ",
  grupo: "READ",
  papeis: PAPEIS_ADMIN,
  descricao: "Quanto há em aberto, vencido por faixa de atraso e vencendo nos próximos dias.",
  preparar(parametros) {
    semParametros.parse(parametros);
    return async (tx, tenant, contexto) => montarAnaliseRecebiveis(await listarRecebiveis(tx, tenant.empresaComprovada, contexto.hoje), contexto);
  },
};
