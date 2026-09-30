import { z } from "zod";
import type { RecursoObjetivo } from "./contratos.ts";

/**
 * Navegação interna (AI V1.1, PR 3): lista FECHADA de telas e rotas. É a única fonte de destino — nem o modelo nem o
 * texto do operador produzem URL. Destino com entidade só com id UUID vindo de contexto/resultado de domínio JÁ
 * validado no tenant (a ferramenta confere antes). Navegar não altera estado: não passa pelo Human Gate, mas passa
 * pelo gateway (Policy + Tenant Context), como qualquer leitura.
 */
export type EntidadeNavegacao = "cliente" | "contrato" | "festa";

type Tela = { recurso: RecursoObjetivo; rotulo: string; entidade?: EntidadeNavegacao; rota: (id: string) => string };

export const TELAS_NAVEGACAO = {
  dashboard: { recurso: "DASHBOARD", rotulo: "Dashboard", rota: () => "/admin/dashboard" },
  clientes: { recurso: "CLIENTE", rotulo: "Clientes", rota: () => "/clientes" },
  cliente: { recurso: "CLIENTE", rotulo: "Cadastro do cliente", entidade: "cliente", rota: (id) => `/clientes/${id}` },
  fechamento: { recurso: "FECHAMENTO", rotulo: "Fechamento do cliente", entidade: "cliente", rota: (id) => `/admin/clientes/${id}/fechamento` },
  contratos: { recurso: "CONTRATO", rotulo: "Contratos", rota: () => "/admin/contratos" },
  contrato: { recurso: "CONTRATO", rotulo: "Contrato", entidade: "contrato", rota: (id) => `/admin/contratos?contratoId=${id}` },
  festas: { recurso: "FESTA", rotulo: "Festas", rota: () => "/admin/festas" },
  festa: { recurso: "FESTA", rotulo: "Festa", entidade: "festa", rota: (id) => `/admin/festas/${id}` },
  contas_receber: { recurso: "FINANCEIRO", rotulo: "Financeiro › Contas a receber", rota: () => "/admin/financeiro/contas-receber" },
  contas_pagar: { recurso: "FINANCEIRO", rotulo: "Financeiro › Contas a pagar", rota: () => "/admin/financeiro/contas-pagar" },
  financeiro: { recurso: "FINANCEIRO", rotulo: "Financeiro", rota: () => "/admin/financeiro" },
  agenda: { recurso: "AGENDA", rotulo: "Agenda", rota: () => "/admin/disponibilidade" },
  catalogo: { recurso: "ITEM", rotulo: "Configurações › Itens do Buffet", rota: () => "/admin/configuracoes/catalogo" },
  pacotes: { recurso: "PACOTE", rotulo: "Configurações › Pacotes", rota: () => "/admin/configuracoes/pacotes" },
  configuracoes: { recurso: "CONFIGURACAO", rotulo: "Configurações", rota: () => "/admin/configuracoes" },
} as const satisfies Record<string, Tela>;

export type TelaNavegacao = keyof typeof TELAS_NAVEGACAO;
export const TELAS = Object.keys(TELAS_NAVEGACAO) as [TelaNavegacao, ...TelaNavegacao[]];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * Toda rota que a navegação pode emitir, ancorada do começo ao fim: sem esquema (javascript:, data:, file:, http:),
 * sem host (//), sem "..", sem barra invertida, sem query fora do padrão.
 */
const PERMITIDAS = new RegExp(
  `^/(?:admin/(?:dashboard|contratos(?:\\?contratoId=${UUID})?|festas(?:/${UUID})?|clientes/${UUID}/fechamento|financeiro(?:/contas-(?:receber|pagar))?|disponibilidade|configuracoes(?:/(?:catalogo|pacotes))?)|clientes(?:/${UUID})?)$`,
);

export function destinoSeguro(destino: unknown): destino is string {
  return typeof destino === "string" && destino.length <= 200 && PERMITIDAS.test(destino);
}

const uuid = z.string().uuid();

/** Única forma de montar destino. Tela com entidade exige id UUID; sem entidade, id é recusado. */
export function montarDestino(tela: TelaNavegacao, id?: string | null): string {
  const t: Tela = TELAS_NAVEGACAO[tela];
  if (t.entidade ? !uuid.safeParse(id).success : id != null) throw new Error("DESTINO_INVALIDO");
  const destino = t.rota(t.entidade ? String(id).toLowerCase() : "");
  if (!destinoSeguro(destino)) throw new Error("DESTINO_INVALIDO");
  return destino;
}
