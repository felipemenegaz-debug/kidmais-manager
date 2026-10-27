import { createHash } from "node:crypto";
import type { DbExecutor } from "../../db/contracts.ts";
import type { FestaAgenda } from "../../festas/leitura-tenant.ts";
import type { Recebivel } from "../../financeiro/servico.ts";
import { montarCorpus } from "../../conhecimento/corpus.ts";
import type { SessaoParaTenant, TenantComprovado } from "../../saas/provar-tenant.ts";
import { type DependenciasFerramentasMcp, type EventoFerramenta, type PrincipalMcp } from "./ferramentas.ts";

/** SOMENTE TESTE: fixtures sintéticas (duas empresas, PII proposital nas fontes) e simulação do Tenant Context. */
export const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const UA = "11111111-1111-4111-8111-111111111111";
export const UB = "22222222-2222-4222-8222-222222222222";
export const AGORA = new Date("2026-10-27T15:00:00Z");
export const HOJE = "2026-10-27";

export const ENV_OK = {
  MCP_ENABLED: "true", MCP_TENANT_ALLOWLIST: `${A},${B}`, MCP_PUBLIC_URL: "http://127.0.0.1:9/api/mcp", MCP_REF_SECRET: "r".repeat(40),
  INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", NODE_ENV: "test",
};

/** Fontes com PII de propósito: nada disso pode sair. */
export const FESTAS: Record<string, FestaAgenda[]> = {
  [A]: [
    { festaId: "f0000000-0000-4000-8000-00000000000a", data: HOJE, horaInicio: "14:00", horaFim: "18:00", cliente: "Maria Aparecida da Silva", pacote: "Pacote Ouro Princesas", convidados: 80, contratoStatus: "ASSINADO" },
    { festaId: "f0000000-0000-4000-8000-00000000000b", data: HOJE, horaInicio: "19:00", horaFim: null, cliente: "João Pedro (11) 98888-7777", pacote: "Pacote Prata", convidados: 50, contratoStatus: "AGUARDANDO_ASSINATURA" },
    { festaId: "f0000000-0000-4000-8000-00000000000c", data: HOJE, horaInicio: "10:00", horaFim: "12:00", cliente: "Cancelada Sobrenome", pacote: "Pacote Bronze", convidados: 30, contratoStatus: "CANCELADO" },
  ],
  [B]: [
    { festaId: "f0000000-0000-4000-8000-0000000000b1", data: HOJE, horaInicio: "15:00", horaFim: "19:00", cliente: "Cliente Secreto da Empresa B", pacote: "Pacote B", convidados: 999, contratoStatus: "ASSINADO" },
  ],
};

export const rec = (over: Partial<Recebivel>): Recebivel => ({
  id: "r", pagamentoId: "p", cliente: "Ana Beatriz CPF 123.456.789-00", clienteId: "c", festaId: null, pacote: "Pacote Ouro", data: HOJE, parcela: 1,
  vencimento: HOJE, valorCentavos: 10000, recebidoCentavos: 0, saldoCentavos: 10000, forma: "PIX", status: "A receber", diasAtraso: 0, ...over,
});
export const RECEBIVEIS: Record<string, Recebivel[]> = {
  [A]: [
    rec({ id: "1", saldoCentavos: 150000, status: "Vencido", diasAtraso: 10, vencimento: "2026-10-17" }),
    rec({ id: "2", saldoCentavos: 50000, status: "Vencido", diasAtraso: 45, vencimento: "2026-09-12" }),
    rec({ id: "3", saldoCentavos: 25050, status: "Vencido", diasAtraso: 90, vencimento: "2026-07-29" }),
    rec({ id: "4", saldoCentavos: 30000, status: "A receber", vencimento: "2026-10-30" }),
    rec({ id: "5", saldoCentavos: 70000, status: "Parcialmente pago", vencimento: "2026-12-01" }),
    rec({ id: "6", saldoCentavos: 0, status: "Pago" }),
    rec({ id: "7", saldoCentavos: 99999, status: "Cancelado" }),
  ],
  [B]: [rec({ id: "b", saldoCentavos: 777777, status: "Vencido", diasAtraso: 5, cliente: "Devedor da Empresa B" })],
};

type Membro = { empresa: string; papel: string; ativa: boolean };
export type Mundo = {
  usuariosAtivos: Set<string>;
  membros: Map<string, Membro[]>;
  empresasAtivas: Set<string>;
  revogadas: Set<string>;
  bloqueadas: Set<string>;
  leituras: string[];
};

export function mundo(): Mundo {
  return {
    usuariosAtivos: new Set([UA, UB]),
    membros: new Map([[UA, [{ empresa: A, papel: "ADMINISTRATIVO", ativa: true }]], [UB, [{ empresa: B, papel: "REPRESENTANTE_AUTORIZADO", ativa: true }]]]),
    empresasAtivas: new Set([A, B]),
    revogadas: new Set(),
    bloqueadas: new Set(),
    leituras: [],
  };
}

const tx: DbExecutor = { async query<Row extends object>() { return { rows: [] as Row[], rowCount: 0 }; } };

/** Simula provarTenant: usuário ativo, empresa ATIVA, membership ATIVA, papel da membership. Recusa = 403 do Core. */
export function tenantSimulado(m: Mundo) {
  return async <T>(sessao: SessaoParaTenant, empresa: string, work: (tx: DbExecutor, t: TenantComprovado) => Promise<T>): Promise<T> => {
    const membro = (m.membros.get(sessao.usuario_id) ?? []).find((x) => x.empresa === empresa && x.ativa);
    if (!m.usuariosAtivos.has(sessao.usuario_id) || !membro || !m.empresasAtivas.has(empresa)) {
      throw Object.assign(new Error("A sessão administrativa não comprova a empresa autorizada."), { code: "TENANT_NAO_COMPROVADO", httpStatus: 403 });
    }
    return work(tx, { empresaComprovada: empresa, membershipId: `m-${empresa}`, usuarioId: sessao.usuario_id, papelAtual: membro.papel });
  };
}

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const DOC = "# Contas a receber\n\n## Onde ver\n\nO detalhamento fica em Financeiro, Contas a receber.";
const DOC_B = "# Regra secreta da empresa B\n\n## Desconto\n\nA empresa B dá desconto secreto de vinte por cento.";
export const CORPUS = montarCorpus({
  versao: 1,
  documentos: [
    { arquivo: "a.md", id: "contas", titulo: "Contas a receber", versao: 1, vigenteDesde: "2026-01-01", vigenteAte: null, situacao: "APROVADO", acl: { tipo: "PLATAFORMA" }, sha256: sha(DOC) },
    { arquivo: "b.md", id: "secreta-b", titulo: "Regra secreta da empresa B", versao: 1, vigenteDesde: "2026-01-01", vigenteAte: null, situacao: "APROVADO", acl: { tipo: "EMPRESA", empresaId: B }, sha256: sha(DOC_B) },
  ],
}, (a) => (a === "a.md" ? DOC : a === "b.md" ? DOC_B : null));

export function deps(m: Mundo, env: Record<string, string | undefined> = ENV_OK, eventos: EventoFerramenta[] = [], extra: Partial<DependenciasFerramentasMcp> = {}): DependenciasFerramentasMcp {
  return {
    env,
    agora: () => AGORA,
    withTenantTransaction: tenantSimulado(m),
    async concessaoVigente(_tx, p) { return !m.revogadas.has(p.concessaoId); },
    async leituraComercialPermitida(_tx, empresa) { return !m.bloqueadas.has(empresa); },
    async agenda(_tx, empresa, dia, limite) { m.leituras.push(`agenda:${empresa}:${dia}:${limite}`); return FESTAS[empresa] ?? []; },
    async contarRecebiveis(_tx, empresa) { return (RECEBIVEIS[empresa] ?? []).length; },
    async recebiveis(_tx, empresa) { m.leituras.push(`recebiveis:${empresa}`); return RECEBIVEIS[empresa] ?? []; },
    corpus: () => CORPUS,
    registrar: (e) => { eventos.push(e); },
    ...extra,
  };
}

export const principalA: PrincipalMcp = { concessaoId: "c-a", usuarioId: UA, empresaId: A, clientId: "https://chatgpt.com/oauth/client.json", escopos: ["agenda:read", "financeiro:read", "conhecimento:read"], papel: "ADMINISTRATIVO" };
