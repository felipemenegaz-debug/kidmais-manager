import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import * as core from "./core.ts";
import * as prontas from "./prontas.ts";
import * as prontasLink from "./prontas-link.ts";
import * as mappers from "../../clientes/repositories/mappers.ts";
import * as normalizers from "../../clientes/repositories/normalizers.ts";
import { listarContratacoes } from "../../fechamentos/contratacoes.ts";

/**
 * Apoio das suítes PostgreSQL do atendimento (063 e concorrência do encerramento). Só usado por *.postgres.test.ts,
 * que rodam pelo check:v1:postgres no cluster descartável com opt-in e autorização explícita. Dados sintéticos.
 * Serviço, worker, biblioteca e o repositório REAL de clientes rodam com uma conexão por transação (como o pool),
 * para corridas e travas de verdade. Modelo e Gupshup são portas simuladas: nenhuma chamada de rede.
 */
export const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

export async function withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  const c = await conectarDescartavel({ travar: false });
  try {
    await c.query("BEGIN");
    const r = await fn(c as unknown as DbExecutor);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
export const db = () => ({ query: async (sql: string, v?: unknown[]) => { const c = await conectarDescartavel({ travar: false }); try { return await c.query(sql, v); } finally { await c.end(); } } });

export function carregarAtendimento(empresaPiloto: string, ambiente = "staging") {
  const configuracao = { ambienteAtendimento: () => ambiente, empresaPiloto: () => empresaPiloto, atendimentoAtivo: () => true, recepcaoAtiva: () => true, receptorDoNumero: () => true, contatoPermitido: (contato: string) => contato.startsWith("55619") };
  const postgres = { withTransaction, db };
  const tenant = { withTenantTransaction: (s: SessaoParaTenant, e: string, w: Parameters<typeof executarNoTenant>[3]) => withTransaction((tx) => executarNoTenant(tx, s, e, w)) };
  const servico = carregarComponente("lib/whatsapp/atendimento/service.ts", {
    "../../db/postgres.ts": postgres, "../../saas/provar-tenant.ts": tenant, "./configuracao.ts": configuracao, "./core.ts": core,
  }).modulo as typeof import("./service.ts");
  const worker = carregarComponente("lib/whatsapp/atendimento/worker.ts", {
    "../../db/postgres.ts": postgres, "./configuracao.ts": configuracao, "./core.ts": core, "./service.ts": servico,
  }).modulo as typeof import("./worker.ts");
  // Repositório REAL de clientes (mesma consulta da aplicação), com a conexão da transação.
  const clientes = carregarComponente("lib/clientes/repositories/cliente.repository.ts", {
    "../../db/postgres": postgres, "./mappers": mappers, "./normalizers": normalizers,
  }).modulo as typeof import("../../clientes/repositories/cliente.repository.ts");
  const biblioteca = carregarComponente("lib/whatsapp/atendimento/prontas-servico.ts", {
    "../../clientes/repositories/cliente.repository.ts": clientes, "../../fechamentos/contratacoes.ts": { listarContratacoes },
    "./configuracao.ts": configuracao, "./service.ts": servico, "./prontas.ts": prontas, "./prontas-link.ts": prontasLink,
  }).modulo as typeof import("./prontas-servico.ts");
  return { servico, worker, biblioteca };
}

/** Empresas e usuários sintéticos (membership ATIVA), no mesmo padrão da suíte 060. */
export function fixtures(c: Client) {
  const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
  const empresa = async (nome: string) => {
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("wa"), nome]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    return e;
  };
  const usuario = async (papel: string, empresaId: string) => {
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness atendimento', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresaId, u, papel]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    return { usuario_id: u, papel } as SessaoParaTenant;
  };
  const cliente = async (empresaId: string, telefone: string) => id(`INSERT INTO clientes (nome_completo, empresa_id, telefone) VALUES ($1, $2::uuid, $3) RETURNING id`, [`Cliente sintético ${cod("")}`, empresaId, telefone]);
  return { id, empresa, usuario, cliente };
}

export const adiado = <T = void>() => { let liberar!: (v: T) => void; const p = new Promise<T>((r) => { liberar = r; }); return { p, liberar }; };
/** Promessa que falha se não terminar no prazo: prova "não bloqueou" sem depender de timeout do teste inteiro. */
export async function noPrazo<T>(p: Promise<T>, ms: number, oque: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${oque}: não terminou em ${ms} ms (bloqueado?)`)), ms); })]); }
  finally { clearTimeout(t); }
}
