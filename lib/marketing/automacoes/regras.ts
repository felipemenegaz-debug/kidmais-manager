import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { MarketingError, conflito, naoEncontrado } from "../erros.ts";
import { exigirUnidadeDaEmpresa } from "../campanhas.ts";
import { fusoValido } from "./janela.ts";
import { validarModelo } from "./modelo.ts";

/**
 * Regras PRÉ-DEFINIDAS (sem construtor genérico de fluxos). Cada tipo tem gatilho e condições fixos no código; a
 * empresa ajusta espera, janela, frequência, ação e texto. Datas vagas é só sugestão revisável (nunca envia).
 */
export const TIPOS_REGRA = ["PROPOSTA_PARADA", "POS_FESTA", "RECOMPRA", "DATAS_VAGAS"] as const;
export type TipoRegra = (typeof TIPOS_REGRA)[number];
export type AcaoRegra = "TAREFA_INTERNA" | "MENSAGEM_WHATSAPP" | "SUGESTAO";

export const CATALOGO_REGRAS: Record<TipoRegra, {
  nome: string; gatilho: string; condicoes: string; publico: string; esperaPadrao: number; acoes: AcaoRegra[]; acaoPadrao: AcaoRegra; texto: string | null;
}> = {
  PROPOSTA_PARADA: {
    nome: "Retomar proposta parada",
    gatilho: "Negociação aguardando aprovação ou contrato sem movimentação há X dias.",
    condicoes: "Festa ainda no futuro; sem contrato assinado ou cancelado; para assim que houver movimentação ou contrato.",
    publico: "Cliente da negociação.",
    esperaPadrao: 3, acoes: ["TAREFA_INTERNA", "MENSAGEM_WHATSAPP"], acaoPadrao: "TAREFA_INTERNA",
    texto: "Olá, {{nome}}! Aqui é do {{buffet}}. Ficou alguma dúvida sobre a proposta da festa de {{data_festa}}? Estamos à disposição. Responda PARAR para não receber mais mensagens.",
  },
  POS_FESTA: {
    nome: "Pós-festa",
    gatilho: "Festa com contrato assinado realizada há X dias.",
    condicoes: "Contrato assinado e não cancelado; janela de 14 dias para não perder festas antigas.",
    publico: "Cliente da festa.",
    esperaPadrao: 1, acoes: ["TAREFA_INTERNA", "MENSAGEM_WHATSAPP"], acaoPadrao: "TAREFA_INTERNA",
    texto: "Olá, {{nome}}! Obrigado por celebrar com o {{buffet}}. Se puder, conte como foi a festa — sua opinião ajuda muito. Responda PARAR para não receber mais mensagens.",
  },
  RECOMPRA: {
    nome: "Oportunidade de recompra",
    gatilho: "X dias antes de completar um ano da última festa com contrato assinado.",
    condicoes: "Sem negociação futura em andamento; cliente ativo; uma vez por ciclo anual.",
    publico: "Clientes com festa no último ano.",
    esperaPadrao: 45, acoes: ["TAREFA_INTERNA", "MENSAGEM_WHATSAPP"], acaoPadrao: "TAREFA_INTERNA",
    texto: "Olá, {{nome}}! Está chegando a época de mais uma festa. O {{buffet}} já está com a agenda do próximo ano aberta. Quer ver datas? Responda PARAR para não receber mais mensagens.",
  },
  DATAS_VAGAS: {
    nome: "Datas vagas para divulgar",
    gatilho: "Datas com horários livres nos próximos dias, lidas da agenda.",
    condicoes: "Somente sugestão para revisão: nada é enviado, reservado ou descontado.",
    publico: "Definido por quem criar a campanha.",
    esperaPadrao: 0, acoes: ["SUGESTAO"], acaoPadrao: "SUGESTAO", texto: null,
  },
};

export type Regra = {
  id: string | null; tipo: TipoRegra; unidadeId: string | null; status: "RASCUNHO" | "ATIVA" | "PAUSADA" | "NAO_CONFIGURADA"; acao: AcaoRegra;
  esperaDias: number; janelaInicio: string; janelaFim: string; fuso: string; fimDeSemana: boolean; limiteFrequenciaDias: number; maxTentativas: number;
  templateTexto: string | null; templateProvedor: string | null; templateRevisadoEm: string | null; versao: number; ativadaEm: string | null; pausadaEm: string | null;
};

type Linha = {
  id: string; tipo: TipoRegra; estabelecimento_id: string | null; status: Regra["status"]; acao: AcaoRegra; espera_dias: number; janela_inicio: string; janela_fim: string;
  fuso: string; fim_de_semana: boolean; limite_frequencia_dias: number; max_tentativas: number; template_texto: string | null; template_provedor: string | null;
  template_revisado_em: string | null; versao: number; ativada_em: string | null; pausada_em: string | null;
};
const COLUNAS = `id::text, tipo, estabelecimento_id::text, status, acao, espera_dias, to_char(janela_inicio, 'HH24:MI') AS janela_inicio, to_char(janela_fim, 'HH24:MI') AS janela_fim,
  fuso, fim_de_semana, limite_frequencia_dias, max_tentativas, template_texto, template_provedor, template_revisado_em::text, versao, ativada_em::text, pausada_em::text`;

export function mapearRegra(l: Linha): Regra {
  return {
    id: l.id, tipo: l.tipo, unidadeId: l.estabelecimento_id, status: l.status, acao: l.acao, esperaDias: l.espera_dias, janelaInicio: l.janela_inicio, janelaFim: l.janela_fim,
    fuso: l.fuso, fimDeSemana: l.fim_de_semana, limiteFrequenciaDias: l.limite_frequencia_dias, maxTentativas: l.max_tentativas, templateTexto: l.template_texto,
    templateProvedor: l.template_provedor, templateRevisadoEm: l.template_revisado_em, versao: l.versao, ativadaEm: l.ativada_em, pausadaEm: l.pausada_em,
  };
}

export function regraPadrao(tipo: TipoRegra, unidadeId: string | null): Regra {
  const c = CATALOGO_REGRAS[tipo];
  return {
    id: null, tipo, unidadeId, status: "NAO_CONFIGURADA", acao: c.acaoPadrao, esperaDias: c.esperaPadrao, janelaInicio: "09:00", janelaFim: "18:00", fuso: "America/Sao_Paulo",
    fimDeSemana: false, limiteFrequenciaDias: 30, maxTentativas: 3, templateTexto: c.texto, templateProvedor: null, templateRevisadoEm: null, versao: 0, ativadaEm: null, pausadaEm: null,
  };
}

/** As quatro regras da unidade: configuradas no banco ou o padrão "não configurada". */
export async function listarRegras(tx: DbExecutor, empresaId: string, unidadeId: string | null) {
  const r = await tx.query<Linha>(
    `SELECT ${COLUNAS} FROM marketing_automacao_regras WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid`, [empresaId, unidadeId]);
  return TIPOS_REGRA.map((tipo) => {
    const l = r.rows.find((x) => x.tipo === tipo);
    return l ? mapearRegra(l) : regraPadrao(tipo, unidadeId);
  });
}

export async function regraDaEmpresa(tx: DbExecutor, empresaId: string, regraId: string, travar = false) {
  const r = await tx.query<Linha>(`SELECT ${COLUNAS} FROM marketing_automacao_regras WHERE id = $1::uuid AND empresa_id = $2::uuid${travar ? " FOR UPDATE" : ""}`, [regraId, empresaId]);
  if (!r.rows[0]) naoEncontrado("Regra não encontrada nesta empresa.");
  return mapearRegra(r.rows[0]);
}

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const esquemaSalvarRegra = z.object({
  acao: z.literal("salvar-regra"),
  tipo: z.enum(TIPOS_REGRA),
  unidadeId: z.string().uuid().nullable().optional(),
  versao: z.number().int().min(0),
  acaoRegra: z.enum(["TAREFA_INTERNA", "MENSAGEM_WHATSAPP", "SUGESTAO"]),
  esperaDias: z.number().int().min(0).max(400),
  janelaInicio: hora,
  janelaFim: hora,
  fuso: z.string().max(64),
  fimDeSemana: z.boolean(),
  limiteFrequenciaDias: z.number().int().min(1).max(365),
  maxTentativas: z.number().int().min(1).max(5),
  templateTexto: z.string().trim().max(1000).nullable().optional(),
  templateProvedor: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,64}$/, "Nome do modelo do provedor: minúsculas, números e _.").nullable().optional(),
}).strict();
export type SalvarRegra = z.infer<typeof esquemaSalvarRegra>;

/**
 * Salvar volta a regra para RASCUNHO quando o texto muda (precisa de nova revisão humana antes de mensagens).
 * Alterar parâmetros de regra ATIVA mantém ativa; mensagens já agendadas são revalidadas no envio com a regra atual.
 */
export async function salvarRegra(tx: DbExecutor, empresaId: string, usuarioId: string, input: SalvarRegra) {
  const catalogo = CATALOGO_REGRAS[input.tipo];
  if (!catalogo.acoes.includes(input.acaoRegra)) throw new MarketingError("MARKETING_REGRA_INVALIDA", "Ação não disponível para esta regra.", 400);
  if (input.janelaInicio >= input.janelaFim) throw new MarketingError("MARKETING_REGRA_INVALIDA", "A janela precisa começar antes de terminar.", 400);
  if (!fusoValido(input.fuso)) throw new MarketingError("MARKETING_REGRA_INVALIDA", "Fuso horário inválido.", 400);
  if (input.templateTexto) {
    const problemas = validarModelo(input.templateTexto);
    if (problemas.length) throw new MarketingError("MARKETING_MODELO_INVALIDO", problemas.join(" "), 400, { problemas });
  }
  const unidade = await exigirUnidadeDaEmpresa(tx, empresaId, input.unidadeId);
  const atual = await tx.query<Linha>(
    `SELECT ${COLUNAS} FROM marketing_automacao_regras WHERE empresa_id = $1::uuid AND tipo = $2 AND estabelecimento_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
    [empresaId, input.tipo, unidade]);
  const params = [input.acaoRegra, input.esperaDias, input.janelaInicio, input.janelaFim, input.fuso, input.fimDeSemana, input.limiteFrequenciaDias, input.maxTentativas,
    input.templateTexto || null, input.templateProvedor || null];
  if (!atual.rows[0]) {
    if (input.versao !== 0) conflito();
    const r = await tx.query<Linha>(
      `INSERT INTO marketing_automacao_regras (empresa_id, estabelecimento_id, tipo, acao, espera_dias, janela_inicio, janela_fim, fuso, fim_de_semana, limite_frequencia_dias,
         max_tentativas, template_texto, template_provedor, criado_por, atualizado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::time, $7::time, $8, $9, $10, $11, $12, $13, $14::uuid, $14::uuid) RETURNING ${COLUNAS}`,
      [empresaId, unidade, input.tipo, ...params, usuarioId]);
    return mapearRegra(r.rows[0]);
  }
  const anterior = mapearRegra(atual.rows[0]);
  if (anterior.versao !== input.versao) conflito();
  const textoMudou = (anterior.templateTexto ?? null) !== (input.templateTexto || null) || (anterior.templateProvedor ?? null) !== (input.templateProvedor || null);
  // Mensagem precisa de texto revisado: texto/modelo alterado, ou ação trocada para mensagem sem revisão anterior.
  const precisaRevisao = input.acaoRegra === "MENSAGEM_WHATSAPP" && (textoMudou || !anterior.templateRevisadoEm);
  const r = await tx.query<Linha>(
    `UPDATE marketing_automacao_regras SET acao = $3, espera_dias = $4, janela_inicio = $5::time, janela_fim = $6::time, fuso = $7, fim_de_semana = $8,
       limite_frequencia_dias = $9, max_tentativas = $10, template_texto = $11, template_provedor = $12,
       template_revisado_em = CASE WHEN $13 THEN NULL ELSE template_revisado_em END, template_revisado_por = CASE WHEN $13 THEN NULL ELSE template_revisado_por END,
       status = CASE WHEN $13 AND status = 'ATIVA' THEN 'PAUSADA' ELSE status END,
       pausada_em = CASE WHEN $13 AND status = 'ATIVA' THEN clock_timestamp() ELSE pausada_em END,
       versao = versao + 1, atualizado_por = $14::uuid, atualizado_em = clock_timestamp()
     WHERE id = $1::uuid AND empresa_id = $2::uuid RETURNING ${COLUNAS}`,
    [anterior.id, empresaId, ...params, precisaRevisao, usuarioId]);
  if (precisaRevisao && anterior.status === "ATIVA") await cancelarPendentes(tx, empresaId, anterior.id!, "TEXTO_ALTERADO_SEM_REVISAO");
  return mapearRegra(r.rows[0]);
}

/** Revisão humana do texto (obrigatória para mensagens). Grava quem revisou e quando. */
export async function revisarModelo(tx: DbExecutor, empresaId: string, usuarioId: string, regraId: string, versao: number) {
  const regra = await regraDaEmpresa(tx, empresaId, regraId, true);
  if (regra.versao !== versao) conflito("O texto mudou desde que você abriu. Revise de novo.");
  if (!regra.templateTexto || !regra.templateProvedor) throw new MarketingError("MARKETING_MODELO_INCOMPLETO", "Informe o texto e o nome do modelo aprovado no provedor.", 400);
  const problemas = validarModelo(regra.templateTexto);
  if (problemas.length) throw new MarketingError("MARKETING_MODELO_INVALIDO", problemas.join(" "), 400, { problemas });
  await tx.query(`UPDATE marketing_automacao_regras SET template_revisado_em = clock_timestamp(), template_revisado_por = $3::uuid, versao = versao + 1,
    atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid AND empresa_id = $2::uuid`, [regraId, empresaId, usuarioId]);
  return regraDaEmpresa(tx, empresaId, regraId);
}

export async function ativarRegra(tx: DbExecutor, empresaId: string, usuarioId: string, regraId: string, versao: number) {
  const regra = await regraDaEmpresa(tx, empresaId, regraId, true);
  if (regra.versao !== versao) conflito();
  if (regra.acao === "SUGESTAO") throw new MarketingError("MARKETING_REGRA_INVALIDA", "Datas vagas é só sugestão: não há o que ativar.", 409);
  if (regra.acao === "MENSAGEM_WHATSAPP" && (!regra.templateRevisadoEm || !regra.templateProvedor)) {
    throw new MarketingError("MARKETING_MODELO_NAO_REVISADO", "Revise e aprove o texto (com o nome do modelo do provedor) antes de ativar mensagens.", 409);
  }
  await tx.query(`UPDATE marketing_automacao_regras SET status = 'ATIVA', ativada_em = clock_timestamp(), pausada_em = NULL, versao = versao + 1,
    atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid AND empresa_id = $2::uuid`, [regraId, empresaId, usuarioId]);
  return regraDaEmpresa(tx, empresaId, regraId);
}

/** Pausar impede tudo o que ainda não saiu: execuções AGENDADAS são canceladas (com motivo e histórico). */
export async function pausarRegra(tx: DbExecutor, empresaId: string, usuarioId: string, regraId: string) {
  const regra = await regraDaEmpresa(tx, empresaId, regraId, true);
  if (regra.status !== "ATIVA") throw new MarketingError("MARKETING_REGRA_NAO_ATIVA", "A regra não está ativa.", 409);
  await tx.query(`UPDATE marketing_automacao_regras SET status = 'PAUSADA', pausada_em = clock_timestamp(), versao = versao + 1,
    atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid AND empresa_id = $2::uuid`, [regraId, empresaId, usuarioId]);
  const canceladas = await cancelarPendentes(tx, empresaId, regraId, "REGRA_PAUSADA");
  return { regra: await regraDaEmpresa(tx, empresaId, regraId), canceladas };
}

/** Interrupção da empresa: pausa todas as regras ativas e cancela o que estava agendado. */
export async function pararTudo(tx: DbExecutor, empresaId: string, usuarioId: string) {
  const ativas = await tx.query<{ id: string }>(`SELECT id::text FROM marketing_automacao_regras WHERE empresa_id = $1::uuid AND status = 'ATIVA' FOR UPDATE`, [empresaId]);
  let canceladas = 0;
  for (const { id } of ativas.rows) {
    await tx.query(`UPDATE marketing_automacao_regras SET status = 'PAUSADA', pausada_em = clock_timestamp(), versao = versao + 1, atualizado_por = $2::uuid,
      atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [id, usuarioId]);
    canceladas += await cancelarPendentes(tx, empresaId, id, "INTERRUPCAO_DA_EMPRESA");
  }
  return { regrasPausadas: ativas.rows.length, canceladas };
}

export async function cancelarPendentes(tx: DbExecutor, empresaId: string, regraId: string, motivo: string) {
  const r = await tx.query<{ id: string }>(
    `UPDATE marketing_automacao_execucoes SET estado = 'CANCELADA', motivo = $3, concluida_em = clock_timestamp(), atualizado_em = clock_timestamp()
      WHERE empresa_id = $1::uuid AND regra_id = $2::uuid AND estado = 'AGENDADA' RETURNING id::text`, [empresaId, regraId, motivo]);
  for (const { id } of r.rows) {
    await tx.query(`INSERT INTO marketing_automacao_eventos (empresa_id, execucao_id, estado_anterior, estado_novo, detalhe) VALUES ($1::uuid, $2::uuid, 'AGENDADA', 'CANCELADA', $3::jsonb)`,
      [empresaId, id, JSON.stringify({ motivo })]);
  }
  return r.rows.length;
}
