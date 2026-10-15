import { z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import { MarketingError, naoEncontrado } from "./erros.ts";
import { CANAIS_ATENDIMENTO, CODIGO_ORIGEM, ORIGEM_DESCONHECIDA, exigirOrigemValida, type CanalAtendimento, type MetodoAtribuicao } from "./origens.ts";
import type { Utm } from "./utm.ts";

/**
 * Atribuição (083, append-only):
 *   CLIENTE    → primeira origem do cliente = primeira linha registrada para ele (correções formam a cadeia);
 *   FECHAMENTO → origem DESTA negociação (cliente antigo pode voltar por outra campanha);
 *   CONTATO    → origem do pedido captado/registrado.
 * Contrato herda a da negociação pelo vínculo existente (contratos.fechamento_id): nada é copiado para contrato.
 * Correção desativa a vigente e insere outra com `substitui_id` e motivo; o histórico inteiro continua legível.
 */
export const ALVOS = ["CLIENTE", "FECHAMENTO", "CONTATO"] as const;
export type AlvoAtribuicao = (typeof ALVOS)[number];

export type Atribuicao = {
  id: string; alvoTipo: AlvoAtribuicao; alvoId: string; origemCodigo: string; canalAtendimento: CanalAtendimento | null;
  campanhaId: string | null; campanhaNome: string | null; metodo: MetodoAtribuicao; detalhe: string | null; utm: Utm;
  contatoId: string | null; vigente: boolean; substituiId: string | null; motivo: string | null;
  registradoPor: string | null; registradoPorNome: string | null; registradoEm: string; substituidaEm: string | null;
};

type Linha = {
  id: string; alvo_tipo: AlvoAtribuicao; alvo_id: string; origem_codigo: string; canal_atendimento: CanalAtendimento | null; campanha_id: string | null;
  campanha_nome: string | null; metodo: MetodoAtribuicao; detalhe: string | null; utm: Utm; contato_id: string | null; vigente: boolean;
  substitui_id: string | null; motivo: string | null; registrado_por: string | null; registrado_por_nome: string | null; registrado_em: string;
  substituida_em: string | null;
};

const SELECT = `SELECT a.id::text, a.alvo_tipo, a.alvo_id::text, a.origem_codigo, a.canal_atendimento, a.campanha_id::text, c.nome AS campanha_nome,
    a.metodo, a.detalhe, a.utm, a.contato_id::text, a.vigente, a.substitui_id::text, a.motivo, a.registrado_por::text,
    u.nome AS registrado_por_nome, a.registrado_em::text, a.substituida_em::text
  FROM marketing_atribuicoes a
  LEFT JOIN marketing_campanhas c ON c.id = a.campanha_id AND c.empresa_id = a.empresa_id
  LEFT JOIN usuarios_administrativos u ON u.id = a.registrado_por`;

function mapear(l: Linha): Atribuicao {
  return {
    id: l.id, alvoTipo: l.alvo_tipo, alvoId: l.alvo_id, origemCodigo: l.origem_codigo, canalAtendimento: l.canal_atendimento,
    campanhaId: l.campanha_id, campanhaNome: l.campanha_nome, metodo: l.metodo, detalhe: l.detalhe, utm: l.utm ?? {},
    contatoId: l.contato_id, vigente: l.vigente, substituiId: l.substitui_id, motivo: l.motivo, registradoPor: l.registrado_por,
    registradoPorNome: l.registrado_por_nome, registradoEm: l.registrado_em, substituidaEm: l.substituida_em,
  };
}

export type NovaAtribuicao = {
  alvoTipo: AlvoAtribuicao; alvoId: string; origemCodigo: string; canalAtendimento?: CanalAtendimento | null;
  campanhaId?: string | null; metodo: MetodoAtribuicao; detalhe?: string | null; utm?: Utm; contatoId?: string | null;
  registradoPor?: string | null;
};

/** Confere que o alvo é da empresa ANTES de qualquer escrita (o gatilho da 083 confere de novo). */
export async function exigirAlvoDaEmpresa(tx: DbExecutor, empresaId: string, alvoTipo: AlvoAtribuicao, alvoId: string) {
  const tabela = alvoTipo === "CLIENTE" ? "clientes" : alvoTipo === "FECHAMENTO" ? "fechamentos" : "marketing_contatos";
  const r = await tx.query<{ ok: boolean }>(`SELECT true AS ok FROM ${tabela} WHERE id = $1::uuid AND empresa_id = $2::uuid`, [alvoId, empresaId]);
  if (r.rows.length !== 1) naoEncontrado();
}

export async function atribuicaoVigente(tx: DbExecutor, empresaId: string, alvoTipo: AlvoAtribuicao, alvoId: string) {
  const r = await tx.query<Linha>(`${SELECT} WHERE a.empresa_id = $1::uuid AND a.alvo_tipo = $2 AND a.alvo_id = $3::uuid AND a.vigente`, [empresaId, alvoTipo, alvoId]);
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

export async function historicoAtribuicao(tx: DbExecutor, empresaId: string, alvoTipo: AlvoAtribuicao, alvoId: string) {
  const r = await tx.query<Linha>(
    `${SELECT} WHERE a.empresa_id = $1::uuid AND a.alvo_tipo = $2 AND a.alvo_id = $3::uuid ORDER BY a.registrado_em, a.id`,
    [empresaId, alvoTipo, alvoId],
  );
  return r.rows.map(mapear);
}

/** Primeira origem do cliente = a primeira linha (sem `substitui_id`) e, se corrigida, a vigente da cadeia. */
export async function primeiraOrigemCliente(tx: DbExecutor, empresaId: string, clienteId: string) {
  return atribuicaoVigente(tx, empresaId, "CLIENTE", clienteId);
}

/** Insere a primeira atribuição do alvo. Já existindo vigente: devolve `null` (quem chama decide se corrige). */
export async function registrarSeAusente(tx: DbExecutor, empresaId: string, nova: NovaAtribuicao): Promise<Atribuicao | null> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, canal_atendimento, campanha_id, metodo, detalhe, utm, contato_id, registrado_por)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7, $8, $9::jsonb, $10::uuid, $11::uuid)
     ON CONFLICT (empresa_id, alvo_tipo, alvo_id) WHERE vigente DO NOTHING
     RETURNING id::text`,
    [empresaId, nova.alvoTipo, nova.alvoId, nova.origemCodigo, nova.canalAtendimento ?? null, nova.campanhaId ?? null, nova.metodo,
      nova.detalhe ?? null, JSON.stringify(nova.utm ?? {}), nova.contatoId ?? null, nova.registradoPor ?? null],
  );
  if (r.rows.length === 0) return null;
  return atribuicaoVigente(tx, empresaId, nova.alvoTipo, nova.alvoId);
}

/** Correção rastreável: trava a vigente, desativa e insere a nova apontando para ela. */
export async function corrigirAtribuicao(tx: DbExecutor, empresaId: string, nova: NovaAtribuicao & { motivo: string; idEsperado: string }) {
  const atual = await tx.query<{ id: string }>(
    `SELECT id::text FROM marketing_atribuicoes WHERE empresa_id = $1::uuid AND alvo_tipo = $2 AND alvo_id = $3::uuid AND vigente FOR UPDATE`,
    [empresaId, nova.alvoTipo, nova.alvoId],
  );
  if (atual.rows.length !== 1 || atual.rows[0].id !== nova.idEsperado) {
    throw new MarketingError("MARKETING_CONFLITO", "A origem foi alterada por outra pessoa. Recarregue antes de corrigir.", 409);
  }
  await tx.query(
    `UPDATE marketing_atribuicoes SET vigente = false, substituida_em = clock_timestamp() WHERE id = $1::uuid AND vigente`,
    [nova.idEsperado],
  );
  const r = await tx.query<{ id: string }>(
    `INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, canal_atendimento, campanha_id, metodo, detalhe, utm, contato_id,
       substitui_id, motivo, registrado_por)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid, $7, $8, $9::jsonb, $10::uuid, $11::uuid, $12, $13::uuid)
     RETURNING id::text`,
    [empresaId, nova.alvoTipo, nova.alvoId, nova.origemCodigo, nova.canalAtendimento ?? null, nova.campanhaId ?? null, nova.metodo,
      nova.detalhe ?? null, JSON.stringify(nova.utm ?? {}), nova.contatoId ?? null, nova.idEsperado, nova.motivo.trim(), nova.registradoPor ?? null],
  );
  return { id: r.rows[0].id };
}

// ---------------------------------------------------------------------------------------------------------------
// Origem manual (CRM): registrar a primeira ou corrigir a vigente.
// ---------------------------------------------------------------------------------------------------------------
export const esquemaOrigemManual = z.object({
  alvoTipo: z.enum(ALVOS),
  alvoId: z.string().uuid(),
  origemCodigo: z.string().regex(CODIGO_ORIGEM),
  canalAtendimento: z.enum(CANAIS_ATENDIMENTO).nullable().optional(),
  campanhaId: z.string().uuid().nullable().optional(),
  detalhe: z.string().trim().max(200).nullable().optional(),
  /** Presente = correção da vigente com este id (motivo obrigatório). */
  corrigeId: z.string().uuid().nullable().optional(),
  motivo: z.string().trim().max(300).nullable().optional(),
}).strict();
export type OrigemManual = z.infer<typeof esquemaOrigemManual>;

async function exigirCampanhaDaEmpresa(tx: DbExecutor, empresaId: string, campanhaId: string | null | undefined) {
  if (!campanhaId) return null;
  const r = await tx.query<{ id: string }>(`SELECT id::text FROM marketing_campanhas WHERE id = $1::uuid AND empresa_id = $2::uuid`, [campanhaId, empresaId]);
  if (r.rows.length !== 1) throw new MarketingError("MARKETING_CAMPANHA_INVALIDA", "Campanha não encontrada nesta empresa.", 404);
  return r.rows[0].id;
}

export async function registrarOrigemManual(tx: DbExecutor, empresaId: string, usuarioId: string, input: OrigemManual) {
  await exigirAlvoDaEmpresa(tx, empresaId, input.alvoTipo, input.alvoId);
  const corrigindo = Boolean(input.corrigeId);
  await exigirOrigemValida(tx, empresaId, input.origemCodigo, { permitirInativa: corrigindo });
  const campanhaId = await exigirCampanhaDaEmpresa(tx, empresaId, input.campanhaId);
  const nova: NovaAtribuicao = {
    alvoTipo: input.alvoTipo, alvoId: input.alvoId, origemCodigo: input.origemCodigo, canalAtendimento: input.canalAtendimento ?? null,
    campanhaId, metodo: "INFORMADO", detalhe: input.detalhe || null, registradoPor: usuarioId,
  };
  if (corrigindo) {
    if (!input.motivo || input.motivo.trim().length < 3) {
      throw new MarketingError("MARKETING_MOTIVO_OBRIGATORIO", "Explique o motivo da correção (o histórico é mantido).", 400);
    }
    return corrigirAtribuicao(tx, empresaId, { ...nova, motivo: input.motivo, idEsperado: input.corrigeId! });
  }
  const criada = await registrarSeAusente(tx, empresaId, nova);
  if (!criada) throw new MarketingError("MARKETING_ORIGEM_JA_REGISTRADA", "Este registro já tem origem. Use “Corrigir” para trocar, com motivo.", 409);
  return { id: criada.id };
}

/** Atribuição desconhecida explícita (sem evidência): nunca usada para preencher lacuna com palpite. */
export function atribuicaoDesconhecida(alvoTipo: AlvoAtribuicao, alvoId: string, canal: CanalAtendimento | null, utm: Utm = {}): NovaAtribuicao {
  return { alvoTipo, alvoId, origemCodigo: ORIGEM_DESCONHECIDA, canalAtendimento: canal, metodo: "DESCONHECIDO", utm };
}
