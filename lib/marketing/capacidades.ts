import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { MarketingError } from "./erros.ts";

/**
 * Capacidades de Marketing (085), no mesmo desenho das capacidades de Festa (056) e do Perfil:
 *   - Gestão (memberships.papel REPRESENTANTE_AUTORIZADO) tem todas, sem concessão;
 *   - Equipe precisa de concessão ATIVA (marketing_membership_capacidades, não revogada) NESTA empresa;
 *   - qualquer capacidade de edição inclui ver o painel (VISUALIZAR).
 * A origem manual de cliente/negociação NÃO depende destas capacidades: é recurso básico do CRM (qualquer membership).
 */
export const CAPACIDADES_MARKETING = [
  "MARKETING_VISUALIZAR",
  "MARKETING_CAMPANHAS_EDITAR",
  "MARKETING_SITE_EDITAR",
  "MARKETING_SITE_PUBLICAR",
  "MARKETING_DOMINIO_CONFIGURAR",
  "MARKETING_AUTOMACOES_GERIR",
] as const;
export type CapacidadeMarketing = (typeof CAPACIDADES_MARKETING)[number];

export const ROTULO_CAPACIDADE: Record<CapacidadeMarketing, string> = {
  MARKETING_VISUALIZAR: "Ver painel, campanhas e contatos",
  MARKETING_CAMPANHAS_EDITAR: "Criar e editar campanhas e contatos",
  MARKETING_SITE_EDITAR: "Editar o rascunho do site",
  MARKETING_SITE_PUBLICAR: "Publicar e despublicar o site",
  MARKETING_DOMINIO_CONFIGURAR: "Configurar domínio",
  MARKETING_AUTOMACOES_GERIR: "Gerir automações",
};

export function capacidadeMarketing(valor: unknown): valor is CapacidadeMarketing {
  return typeof valor === "string" && (CAPACIDADES_MARKETING as readonly string[]).includes(valor);
}

export function eGestao(tenant: Pick<TenantComprovado, "papelAtual">) {
  return tenant.papelAtual === "REPRESENTANTE_AUTORIZADO";
}

/** Capacidades efetivas da membership comprovada (Gestão: todas). */
export async function capacidadesDoTenant(tx: DbExecutor, tenant: TenantComprovado): Promise<CapacidadeMarketing[]> {
  if (eGestao(tenant)) return [...CAPACIDADES_MARKETING];
  const r = await tx.query<{ capacidade: string }>(
    `SELECT capacidade FROM marketing_membership_capacidades
      WHERE empresa_id = $1::uuid AND membership_id = $2::uuid AND revogado_em IS NULL
      ORDER BY capacidade`,
    [tenant.empresaComprovada, tenant.membershipId],
  );
  const concedidas = r.rows.map((l) => l.capacidade).filter(capacidadeMarketing);
  if (concedidas.length > 0 && !concedidas.includes("MARKETING_VISUALIZAR")) concedidas.unshift("MARKETING_VISUALIZAR");
  return concedidas;
}

export async function exigirCapacidadeMarketing(tx: DbExecutor, tenant: TenantComprovado, capacidade: CapacidadeMarketing) {
  const efetivas = await capacidadesDoTenant(tx, tenant);
  if (!efetivas.includes(capacidade)) {
    throw new MarketingError("MARKETING_SEM_PERMISSAO", "Seu acesso nesta empresa não inclui esta ação de Marketing. Peça à Gestão.", 403, { capacidade });
  }
  return efetivas;
}

/**
 * Só para o MENU (a barreira está nas APIs): Marketing aparece quando o plano inclui e a pessoa tem ao menos uma
 * capacidade nesta empresa. Qualquer falha de leitura (085 ausente, plano ilegível) esconde o item.
 */
export async function menuMarketingVisivel(
  tx: DbExecutor, empresaId: string, usuarioId: string, gestao: boolean,
  recursoIncluido: (tx: DbExecutor, empresaId: string, recurso: "MARKETING") => Promise<boolean>,
) {
  try {
    if (!(await recursoIncluido(tx, empresaId, "MARKETING"))) return false;
    if (gestao) return true;
    const r = await tx.query<{ ok: boolean }>(
      `SELECT true AS ok FROM marketing_membership_capacidades c JOIN memberships m ON m.id = c.membership_id AND m.empresa_id = c.empresa_id
        WHERE c.empresa_id = $1::uuid AND m.usuario_id = $2::uuid AND m.status = 'ATIVA' AND c.revogado_em IS NULL LIMIT 1`,
      [empresaId, usuarioId],
    );
    return r.rows.length === 1;
  } catch {
    return false;
  }
}

export type ConcessaoMarketing = {
  id: string; membershipId: string; usuarioNome: string; usuarioEmail: string; capacidade: CapacidadeMarketing;
  concedidoEm: string; motivo: string;
};

/** Equipe da empresa e concessões ativas (somente Gestão chama; a rota exige). */
export async function listarConcessoes(tx: DbExecutor, empresaId: string) {
  const equipe = await tx.query<{ membership_id: string; nome: string; email: string; papel: string }>(
    `SELECT m.id::text AS membership_id, u.nome, u.email, m.papel
       FROM memberships m JOIN usuarios_administrativos u ON u.id = m.usuario_id
      WHERE m.empresa_id = $1::uuid AND m.status = 'ATIVA' AND u.ativo
      ORDER BY u.nome, m.id`,
    [empresaId],
  );
  const concessoes = await tx.query<{ id: string; membership_id: string; capacidade: string; concedido_em: string; motivo: string }>(
    `SELECT id::text, membership_id::text, capacidade, concedido_em::text, motivo
       FROM marketing_membership_capacidades
      WHERE empresa_id = $1::uuid AND revogado_em IS NULL
      ORDER BY concedido_em`,
    [empresaId],
  );
  return equipe.rows.map((m) => ({
    membershipId: m.membership_id,
    nome: m.nome,
    email: m.email,
    gestao: m.papel === "REPRESENTANTE_AUTORIZADO",
    concessoes: concessoes.rows
      .filter((c) => c.membership_id === m.membership_id && capacidadeMarketing(c.capacidade))
      .map((c) => ({ id: c.id, capacidade: c.capacidade as CapacidadeMarketing, concedidoEm: c.concedido_em, motivo: c.motivo })),
  }));
}

export async function concederCapacidade(
  tx: DbExecutor, tenant: TenantComprovado, input: { membershipId: string; capacidade: CapacidadeMarketing; motivo: string },
) {
  const alvo = await tx.query<{ papel: string }>(
    `SELECT papel FROM memberships WHERE id = $1::uuid AND empresa_id = $2::uuid AND status = 'ATIVA' FOR SHARE`,
    [input.membershipId, tenant.empresaComprovada],
  );
  if (alvo.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Pessoa não encontrada nesta empresa.", 404);
  if (alvo.rows[0].papel === "REPRESENTANTE_AUTORIZADO") {
    throw new MarketingError("MARKETING_CONCESSAO_DESNECESSARIA", "Gestão já tem todas as permissões de Marketing.", 409);
  }
  const r = await tx.query<{ id: string }>(
    `INSERT INTO marketing_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)
     ON CONFLICT (membership_id, capacidade) WHERE revogado_em IS NULL DO NOTHING
     RETURNING id::text`,
    [tenant.empresaComprovada, input.membershipId, input.capacidade, tenant.usuarioId, input.motivo.trim()],
  );
  return { id: r.rows[0]?.id ?? null, jaExistia: r.rows.length === 0 };
}

export async function revogarCapacidade(tx: DbExecutor, tenant: TenantComprovado, input: { concessaoId: string; motivo: string }) {
  const r = await tx.query<{ id: string }>(
    `UPDATE marketing_membership_capacidades
        SET revogado_por = $3::uuid, revogado_em = clock_timestamp(), motivo_revogacao = $4
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND revogado_em IS NULL
      RETURNING id::text`,
    [input.concessaoId, tenant.empresaComprovada, tenant.usuarioId, input.motivo.trim()],
  );
  if (r.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Concessão não encontrada nesta empresa.", 404);
  return { id: r.rows[0].id };
}
