import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { MarketingError } from "../erros.ts";

/**
 * Descadastro e autorização de mensagens do Marketing (084, com a correção R1 de 15/10/2026).
 *
 * Autorização é POR DESTINO: o número normalizado que a pessoa autorizou, com origem (formulário do site ou equipe) e
 * evidência (contato captado, registro da equipe). Regras:
 *   - só autorização CONFIRMADA de um número que AINDA está no cadastro do cliente permite mensagem; o motor envia
 *     exatamente para esse número (nunca para outro número do mesmo cliente);
 *   - mudança de número no cadastro não herda autorização antiga;
 *   - reaproveitar cadastro sem o número informado (ex.: mesmo e-mail, outro telefone) NÃO prova o destino: a autorização
 *     fica PENDENTE até a equipe confirmar; o CRM não é alterado e o número fica guardado no contato e na autorização;
 *   - descadastro é do cliente inteiro, prevalece sobre tudo e revoga as autorizações vivas (histórico mantido);
 *   - o controle "não contatar" do atendimento WhatsApp (082), quando existe, também bloqueia;
 *   - tudo é revalidado imediatamente antes do envio. Não há autorização sem destino: nada é presumido.
 * Limite conhecido: o formulário é "opt-in simples" (sem código de confirmação no número); ver docs/MARKETING_LOCAL_20261014.md.
 */

/** Destino canônico: só dígitos; número brasileiro de 10/11 dígitos ganha o DDI 55 (mesma equivalência da deduplicação). */
export function normalizarDestino(valor: string | null | undefined): string | null {
  const d = (valor ?? "").replace(/\D/g, "");
  if (/^\d{10,11}$/.test(d)) return `55${d}`;
  return /^\d{12,15}$/.test(d) ? d : null;
}

/** Números do cadastro do cliente, na ordem de preferência para mensagem (WhatsApp antes do telefone), sem repetição. */
export function destinosDoCadastro(cliente: { whatsapp: string | null; telefone: string | null }) {
  return [...new Set([normalizarDestino(cliente.whatsapp), normalizarDestino(cliente.telefone)].filter((v): v is string => Boolean(v)))];
}

export type Descadastro = { descadastradoEm: string | null; descadastroOrigem: string | null };
export type Autorizacao = {
  id: string; destino: string; estado: "PENDENTE" | "CONFIRMADA" | "REVOGADA"; origem: "FORMULARIO_SITE" | "EQUIPE"; contatoId: string | null;
  evidencia: string; confirmadaEm: string | null; confirmacao: string | null; revogadaEm: string | null; motivoRevogacao: string | null; criadoEm: string;
};

export async function automacoesInstaladas(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.marketing_contato_autorizacoes') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

export async function lerDescadastro(tx: DbExecutor, empresaId: string, clienteId: string): Promise<Descadastro> {
  const r = await tx.query<{ descadastrado_em: string | null; descadastro_origem: string | null }>(
    `SELECT descadastrado_em::text, descadastro_origem FROM marketing_contato_preferencias WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`,
    [empresaId, clienteId]);
  return { descadastradoEm: r.rows[0]?.descadastrado_em ?? null, descadastroOrigem: r.rows[0]?.descadastro_origem ?? null };
}

export async function listarAutorizacoes(tx: DbExecutor, empresaId: string, clienteId: string): Promise<Autorizacao[]> {
  const r = await tx.query<{ id: string; destino: string; estado: Autorizacao["estado"]; origem: Autorizacao["origem"]; contato_id: string | null; evidencia: string;
    confirmada_em: string | null; confirmacao: string | null; revogada_em: string | null; motivo_revogacao: string | null; criado_em: string }>(
    `SELECT id::text, destino, estado, origem, contato_id::text, evidencia, confirmada_em::text, confirmacao, revogada_em::text, motivo_revogacao, criado_em::text
       FROM marketing_contato_autorizacoes WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND canal = 'WHATSAPP'
      ORDER BY (estado = 'REVOGADA'), criado_em DESC`, [empresaId, clienteId]);
  return r.rows.map((l) => ({ id: l.id, destino: l.destino, estado: l.estado, origem: l.origem, contatoId: l.contato_id, evidencia: l.evidencia,
    confirmadaEm: l.confirmada_em, confirmacao: l.confirmacao, revogadaEm: l.revogada_em, motivoRevogacao: l.motivo_revogacao, criadoEm: l.criado_em }));
}

/** Compatibilidade de leitura para a tela: descadastro + autorizações. */
export async function lerPreferencia(tx: DbExecutor, empresaId: string, clienteId: string) {
  return { ...(await lerDescadastro(tx, empresaId, clienteId)), autorizacoes: await listarAutorizacoes(tx, empresaId, clienteId) };
}

export type ResultadoFormulario = "CONFIRMADA" | "PENDENTE" | "JA_EXISTENTE" | "IGNORADA_DESCADASTRO" | "SEM_DESTINO" | "NAO_INSTALADA";

/**
 * Caixa "aceito receber mensagens" marcada no formulário do site, com o número informado no pedido.
 *   - o número é o do cliente vinculado (cliente novo criado com ele, ou cadastro que já tem esse número) → CONFIRMADA;
 *   - cadastro reaproveitado sem esse número (ex.: pelo e-mail) → PENDENTE (não autoriza nenhum número do cadastro);
 *   - cliente descadastrado → nada é registrado (o formulário nunca desfaz descadastro).
 */
export async function registrarAutorizacaoDoFormulario(
  tx: DbExecutor, empresaId: string, clienteId: string, contatoId: string, telefoneInformado: string,
): Promise<ResultadoFormulario> {
  if (!(await automacoesInstaladas(tx))) return "NAO_INSTALADA";
  const destino = normalizarDestino(telefoneInformado);
  if (!destino) return "SEM_DESTINO";
  if ((await lerDescadastro(tx, empresaId, clienteId)).descadastradoEm) return "IGNORADA_DESCADASTRO";
  const c = await tx.query<{ whatsapp: string | null; telefone: string | null }>(
    `SELECT whatsapp, telefone FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid`, [clienteId, empresaId]);
  const doCadastro = c.rows[0] ? destinosDoCadastro(c.rows[0]) : [];
  const comprovado = doCadastro.includes(destino);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO marketing_contato_autorizacoes (empresa_id, cliente_id, canal, destino, estado, origem, contato_id, evidencia, confirmada_em, confirmacao)
     VALUES ($1::uuid, $2::uuid, 'WHATSAPP', $3, $4, 'FORMULARIO_SITE', $5::uuid, $6,
             CASE WHEN $4 = 'CONFIRMADA' THEN clock_timestamp() END, CASE WHEN $4 = 'CONFIRMADA' THEN $7 END)
     ON CONFLICT (empresa_id, cliente_id, canal, destino) WHERE estado <> 'REVOGADA' DO NOTHING
     RETURNING id::text`,
    [empresaId, clienteId, destino, comprovado ? "CONFIRMADA" : "PENDENTE", contatoId,
      "Caixa de autorização marcada no formulário do site, com este número.",
      "Número do pedido coincide com o cadastro do cliente vinculado."]);
  if (r.rows.length === 0) return "JA_EXISTENTE";
  return comprovado ? "CONFIRMADA" : "PENDENTE";
}

const texto = z.string().trim().min(3).max(300);
export const esquemaPreferencia = z.discriminatedUnion("operacao", [
  z.object({ acao: z.literal("preferencia"), operacao: z.literal("autorizar"), clienteId: z.string().uuid(), destino: z.string().trim().max(20), confirmacao: texto }).strict(),
  z.object({ acao: z.literal("preferencia"), operacao: z.literal("confirmar"), clienteId: z.string().uuid(), autorizacaoId: z.string().uuid(), confirmacao: texto }).strict(),
  z.object({ acao: z.literal("preferencia"), operacao: z.literal("revogar"), clienteId: z.string().uuid(), autorizacaoId: z.string().uuid(), confirmacao: texto }).strict(),
  z.object({ acao: z.literal("preferencia"), operacao: z.literal("descadastrar"), clienteId: z.string().uuid(), confirmacao: texto }).strict(),
  z.object({ acao: z.literal("preferencia"), operacao: z.literal("reativar"), clienteId: z.string().uuid(), confirmacao: texto }).strict(),
]);
export type OperacaoPreferencia = z.infer<typeof esquemaPreferencia>;

/**
 * Pela equipe, sempre com o registro de como a pessoa autorizou/pediu:
 *   autorizar   — um número QUE ESTÁ no cadastro do cliente (confirmado pela equipe);
 *   confirmar   — uma autorização PENDENTE (ex.: número do formulário diferente do cadastro);
 *   revogar     — uma autorização viva;
 *   descadastrar — o cliente inteiro (revoga as vivas e suprime mensagens agendadas);
 *   reativar    — tira o descadastro após novo pedido da pessoa; NÃO devolve autorizações antigas.
 */
export async function alterarPreferencia(tx: DbExecutor, empresaId: string, usuarioId: string, input: OperacaoPreferencia) {
  const cliente = await tx.query<{ whatsapp: string | null; telefone: string | null }>(
    `SELECT whatsapp, telefone FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [input.clienteId, empresaId]);
  if (cliente.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Cliente não encontrado nesta empresa.", 404);
  const descadastro = await lerDescadastro(tx, empresaId, input.clienteId);
  let canceladas = 0;
  if (input.operacao === "descadastrar") {
    await tx.query(
      `INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, descadastrado_em, descadastro_origem, observacao, atualizado_por)
       VALUES ($1::uuid, $2::uuid, clock_timestamp(), 'EQUIPE', $4, $3::uuid)
       ON CONFLICT (empresa_id, cliente_id) DO UPDATE SET descadastrado_em = clock_timestamp(), descadastro_origem = 'EQUIPE',
         observacao = $4, atualizado_por = $3::uuid, atualizado_em = clock_timestamp()`, [empresaId, input.clienteId, usuarioId, input.confirmacao]);
    await revogarVivas(tx, empresaId, input.clienteId, usuarioId, "DESCADASTRO: " + input.confirmacao);
    canceladas = await suprimirAgendadasDoCliente(tx, empresaId, input.clienteId, "DESCADASTRADO");
  } else if (input.operacao === "reativar") {
    if (!descadastro.descadastradoEm) throw new MarketingError("MARKETING_NAO_DESCADASTRADO", "O cliente não está descadastrado.", 409);
    await tx.query(
      `UPDATE marketing_contato_preferencias SET descadastrado_em = NULL, descadastro_origem = NULL, observacao = $4, atualizado_por = $3::uuid,
         atualizado_em = clock_timestamp() WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`, [empresaId, input.clienteId, usuarioId, input.confirmacao]);
  } else {
    if (descadastro.descadastradoEm && input.operacao !== "revogar") {
      throw new MarketingError("MARKETING_DESCADASTRADO", "Cliente descadastrado. Use “Reativar” somente com novo pedido da própria pessoa.", 409);
    }
    if (input.operacao === "autorizar") {
      const destino = normalizarDestino(input.destino);
      if (!destino || !destinosDoCadastro(cliente.rows[0]).includes(destino)) {
        throw new MarketingError("MARKETING_DESTINO_FORA_DO_CADASTRO", "Autorize só um número que está no cadastro do cliente. Para outro número, atualize o cadastro antes.", 400);
      }
      const pendente = await tx.query<{ id: string }>(
        `SELECT id::text FROM marketing_contato_autorizacoes WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND canal = 'WHATSAPP' AND destino = $3 AND estado = 'PENDENTE' FOR UPDATE`,
        [empresaId, input.clienteId, destino]);
      if (pendente.rows[0]) await confirmar(tx, empresaId, input.clienteId, pendente.rows[0].id, usuarioId, input.confirmacao);
      else {
        await tx.query(
          `INSERT INTO marketing_contato_autorizacoes (empresa_id, cliente_id, canal, destino, estado, origem, evidencia, confirmada_em, confirmada_por, confirmacao, criado_por)
           VALUES ($1::uuid, $2::uuid, 'WHATSAPP', $3, 'CONFIRMADA', 'EQUIPE', $4, clock_timestamp(), $5::uuid, $4, $5::uuid)
           ON CONFLICT (empresa_id, cliente_id, canal, destino) WHERE estado <> 'REVOGADA' DO NOTHING`,
          [empresaId, input.clienteId, destino, input.confirmacao, usuarioId]);
      }
    } else if (input.operacao === "confirmar") {
      await confirmar(tx, empresaId, input.clienteId, input.autorizacaoId, usuarioId, input.confirmacao);
    } else {
      const r = await tx.query<{ id: string }>(
        `UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = clock_timestamp(), revogada_por = $4::uuid, motivo_revogacao = $5,
           atualizado_em = clock_timestamp() WHERE id = $1::uuid AND empresa_id = $2::uuid AND cliente_id = $3::uuid AND estado <> 'REVOGADA' RETURNING id::text`,
        [input.autorizacaoId, empresaId, input.clienteId, usuarioId, input.confirmacao]);
      if (!r.rows[0]) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Autorização não encontrada ou já revogada.", 404);
    }
  }
  return { preferencia: await lerPreferencia(tx, empresaId, input.clienteId), canceladas };
}

async function confirmar(tx: DbExecutor, empresaId: string, clienteId: string, autorizacaoId: string, usuarioId: string, confirmacao: string) {
  const r = await tx.query<{ id: string }>(
    `UPDATE marketing_contato_autorizacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(), confirmada_por = $4::uuid, confirmacao = $5,
       atualizado_em = clock_timestamp() WHERE id = $1::uuid AND empresa_id = $2::uuid AND cliente_id = $3::uuid AND estado = 'PENDENTE' RETURNING id::text`,
    [autorizacaoId, empresaId, clienteId, usuarioId, confirmacao]);
  if (!r.rows[0]) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Autorização pendente não encontrada.", 404);
}

async function revogarVivas(tx: DbExecutor, empresaId: string, clienteId: string, usuarioId: string | null, motivo: string) {
  await tx.query(
    `UPDATE marketing_contato_autorizacoes SET estado = 'REVOGADA', revogada_em = clock_timestamp(), revogada_por = $3::uuid, motivo_revogacao = $4,
       atualizado_em = clock_timestamp() WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND estado <> 'REVOGADA'`,
    [empresaId, clienteId, usuarioId, motivo.slice(0, 300)]);
}

/** Descadastro: mensagens ainda agendadas para o cliente viram SUPRIMIDA (tarefas internas continuam). */
export async function suprimirAgendadasDoCliente(tx: DbExecutor, empresaId: string, clienteId: string, motivo: string) {
  const r = await tx.query<{ id: string }>(
    `UPDATE marketing_automacao_execucoes SET estado = 'SUPRIMIDA', motivo = $3, concluida_em = clock_timestamp(), atualizado_em = clock_timestamp()
      WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND estado = 'AGENDADA' AND acao = 'MENSAGEM_WHATSAPP' RETURNING id::text`,
    [empresaId, clienteId, motivo]);
  for (const { id } of r.rows) {
    await tx.query(`INSERT INTO marketing_automacao_eventos (empresa_id, execucao_id, estado_anterior, estado_novo, detalhe) VALUES ($1::uuid, $2::uuid, 'AGENDADA', 'SUPRIMIDA', $3::jsonb)`,
      [empresaId, id, JSON.stringify({ motivo })]);
  }
  return r.rows.length;
}

export type MotivoInelegivel = "SEM_AUTORIZACAO" | "SEM_AUTORIZACAO_DESTINO" | "DESCADASTRADO" | "SEM_TELEFONE" | "NAO_CONTATAR_ATENDIMENTO" | "CLIENTE_INATIVO";
export type Elegibilidade = { ok: true; telefone: string; autorizacaoId: string } | { ok: false; motivo: MotivoInelegivel };

/**
 * Revalidação no momento do envio. Devolve o DESTINO que o transporte deve usar: o primeiro número do cadastro atual
 * (WhatsApp, depois telefone) que tem autorização CONFIRMADA. Autorização de número que saiu do cadastro não vale;
 * autorização pendente não vale.
 */
export async function elegivelParaMensagem(tx: DbExecutor, empresaId: string, clienteId: string): Promise<Elegibilidade> {
  const c = await tx.query<{ status: string; whatsapp: string | null; telefone: string | null }>(
    `SELECT status, whatsapp, telefone FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid`, [clienteId, empresaId]);
  const cliente = c.rows[0];
  if (!cliente || cliente.status !== "ATIVO") return { ok: false, motivo: "CLIENTE_INATIVO" };
  if ((await lerDescadastro(tx, empresaId, clienteId)).descadastradoEm) return { ok: false, motivo: "DESCADASTRADO" };
  const destinos = destinosDoCadastro(cliente);
  if (destinos.length === 0) return { ok: false, motivo: "SEM_TELEFONE" };
  const confirmadas = await tx.query<{ id: string; destino: string }>(
    `SELECT id::text, destino FROM marketing_contato_autorizacoes WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND canal = 'WHATSAPP' AND estado = 'CONFIRMADA'`,
    [empresaId, clienteId]);
  if (confirmadas.rows.length === 0) return { ok: false, motivo: "SEM_AUTORIZACAO" };
  const escolhido = destinos.map((d) => confirmadas.rows.find((a) => a.destino === d)).find(Boolean);
  if (!escolhido) return { ok: false, motivo: "SEM_AUTORIZACAO_DESTINO" };
  const controle = await tx.query<{ existe: string | null }>(`SELECT to_regclass('public.whatsapp_atendimento_controles_contato')::text AS existe`);
  if (controle.rows[0]?.existe) {
    const nacional = escolhido.destino.startsWith("55") ? escolhido.destino.slice(2) : escolhido.destino;
    const bloqueio = await tx.query<{ ok: boolean }>(
      `SELECT true AS ok FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1::uuid AND nao_contatar AND contato IN ($2, $3) LIMIT 1`,
      [empresaId, escolhido.destino, nacional]);
    if (bloqueio.rows.length > 0) return { ok: false, motivo: "NAO_CONTATAR_ATENDIMENTO" };
  }
  return { ok: true, telefone: escolhido.destino, autorizacaoId: escolhido.id };
}
