import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { PortaWallE } from "./worker.ts";
import { pausaPedidaNaRecepcao, comandoDireto } from "./core.ts";

/**
 * Revisão final (M3/M4): nenhuma entrada fica à espera de uma resposta automática "para depois". Worker REAL no
 * PostgreSQL descartável (modelo "atual" + 060/076/077/078), só pelo check:v1:postgres, com opt-in. Dados sintéticos;
 * Wall-e e modelo por portas simuladas que contam as chamadas; transporte simulado (nenhuma rede).
 *
 *  V1 entrada parada além de 15 min: equipe (SEM_RESPOSTA_AUTOMATICA), nada enviado, Wall-e e modelo não chamados;
 *  V2 entrada de 14 min: resposta normal (limite do prazo);
 *  V3 entrada vencida com pedido de PAUSA: marca persistente gravada; "Devolver ao Wall-e" recusado; nada enviado;
 *  V4 entrada vencida com PARAR inequívoco: o bloqueio da recepção vale; nada enviado;
 *  D1 automação global desligada: entradas pendentes vão à equipe sem resposta; saída AUTOMÁTICA na fila é cancelada e a
 *     conversa vai à equipe; saída do ATENDENTE não é tocada; Wall-e, modelo e transporte não são chamados;
 *  D2 entrada que chega com a automação desligada: o próximo ciclo a encaminha (sem esperar a IA voltar);
 *  D3 pausa pedida com a automação desligada: marca persistente gravada;
 *  D4 religar: nada encaminhado recebe resposta automática depois (nem com mensagem nova na mesma conversa); a saída do
 *     atendente sai; contato novo é atendido normalmente;
 *  D5 desligada SEM ciclo do processador e religada depois do prazo: a entrada antiga vai à equipe sem resposta (M4).
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIGRATIONS = [
  ["database/migrations/20261001_060_whatsapp_atendimento.sql", "database/checks/20261001_060_postcheck.sql"],
  ["database/migrations/20261009_076_whatsapp_mensagens_prontas.sql", "database/checks/20261009_076_postcheck.sql"],
  ["database/migrations/20261009_077_whatsapp_prontas_midia.sql", "database/checks/20261009_077_postcheck.sql"],
  ["database/migrations/20261009_078_wall_e_atendimento.sql", "database/checks/20261009_078_postcheck.sql"],
].map(([up, post]) => [ler(up), ler(post)]);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PAUSA = "por enquanto não precisa me mandar mais nada, depois eu chamo vcs";
const PARAR = "não quero receber mais nada de vocês";
const MIN = 60_000;

test("fila do atendimento: validade das entradas (15 min) e automação global desligada/religada", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  assert.ok(pausaPedidaNaRecepcao(PAUSA) && !comandoDireto(PAUSA)?.intencao?.startsWith("PARAR"), "texto de pausa (ambíguo, sem bloqueio)");
  assert.equal(comandoDireto(PARAR)?.intencao, "PARAR", "texto de PARAR inequívoco");
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    for (const [up, post] of MIGRATIONS) { await q(up); await q(post); }
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet sintético (fila)', 'PROVISIONAMENTO') RETURNING id`, [cod("fv")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness fila', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    // Modelo "atual" (sem a 063): sessão sem empresa ativa, como nas suítes da 060/078.
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO" } as never;
    const { servico, worker } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Buffet sintético", perguntas: [], wallE: { ativo: true } });

    const chamadas = { wallE: 0, modelo: 0 };
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    const porta: PortaWallE = { async responder() { chamadas.wallE++; return { saidas: [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }], contexto: {} as never, passagem: null }; } };
    const deps = { interpretar: async () => { chamadas.modelo++; throw new Error("modelo proibido no harness"); }, enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); }, wallE: porta };
    const receber = (contato: string, texto: string, idadeMs = 0) => servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now() - idadeMs, nomePerfil: null });
    const conversa = async (contato: string) => (await q("SELECT id, versao, estado, contexto, passagem, nao_contatar FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const mensagens = async (contato: string) => (await q(`SELECT m.direcao, m.estado, m.autor_usuario_id IS NOT NULL AS humana FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas cv ON cv.id = m.conversa_id
      WHERE cv.empresa_id = $1 AND cv.contato = $2 ORDER BY m.criada_em, m.id`, [A, contato])).rows.map((x) => `${x.direcao}:${x.estado}${x.humana ? ":humana" : ""}`);
    const enviadosPara = (contato: string) => envios.filter((x) => x.contato === contato).length;
    const motivos = async (contato: string) => ((await conversa(contato)).passagem?.motivos ?? []) as string[];

    // V1 — entrada de 16 min: equipe, sem nada enviado nem chamado.
    const v1 = "5561900001001";
    await receber(v1, "quanto custa a festa?", 16 * MIN);
    assert.deepEqual(await mensagens(v1), ["ENTRADA:PENDENTE"], "V1: a recepção ainda enfileira (não sabe da idade)");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.deepEqual(await mensagens(v1), ["ENTRADA:PROCESSADA"], "V1: entrada encaminhada, nenhuma saída criada");
    assert.equal((await conversa(v1)).estado, "AGUARDANDO_HUMANO");
    assert.deepEqual(await motivos(v1), ["SEM_RESPOSTA_AUTOMATICA"]);
    assert.equal(enviadosPara(v1), 0); assert.deepEqual(chamadas, { wallE: 0, modelo: 0 }, "V1: Wall-e e modelo não chamados");
    // V2 — 14 min: resposta normal.
    const v2 = "5561900001002";
    await receber(v2, "quanto custa a festa?", 14 * MIN);
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(chamadas.wallE, 1, "V2: Wall-e chamado"); assert.equal(enviadosPara(v2), 1, "V2: resposta enviada");
    assert.deepEqual(await mensagens(v2), ["ENTRADA:PROCESSADA", "SAIDA:SUBMETIDA"]);
    // V3 — vencida com pedido de pausa: marca persistente, retomar recusado, nada enviado.
    const v3 = "5561900001003";
    await receber(v3, PAUSA, 20 * MIN);
    await worker.processarLote(deps, { maxTarefas: 10 });
    const cv3 = await conversa(v3);
    assert.equal(cv3.estado, "AGUARDANDO_HUMANO"); assert.equal(cv3.nao_contatar, false, "V3: pausa não é bloqueio definitivo");
    assert.deepEqual(await motivos(v3), ["PARAR_A_CONFIRMAR", "SEM_RESPOSTA_AUTOMATICA"]);
    assert.equal(cv3.contexto?.semAutomatico?.motivo, "PARAR_A_CONFIRMAR"); assert.equal(cv3.contexto?.semAutomatico?.origem, "ENTRADA_VENCIDA");
    await assert.rejects(servico.controlarAtendimento(sessao, { acao: "retomar", conversaId: cv3.id, versao: Number(cv3.versao) }), /ATENDIMENTO_PAUSA_PEDIDA/, "V3: Devolver ao Wall-e recusado");
    assert.equal(enviadosPara(v3), 0);
    // V4 — vencida com PARAR inequívoco: bloqueio da recepção, nada enviado.
    const v4 = "5561900001004";
    await receber(v4, PARAR, 20 * MIN);
    await worker.processarLote(deps, { maxTarefas: 10 });
    const cv4 = await conversa(v4);
    assert.equal(cv4.nao_contatar, true, "V4: bloqueio definitivo"); assert.equal(cv4.estado, "ENCERRADA");
    assert.deepEqual(await mensagens(v4), ["ENTRADA:CANCELADA"]); assert.equal(enviadosPara(v4), 0);
    assert.equal(chamadas.wallE, 1, "V3/V4: Wall-e não chamado");

    // D1 — automação global desligada.
    const d7 = "5561900001007", d6 = "5561900001006", d8 = "5561900001008";
    await receber(d7, "tem vaga em dezembro?");
    await worker.processarLote(deps, { maxTarefas: 1 }); // só interpreta: a saída automática fica na fila
    assert.deepEqual(await mensagens(d7), ["ENTRADA:PROCESSADA", "SAIDA:PENDENTE"], "D1: saída automática na fila");
    await receber(d6, "qual o endereço?");
    await receber(d8, "oi, quero falar com alguém");
    let cv8 = await conversa(d8);
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv8.id, versao: Number(cv8.versao) });
    cv8 = await conversa(d8);
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv8.id, versao: Number(cv8.versao), texto: "Olá! Sou da equipe sintética." });
    const antes = { ...chamadas }, enviosAntes = envios.length;
    const r1 = await worker.processarLote(deps, { maxTarefas: 10, semAutomacao: true });
    assert.equal(r1.estado, "DESLIGADO"); assert.ok(r1.tarefas >= 2, JSON.stringify(r1));
    assert.deepEqual(chamadas, antes, "D1: Wall-e e modelo não chamados"); assert.equal(envios.length, enviosAntes, "D1: nada enviado");
    assert.deepEqual(await mensagens(d6), ["ENTRADA:PROCESSADA"]); assert.equal((await conversa(d6)).estado, "AGUARDANDO_HUMANO");
    assert.deepEqual(await motivos(d6), ["SEM_RESPOSTA_AUTOMATICA"]);
    assert.deepEqual(await mensagens(d7), ["ENTRADA:PROCESSADA", "SAIDA:CANCELADA"], "D1: saída automática cancelada"); assert.equal((await conversa(d7)).estado, "AGUARDANDO_HUMANO");
    assert.deepEqual(await mensagens(d8), ["ENTRADA:CANCELADA", "SAIDA:PENDENTE:humana"], "D1: saída do atendente intacta");
    assert.equal((await conversa(d8)).estado, "HUMANO");
    // D2 — chega com a automação desligada: o próximo ciclo encaminha.
    const d9 = "5561900001009";
    await receber(d9, "vocês fazem festa de 15 anos?");
    await worker.processarLote(deps, { semAutomacao: true });
    assert.deepEqual(await mensagens(d9), ["ENTRADA:PROCESSADA"]); assert.equal((await conversa(d9)).estado, "AGUARDANDO_HUMANO");
    // D3 — pausa com a automação desligada.
    const d12 = "5561900001012";
    await receber(d12, PAUSA);
    await worker.processarLote(deps, { semAutomacao: true });
    const cv12 = await conversa(d12);
    assert.equal(cv12.contexto?.semAutomatico?.origem, "AUTOMACAO_DESLIGADA"); assert.deepEqual(await motivos(d12), ["PARAR_A_CONFIRMAR", "SEM_RESPOSTA_AUTOMATICA"]);
    assert.deepEqual(chamadas, antes); assert.equal(envios.length, enviosAntes);

    // D4 — religar.
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(enviadosPara(d8), 1, "D4: a saída do atendente sai");
    for (const ct of [d6, d7, d9, d12]) { assert.equal(enviadosPara(ct), 0, `D4: nada automático para ${ct}`); assert.equal((await conversa(ct)).estado, "AGUARDANDO_HUMANO", `D4: ${ct} segue com a equipe`); }
    await receber(d6, "e o horário?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(enviadosPara(d6), 0, "D4: mensagem nova numa conversa encaminhada fica com a equipe");
    assert.deepEqual(await mensagens(d6), ["ENTRADA:PROCESSADA", "ENTRADA:PROCESSADA"]);
    const d10 = "5561900001010";
    await receber(d10, "quanto custa?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(enviadosPara(d10), 1, "D4: contato novo é atendido normalmente depois de religar");
    // D5 — desligada sem ciclo do processador; religada depois do prazo.
    const d11 = "5561900001011";
    await receber(d11, "tem vaga dia 20?");
    await q("UPDATE whatsapp_atendimento_mensagens SET criada_em = criada_em - interval '16 minutes' WHERE conversa_id = (SELECT id FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2)", [A, d11]);
    const wallEAntes = chamadas.wallE;
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.deepEqual(await mensagens(d11), ["ENTRADA:PROCESSADA"]); assert.equal(enviadosPara(d11), 0, "D5: nada enviado");
    assert.deepEqual(await motivos(d11), ["SEM_RESPOSTA_AUTOMATICA"]); assert.equal(chamadas.wallE, wallEAntes, "D5: Wall-e não chamado");
    assert.equal(chamadas.modelo, 0, "modelo nunca chamado");
  } finally {
    await c.end();
  }
});
