import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../../db/contracts.ts";
import { nomePublicoDaEmpresa } from "../../perfil/nome-publico.ts";
import { alvoContinuaElegivel, alvosParaPlanejar, alvosParaSimular, chaveExecucao, cicloDaChave, LIMITE_PLANEJAMENTO, totalDeAlvos, type Alvo } from "./alvos.ts";
import { empresaApta } from "./aptidao.ts";
import { dataLocal, dentroDaJanela, proximoHorarioPermitido } from "./janela.ts";
import { mascararTelefone, renderizarModelo } from "./modelo.ts";
import { elegivelParaMensagem, lerPreferencia } from "./preferencias.ts";
import { mapearRegra, type Regra } from "./regras.ts";
import { FalhaTransporte, type TransporteMarketing } from "./transporte.ts";

/**
 * Motor das automações (planejar → reservar → processar). Garantias:
 *   - planejar é idempotente (chave única por regra/ação/alvo/ciclo): rodar duas vezes não duplica;
 *   - reservar usa FOR UPDATE SKIP LOCKED + posse com prazo: dois processadores nunca pegam a mesma execução;
 *   - antes de agir, revalida regra ATIVA, alvo elegível no mesmo ciclo, janela, autorização/descadastro e frequência,
 *     sob trava por cliente (pg_advisory_xact_lock) para a frequência valer sob concorrência;
 *   - mensagem: marca ENVIANDO e confirma ANTES da rede; resposta → ACEITA; sem resposta → INCERTA (nunca reenviada);
 *     recusa → FALHOU; indisponibilidade confirmada → nova tentativa com espera até o máximo.
 */
export type Banco = { transacao<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> };

type LinhaExecucao = {
  id: string; empresa_id: string; regra_id: string; acao: "TAREFA_INTERNA" | "MENSAGEM_WHATSAPP"; alvo_tipo: string; alvo_id: string; cliente_id: string;
  fechamento_id: string | null; chave_idempotencia: string; estado: string; tentativas: number; max_tentativas: number; posse_token: string | null;
};

async function evento(tx: DbExecutor, empresaId: string, execucaoId: string, anterior: string | null, novo: string, detalhe: Record<string, unknown> = {}) {
  await tx.query(`INSERT INTO marketing_automacao_eventos (empresa_id, execucao_id, estado_anterior, estado_novo, detalhe) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
    [empresaId, execucaoId, anterior, novo, JSON.stringify(detalhe)]);
}

const COLUNAS_REGRA = `id::text, tipo, estabelecimento_id::text, status, acao, espera_dias, to_char(janela_inicio, 'HH24:MI') AS janela_inicio, to_char(janela_fim, 'HH24:MI') AS janela_fim,
  fuso, fim_de_semana, limite_frequencia_dias, max_tentativas, template_texto, template_provedor, template_revisado_em::text, versao, ativada_em::text, pausada_em::text`;

function janelaDe(r: Regra) { return { inicio: r.janelaInicio, fim: r.janelaFim, fuso: r.fuso, fimDeSemana: r.fimDeSemana }; }

// ------------------------------------------------------------------------------------------------------------------
// Planejar
// ------------------------------------------------------------------------------------------------------------------
export async function planejarEmpresa(tx: DbExecutor, empresaId: string, agora: Date, opcoes: { lote?: number } = {}) {
  // R2: empresa sem aptidão (status, recurso MARKETING, situação comercial) não planeja nada; o motivo volta para o ciclo.
  const aptidao = await empresaApta(tx, empresaId);
  if (!aptidao.apta) return { regras: 0, criadas: 0, existentes: 0, bloqueio: aptidao.motivo };
  const regras = (await tx.query<Parameters<typeof mapearRegra>[0]>(
    `SELECT ${COLUNAS_REGRA} FROM marketing_automacao_regras WHERE empresa_id = $1::uuid AND status = 'ATIVA' AND acao <> 'SUGESTAO'`, [empresaId])).rows.map(mapearRegra);
  let criadas = 0, existentes = 0;
  for (const regra of regras) {
    const quando = proximoHorarioPermitido(agora, janelaDe(regra));
    // R4: só alvos ainda não planejados nesta regra/ação/ciclo, em lote limitado e ordem determinística (avança a cada ciclo).
    for (const alvo of await alvosParaPlanejar(tx, empresaId, regra, agora, opcoes.lote ?? LIMITE_PLANEJAMENTO)) {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, fechamento_id, chave_idempotencia,
           agendada_para, max_tentativas)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid, $9, $10::timestamptz, $11)
         ON CONFLICT (empresa_id, chave_idempotencia) DO NOTHING RETURNING id::text`,
        [empresaId, regra.id, regra.versao, regra.acao, alvo.alvoTipo, alvo.alvoId, alvo.clienteId, alvo.fechamentoId, chaveExecucao(regra.id!, regra.acao, alvo),
          quando.toISOString(), regra.maxTentativas]);
      if (r.rows[0]) { criadas++; await evento(tx, empresaId, r.rows[0].id, null, "AGENDADA", { regra: regra.tipo, agendadaPara: quando.toISOString() }); }
      else existentes++;
    }
  }
  return { regras: regras.length, criadas, existentes, bloqueio: null as string | null };
}

/** Simulação sem gravar nada: o que cada regra faria agora (com motivos de supressão). */
export async function simularEmpresa(tx: DbExecutor, empresaId: string, regra: Regra, agora: Date) {
  if (regra.acao === "SUGESTAO") return { alvos: [], total: 0 };
  const alvos = await alvosParaSimular(tx, empresaId, regra, agora);
  const linhas = [];
  for (const alvo of alvos) {
    const chave = regra.id ? chaveExecucao(regra.id, regra.acao, alvo) : null;
    const jaPlanejada = chave ? (await tx.query<{ estado: string }>(`SELECT estado FROM marketing_automacao_execucoes WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`, [empresaId, chave])).rows[0]?.estado ?? null : null;
    let impedimento: string | null = null;
    if (regra.acao === "MENSAGEM_WHATSAPP") {
      const e = await elegivelParaMensagem(tx, empresaId, alvo.clienteId);
      if (!e.ok) impedimento = e.motivo;
      else if (await frequenciaExcedida(tx, empresaId, alvo.clienteId, regra.limiteFrequenciaDias, null)) impedimento = "LIMITE_FREQUENCIA";
    }
    linhas.push({ ...alvo, jaPlanejada, impedimento, agendadaPara: proximoHorarioPermitido(agora, janelaDe(regra)).toISOString() });
  }
  return { alvos: linhas, total: await totalDeAlvos(tx, empresaId, regra, agora) };
}

async function frequenciaExcedida(tx: DbExecutor, empresaId: string, clienteId: string, dias: number, excetoId: string | null) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT true AS ok FROM marketing_automacao_execucoes
      WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND acao = 'MENSAGEM_WHATSAPP' AND estado IN ('ENVIANDO', 'ACEITA', 'ENTREGUE', 'INCERTA')
        AND atualizado_em > clock_timestamp() - make_interval(days => $3::int) AND ($4::uuid IS NULL OR id <> $4::uuid) LIMIT 1`,
    [empresaId, clienteId, dias, excetoId]);
  return r.rows.length > 0;
}

// ------------------------------------------------------------------------------------------------------------------
// Reservar e recuperar posses vencidas
// ------------------------------------------------------------------------------------------------------------------
export async function recuperarPosses(tx: DbExecutor, agora: Date, empresaId: string | null) {
  const voltam = await tx.query<{ id: string; empresa_id: string }>(
    `UPDATE marketing_automacao_execucoes SET estado = 'AGENDADA', posse_token = NULL, posse_ate = NULL, atualizado_em = clock_timestamp()
      WHERE estado = 'PROCESSANDO' AND posse_ate < $1::timestamptz AND ($2::uuid IS NULL OR empresa_id = $2::uuid) RETURNING id::text, empresa_id::text`,
    [agora.toISOString(), empresaId]);
  for (const v of voltam.rows) await evento(tx, v.empresa_id, v.id, "PROCESSANDO", "AGENDADA", { motivo: "POSSE_VENCIDA_SEM_ENVIO" });
  const incertas = await tx.query<{ id: string; empresa_id: string }>(
    `UPDATE marketing_automacao_execucoes SET estado = 'INCERTA', motivo = 'POSSE_VENCIDA_DURANTE_ENVIO', posse_token = NULL, posse_ate = NULL, atualizado_em = clock_timestamp()
      WHERE estado = 'ENVIANDO' AND posse_ate < $1::timestamptz AND ($2::uuid IS NULL OR empresa_id = $2::uuid) RETURNING id::text, empresa_id::text`,
    [agora.toISOString(), empresaId]);
  for (const v of incertas.rows) await evento(tx, v.empresa_id, v.id, "ENVIANDO", "INCERTA", { motivo: "POSSE_VENCIDA_DURANTE_ENVIO" });
  return { reagendadas: voltam.rows.length, incertas: incertas.rows.length };
}

export async function reservar(tx: DbExecutor, agora: Date, limite: number, empresaId: string | null) {
  const token = randomUUID();
  const r = await tx.query<{ id: string; empresa_id: string }>(
    `WITH alvo AS (
       SELECT id FROM marketing_automacao_execucoes
        WHERE estado = 'AGENDADA' AND agendada_para <= $1::timestamptz AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= $1::timestamptz)
          AND ($4::uuid IS NULL OR empresa_id = $4::uuid)
        ORDER BY agendada_para, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE marketing_automacao_execucoes e SET estado = 'PROCESSANDO', posse_token = $3::uuid, posse_ate = $1::timestamptz + interval '5 minutes', atualizado_em = clock_timestamp()
       FROM alvo WHERE e.id = alvo.id RETURNING e.id::text, e.empresa_id::text`,
    [agora.toISOString(), limite, token, empresaId]);
  for (const v of r.rows) await evento(tx, v.empresa_id, v.id, "AGENDADA", "PROCESSANDO", {});
  return { token, ids: r.rows.map((x) => x.id) };
}

// ------------------------------------------------------------------------------------------------------------------
// Processar uma execução reservada
// ------------------------------------------------------------------------------------------------------------------
type Decisao =
  | { tipo: "PRONTA"; estado: string }
  | { tipo: "ENVIAR"; exec: LinhaExecucao; regra: Regra; telefone: string; texto: string; idempotencia: string };

async function concluir(tx: DbExecutor, e: LinhaExecucao, estado: "TAREFA_CRIADA" | "SUPRIMIDA" | "CANCELADA", motivo: string | null, detalhe: Record<string, unknown> = {}) {
  await tx.query(`UPDATE marketing_automacao_execucoes SET estado = $2, motivo = $3, posse_token = NULL, posse_ate = NULL, concluida_em = clock_timestamp(),
    atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id, estado, motivo]);
  await evento(tx, e.empresa_id, e.id, e.estado, estado, { motivo, ...detalhe });
  return { tipo: "PRONTA" as const, estado };
}

async function decidir(tx: DbExecutor, id: string, token: string, agora: Date): Promise<Decisao> {
  const r = await tx.query<LinhaExecucao>(
    `SELECT id::text, empresa_id::text, regra_id::text, acao, alvo_tipo, alvo_id::text, cliente_id::text, fechamento_id::text, chave_idempotencia, estado, tentativas,
            max_tentativas, posse_token::text FROM marketing_automacao_execucoes WHERE id = $1::uuid FOR UPDATE`, [id]);
  const e = r.rows[0];
  if (!e || e.estado !== "PROCESSANDO" || e.posse_token !== token) return { tipo: "PRONTA", estado: "POSSE_PERDIDA" };
  // Trava por cliente: decisões de frequência do mesmo cliente nunca correm em paralelo.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('marketing:' || $1 || ':' || $2))`, [e.empresa_id, e.cliente_id]);
  // R2: aptidão da EMPRESA agora, antes de qualquer ação (vale para agendada, reservada, recuperada e nova tentativa).
  const aptidao = await empresaApta(tx, e.empresa_id);
  if (!aptidao.apta && aptidao.definitivo) return concluir(tx, e, "CANCELADA", `EMPRESA_INAPTA: ${aptidao.motivo}`);
  if (!aptidao.apta) {
    // Leitura do direito falhou: não age e não libera; volta para a fila com espera (tentativas não mudam).
    await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'AGENDADA', proxima_tentativa_em = clock_timestamp() + interval '15 minutes',
      posse_token = NULL, posse_ate = NULL, motivo = $2, atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id, aptidao.motivo]);
    await evento(tx, e.empresa_id, e.id, "PROCESSANDO", "AGENDADA", { motivo: aptidao.motivo });
    return { tipo: "PRONTA", estado: "AGUARDANDO_DIREITO" };
  }
  const regraLinha = (await tx.query<Parameters<typeof mapearRegra>[0]>(`SELECT ${COLUNAS_REGRA} FROM marketing_automacao_regras WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [e.regra_id, e.empresa_id])).rows[0];
  const regra = regraLinha ? mapearRegra(regraLinha) : null;
  if (!regra || regra.status !== "ATIVA") return concluir(tx, e, "CANCELADA", "REGRA_INATIVA");
  if (regra.acao !== e.acao) return concluir(tx, e, "CANCELADA", "ACAO_ALTERADA");
  const alvo: Alvo | null = await alvoContinuaElegivel(tx, e.empresa_id, regra, e.alvo_id, cicloDaChave(e.chave_idempotencia), agora);
  if (!alvo) return concluir(tx, e, "SUPRIMIDA", "ALVO_NAO_ELEGIVEL");
  if (!dentroDaJanela(agora, janelaDe(regra))) {
    const proxima = proximoHorarioPermitido(agora, janelaDe(regra));
    await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'AGENDADA', agendada_para = $2::timestamptz, posse_token = NULL, posse_ate = NULL,
      atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id, proxima.toISOString()]);
    await evento(tx, e.empresa_id, e.id, "PROCESSANDO", "AGENDADA", { motivo: "FORA_DA_JANELA", agendadaPara: proxima.toISOString() });
    return { tipo: "PRONTA", estado: "AGENDADA" };
  }
  if (e.acao === "TAREFA_INTERNA") {
    const titulos: Record<string, string> = { PROPOSTA_PARADA: "Retomar proposta parada", POS_FESTA: "Pós-festa: agradecer e pedir avaliação", RECOMPRA: "Oferecer a próxima festa (recompra)" };
    await tx.query(
      `INSERT INTO marketing_tarefas (empresa_id, execucao_id, cliente_id, fechamento_id, titulo, descricao, vencimento)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date) ON CONFLICT (execucao_id) DO NOTHING`,
      [e.empresa_id, e.id, e.cliente_id, e.fechamento_id, `${titulos[regra.tipo] ?? "Tarefa"} — ${alvo.clienteNome}`.slice(0, 160),
        alvo.dataFesta ? `Festa: ${alvo.dataFesta.split("-").reverse().join("/")}` : null, dataLocal(agora, regra.fuso)]);
    return concluir(tx, e, "TAREFA_CRIADA", null);
  }
  const elegivel = await elegivelParaMensagem(tx, e.empresa_id, e.cliente_id);
  if (!elegivel.ok) return concluir(tx, e, "SUPRIMIDA", elegivel.motivo);
  if (await frequenciaExcedida(tx, e.empresa_id, e.cliente_id, regra.limiteFrequenciaDias, e.id)) return concluir(tx, e, "SUPRIMIDA", "LIMITE_FREQUENCIA");
  if (!regra.templateTexto || !regra.templateProvedor || !regra.templateRevisadoEm) return concluir(tx, e, "CANCELADA", "MODELO_NAO_REVISADO");
  const buffet = (await nomePublicoDaEmpresa(tx, e.empresa_id)) ?? "buffet";
  const texto = renderizarModelo(regra.templateTexto, { nome: alvo.clienteNome, buffet, dataFesta: alvo.dataFesta });
  const tentativa = e.tentativas + 1;
  await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'ENVIANDO', conteudo = $2, destinatario_mascarado = $3, posse_ate = clock_timestamp() + interval '5 minutes',
    atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id, texto, mascararTelefone(elegivel.telefone)]);
  // R1: o destino é o número com autorização CONFIRMADA escolhido na elegibilidade (rastreável pela autorização).
  await evento(tx, e.empresa_id, e.id, "PROCESSANDO", "ENVIANDO", { tentativa, autorizacaoId: elegivel.autorizacaoId });
  return { tipo: "ENVIAR", exec: { ...e, estado: "ENVIANDO" }, regra, telefone: elegivel.telefone, texto, idempotencia: `${e.id}:${tentativa}` };
}

export async function processarReservada(banco: Banco, transporte: TransporteMarketing, id: string, token: string, agora: Date) {
  const decisao = await banco.transacao((tx) => decidir(tx, id, token, agora));
  if (decisao.tipo === "PRONTA") return decisao.estado;
  const { exec, regra, telefone, texto, idempotencia } = decisao;
  let resultado: { ok: true; provedorMensagemId: string } | { ok: false; tipo: "RECUSADO" | "TEMPORARIO" | "DESCONHECIDO"; mensagem: string };
  try {
    const r = await transporte.enviar({ empresaId: exec.empresa_id, execucaoId: exec.id, idempotencia, telefone, templateProvedor: regra.templateProvedor!, texto });
    resultado = { ok: true, provedorMensagemId: r.provedorMensagemId };
  } catch (error) {
    resultado = error instanceof FalhaTransporte ? { ok: false, tipo: error.tipo, mensagem: error.message } : { ok: false, tipo: "DESCONHECIDO", mensagem: "Falha sem classificação." };
  }
  return banco.transacao(async (tx) => {
    const atual = await tx.query<{ estado: string; posse_token: string | null; tentativas: number; max_tentativas: number }>(
      `SELECT estado, posse_token::text, tentativas, max_tentativas FROM marketing_automacao_execucoes WHERE id = $1::uuid FOR UPDATE`, [exec.id]);
    const linha = atual.rows[0];
    if (!linha || linha.estado !== "ENVIANDO" || linha.posse_token !== token) return "POSSE_PERDIDA";
    const tentativas = linha.tentativas + 1;
    if (resultado.ok) {
      await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'ACEITA', provedor_mensagem_id = $2, tentativas = $3, posse_token = NULL, posse_ate = NULL,
        motivo = NULL, atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [exec.id, resultado.provedorMensagemId, tentativas]);
      await evento(tx, exec.empresa_id, exec.id, "ENVIANDO", "ACEITA", { provedor: transporte.nome, tentativa: tentativas });
      return "ACEITA";
    }
    if (resultado.tipo === "TEMPORARIO" && tentativas < linha.max_tentativas) {
      const espera = Math.min(3600, 60 * 2 ** (tentativas - 1));
      await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'AGENDADA', tentativas = $2, proxima_tentativa_em = clock_timestamp() + make_interval(secs => $3::int),
        posse_token = NULL, posse_ate = NULL, motivo = $4, atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [exec.id, tentativas, espera, `TEMPORARIO: ${resultado.mensagem}`.slice(0, 300)]);
      await evento(tx, exec.empresa_id, exec.id, "ENVIANDO", "AGENDADA", { erro: "TEMPORARIO", esperaSegundos: espera, tentativa: tentativas });
      return "AGENDADA";
    }
    const estado = resultado.tipo === "DESCONHECIDO" ? "INCERTA" : "FALHOU";
    await tx.query(`UPDATE marketing_automacao_execucoes SET estado = $2, tentativas = $3, posse_token = NULL, posse_ate = NULL, motivo = $4, atualizado_em = clock_timestamp()
      WHERE id = $1::uuid`, [exec.id, estado, tentativas, `${resultado.tipo}: ${resultado.mensagem}`.slice(0, 300)]);
    await evento(tx, exec.empresa_id, exec.id, "ENVIANDO", estado, { erro: resultado.tipo, tentativa: tentativas });
    return estado;
  });
}

/** Ciclo completo (planejar todas as empresas ou uma; recuperar posses; reservar e processar). */
export async function executarCiclo(banco: Banco, transporte: TransporteMarketing, agora: Date, opcoes: { empresaId?: string | null; limite?: number; lote?: number } = {}) {
  const empresaId = opcoes.empresaId ?? null;
  const planejamento = await banco.transacao(async (tx) => {
    const empresas = empresaId ? [empresaId] : (await tx.query<{ empresa_id: string }>(
      `SELECT DISTINCT r.empresa_id::text FROM marketing_automacao_regras r JOIN empresas e ON e.id = r.empresa_id AND e.status = 'ATIVA' WHERE r.status = 'ATIVA'`)).rows.map((x) => x.empresa_id);
    let criadas = 0;
    const bloqueadas: Array<{ empresaId: string; motivo: string }> = [];
    for (const id of empresas) {
      const r = await planejarEmpresa(tx, id, agora, { lote: opcoes.lote });
      criadas += r.criadas;
      if (r.bloqueio) bloqueadas.push({ empresaId: id, motivo: r.bloqueio });
    }
    return { empresas: empresas.length, criadas, bloqueadas };
  });
  const posses = await banco.transacao((tx) => recuperarPosses(tx, agora, empresaId));
  const { token, ids } = await banco.transacao((tx) => reservar(tx, agora, opcoes.limite ?? 50, empresaId));
  const resultados: Record<string, number> = {};
  for (const id of ids) {
    const estado = await processarReservada(banco, transporte, id, token, agora);
    resultados[estado] = (resultados[estado] ?? 0) + 1;
  }
  return { planejamento, posses, processadas: ids.length, resultados };
}

// ------------------------------------------------------------------------------------------------------------------
// Retorno de status (callback verificado) e ações manuais
// ------------------------------------------------------------------------------------------------------------------
/** ACEITA → ENTREGUE | FALHOU. Repetição e retorno fora de ordem são ignorados (estado final não volta). */
export async function aplicarRetorno(tx: DbExecutor, provedorMensagemId: string, status: "ENTREGUE" | "FALHOU", detalhe: string | null) {
  const r = await tx.query<{ id: string; empresa_id: string; estado: string }>(
    `SELECT id::text, empresa_id::text, estado FROM marketing_automacao_execucoes WHERE provedor_mensagem_id = $1 FOR UPDATE`, [provedorMensagemId]);
  const e = r.rows[0];
  if (!e) return "DESCONHECIDA";
  if (e.estado !== "ACEITA") return "IGNORADO";
  await tx.query(`UPDATE marketing_automacao_execucoes SET estado = $2, motivo = $3, concluida_em = CASE WHEN $2 = 'ENTREGUE' THEN clock_timestamp() ELSE NULL END,
    atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id, status, status === "FALHOU" ? `RETORNO: ${detalhe ?? "falha informada pelo provedor"}`.slice(0, 300) : null]);
  await tx.query(`UPDATE marketing_transporte_simulado SET status = $2, atualizado_em = clock_timestamp() WHERE provedor_mensagem_id = $1`, [provedorMensagemId, status]);
  await evento(tx, e.empresa_id, e.id, "ACEITA", status, { origem: "RETORNO_PROVEDOR" });
  return status;
}

/** Pessoa re-agenda uma FALHOU (nova revalidação completa no próximo ciclo) ou encerra uma INCERTA após conferir. */
export async function acaoManualExecucao(tx: DbExecutor, empresaId: string, execucaoId: string, acao: "tentar-novamente" | "encerrar", agora: Date) {
  const r = await tx.query<{ estado: string; tentativas: number }>(
    `SELECT estado, tentativas FROM marketing_automacao_execucoes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [execucaoId, empresaId]);
  const e = r.rows[0];
  if (!e) return null;
  if (acao === "tentar-novamente" && e.estado === "FALHOU" && e.tentativas >= 5) return "LIMITE_DE_TENTATIVAS";
  if (acao === "tentar-novamente" && e.estado === "FALHOU") {
    await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'AGENDADA', agendada_para = $2::timestamptz, proxima_tentativa_em = NULL,
      max_tentativas = LEAST(5, GREATEST(max_tentativas, tentativas + 1)), atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [execucaoId, agora.toISOString()]);
    await evento(tx, empresaId, execucaoId, "FALHOU", "AGENDADA", { motivo: "NOVA_TENTATIVA_MANUAL" });
    return "AGENDADA";
  }
  if (acao === "encerrar" && (e.estado === "INCERTA" || e.estado === "FALHOU")) {
    await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'CANCELADA', motivo = 'ENCERRADA_MANUALMENTE', concluida_em = clock_timestamp(),
      atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [execucaoId]);
    await evento(tx, empresaId, execucaoId, e.estado, "CANCELADA", { motivo: "ENCERRADA_MANUALMENTE" });
    return "CANCELADA";
  }
  return "SEM_EFEITO";
}

export { lerPreferencia };
