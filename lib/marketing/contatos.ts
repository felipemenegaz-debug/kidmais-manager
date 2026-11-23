import { vincularContatoNegociacao } from './conversao.ts';
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
import { perdaSchema } from '../oportunidades/modelo.ts';
import { gravarPerda } from '../oportunidades/perda.ts';
import { herdarAcoesDoContato } from '../oportunidades/conversao.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { ambienteDoDeploy } from '../oportunidades/ambiente.ts';

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
  await travarTelefoneNoFunil(tx, site.empresaId, entrada.telefone);
  const repetidoPelaChave = await tx.query<{ id: string }>(
    `SELECT id::text FROM marketing_contatos WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`, [site.empresaId, entrada.chave]);
  if (repetidoPelaChave.rows.length) return { contatoId: repetidoPelaChave.rows[0].id, repetido: true };
  // r3 (P2): o Wall-e já abriu o cartão deste telefone neste ambiente → o pedido do site completa esse cartão (um por telefone).
  const walle = await cartaoWalleAberto(tx, site.empresaId, entrada.telefone);
  if (walle) {
    if (await atribuicaoVigente(tx, site.empresaId, "CONTATO", walle.id)) return { contatoId: walle.id, repetido: true };
    // site_id fica como está: a 085 o torna imutável; a origem Site fica na atribuição.
    await tx.query(
      `UPDATE marketing_contatos SET nome = $3, email = coalesce($4, email), data_desejada = coalesce($5::date, data_desejada), convidados = coalesce($6, convidados),
         mensagem = coalesce($7, mensagem), estabelecimento_id = coalesce(estabelecimento_id, $8::uuid), atualizado_em = clock_timestamp()
       WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [walle.id, site.empresaId, entrada.nome, entrada.email, entrada.dataDesejada, entrada.convidados, entrada.mensagem, site.estabelecimentoId],
    );
  }
  const inserido = walle ? { rows: [{ id: walle.id }] } : await tx.query<{ id: string }>(
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

  // Cartão do Wall-e já vinculado (correspondência única) mantém o cliente; os demais seguem a regra do site.
  const { clienteId, novo } = walle?.clienteId ? { clienteId: walle.clienteId, novo: false } : await clienteDoContato(tx, site.empresaId, entrada);
  if (!walle?.clienteId) await tx.query(
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
  // altera o CRM e nunca desfaz descadastro (086 ausente = ignorado).
  const autorizacao: ResultadoFormulario | null = entrada.autorizaWhatsapp === true && entrada.telefone
    ? await registrarAutorizacaoDoFormulario(tx, site.empresaId, clienteId, contatoId, entrada.telefone) : null;
  await registrarEventoHistorico({
    clienteId, tipoEvento: "CONTATO_MARKETING_RECEBIDO", origem: ORIGEM_SITE, entidadeTipo: "MARKETING_CONTATO", entidadeId: contatoId,
    detalhe: "Pedido de orçamento recebido pelo site.", metadata: { canal: "FORMULARIO_SITE", campanhaId: campanha?.id ?? null, clienteNovo: novo, autorizacaoWhatsapp: autorizacao },
  }, tx);
  return { contatoId, repetido: false };
}

/** Telefone com e sem o DDI 55 (o CRM guarda dígitos como foram digitados): o mesmo número acha o mesmo cliente. */
/**
 * Trava consultiva do telefone no funil, por empresa (com e sem 55 caem na mesma), tomada antes de gravar um contato com
 * telefone. A MESMA chave da captura do Wall-e (lib/whatsapp/atendimento/walle/oportunidade.ts; paridade em teste): a
 * captura nunca decide "não há cartão aberto" enquanto o site ou o registro manual gravam um cartão do mesmo telefone.
 */
export function chaveTravaTelefone(empresaId: string, digitos: string) {
  return `funil-telefone|${empresaId}|${/^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos}`;
}
async function travarTelefoneNoFunil(tx: DbExecutor, empresaId: string, telefone: string | null | undefined) {
  if (telefone) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [chaveTravaTelefone(empresaId, telefone)]);
}
/**
 * r3 (P2): cartão aberto que o Wall-e criou para este telefone (com e sem 55) neste ambiente, sem negociação e não
 * anonimizado. Chamado já sob a trava do telefone; o cartão fica em FOR UPDATE. Sem a 132 ou fora de staging/production, nenhum.
 */
async function cartaoWalleAberto(tx: DbExecutor, empresaId: string, telefone: string | null | undefined) {
  const ambiente = ambienteDoDeploy();
  if (!telefone || !ambiente) return null;
  if (!(await tx.query<{ ok: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_oportunidades') IS NOT NULL AS ok")).rows[0]?.ok) return null;
  const r = await tx.query<{ id: string; cliente_id: string | null; status: StatusContato }>(
    `SELECT k.id::text, k.cliente_id::text, k.status FROM marketing_contatos k
       JOIN whatsapp_atendimento_oportunidades o ON o.contato_id = k.id AND o.empresa_id = k.empresa_id
      WHERE k.empresa_id = $1::uuid AND o.ambiente = $2::text AND o.anonimizado_em IS NULL AND k.fechamento_id IS NULL
        AND k.status IN ('NOVO', 'EM_ATENDIMENTO') AND k.telefone = ANY($3::text[])
      ORDER BY k.recebido_em DESC, k.id LIMIT 1 FOR UPDATE OF k`,
    [empresaId, ambiente, variantesTelefone(telefone)],
  );
  const k = r.rows[0];
  return k ? { id: k.id, clienteId: k.cliente_id, status: k.status } : null;
}
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

export async function clienteDoContato(
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

/** r3 (P1): cartão do Wall-e de OUTRO ambiente (staging x production na mesma base) não aparece na lista nem no detalhe. */
const CORTE_AMBIENTE_WALLE = ' AND NOT EXISTS (SELECT 1 FROM whatsapp_atendimento_oportunidades wo WHERE wo.contato_id = k.id AND wo.ambiente IS DISTINCT FROM $9::text)';
const sqlListaContatos = (corte: string) => `SELECT k.id::text, k.nome, k.telefone, k.email, k.canal_atendimento, k.status, k.recebido_em::text, k.data_desejada::text, k.convidados,
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
        AND ($8::uuid IS NULL OR k.id = $8::uuid)${corte}
      ORDER BY k.recebido_em DESC, k.id
      LIMIT $7`;
export async function listarContatos(
  tx: DbExecutor, empresaId: string,
  filtros: { id?: string | null; de?: string | null; ate?: string | null; status?: StatusContato | null; unidadeId?: string | null; campanhaId?: string | null; limite?: number },
  ambiente: string | null = ambienteDoDeploy(),
): Promise<ContatoLista[]> {
  const com132 = !!(await tx.query<{ ok: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_oportunidades') IS NOT NULL AS ok")).rows[0]?.ok;
  const r = await tx.query<{
    id: string; nome: string; telefone: string | null; email: string | null; canal_atendimento: CanalAtendimento; status: StatusContato; recebido_em: string;
    data_desejada: string | null; convidados: number | null; cliente_id: string | null; cliente_nome: string | null; vinculo_cliente: string;
    fechamento_id: string | null; origem_codigo: string | null; metodo: string | null; campanha_id: string | null; campanha_nome: string | null;
    estabelecimento_id: string | null;
  }>(
    com132 ? sqlListaContatos(CORTE_AMBIENTE_WALLE) : sqlListaContatos(''),
    [empresaId, filtros.de ?? null, filtros.ate ?? null, filtros.status ?? null, filtros.unidadeId ?? null, filtros.campanhaId ?? null,
      Math.min(Math.max(filtros.limite ?? 200, 1), 500), filtros.id ?? null, ...(com132 ? [ambiente] : [])],
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
  z.object({ acao: z.literal("preparar-negociacao"), id: z.string().uuid() }).strict(),
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
  z.object({ acao: z.literal("status"), id: z.string().uuid(), status: z.enum(["NOVO", "EM_ATENDIMENTO", "DESCARTADO"]), perda: perdaSchema.optional() }).strict(),
  z.object({ acao: z.literal("vincular-cliente"), id: z.string().uuid(), clienteId: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("vincular-negociacao"), id: z.string().uuid(), fechamentoId: z.string().uuid() }).strict(),
]);
export type AcaoContato = z.infer<typeof esquemaAcaoContato>;

export async function executarAcaoContato(
  tx: DbExecutor, empresaId: string, usuarioId: string | null, acao: AcaoContato,
  // Contexto interno do chamador, nunca aceito no corpo da API de ações manuais.
  contexto: { origemVinculo?: 'CRM_INTERNO' | 'FECHAMENTO_PUBLICO' } = {},
) {
  if (acao.acao === "registrar") {
    if (!acao.telefone && !acao.email) throw new MarketingError("MARKETING_CONTATO_SEM_MEIO", "Informe telefone ou e-mail.", 400);
    const unidade = await exigirUnidadeDaEmpresa(tx, empresaId, acao.unidadeId);
    if (acao.clienteId) await exigirClienteAtivo(tx, empresaId, acao.clienteId);
    if (acao.origemCodigo) await exigirOrigemValida(tx, empresaId, acao.origemCodigo);
    const campanha = acao.campanhaId ? await tx.query<{ id: string }>(
      `SELECT id::text FROM marketing_campanhas WHERE id = $1::uuid AND empresa_id = $2::uuid`, [acao.campanhaId, empresaId]) : null;
    if (campanha && campanha.rows.length !== 1) throw new MarketingError("MARKETING_CAMPANHA_INVALIDA", "Campanha não encontrada nesta empresa.", 404);
    await travarTelefoneNoFunil(tx, empresaId, acao.telefone);
    const repetidoPelaChave = await tx.query<{ id: string }>(`SELECT id::text FROM marketing_contatos WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`, [empresaId, acao.chave]);
    if (repetidoPelaChave.rows.length) return { id: repetidoPelaChave.rows[0].id, repetido: true };
    // r3 (P2): o Wall-e já abriu o cartão deste telefone neste ambiente → o registro manual completa esse cartão.
    const walle = await cartaoWalleAberto(tx, empresaId, acao.telefone);
    if (walle) {
      if (await atribuicaoVigente(tx, empresaId, "CONTATO", walle.id)) return { id: walle.id, repetido: true };
      await tx.query(
        `UPDATE marketing_contatos SET nome = $3, email = coalesce($4, email), data_desejada = coalesce($5::date, data_desejada), convidados = coalesce($6, convidados),
           mensagem = coalesce($7, mensagem), estabelecimento_id = coalesce(estabelecimento_id, $8::uuid),
           cliente_id = coalesce(cliente_id, $9::uuid), vinculo_cliente = CASE WHEN cliente_id IS NULL AND $9::uuid IS NOT NULL THEN 'MANUAL' ELSE vinculo_cliente END,
           status = 'EM_ATENDIMENTO', atualizado_por = $10::uuid, atualizado_em = clock_timestamp()
         WHERE id = $1::uuid AND empresa_id = $2::uuid`,
        [walle.id, empresaId, acao.nome, acao.email ?? null, acao.dataDesejada ?? null, acao.convidados ?? null, acao.mensagem || null, unidade,
          acao.clienteId ?? null, usuarioId],
      );
    }
    const r = walle ? { rows: [{ id: walle.id }] } : await tx.query<{ id: string }>(
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
  // O vínculo manual a uma negociação herda o responsável do próximo passo em fechamentos: a 114 exige a configuração
  // da agenda travada antes de qualquer linha (a entrada administrativa já tem a empresa em FOR UPDATE).
  if (acao.acao === 'vincular-negociacao') await travarConfiguracaoAgenda(tx, empresaId, { modo: 'COMPARTILHADA', linha: 'JA_TRAVADA' });
  const atual = await tx.query<{ status: StatusContato; cliente_id: string | null; fechamento_id: string | null }>(
    `SELECT status, cliente_id::text, fechamento_id::text FROM marketing_contatos WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [acao.id, empresaId],
  );
  const contato = atual.rows[0];
  if (!contato) naoEncontrado("Contato não encontrado nesta empresa.");
  if (acao.acao === "status") {
    if (contato.status === "CONVERTIDO") throw new MarketingError("MARKETING_CONTATO_CONVERTIDO", "Contato já vinculado a uma negociação.", 409);
    if (contato.status === 'DESCARTADO') throw new MarketingError('CONTATO_ENCERRADO','Este contato já foi encerrado.',409);
    if (acao.status === 'DESCARTADO') {
      const perda=perdaSchema.parse(acao.perda);
      // Perda é sempre registrada por uma pessoa (a conversão automática, sem usuário, nunca descarta).
      if (!usuarioId) throw new MarketingError('MARKETING_PERDA_SEM_USUARIO','Registre a perda com um usuário identificado.',403);
      if (contato.fechamento_id)
        throw new MarketingError('CONTATO_COM_NEGOCIACAO','Registre a perda na negociação deste cliente.',409);
      let clienteId=contato.cliente_id;
      if (!clienteId) {
        const dados=(await tx.query<{nome:string;telefone:string|null;email:string|null}>('SELECT nome,telefone,email FROM marketing_contatos WHERE empresa_id=$1::uuid AND id=$2::uuid',[empresaId,acao.id])).rows[0];
        clienteId=(await clienteDoContato(tx,empresaId,dados)).clienteId;
        await tx.query("UPDATE marketing_contatos SET cliente_id=$3::uuid,vinculo_cliente='MANUAL' WHERE empresa_id=$1::uuid AND id=$2::uuid",[empresaId,acao.id,clienteId]);
      }
      await tx.query("UPDATE marketing_contatos SET status='DESCARTADO',atualizado_por=$3::uuid WHERE empresa_id=$1::uuid AND id=$2::uuid",[empresaId,acao.id,usuarioId]);
      await gravarPerda(tx,empresaId,usuarioId,{tipo:'CONTATO',id:acao.id},clienteId,perda);
      return {id:acao.id};
    }
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
  if (acao.acao === 'preparar-negociacao') {
    if (contato.status === 'DESCARTADO') throw new MarketingError('MARKETING_CONTATO_DESCARTADO','Este pedido foi descartado.',409);
    if (contato.cliente_id) return {id: acao.id, clienteId: contato.cliente_id};
    const dados = (await tx.query<{nome:string;telefone:string|null;email:string|null}>(
      'SELECT nome,telefone,email FROM marketing_contatos WHERE id=$1::uuid AND empresa_id=$2::uuid',[acao.id,empresaId])).rows[0];
    const {clienteId,novo} = await clienteDoContato(tx,empresaId,dados);
    await tx.query("UPDATE marketing_contatos SET cliente_id=$2::uuid,vinculo_cliente='MANUAL',atualizado_por=$3::uuid,atualizado_em=clock_timestamp() WHERE id=$1::uuid AND empresa_id=$4::uuid",[acao.id,clienteId,usuarioId,empresaId]);
    const origem = await atribuicaoVigente(tx,empresaId,'CONTATO',acao.id);
    if(novo && origem) await registrarSeAusente(tx,empresaId,{...origem,alvoTipo:'CLIENTE',alvoId:clienteId,registradoPor:usuarioId});
    await registrarEventoHistorico({clienteId,tipoEvento:'CONTATO_MARKETING_VINCULADO',origem:'CRM_INTERNO',entidadeTipo:'MARKETING_CONTATO',entidadeId:acao.id,usuarioId},tx);
    return {id:acao.id,clienteId};
  }
  // vincular-negociacao: implementação única em ./conversao.ts (herança idempotente) + próxima ação do Funil.
  const resultado = await vincularContatoNegociacao(tx,empresaId,usuarioId,acao,{origemVinculo:contexto.origemVinculo});
  await herdarAcoesDoContato(tx,acao.fechamentoId);
  return { id: resultado.id, origemNegociacaoExistente: resultado.origemNegociacaoExistente };
}

async function exigirClienteAtivo(tx: DbExecutor, empresaId: string, clienteId: string) {
  const r = await tx.query<{ ok: boolean }>(`SELECT true AS ok FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid AND status = 'ATIVO'`, [clienteId, empresaId]);
  if (r.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Cliente não encontrado nesta empresa.", 404);
}
