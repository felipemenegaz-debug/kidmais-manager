import { z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import { buscarClientesPorContatoExato, buscarClientesPorEmailExato, criarCliente } from "../clientes/repositories/cliente.repository.ts";
import { registrarPossivelDuplicidade } from "../clientes/repositories/duplicidade.repository.ts";
import { registrarEventoHistorico } from "../clientes/repositories/historico.repository.ts";
import { registrarAuditoria } from "../clientes/repositories/auditoria.repository.ts";
import { MarketingError, naoEncontrado } from "./erros.ts";
import {
  atribuicaoDesconhecida, atribuicaoVigente, historicoAtribuicao, registrarSeAusente, type Atribuicao, type NovaAtribuicao,
} from "./atribuicao.ts";
import { campanhaPorCodigo, exigirUnidadeDaEmpresa } from "./campanhas.ts";
import { CANAIS_ATENDIMENTO, CODIGO_ORIGEM, exigirOrigemValida, type CanalAtendimento } from "./origens.ts";
import type { CapturaCampanha } from "./utm.ts";
import { registrarAutorizacaoDoFormulario, type ResultadoFormulario } from "./automacoes/preferencias.ts";

export const ORIGEM_SITE = "SITE_PUBLICO";
export const STATUS_CONTATO = ["NOVO", "EM_ATENDIMENTO", "CONVERTIDO", "DESCARTADO"] as const;
export type StatusContato = (typeof STATUS_CONTATO)[number];

const telefone = z.string().trim().transform((v) => v.replace(/\D/g, "")).pipe(z.string().regex(/^[0-9]{10,15}$/, "Informe o telefone com DDD."));
const email = z.string().trim().toLowerCase().max(254).email("E-mail inválido.");
const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Corpo do formulário público. `site` vem da URL; empresa e unidade, só do servidor. */
export const esquemaFormularioPublico = z.object({
  nome: z.string().trim().min(2, "Informe seu nome.").max(120),
  telefone: telefone.optional().or(z.literal("")),
  email: email.optional().or(z.literal("")),
  dataDesejada: dataIso.optional().or(z.literal("")),
  convidados: z.coerce.number().int().min(1).max(5000).optional().or(z.literal("")),
  mensagem: z.string().trim().max(1000).optional(),
  chave: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  /** Autorização explícita (caixa desmarcada por padrão) para mensagens do buffet pelo WhatsApp. */
  autorizaWhatsapp: z.boolean().optional(),
  /** Honeypot: campo invisível; preenchido = robô (resposta igual, nada gravado). */
  website: z.string().max(200).optional(),
  utm_source: z.string().max(120).optional(), utm_medium: z.string().max(120).optional(), utm_campaign: z.string().max(120).optional(),
  utm_content: z.string().max(120).optional(), utm_term: z.string().max(120).optional(), kc: z.string().max(120).optional(),
}).strict().refine((v) => Boolean(v.telefone) || Boolean(v.email), { message: "Informe telefone ou e-mail para retorno.", path: ["telefone"] });
export type FormularioPublico = z.infer<typeof esquemaFormularioPublico>;

export type SitePublicoEscopo = { siteId: string; empresaId: string; estabelecimentoId: string | null };

/**
 * Pedido de orçamento do site. Idempotente pela chave do formulário (repetição não duplica contato, cliente nem
 * atribuição). Reaproveita a deduplicação do CRM sem revelar nada a quem enviou:
 *   - exatamente 1 cliente ATIVO da empresa com o mesmo telefone/WhatsApp → reaproveita (nada do cadastro é alterado);
 *   - senão, exatamente 1 com o mesmo e-mail → reaproveita;
 *   - senão cria cliente novo; candidatos ambíguos viram "possível duplicidade" para a equipe revisar.
 * Origem: campanha só pelo `kc` válido da MESMA empresa (CAPTURADO); sem isso, DESCONHECIDA (UTM solta fica guardada
 * como informação). Cliente novo recebe a mesma como primeira origem; cliente existente mantém a sua.
 */
export async function capturarContatoPublico(
  tx: DbExecutor,
  site: SitePublicoEscopo,
  entrada: { nome: string; telefone: string | null; email: string | null; dataDesejada: string | null; convidados: number | null; mensagem: string | null; chave: string; autorizaWhatsapp?: boolean },
  captura: CapturaCampanha,
): Promise<{ contatoId: string; repetido: boolean }> {
  const inserido = await tx.query<{ id: string }>(
    `INSERT INTO marketing_contatos (empresa_id, estabelecimento_id, site_id, canal_atendimento, nome, telefone, email, data_desejada, convidados,
       mensagem, chave_idempotencia, vinculo_cliente)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'FORMULARIO_SITE', $4, $5, $6, $7::date, $8, $9, $10, 'SEM_CLIENTE')
     ON CONFLICT (empresa_id, chave_idempotencia) DO NOTHING
     RETURNING id::text`,
    [site.empresaId, site.estabelecimentoId, site.siteId, entrada.nome, entrada.telefone, entrada.email, entrada.dataDesejada,
      entrada.convidados, entrada.mensagem, entrada.chave],
  );
  if (inserido.rows.length === 0) {
    const existente = await tx.query<{ id: string }>(
      `SELECT id::text FROM marketing_contatos WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`, [site.empresaId, entrada.chave]);
    return { contatoId: existente.rows[0].id, repetido: true };
  }
  const contatoId = inserido.rows[0].id;

  const campanha = captura.codigoCampanha ? await campanhaPorCodigo(tx, site.empresaId, captura.codigoCampanha) : null;
  const utm = { ...captura.utm };
  const atribuicaoBase: Omit<NovaAtribuicao, "alvoTipo" | "alvoId"> = campanha
    ? { origemCodigo: campanha.origemCodigo, canalAtendimento: "FORMULARIO_SITE", campanhaId: campanha.id, metodo: "CAPTURADO", utm, contatoId }
    : { ...atribuicaoDesconhecida("CONTATO", contatoId, "FORMULARIO_SITE", utm), contatoId };
  await registrarSeAusente(tx, site.empresaId, { ...atribuicaoBase, alvoTipo: "CONTATO", alvoId: contatoId });

  const { clienteId, novo } = await clienteDoContato(tx, site.empresaId, entrada);
  await tx.query(
    `UPDATE marketing_contatos SET cliente_id = $2::uuid, vinculo_cliente = $3, atualizado_em = clock_timestamp() WHERE id = $1::uuid`,
    [contatoId, clienteId, novo ? "NOVO" : "EXISTENTE_CONTATO"],
  );
  if (novo) {
    await registrarSeAusente(tx, site.empresaId, { ...atribuicaoBase, alvoTipo: "CLIENTE", alvoId: clienteId });
    await registrarAuditoria({
      clienteId, atorTipo: "SISTEMA", usuarioId: null, acao: "CLIENTE_CRIADO", entidadeTipo: "CLIENTE", entidadeId: clienteId,
      dadosDepois: { origem: ORIGEM_SITE, contatoMarketingId: contatoId }, origem: ORIGEM_SITE,
    }, tx);
  }
  // Consentimento (R1): vale só para o número INFORMADO no pedido. Se o cadastro vinculado não tem esse número (ex.:
  // reaproveitado pelo e-mail), fica PENDENTE para a equipe confirmar; nunca autoriza outro número do cadastro, nunca
  // altera o CRM e nunca desfaz descadastro (085 ausente = ignorado).
  const autorizacao: ResultadoFormulario | null = entrada.autorizaWhatsapp === true && entrada.telefone
    ? await registrarAutorizacaoDoFormulario(tx, site.empresaId, clienteId, contatoId, entrada.telefone) : null;
  await registrarEventoHistorico({
    clienteId, tipoEvento: "CONTATO_MARKETING_RECEBIDO", origem: ORIGEM_SITE, entidadeTipo: "MARKETING_CONTATO", entidadeId: contatoId,
    detalhe: "Pedido de orçamento recebido pelo site.", metadata: { canal: "FORMULARIO_SITE", campanhaId: campanha?.id ?? null, clienteNovo: novo, autorizacaoWhatsapp: autorizacao },
  }, tx);
  return { contatoId, repetido: false };
}

/** Telefone com e sem o DDI 55 (o CRM guarda dígitos como foram digitados): o mesmo número acha o mesmo cliente. */
export function variantesTelefone(digitos: string) {
  const v = new Set([digitos]);
  if (/^55\d{10,11}$/.test(digitos)) v.add(digitos.slice(2));
  if (/^\d{10,11}$/.test(digitos)) v.add(`55${digitos}`);
  return [...v];
}

async function clientesPorTelefone(tx: DbExecutor, empresaId: string, telefone: string) {
  const vistos = new Map<string, Awaited<ReturnType<typeof buscarClientesPorContatoExato>>[number]>();
  for (const v of variantesTelefone(telefone)) for (const c of await buscarClientesPorContatoExato(v, empresaId, tx)) if (c.status === "ATIVO") vistos.set(c.id, c);
  return [...vistos.values()];
}

async function clienteDoContato(
  tx: DbExecutor, empresaId: string, entrada: { nome: string; telefone: string | null; email: string | null },
): Promise<{ clienteId: string; novo: boolean }> {
  const porTelefone = entrada.telefone ? await clientesPorTelefone(tx, empresaId, entrada.telefone) : [];
  if (porTelefone.length === 1) return { clienteId: porTelefone[0].id, novo: false };
  const porEmail = porTelefone.length === 0 && entrada.email
    ? (await buscarClientesPorEmailExato(entrada.email, empresaId, tx)).filter((c) => c.status === "ATIVO") : [];
  if (porEmail.length === 1) return { clienteId: porEmail[0].id, novo: false };
  const criado = await criarCliente({ empresaId, nomeCompleto: entrada.nome, telefone: entrada.telefone, whatsapp: entrada.telefone, email: entrada.email }, tx);
  const candidatos = [...porTelefone.map((c) => ({ id: c.id, motivo: "TELEFONE_IGUAL" })), ...porEmail.map((c) => ({ id: c.id, motivo: "EMAIL_IGUAL" }))].slice(0, 5);
  for (const candidato of candidatos) {
    await registrarPossivelDuplicidade({ clienteUmId: criado.id, clienteDoisId: candidato.id, motivos: [candidato.motivo] }, tx);
  }
  return { clienteId: criado.id, novo: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Administração (tela Origens dos contatos).
// ---------------------------------------------------------------------------------------------------------------
export type ContatoLista = {
  id: string; nome: string; telefone: string | null; email: string | null; canal: CanalAtendimento; status: StatusContato;
  recebidoEm: string; dataDesejada: string | null; convidados: number | null; clienteId: string | null; clienteNome: string | null;
  vinculoCliente: string; fechamentoId: string | null; origemCodigo: string | null; metodo: string | null; campanhaId: string | null;
  campanhaNome: string | null; unidadeId: string | null;
};

export async function listarContatos(
  tx: DbExecutor, empresaId: string,
  filtros: { id?: string | null; de?: string | null; ate?: string | null; status?: StatusContato | null; unidadeId?: string | null; campanhaId?: string | null; limite?: number },
): Promise<ContatoLista[]> {
  const r = await tx.query<{
    id: string; nome: string; telefone: string | null; email: string | null; canal_atendimento: CanalAtendimento; status: StatusContato; recebido_em: string;
    data_desejada: string | null; convidados: number | null; cliente_id: string | null; cliente_nome: string | null; vinculo_cliente: string;
    fechamento_id: string | null; origem_codigo: string | null; metodo: string | null; campanha_id: string | null; campanha_nome: string | null;
    estabelecimento_id: string | null;
  }>(
    `SELECT k.id::text, k.nome, k.telefone, k.email, k.canal_atendimento, k.status, k.recebido_em::text, k.data_desejada::text, k.convidados,
            k.cliente_id::text, c.nome_completo AS cliente_nome, k.vinculo_cliente, k.fechamento_id::text, a.origem_codigo, a.metodo,
            a.campanha_id::text, cp.nome AS campanha_nome, k.estabelecimento_id::text
       FROM marketing_contatos k
       LEFT JOIN clientes c ON c.id = k.cliente_id AND c.empresa_id = k.empresa_id
       LEFT JOIN marketing_atribuicoes a ON a.empresa_id = k.empresa_id AND a.alvo_tipo = 'CONTATO' AND a.alvo_id = k.id AND a.vigente
       LEFT JOIN marketing_campanhas cp ON cp.id = a.campanha_id AND cp.empresa_id = k.empresa_id
      WHERE k.empresa_id = $1::uuid
        AND ($2::date IS NULL OR k.recebido_em >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
        AND ($3::date IS NULL OR k.recebido_em < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
        AND ($4::text IS NULL OR k.status = $4)
        AND ($5::uuid IS NULL OR k.estabelecimento_id = $5::uuid)
        AND ($6::uuid IS NULL OR a.campanha_id = $6::uuid)
        AND ($8::uuid IS NULL OR k.id = $8::uuid)
      ORDER BY k.recebido_em DESC, k.id
      LIMIT $7`,
    [empresaId, filtros.de ?? null, filtros.ate ?? null, filtros.status ?? null, filtros.unidadeId ?? null, filtros.campanhaId ?? null,
      Math.min(Math.max(filtros.limite ?? 200, 1), 500), filtros.id ?? null],
  );
  return r.rows.map((l) => ({
    id: l.id, nome: l.nome, telefone: l.telefone, email: l.email, canal: l.canal_atendimento, status: l.status, recebidoEm: l.recebido_em,
    dataDesejada: l.data_desejada, convidados: l.convidados, clienteId: l.cliente_id, clienteNome: l.cliente_nome, vinculoCliente: l.vinculo_cliente,
    fechamentoId: l.fechamento_id, origemCodigo: l.origem_codigo, metodo: l.metodo, campanhaId: l.campanha_id, campanhaNome: l.campanha_nome,
    unidadeId: l.estabelecimento_id,
  }));
}

export type DetalheContato = ContatoLista & {
  mensagem: string | null;
  atribuicoes: Atribuicao[];
  origemCliente: Atribuicao | null;
  fechamentosDoCliente: Array<{ id: string; dataEvento: string; status: string; origemDefinida: boolean; vinculadoAOutroContato: boolean }>;
};

export async function detalheContato(tx: DbExecutor, empresaId: string, contatoId: string): Promise<DetalheContato> {
  const base = (await listarContatosPorId(tx, empresaId, contatoId));
  if (!base) naoEncontrado("Contato não encontrado nesta empresa.");
  const mensagem = await tx.query<{ mensagem: string | null }>(`SELECT mensagem FROM marketing_contatos WHERE id = $1::uuid AND empresa_id = $2::uuid`, [contatoId, empresaId]);
  const atribuicoes = await historicoAtribuicao(tx, empresaId, "CONTATO", contatoId);
  const origemCliente = base.clienteId ? await atribuicaoVigente(tx, empresaId, "CLIENTE", base.clienteId) : null;
  const fechamentos = base.clienteId ? (await tx.query<{ id: string; data_evento: string; status: string; origem_definida: boolean; outro: boolean }>(
    `SELECT f.id::text, f.data_evento::text, f.status,
            EXISTS (SELECT 1 FROM marketing_atribuicoes a WHERE a.empresa_id = f.empresa_id AND a.alvo_tipo = 'FECHAMENTO' AND a.alvo_id = f.id AND a.vigente) AS origem_definida,
            EXISTS (SELECT 1 FROM marketing_contatos k WHERE k.fechamento_id = f.id AND k.id <> $3::uuid) AS outro
       FROM fechamentos f WHERE f.empresa_id = $1::uuid AND f.cliente_id = $2::uuid
      ORDER BY f.data_evento DESC, f.id LIMIT 50`,
    [empresaId, base.clienteId, contatoId],
  )).rows : [];
  return {
    ...base, mensagem: mensagem.rows[0]?.mensagem ?? null, atribuicoes, origemCliente,
    fechamentosDoCliente: fechamentos.map((f) => ({ id: f.id, dataEvento: f.data_evento, status: f.status, origemDefinida: f.origem_definida, vinculadoAOutroContato: f.outro })),
  };
}

async function listarContatosPorId(tx: DbExecutor, empresaId: string, contatoId: string) {
  return (await listarContatos(tx, empresaId, { id: contatoId, limite: 1 }))[0] ?? null;
}

export const esquemaAcaoContato = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("registrar"),
    nome: z.string().trim().min(2).max(120),
    telefone: telefone.nullable().optional(),
    email: email.nullable().optional(),
    canal: z.enum(CANAIS_ATENDIMENTO),
    origemCodigo: z.string().regex(CODIGO_ORIGEM).nullable().optional(),
    campanhaId: z.string().uuid().nullable().optional(),
    detalhe: z.string().trim().max(200).nullable().optional(),
    dataDesejada: dataIso.nullable().optional(),
    convidados: z.number().int().min(1).max(5000).nullable().optional(),
    mensagem: z.string().trim().max(1000).nullable().optional(),
    clienteId: z.string().uuid().nullable().optional(),
    unidadeId: z.string().uuid().nullable().optional(),
    chave: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  }).strict(),
  z.object({ acao: z.literal("status"), id: z.string().uuid(), status: z.enum(["NOVO", "EM_ATENDIMENTO", "DESCARTADO"]) }).strict(),
  z.object({ acao: z.literal("vincular-cliente"), id: z.string().uuid(), clienteId: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("vincular-negociacao"), id: z.string().uuid(), fechamentoId: z.string().uuid() }).strict(),
]);
export type AcaoContato = z.infer<typeof esquemaAcaoContato>;

export async function executarAcaoContato(tx: DbExecutor, empresaId: string, usuarioId: string, acao: AcaoContato) {
  if (acao.acao === "registrar") {
    if (!acao.telefone && !acao.email) throw new MarketingError("MARKETING_CONTATO_SEM_MEIO", "Informe telefone ou e-mail.", 400);
    const unidade = await exigirUnidadeDaEmpresa(tx, empresaId, acao.unidadeId);
    if (acao.clienteId) await exigirClienteAtivo(tx, empresaId, acao.clienteId);
    if (acao.origemCodigo) await exigirOrigemValida(tx, empresaId, acao.origemCodigo);
    const campanha = acao.campanhaId ? await tx.query<{ id: string }>(
      `SELECT id::text FROM marketing_campanhas WHERE id = $1::uuid AND empresa_id = $2::uuid`, [acao.campanhaId, empresaId]) : null;
    if (campanha && campanha.rows.length !== 1) throw new MarketingError("MARKETING_CAMPANHA_INVALIDA", "Campanha não encontrada nesta empresa.", 404);
    const r = await tx.query<{ id: string }>(
      `INSERT INTO marketing_contatos (empresa_id, estabelecimento_id, cliente_id, canal_atendimento, nome, telefone, email, data_desejada, convidados,
         mensagem, chave_idempotencia, vinculo_cliente, status, atualizado_por)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, 'EM_ATENDIMENTO', $13::uuid)
       ON CONFLICT (empresa_id, chave_idempotencia) DO NOTHING
       RETURNING id::text`,
      [empresaId, unidade, acao.clienteId ?? null, acao.canal, acao.nome, acao.telefone ?? null, acao.email ?? null, acao.dataDesejada ?? null,
        acao.convidados ?? null, acao.mensagem || null, acao.chave, acao.clienteId ? "MANUAL" : "SEM_CLIENTE", usuarioId],
    );
    if (r.rows.length === 0) {
      const existente = await tx.query<{ id: string }>(`SELECT id::text FROM marketing_contatos WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`, [empresaId, acao.chave]);
      return { id: existente.rows[0].id, repetido: true };
    }
    const id = r.rows[0].id;
    await registrarSeAusente(tx, empresaId, acao.origemCodigo
      ? { alvoTipo: "CONTATO", alvoId: id, origemCodigo: acao.origemCodigo, canalAtendimento: acao.canal, campanhaId: acao.campanhaId ?? null,
        metodo: "INFORMADO", detalhe: acao.detalhe || null, contatoId: id, registradoPor: usuarioId }
      : { ...atribuicaoDesconhecida("CONTATO", id, acao.canal), contatoId: id, registradoPor: usuarioId });
    if (acao.clienteId) {
      await registrarEventoHistorico({
        clienteId: acao.clienteId, tipoEvento: "CONTATO_MARKETING_REGISTRADO", origem: "CRM_INTERNO", entidadeTipo: "MARKETING_CONTATO", entidadeId: id,
        usuarioId, metadata: { canal: acao.canal },
      }, tx);
    }
    return { id, repetido: false };
  }
  const atual = await tx.query<{ status: StatusContato; cliente_id: string | null; fechamento_id: string | null }>(
    `SELECT status, cliente_id::text, fechamento_id::text FROM marketing_contatos WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [acao.id, empresaId],
  );
  const contato = atual.rows[0];
  if (!contato) naoEncontrado("Contato não encontrado nesta empresa.");
  if (acao.acao === "status") {
    if (contato.status === "CONVERTIDO") throw new MarketingError("MARKETING_CONTATO_CONVERTIDO", "Contato já vinculado a uma negociação.", 409);
    await tx.query(`UPDATE marketing_contatos SET status = $2, atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid`,
      [acao.id, acao.status, usuarioId]);
    return { id: acao.id };
  }
  if (acao.acao === "vincular-cliente") {
    if (contato.fechamento_id) throw new MarketingError("MARKETING_CONTATO_CONVERTIDO", "Contato já vinculado a uma negociação; o cliente não muda.", 409);
    await exigirClienteAtivo(tx, empresaId, acao.clienteId);
    await tx.query(
      `UPDATE marketing_contatos SET cliente_id = $2::uuid, vinculo_cliente = 'MANUAL', atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid`,
      [acao.id, acao.clienteId, usuarioId],
    );
    await registrarEventoHistorico({
      clienteId: acao.clienteId, tipoEvento: "CONTATO_MARKETING_VINCULADO", origem: "CRM_INTERNO", entidadeTipo: "MARKETING_CONTATO", entidadeId: acao.id, usuarioId,
    }, tx);
    return { id: acao.id };
  }
  // vincular-negociacao: a negociação herda a origem do contato (se ainda não tiver uma). Contrato herda da negociação.
  if (contato.fechamento_id) throw new MarketingError("MARKETING_CONTATO_CONVERTIDO", "Contato já vinculado a uma negociação.", 409);
  if (!contato.cliente_id) throw new MarketingError("MARKETING_CONTATO_SEM_CLIENTE", "Vincule o contato a um cliente antes da negociação.", 409);
  const fechamento = await tx.query<{ id: string }>(
    `SELECT id::text FROM fechamentos WHERE id = $1::uuid AND empresa_id = $2::uuid AND cliente_id = $3::uuid`,
    [acao.fechamentoId, empresaId, contato.cliente_id],
  );
  if (fechamento.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Negociação não encontrada para este cliente.", 404);
  try {
    await tx.query(
      `UPDATE marketing_contatos SET fechamento_id = $2::uuid, status = 'CONVERTIDO', atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid`,
      [acao.id, acao.fechamentoId, usuarioId],
    );
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "marketing_contatos_fechamento_uk") {
      throw new MarketingError("MARKETING_NEGOCIACAO_JA_VINCULADA", "Esta negociação já está vinculada a outro contato.", 409);
    }
    throw error;
  }
  const origemContato = await atribuicaoVigente(tx, empresaId, "CONTATO", acao.id);
  const herdada = origemContato ? await registrarSeAusente(tx, empresaId, {
    alvoTipo: "FECHAMENTO", alvoId: acao.fechamentoId,
    origemCodigo: origemContato.origemCodigo, canalAtendimento: origemContato.canalAtendimento, campanhaId: origemContato.campanhaId,
    metodo: origemContato.metodo === "DESCONHECIDO" ? "DESCONHECIDO" : "HERDADO", detalhe: origemContato.detalhe, utm: origemContato.utm,
    contatoId: acao.id, registradoPor: usuarioId,
  }) : null;
  await registrarEventoHistorico({
    clienteId: contato.cliente_id, tipoEvento: "CONTATO_MARKETING_NEGOCIACAO", origem: "CRM_INTERNO", entidadeTipo: "FECHAMENTO", entidadeId: acao.fechamentoId,
    usuarioId, metadata: { contatoMarketingId: acao.id, origemHerdada: Boolean(herdada) },
  }, tx);
  return { id: acao.id, origemNegociacaoExistente: !herdada };
}

async function exigirClienteAtivo(tx: DbExecutor, empresaId: string, clienteId: string) {
  const r = await tx.query<{ ok: boolean }>(`SELECT true AS ok FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid AND status = 'ATIVO'`, [clienteId, empresaId]);
  if (r.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Cliente não encontrado nesta empresa.", 404);
}
