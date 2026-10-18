import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { MarketingError, naoEncontrado } from "../erros.ts";
import { alvoDns, hostReservado, instrucoesDns, normalizarHost, type AmbienteDominios } from "./hosts.ts";
import type { ProvedorDominio } from "./provedor.ts";

/**
 * Domínio personalizado (fluxo futuro, exercitado só com provedor SIMULADO):
 *   solicitar → PENDENTE_DNS (instruções TXT + A/CNAME) → verificar no provedor → VERIFICADO → provisionar → ATIVO
 *   remover → REMOVIDO (imediato, irreversível; o host fica livre para nova verificação, nunca para servir sem DNS).
 * Exclusividade: um host não REMOVIDO pertence a um único site de uma única empresa (índice único da 084).
 * Domínio já em uso por outra empresa: a mesma recusa genérica de host indisponível, sem dizer de quem é.
 * Compra, renovação e DNS são do cliente: o sistema só mostra instruções e confere.
 */
export type Dominio = {
  id: string; siteId: string; host: string; principal: boolean; status: "PENDENTE_DNS" | "VERIFICADO" | "ATIVO" | "FALHOU" | "REMOVIDO";
  simulado: boolean; provedor: string; verificadoEm: string | null; ativadoEm: string | null; removidoEm: string | null;
  ultimaVerificacao: Record<string, unknown>; instrucoes: ReturnType<typeof instrucoesDns>;
};

type Linha = {
  id: string; site_id: string; host: string; principal: boolean; status: Dominio["status"]; simulado: boolean; provedor: string; token_verificacao: string;
  verificado_em: string | null; ativado_em: string | null; removido_em: string | null; ultima_verificacao: Record<string, unknown>;
};
const COLUNAS = `id::text, site_id::text, host, principal, status, simulado, provedor, token_verificacao, verificado_em::text, ativado_em::text,
  removido_em::text, ultima_verificacao`;

type Env = AmbienteDominios & { MARKETING_DOMINIO_ALVO_CNAME?: string; MARKETING_DOMINIO_ALVO_IP?: string };

function mapear(l: Linha, env: Env): Dominio {
  return {
    id: l.id, siteId: l.site_id, host: l.host, principal: l.principal, status: l.status, simulado: l.simulado, provedor: l.provedor,
    verificadoEm: l.verificado_em, ativadoEm: l.ativado_em, removidoEm: l.removido_em, ultimaVerificacao: l.ultima_verificacao ?? {},
    instrucoes: instrucoesDns(l.host, l.token_verificacao, alvoDns(env)),
  };
}

export async function listarDominios(tx: DbExecutor, empresaId: string, siteId: string, env: Env = process.env) {
  const r = await tx.query<Linha>(
    `SELECT ${COLUNAS} FROM marketing_dominios WHERE empresa_id = $1::uuid AND site_id = $2::uuid
      ORDER BY (status = 'REMOVIDO'), principal DESC, criado_em`, [empresaId, siteId]);
  return r.rows.map((l) => mapear(l, env));
}

async function dominioDaEmpresa(tx: DbExecutor, empresaId: string, id: string, env: Env) {
  const r = await tx.query<Linha>(`SELECT ${COLUNAS} FROM marketing_dominios WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [id, empresaId]);
  if (!r.rows[0]) naoEncontrado("Domínio não encontrado nesta empresa.");
  return mapear(r.rows[0], env);
}

export const esquemaAcaoDominio = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("solicitar"), siteId: z.string().uuid(), host: z.string().trim().max(260), incluirWww: z.boolean().optional() }).strict(),
  z.object({ acao: z.literal("simular-dns"), id: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("verificar"), id: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("principal"), id: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("remover"), id: z.string().uuid() }).strict(),
]);
export type AcaoDominio = z.infer<typeof esquemaAcaoDominio>;

function indisponivel(): never {
  throw new MarketingError("MARKETING_DOMINIO_INDISPONIVEL", "Este domínio não está disponível para cadastro.", 409);
}

async function inserirHost(tx: DbExecutor, empresaId: string, siteId: string, usuarioId: string, host: string, principal: boolean) {
  try {
    await tx.query("SAVEPOINT marketing_dominio");
    const r = await tx.query<{ id: string }>(
      `INSERT INTO marketing_dominios (empresa_id, site_id, host, principal, token_verificacao, criado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid) RETURNING id::text`,
      [empresaId, siteId, host, principal, randomBytes(16).toString("hex"), usuarioId],
    );
    await tx.query("RELEASE SAVEPOINT marketing_dominio");
    return r.rows[0].id;
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT marketing_dominio");
    const c = (error as { constraint?: string }).constraint;
    if (c === "marketing_dominios_host_uk") indisponivel();
    if (c === "marketing_dominios_principal_uk") return null;
    throw error;
  }
}

export async function executarAcaoDominio(
  tx: DbExecutor, empresaId: string, usuarioId: string, acao: AcaoDominio, provedor: ProvedorDominio, env: Env = process.env,
) {
  if (acao.acao === "solicitar") {
    const host = normalizarHost(acao.host.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""));
    if (!host) throw new MarketingError("MARKETING_DOMINIO_INVALIDO", "Informe só o domínio, por exemplo festas.seubuffet.com.br.", 400);
    if (hostReservado(host, env)) indisponivel();
    const site = await tx.query<{ id: string }>(`SELECT id::text FROM marketing_sites WHERE id = $1::uuid AND empresa_id = $2::uuid`, [acao.siteId, empresaId]);
    if (site.rows.length !== 1) naoEncontrado("Site não encontrado nesta empresa.");
    const jaTemPrincipal = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketing_dominios WHERE site_id = $1::uuid AND principal AND status <> 'REMOVIDO'`, [acao.siteId]);
    const principal = Number(jaTemPrincipal.rows[0]?.n ?? 0) === 0;
    const ids = [await inserirHost(tx, empresaId, acao.siteId, usuarioId, host, principal)];
    // Raiz + www: o www entra como apelido (redireciona para o principal) e é verificado separadamente.
    if (acao.incluirWww && !host.startsWith("www.")) ids.push(await inserirHost(tx, empresaId, acao.siteId, usuarioId, `www.${host}`, false));
    return { ids: ids.filter(Boolean) };
  }
  const dominio = await dominioDaEmpresa(tx, empresaId, acao.id, env);
  if (dominio.status === "REMOVIDO") throw new MarketingError("MARKETING_DOMINIO_REMOVIDO", "Domínio removido. Cadastre de novo, se quiser usá-lo.", 409);
  if (acao.acao === "simular-dns") {
    if (!provedor.simulado) throw new MarketingError("MARKETING_SOMENTE_SIMULADO", "Ação disponível só com o provedor simulado.", 409);
    const i = dominio.instrucoes;
    await tx.query(`DELETE FROM marketing_dns_simulado WHERE host = $1`, [dominio.host]);
    await tx.query(`INSERT INTO marketing_dns_simulado (host, tipo, nome, valor) VALUES ($1, 'TXT', $2, $3), ($1, $4, $1, $5)`,
      [dominio.host, i.verificacao.nome, i.verificacao.valor, i.apontamento.tipo, i.apontamento.valor]);
    return { id: dominio.id };
  }
  if (acao.acao === "verificar") {
    const i = dominio.instrucoes;
    const resultado = await provedor.verificar(dominio.host, { txtNome: i.verificacao.nome, txtValor: i.verificacao.valor, tipo: i.apontamento.tipo, valor: i.apontamento.valor });
    if (!resultado.ok) {
      await tx.query(`UPDATE marketing_dominios SET status = CASE WHEN status = 'ATIVO' THEN 'FALHOU' ELSE 'FALHOU' END, ultima_verificacao = $2::jsonb,
          atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [dominio.id, JSON.stringify(resultado)]);
      return { id: dominio.id, status: "FALHOU" as const, verificacao: resultado };
    }
    const certificado = await provedor.provisionar(dominio.host);
    const status = certificado.ok ? "ATIVO" : "VERIFICADO";
    await tx.query(
      `UPDATE marketing_dominios SET status = $2, verificado_em = COALESCE(verificado_em, clock_timestamp()),
          ativado_em = CASE WHEN $2 = 'ATIVO' THEN COALESCE(ativado_em, clock_timestamp()) ELSE ativado_em END,
          ultima_verificacao = $3::jsonb, atualizado_em = clock_timestamp() WHERE id = $1::uuid`,
      [dominio.id, status, JSON.stringify({ ...resultado, certificado: certificado.detalhe })],
    );
    return { id: dominio.id, status, verificacao: resultado };
  }
  if (acao.acao === "principal") {
    await tx.query(`UPDATE marketing_dominios SET principal = false, atualizado_em = clock_timestamp() WHERE site_id = $1::uuid AND principal AND status <> 'REMOVIDO'`, [dominio.siteId]);
    await tx.query(`UPDATE marketing_dominios SET principal = true, atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [dominio.id]);
    return { id: dominio.id };
  }
  // remover: deixa de ser servido na hora; o DNS simulado do host também some (como o cliente apagaria o dele).
  await tx.query(`UPDATE marketing_dominios SET status = 'REMOVIDO', principal = false, removido_em = clock_timestamp(), atualizado_em = clock_timestamp()
    WHERE id = $1::uuid`, [dominio.id]);
  if (provedor.simulado) await tx.query(`DELETE FROM marketing_dns_simulado WHERE host = $1`, [dominio.host]);
  await provedor.liberar(dominio.host);
  return { id: dominio.id };
}

/**
 * Resolução pública por Host: só domínio ATIVO; simulado só quando o ambiente local permite servir simulado.
 * Devolve o site e o host principal (para redirecionar apelidos, ex.: www → raiz).
 */
export async function siteDoHost(tx: DbExecutor, host: string, env: AmbienteDominios) {
  const r = await tx.query<{ site_id: string; empresa_id: string; principal: boolean; simulado: boolean; principal_host: string | null }>(
    `SELECT d.site_id::text, d.empresa_id::text, d.principal, d.simulado,
            (SELECT p.host FROM marketing_dominios p WHERE p.site_id = d.site_id AND p.principal AND p.status = 'ATIVO' LIMIT 1) AS principal_host
       FROM marketing_dominios d WHERE d.host = $1 AND d.status = 'ATIVO'`, [host]);
  const d = r.rows[0];
  if (!d) return null;
  if (d.simulado && env.MARKETING_DOMINIO_SIMULADO_SERVIR?.trim() !== "true") return null;
  return { siteId: d.site_id, empresaId: d.empresa_id, simulado: d.simulado, principalHost: d.principal_host ?? host, ehPrincipal: d.principal || !d.principal_host };
}
