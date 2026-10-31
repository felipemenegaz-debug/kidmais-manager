import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../../db/contracts.ts";
import { nomePublicoDaEmpresa } from "../../perfil/nome-publico.ts";
import { alvoContinuaElegivel, alvosParaPlanejar, alvosParaSimular, chaveExecucao, cicloDaChave, LIMITE_PLANEJAMENTO, totalDeAlvos, type Alvo } from "./alvos.ts";
import { empresaApta } from "./aptidao.ts";
import { dataLocal, dentroDaJanela, proximoHorarioPermitido } from "./janela.ts";
import { mascararTelefone, renderizarModelo } from "./modelo.ts";
import { elegivelParaMensagem, lerPreferencia } from "./preferencias.ts";
import { pesquisaInstalada } from "../../satisfacao/supressao.ts";
import { criarEnvio } from "../../satisfacao/envios.ts";
import { aplicarRetornoEntrega, executarEntregas, type ContextoPesquisa } from "../../satisfacao/despacho.ts";
import { comRepeticao, TravaOcupada } from "../../satisfacao/travas.ts";
import { frequenciaExcedida } from "./frequencia.ts";
import { COLUNAS as COLUNAS_REGRA, mapearRegra, type Regra } from "./regras.ts";
import { FalhaTransporte, type TransporteMarketing } from "./transporte.ts";

export { frequenciaExcedida };

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
  id: string; empresa_id: string; regra_id: string; acao: "TAREFA_INTERNA" | "MENSAGEM_WHATSAPP" | "PESQUISA_SATISFACAO"; alvo_tipo: string; alvo_id: string; cliente_id: string;
  fechamento_id: string | null; chave_idempotencia: string; estado: string; tentativas: number; max_tentativas: number; posse_token: string | null;
};

async function evento(tx: DbExecutor, empresaId: string, execucaoId: string, anterior: string | null, novo: string, detalhe: Record<string, unknown> = {}) {
  await tx.query(`INSERT INTO marketing_automacao_eventos (empresa_id, execucao_id, estado_anterior, estado_novo, detalhe) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
    [empresaId, execucaoId, anterior, novo, JSON.stringify(detalhe)]);
}

function janelaDe(r: Regra) { return { inicio: r.janelaInicio, fim: r.janelaFim, fuso: r.fuso, fimDeSemana: r.fimDeSemana }; }

// ------------------------------------------------------------------------------------------------------------------
// Planejar
// ------------------------------------------------------------------------------------------------------------------
export async function planejarEmpresa(tx: DbExecutor, empresaId: string, agora: Date, opcoes: { lote?: number; pesquisa?: boolean } = {}) {
  // R2: empresa sem aptidão (status, recurso MARKETING, situação comercial) não planeja nada; o motivo volta para o ciclo.
  const aptidao = await empresaApta(tx, empresaId);
  if (!aptidao.apta) return { regras: 0, criadas: 0, existentes: 0, bloqueio: aptidao.motivo };
  // Pesquisa de satisfação só é planejada com a 110 instalada e a pesquisa ligada neste servidor (contexto do ciclo).
  const acoes = opcoes.pesquisa && (await pesquisaInstalada(tx)) ? ["TAREFA_INTERNA", "MENSAGEM_WHATSAPP", "PESQUISA_SATISFACAO"] : ["TAREFA_INTERNA", "MENSAGEM_WHATSAPP"];
  const regras = (await tx.query<Parameters<typeof mapearRegra>[0]>(
    `SELECT ${COLUNAS_REGRA} FROM marketing_automacao_regras WHERE empresa_id = $1::uuid AND status = 'ATIVA' AND acao = ANY($2::text[])`, [empresaId, acoes])).rows.map(mapearRegra);
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
    } else if (regra.acao === "PESQUISA_SATISFACAO" && alvo.fechamentoId) {
      // Prévia: o consentimento de cada canal é conferido no despacho; aqui só o que impede criar a pesquisa.
      impedimento = await impedimentoDaPesquisa(tx, empresaId, alvo.clienteId, alvo.fechamentoId, regra.limiteFrequenciaDias, null);
    }
    linhas.push({ ...alvo, jaPlanejada, impedimento, agendadaPara: proximoHorarioPermitido(agora, janelaDe(regra)).toISOString() });
  }
  return { alvos: linhas, total: await totalDeAlvos(tx, empresaId, regra, agora) };
}

/**
 * Plano da pesquisa R5/R6: o que impede CRIAR a pesquisa de um fechamento — já existe uma (uma por festa), a festa já
 * teve uma Mensagem simples pós-festa que saiu ou pode ter saído (tarefa interna não conta), ou o limite de frequência.
 */
async function impedimentoDaPesquisa(tx: DbExecutor, empresaId: string, clienteId: string, fechamentoId: string, dias: number, excetoId: string | null) {
  if (await pesquisaDoFechamento(tx, empresaId, fechamentoId)) return "PESQUISA_JA_EXISTE";
  const contato = await tx.query(
    `SELECT 1 FROM marketing_automacao_execucoes x JOIN marketing_automacao_regras r ON r.id = x.regra_id AND r.empresa_id = x.empresa_id AND r.tipo = 'POS_FESTA'
      WHERE x.empresa_id = $1::uuid AND x.fechamento_id = $2::uuid AND x.acao = 'MENSAGEM_WHATSAPP' AND x.estado IN ('ENVIANDO', 'ACEITA', 'ENTREGUE', 'INCERTA') LIMIT 1`,
    [empresaId, fechamentoId]);
  if (contato.rows.length > 0) return "CONTATO_POS_FESTA_JA_FEITO";
  if (await frequenciaExcedida(tx, empresaId, clienteId, dias, excetoId)) return "LIMITE_FREQUENCIA";
  return null;
}

async function pesquisaDoFechamento(tx: DbExecutor, empresaId: string, fechamentoId: string) {
  if (!(await pesquisaInstalada(tx))) return false;
  const r = await tx.query(`SELECT 1 FROM satisfacao_envios WHERE empresa_id = $1::uuid AND fechamento_id = $2::uuid`, [empresaId, fechamentoId]);
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

async function concluir(tx: DbExecutor, e: LinhaExecucao, estado: "TAREFA_CRIADA" | "PESQUISA_CRIADA" | "SUPRIMIDA" | "CANCELADA", motivo: string | null, detalhe: Record<string, unknown> = {}) {
  await tx.query(`UPDATE marketing_automacao_execucoes SET estado = $2, motivo = $3, posse_token = NULL, posse_ate = NULL, concluida_em = clock_timestamp(),
    atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id, estado, motivo]);
  await evento(tx, e.empresa_id, e.id, e.estado, estado, { motivo, ...detalhe });
  return { tipo: "PRONTA" as const, estado };
}

/** Volta a execução para a fila sem consumir tentativa (direito ilegível, pesquisa sem configuração, pais ocupados). */
async function devolverParaFila(tx: DbExecutor, e: LinhaExecucao, motivo: string) {
  await tx.query(`UPDATE marketing_automacao_execucoes SET estado = 'AGENDADA', proxima_tentativa_em = clock_timestamp() + interval '15 minutes',
    posse_token = NULL, posse_ate = NULL, motivo = $2, atualizado_em = clock_timestamp() WHERE id = $1::uuid`, [e.id, motivo]);
  await evento(tx, e.empresa_id, e.id, "PROCESSANDO", "AGENDADA", { motivo });
}

/**
 * Pesquisa de satisfação (plano R4/R5): a execução CRIA o envio e as entregas INICIAL (na janela, então elas já estão
 * devidas) e termina em PESQUISA_CRIADA; quem envia é o despacho das entregas. Sem a pesquisa ligada ou sem o segredo
 * do link/origem pública, a execução espera na fila (nada é criado sem link possível).
 */
async function decidirPesquisa(tx: DbExecutor, e: LinhaExecucao, regra: Regra, agora: Date, pesquisa: ContextoPesquisa | null): Promise<Decisao> {
  if (!(await pesquisaInstalada(tx))) return concluir(tx, e, "CANCELADA", "PESQUISA_NAO_DISPONIVEL");
  if (!pesquisa?.habilitada) { await devolverParaFila(tx, e, "PESQUISA_DESLIGADA"); return { tipo: "PRONTA", estado: "AGUARDANDO_PESQUISA" }; }
  if (!pesquisa.anel || !pesquisa.origem) { await devolverParaFila(tx, e, "LINK_NAO_CONFIGURADO"); return { tipo: "PRONTA", estado: "AGUARDANDO_PESQUISA" }; }
  if (!e.fechamento_id) return concluir(tx, e, "CANCELADA", "EXECUCAO_INVALIDA");
  const impedimento = await impedimentoDaPesquisa(tx, e.empresa_id, e.cliente_id, e.fechamento_id, regra.limiteFrequenciaDias, e.id);
  if (impedimento) return concluir(tx, e, "SUPRIMIDA", impedimento);
  const r = await criarEnvio(tx, pesquisa.anel, { empresaId: e.empresa_id, execucaoId: e.id, canais: regra.canais, agendadaPara: agora, maxTentativas: regra.maxTentativas });
  if (r.criado) return concluir(tx, e, "PESQUISA_CRIADA", null, { envioId: r.envioId, canais: regra.canais });
  return concluir(tx, e, r.motivo === "EXECUCAO_INVALIDA" ? "CANCELADA" : "SUPRIMIDA", r.motivo);
}

async function decidir(tx: DbExecutor, id: string, token: string, agora: Date, pesquisa: ContextoPesquisa | null): Promise<Decisao> {
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
    await devolverParaFila(tx, e, aptidao.motivo);
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
  if (e.acao === "PESQUISA_SATISFACAO") return decidirPesquisa(tx, e, regra, agora, pesquisa);
  if (e.acao === "TAREFA_INTERNA") {
    const titulos: Record<string, string> = { PROPOSTA_PARADA: "Retomar proposta parada", POS_FESTA: "Pós-festa: agradecer e pedir avaliação", RECOMPRA: "Oferecer a próxima festa (recompra)" };
    await tx.query(
      `INSERT INTO marketing_tarefas (empresa_id, execucao_id, cliente_id, fechamento_id, titulo, descricao, vencimento)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date) ON CONFLICT (execucao_id) DO NOTHING`,
      [e.empresa_id, e.id, e.cliente_id, e.fechamento_id, `${titulos[regra.tipo] ?? "Tarefa"} — ${alvo.clienteNome}`.slice(0, 160),
        alvo.dataFesta ? `Festa: ${alvo.dataFesta.split("-").reverse().join("/")}` : null, dataLocal(agora, regra.fuso)]);
    return concluir(tx, e, "TAREFA_CRIADA", null);
  }
  // R5: a festa que já tem pesquisa não recebe também a Mensagem simples pós-festa (mesma trava por cliente da criação).
  if (regra.tipo === "POS_FESTA" && e.fechamento_id && (await pesquisaDoFechamento(tx, e.empresa_id, e.fechamento_id))) {
    return concluir(tx, e, "SUPRIMIDA", "PESQUISA_JA_EXISTE");
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

export async function processarReservada(banco: Banco, transporte: TransporteMarketing, id: string, token: string, agora: Date, pesquisa: ContextoPesquisa | null = null) {
  let decisao: Decisao;
  try {
    // A criação da pesquisa trava os pais NOWAIT: 55P03 desfaz a transação inteira e ela é repetida do começo (travas.ts).
    decisao = await comRepeticao(() => banco.transacao((tx) => decidir(tx, id, token, agora, pesquisa)), pesquisa?.repeticao);
  } catch (error) {
    if (!(error instanceof TravaOcupada)) throw error;
    // Pais ocupados em todas as tentativas: a execução volta para a fila sem consumir tentativa.
    return banco.transacao(async (tx) => {
      const r = await tx.query<LinhaExecucao>(
        `SELECT id::text, empresa_id::text, estado, posse_token::text FROM marketing_automacao_execucoes WHERE id = $1::uuid FOR UPDATE`, [id]);
      const e = r.rows[0];
      if (!e || e.estado !== "PROCESSANDO" || e.posse_token !== token) return "POSSE_PERDIDA";
      await devolverParaFila(tx, e, "PAIS_OCUPADOS");
      return "AGUARDANDO_TRAVA";
    });
  }
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

/**
 * Ciclo completo (planejar todas as empresas ou uma; recuperar posses; reservar e processar) e, com o contexto da
 * pesquisa, o despacho das entregas da pesquisa de satisfação (iniciais e lembretes) no mesmo ciclo.
 */
export async function executarCiclo(banco: Banco, transporte: TransporteMarketing, agora: Date,
  opcoes: { empresaId?: string | null; limite?: number; lote?: number; pesquisa?: ContextoPesquisa | null } = {}) {
  const empresaId = opcoes.empresaId ?? null;
  const pesquisa = opcoes.pesquisa ?? null;
  const planejamento = await banco.transacao(async (tx) => {
    const empresas = empresaId ? [empresaId] : (await tx.query<{ empresa_id: string }>(
      `SELECT DISTINCT r.empresa_id::text FROM marketing_automacao_regras r JOIN empresas e ON e.id = r.empresa_id AND e.status = 'ATIVA' WHERE r.status = 'ATIVA'`)).rows.map((x) => x.empresa_id);
    let criadas = 0;
    const bloqueadas: Array<{ empresaId: string; motivo: string }> = [];
    for (const id of empresas) {
      const r = await planejarEmpresa(tx, id, agora, { lote: opcoes.lote, pesquisa: pesquisa?.habilitada === true });
      criadas += r.criadas;
      if (r.bloqueio) bloqueadas.push({ empresaId: id, motivo: r.bloqueio });
    }
    return { empresas: empresas.length, criadas, bloqueadas };
  });
  const posses = await banco.transacao((tx) => recuperarPosses(tx, agora, empresaId));
  const { token, ids } = await banco.transacao((tx) => reservar(tx, agora, opcoes.limite ?? 50, empresaId));
  const resultados: Record<string, number> = {};
  for (const id of ids) {
    const estado = await processarReservada(banco, transporte, id, token, agora, pesquisa);
    resultados[estado] = (resultados[estado] ?? 0) + 1;
  }
  const entregas = pesquisa?.habilitada ? await executarEntregas(banco, pesquisa, agora, { empresaId, limite: opcoes.limite ?? 50 }) : null;
  return { planejamento, posses, processadas: ids.length, resultados, entregas };
}

// ------------------------------------------------------------------------------------------------------------------
// Retorno de status (callback verificado) e ações manuais
// ------------------------------------------------------------------------------------------------------------------
/** ACEITA → ENTREGUE | FALHOU. Repetição e retorno fora de ordem são ignorados (estado final não volta). */
export async function aplicarRetorno(tx: DbExecutor, provedorMensagemId: string, status: "ENTREGUE" | "FALHOU", detalhe: string | null) {
  const r = await tx.query<{ id: string; empresa_id: string; estado: string }>(
    `SELECT id::text, empresa_id::text, estado FROM marketing_automacao_execucoes WHERE provedor_mensagem_id = $1 FOR UPDATE`, [provedorMensagemId]);
  const e = r.rows[0];
  // Sem execução com esse id: pode ser uma entrega de WhatsApp da pesquisa (mesma caixa de saída simulada).
  if (!e) return aplicarRetornoEntrega(tx, provedorMensagemId, status, detalhe);
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
