import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import { adiado, carregarAtendimento, cod, fixtures, noPrazo } from "./harness-postgres.ts";

/**
 * Evidência de concorrência do ENCERRAR (cancelamento na mesma transação com FOR UPDATE SKIP LOCKED), no PostgreSQL
 * descartável. Só roda pelo check:v1:postgres, com KIDMAIS_POSTGRES_DESCARTAVEL, no cluster descartável e com
 * autorização explícita do Felipe (docs/OPERACAO_AGENTES.md). PREPARADA: execução registrada em
 * docs/VALIDACAO_063_E_ENCERRAMENTO.md. Dados sintéticos; modelo e Gupshup simulados.
 *
 * Roteiro:
 *  1. controle do risco: sem SKIP LOCKED, a ordem de travas inversa (worker: mensagem → conversa; encerrar:
 *     conversa → mensagens) gera deadlock real (40P01);
 *  2. encerrar com a reserva do worker em andamento (mensagem travada): NÃO bloqueia; cancela as outras pendentes;
 *     a linha travada é PULADA (fora do contador) e, depois, o worker REAL a cancela ao revalidar (ENCERRADA);
 *  3. encerrar durante a interpretação (PROCESSANDO fora de trava): a entrada é cancelada pelo encerrar; quando o
 *     modelo responde, o worker REAL revalida, não cria resposta e nada é enviado;
 *  4. envio em andamento (ENVIANDO) continua recusando o encerramento; nada é cancelado;
 *  5. histórico preservado: nenhuma mensagem apagada; auditoria registra o encerrar.
 */
const UP060 = readFileSync("database/migrations/20261001_060_whatsapp_atendimento.sql", "utf8");
const DOWN060 = readFileSync("database/rollback/20261001_060_whatsapp_atendimento_down.sql", "utf8");

test("encerrar: cancelamento na mesma transação, SKIP LOCKED sem deadlock e cancelamento posterior pelo worker", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  try {
    await c.query(UP060);
    const f = fixtures(c);
    const A = await f.empresa("Empresa sintética A (concorrência)");
    const atendente = await f.usuario("ADMINISTRATIVO", A), representante = await f.usuario("REPRESENTANTE_AUTORIZADO", A);
    const { servico, worker } = carregarAtendimento(A);
    await servico.salvarConfiguracao(representante, { ativo: true, nome: "Empresa sintética A", perguntas: [] });
    const conversa = async (contato: string) => (await c.query("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const msgs = async (conversaId: string) => (await c.query("SELECT id, direcao, estado FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 ORDER BY criada_em, id", [conversaId])).rows;
    const entrada = (contato: string, texto: string) => servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now() });
    const conectar = () => conectarDescartavel({ travar: false });

    // 1. Controle: a mesma ordem inversa de travas SEM SKIP LOCKED termina em deadlock detectado pelo PostgreSQL.
    await entrada("5561900000301", "Olá");
    const c1 = await conversa("5561900000301"), [m1] = await msgs(c1.id);
    const w = await conectar(), e = await conectar();
    try {
      await w.query("BEGIN"); await e.query("BEGIN");
      await w.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE id = $1 FOR UPDATE", [m1.id]);          // worker: mensagem
      await e.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [c1.id]);         // encerrar: conversa
      const wConversa = w.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [c1.id]); // worker espera
      const eMensagens = e.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'CANCELADA' WHERE conversa_id = $1 AND estado IN ('PENDENTE','PROCESSANDO')", [c1.id]); // SEM SKIP LOCKED
      const r = await Promise.allSettled([wConversa, eMensagens]);
      assert.ok(r.some((x) => x.status === "rejected" && /deadlock/i.test(String((x as PromiseRejectedResult).reason?.message))), "sem SKIP LOCKED há deadlock (40P01)");
    } finally { await w.query("ROLLBACK").catch(() => {}); await e.query("ROLLBACK").catch(() => {}); await w.end(); await e.end(); }
    // Sem trava concorrente, o encerrar do serviço cancela a entrada de c1 normalmente (e ela não sobra para o worker).
    assert.deepEqual(await noPrazo(servico.controlarAtendimento(atendente, { acao: "encerrar", conversaId: c1.id, versao: Number(c1.versao) }), 10_000, "encerrar c1"), { canceladas: { entradas: 1, saidas: 0 } });

    // 2. Reserva do worker em andamento: a mensagem M fica travada como na reserva real (mensagem antes da conversa).
    await entrada("5561900000302", "Primeira");
    const c2 = await conversa("5561900000302");
    await c.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa) VALUES ($1, $2, 'staging', 'SAIDA', 'Resposta na fila', 'PENDENTE', $3)`, [c2.id, A, Number(c2.versao)]);
    const [travada, livre] = await msgs(c2.id);
    const reserva = await conectar();
    try {
      await reserva.query("BEGIN");
      await reserva.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE id = $1 FOR UPDATE", [travada.id]);
      const r = await noPrazo(servico.controlarAtendimento(atendente, { acao: "encerrar", conversaId: c2.id, versao: Number(c2.versao) }), 10_000, "encerrar com mensagem travada pelo worker");
      assert.deepEqual(r, { canceladas: { entradas: 0, saidas: 1 } }, "a linha travada foi PULADA (fora do contador); a saída livre foi cancelada");
      assert.equal((await c.query("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id = $1", [livre.id])).rows[0].estado, "CANCELADA");
      assert.equal((await c.query("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id = $1", [travada.id])).rows[0].estado, "PENDENTE", "pulada: ainda PENDENTE");
      // O "worker" segue: pede a conversa (não espera mais) e vê ENCERRADA.
      assert.equal((await noPrazo(reserva.query("SELECT estado FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [c2.id]), 5_000, "worker pede a conversa")).rows[0].estado, "ENCERRADA");
    } finally { await reserva.query("ROLLBACK").catch(() => {}); await reserva.end(); }
    // Worker REAL: reserva a linha pulada, revalida e cancela; não chama modelo nem envia.
    let modelo = 0, envios = 0;
    const deps = { interpretar: async () => { modelo++; return { intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }; }, enviar: async () => { envios++; return cod("gs-"); } };
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal((await c.query("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id = $1", [travada.id])).rows[0].estado, "CANCELADA", "cancelada DEPOIS pelo worker");
    assert.deepEqual([modelo, envios], [0, 0]);

    // 3. Encerrar durante a interpretação: a entrada está PROCESSANDO (fora de trava) enquanto o modelo responde.
    await entrada("5561900000303", "Quero uma festa");
    const c3 = await conversa("5561900000303");
    const modeloLiberado = adiado<void>(), modeloChamado = adiado<void>();
    let enviados3 = 0;
    const lote = worker.processarLote({
      interpretar: async () => { modeloChamado.liberar(); await modeloLiberado.p; return { intencao: "INTERESSE" as const, perguntaId: null, data: null, convidados: null }; },
      enviar: async () => { enviados3++; return cod("gs-"); },
    }, { maxTarefas: 1 });
    await noPrazo(modeloChamado.p, 10_000, "worker chamar o modelo");
    const c3agora = await conversa("5561900000303");
    const r3 = await noPrazo(servico.controlarAtendimento(atendente, { acao: "encerrar", conversaId: c3.id, versao: Number(c3agora.versao) }), 10_000, "encerrar durante a interpretação");
    assert.deepEqual(r3, { canceladas: { entradas: 1, saidas: 0 } }, "a entrada em interpretação foi cancelada pelo encerrar");
    modeloLiberado.liberar();
    await lote;
    await worker.processarLote({ interpretar: async () => assert.fail("sem nova chamada"), enviar: async () => assert.fail("nada a enviar") }, { maxTarefas: 10 });
    const m3 = await msgs(c3.id);
    assert.deepEqual(m3.map((m) => [m.direcao, m.estado]), [["ENTRADA", "CANCELADA"]], "nenhuma resposta criada nem enviada");
    assert.equal(enviados3, 0);
    assert.equal((await conversa("5561900000303")).estado, "ENCERRADA");

    // 4. Envio em andamento recusa o encerramento e nada é cancelado.
    await entrada("5561900000304", "Oi");
    const c4 = await conversa("5561900000304");
    await c.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa) VALUES ($1, $2, 'staging', 'SAIDA', 'Saindo', 'ENVIANDO', $3)`, [c4.id, A, Number(c4.versao)]);
    await assert.rejects(servico.controlarAtendimento(atendente, { acao: "encerrar", conversaId: c4.id, versao: Number(c4.versao) }), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/);
    assert.deepEqual((await msgs(c4.id)).map((m) => m.estado).sort(), ["ENVIANDO", "PENDENTE"]);
    assert.notEqual((await conversa("5561900000304")).estado, "ENCERRADA");

    // 5. Histórico preservado e auditado.
    const total = Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id = ANY($1::uuid[])", [[c2.id, c3.id]])).rows[0].n);
    assert.equal(total, 3, "nenhuma mensagem apagada (2 em c2, 1 em c3)");
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_auditoria WHERE acao = 'encerrar' AND conversa_id = ANY($1::uuid[])", [[c2.id, c3.id]])).rows[0].n), 2);

    // Limpeza da estrutura (o runner também restaura o banco de trabalho antes de cada suíte).
    await c.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'FALHOU' WHERE estado IN ('ENVIANDO','PROCESSANDO')");
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'");
    await c.query(semTransacaoExplicita(DOWN060)); await c.query("COMMIT");
  } finally {
    await encerrarDescartavel(c);
  }
});
