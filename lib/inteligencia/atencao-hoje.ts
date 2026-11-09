import { z } from "zod";
import type { Papel } from "../autenticacao/service.ts";
import { reaisDe } from "../financeiro/calculos.ts";
import { listarRecebiveis, pendenciasDoCaixa, type Recebivel } from "../financeiro/servico.ts";
import type { DbExecutor } from "../db/contracts.ts";
import type { ContextoFerramenta, Ferramenta } from "./ferramentas.ts";

/**
 * “O que precisa da minha atenção hoje?” — sem LLM.
 *
 * Fonte única: listarRecebiveis, o mesmo serviço tenant-comprovado do Dashboard e de Contas a receber.
 * Não usa painelGeral inteiro porque ele também lê agenda de Festas/Contratos (fora do escopo da V1)
 * e passa por garantirCategorias, que grava categorias padrão; esta capacidade não pode escrever.
 * P2: no plano com financeiro completo, soma as pendências da conferência do caixa (pendenciasDoCaixa, só leitura),
 * o mesmo agregado do fluxo de caixa e do Dashboard.
 */

/** Paridade com /api/admin/dashboard e /api/admin/financeiro: exigem só sessão e tenant comprovado. */
const PAPEIS_FINANCEIRO: readonly Papel[] = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"];
const FONTE = "financeiro.recebiveis";
const DESTINO = "/admin/financeiro/contas-receber";
const FONTE_CAIXA = "financeiro.caixa.abertura";
const DESTINO_CAIXA = "/admin/financeiro/fluxo-caixa";

const parametrosSchema = z.object({}).strict();

export type Prioridade = "alta" | "media" | "baixa";
export type TipoAtencao = "RECEBIVEIS_VENCIDOS" | "RECEBIVEIS_VENCEM_HOJE" | "CAIXA_A_CONFERIR" | "A_RECEBER_EM_ABERTO";
/** Pendências da conferência do caixa (P2, C.2.2): quantidade de movimentos e soma em módulo. */
export type PendenciasCaixa = { quantidade: number; centavos: number };

/**
 * Evidência agregada: sustenta cada frase e é o único formato que um futuro contexto de modelo pode receber.
 * Não carrega registros individuais, ids, nomes, contatos, pacote nem forma de pagamento.
 * O detalhamento fica na tela de origem (`destino`), que já lista os registros com o mesmo tenant comprovado.
 */
export type EvidenciaAgregada = {
  fonte: string;
  quantidade: number;
  valorCentavos: number;
  /** Só em vencidos: maior atraso em dias, calculado pelo Financeiro. */
  maiorAtrasoDias?: number;
};

export type ItemAtencao = {
  tipo: TipoAtencao;
  prioridade: Prioridade;
  titulo: string;
  detalhe: string;
  destino: string;
  evidencia: EvidenciaAgregada;
};

export type AtencaoHoje = {
  capacidade: "atencao_hoje";
  estado: "atencao" | "em_dia" | "sem_dados";
  resumo: string;
  referencia: { hoje: string; geradoEm: string; fonte: string };
  /**
   * Visões independentes, não somáveis entre si: A_RECEBER_EM_ABERTO é o total em aberto
   * e já contém os vencidos e os que vencem hoje.
   */
  itens: ItemAtencao[];
};

const ABERTOS: ReadonlySet<Recebivel["status"]> = new Set(["A receber", "Parcialmente pago", "Vencido"]);

function plural(n: number, singular: string, pluralTexto: string) {
  return n === 1 ? singular : pluralTexto;
}

function evidencia(lista: readonly Recebivel[]): EvidenciaAgregada {
  return {
    fonte: FONTE,
    quantidade: lista.length,
    valorCentavos: lista.reduce((total, item) => total + item.saldoCentavos, 0),
  };
}

/** Função pura: os números vêm do serviço de domínio; aqui só se agrupa e se escreve o texto. */
export function montarAtencaoHoje(recebiveis: readonly Recebivel[], contexto: ContextoFerramenta, caixa: PendenciasCaixa | null = null): AtencaoHoje {
  const referencia = { hoje: contexto.hoje, geradoEm: contexto.geradoEm, fonte: FONTE };
  const aConferir = caixa && caixa.quantidade > 0 ? caixa : null;
  if (recebiveis.length === 0 && !aConferir) {
    return {
      capacidade: "atencao_hoje",
      estado: "sem_dados",
      resumo: "Ainda não há recebíveis registrados para esta empresa. Não há dados suficientes para apontar pendências financeiras.",
      referencia,
      itens: [],
    };
  }

  const abertos = recebiveis.filter((item) => ABERTOS.has(item.status));
  const vencidos = abertos.filter((item) => item.status === "Vencido");
  const vencemHoje = abertos.filter((item) => item.status !== "Vencido" && item.vencimento === contexto.hoje);
  const itens: ItemAtencao[] = [];

  if (vencidos.length > 0) {
    const maiorAtraso = Math.max(...vencidos.map((item) => item.diasAtraso));
    const prova = { ...evidencia(vencidos), maiorAtrasoDias: maiorAtraso };
    itens.push({
      tipo: "RECEBIVEIS_VENCIDOS",
      prioridade: "alta",
      titulo: `${vencidos.length} ${plural(vencidos.length, "pagamento vencido", "pagamentos vencidos")}`,
      detalhe: `${reaisDe(prova.valorCentavos)} em aberto. O mais antigo venceu há ${maiorAtraso} ${plural(maiorAtraso, "dia", "dias")}.`,
      destino: DESTINO,
      evidencia: prova,
    });
  }

  if (vencemHoje.length > 0) {
    const prova = evidencia(vencemHoje);
    itens.push({
      tipo: "RECEBIVEIS_VENCEM_HOJE",
      prioridade: "media",
      titulo: `${vencemHoje.length} ${plural(vencemHoje.length, "pagamento vence hoje", "pagamentos vencem hoje")}`,
      detalhe: `${reaisDe(prova.valorCentavos)} ${plural(vencemHoje.length, "previsto", "previstos")} para hoje.`,
      destino: DESTINO,
      evidencia: prova,
    });
  }

  if (aConferir) {
    itens.push({
      tipo: "CAIXA_A_CONFERIR",
      prioridade: "media",
      titulo: `${aConferir.quantidade} ${plural(aConferir.quantidade, "movimento do caixa a conferir", "movimentos do caixa a conferir")}`,
      detalhe: `${reaisDe(aConferir.centavos)} em movimentos desde o saldo de abertura que ainda não foram conferidos.`,
      destino: DESTINO_CAIXA,
      evidencia: { fonte: FONTE_CAIXA, quantidade: aConferir.quantidade, valorCentavos: aConferir.centavos },
    });
  }

  if (abertos.length > 0) {
    const prova = evidencia(abertos);
    itens.push({
      tipo: "A_RECEBER_EM_ABERTO",
      prioridade: "baixa",
      titulo: "Valores a receber",
      detalhe: `${reaisDe(prova.valorCentavos)} em aberto em ${abertos.length} ${plural(abertos.length, "recebível", "recebíveis")}.`,
      destino: DESTINO,
      evidencia: prova,
    });
  }

  let resumo: string;
  if (vencidos.length > 0) {
    resumo = vencidos.length === 1
      ? "Existe 1 pagamento vencido que precisa de atenção."
      : `Existem ${vencidos.length} pagamentos vencidos que precisam de atenção.`;
    if (vencemHoje.length > 0) resumo += ` Além disso, ${vencemHoje.length} ${plural(vencemHoje.length, "vence", "vencem")} hoje.`;
  } else if (vencemHoje.length > 0) {
    resumo = `Nenhum pagamento vencido. ${vencemHoje.length} ${plural(vencemHoje.length, "pagamento vence", "pagamentos vencem")} hoje.`;
  } else if (abertos.length > 0) {
    resumo = "Nenhum pagamento vencido ou vencendo hoje.";
  } else if (recebiveis.length === 0) {
    resumo = "Ainda não há recebíveis registrados para esta empresa.";
  } else {
    resumo = "Nenhum recebível em aberto no momento.";
  }
  if (aConferir) resumo += ` No caixa, ${aConferir.quantidade} ${plural(aConferir.quantidade, "movimento", "movimentos")} desde a abertura ${plural(aConferir.quantidade, "precisa", "precisam")} ser ${plural(aConferir.quantidade, "conferido", "conferidos")}.`;

  return {
    capacidade: "atencao_hoje",
    estado: vencidos.length > 0 || vencemHoje.length > 0 || aConferir ? "atencao" : "em_dia",
    resumo,
    referencia,
    itens,
  };
}

export const atencaoHoje: Ferramenta<AtencaoHoje> = {
  // Nome e capacidade preservados da V1: traces e UI existentes dependem de "atencao_hoje".
  nome: "atencao_hoje",
  capacidade: "atencao_hoje",
  classe: "READ",
  grupo: "FUNDACAO",
  entrada: parametrosSchema,
  descricao: "Pagamentos vencidos, que vencem hoje e valores a receber.",
  papeis: PAPEIS_FINANCEIRO,
  preparar(parametros) {
    parametrosSchema.parse(parametros);
    return (tx, tenant, contexto) => lerAtencaoHoje(tx, tenant.empresaComprovada, contexto);
  },
};

export type LeiturasAtencao = {
  recebiveis: (tx: DbExecutor, empresaId: string, hoje: string) => Promise<Recebivel[]>;
  pendenciasCaixa: (tx: DbExecutor, empresaId: string) => Promise<PendenciasCaixa | null>;
};
const LEITURAS: LeiturasAtencao = { recebiveis: listarRecebiveis, pendenciasCaixa: pendenciasDoCaixa };

/**
 * Leitura da ferramenta. O caixa só entra com financeiro completo confirmado pela porta do plano (o mesmo recurso que
 * libera o fluxo de caixa); sem a porta ou sem o recurso, não lê o caixa.
 */
export async function lerAtencaoHoje(tx: DbExecutor, empresaId: string, contexto: ContextoFerramenta, leituras: LeiturasAtencao = LEITURAS) {
  const recebiveis = await leituras.recebiveis(tx, empresaId, contexto.hoje);
  const completo = await contexto.portas.recursos?.financeiroCompleto(tx, empresaId);
  const caixa = completo === true ? await leituras.pendenciasCaixa(tx, empresaId) : null;
  return montarAtencaoHoje(recebiveis, contexto, caixa);
}
