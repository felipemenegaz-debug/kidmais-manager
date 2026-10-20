import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { PortaWallE } from "./worker.ts";
import { MENSAGEM_ENCAMINHAMENTO } from "./core.ts";

/**
 * Proteções finais do atendimento, worker e recepção REAIS no PostgreSQL descartável (modelo "atual"; a 060 primeiro e
 * depois 080/081/082), só pelo check:v1:postgres, com opt-in. Dados sintéticos; modelo e Wall-e por portas que contam as
 * chamadas; transporte simulado (nenhuma rede). Um ORÇAMENTO VÁLIDO fica no ambiente durante o modo regras.
 *
 *  R1 sem a 082 (fase B), modo regras: o modelo não é chamado; só o texto fixo de encaminhamento sai;
 *     o mesmo cenário fora do modo regras chama o modelo (controle: a guarda é o que impede);
 *  R2 com a 082 e o Wall-e DESLIGADO na tela (fase B), modo regras: o modelo não é chamado;
 *  G1 desligar a IA global, receber, religar em menos de 15 min e SÓ ENTÃO processar (nenhum ciclo no meio): a entrada
 *     nasceu com a equipe (SEM_RESPOSTA_AUTOMATICA) e nada é respondido; mensagem nova na mesma conversa fica com a equipe;
 *  G2 pausa durante o desligamento: marca persistente; "Devolver ao Wall-e" recusado;
 *  G3 PARAR durante o desligamento: bloqueio definitivo; nada sai;
 *  G4 saída automática que estava na fila antes do desligamento não sai depois de religar (nova entrada durante o
 *     desligamento muda a versão); a RESPOSTA MANUAL do atendente, criada durante o desligamento, sai depois de religar;
 *  G5 contato novo depois de religar é atendido normalmente.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIG = (up: string, post: string) => [ler(up), ler(post)] as const;
const M060 = MIG("database/migrations/20261001_060_whatsapp_atendimento.sql", "database/checks/20261001_060_postcheck.sql");
const M07X = [
  MIG("database/migrations/20261011_080_whatsapp_mensagens_prontas.sql", "database/checks/20261011_080_postcheck.sql"),
  MIG("database/migrations/20261011_081_whatsapp_prontas_midia.sql", "database/checks/20261011_081_postcheck.sql"),
  MIG("database/migrations/20261011_082_wall_e_atendimento.sql", "database/checks/20261011_082_postcheck.sql"),
];
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const ORCAMENTO_VALIDO = JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 }, porCapacidade: { whatsapp_atendimento: { tokensDiario: 100_000 } } });
const PAUSA = "por enquanto não precisa me mandar mais nada, depois eu chamo vcs";
const PARAR = "não quero receber mais nada de vocês";

test("proteções finais: modo regras em todos os caminhos e entrada recebida com a IA desligada nunca respondida depois", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const ambienteAntes = { modo: process.env.WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO, orcamento: process.env.AI_BUDGET_JSON, autorizacao: process.env.WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO, contatos: process.env.WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS };
  const modoRegras = (ligado: boolean) => {
    if (ligado) { process.env.WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO = "regras"; process.env.AI_BUDGET_JSON = ORCAMENTO_VALIDO; }
    // B5 (revisão de 69dc301): fora do modo regras, o modelo SIMULADO precisa das duas chaves (como na produção).
    else { Object.assign(process.env, { WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: "modelo", WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: "R6-teste-sintetico", WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS: "5561900000000" }); delete process.env.AI_BUDGET_JSON; }
  };
  try {
    await q(M060[0]); await q(M060[1]);
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet sintético (proteções)', 'PROVISIONAMENTO') RETURNING id`, [cod("pf")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness proteções', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO" } as never;
    const { servico, worker } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Buffet sintético", perguntas: [] });

    const chamadas = { modelo: 0, wallE: 0 };
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    const porta: PortaWallE = { async responder() { chamadas.wallE++; return { saidas: [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }], contexto: {} as never, passagem: null }; } };
    // Uma composition root "errada" que passa a porta de modelo mesmo em modo regras: a guarda do Core precisa barrar.
    const deps = { interpretar: async () => { chamadas.modelo++; return { intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }; },
      enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); }, wallE: porta };
    const receber = (contato: string, texto: string, automacaoGlobal?: boolean) =>
      servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now(), nomePerfil: null }, automacaoGlobal === undefined ? {} : { automacaoGlobal });
    const conversa = async (contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const mensagens = async (contato: string) => (await q(`SELECT m.direcao, m.estado, m.autor_usuario_id IS NOT NULL AS humana FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas cv ON cv.id = m.conversa_id
      WHERE cv.empresa_id = $1 AND cv.contato = $2 ORDER BY m.criada_em, m.id`, [A, contato])).rows.map((x) => `${x.direcao}:${x.estado}${x.humana ? ":humana" : ""}`);
    const textosPara = (contato: string) => envios.filter((x) => x.contato === contato).map((x) => (x.conteudo.tipo === "TEXTO" ? x.conteudo.texto : x.conteudo.tipo));

    // R1 — sem a 082 (fase B), modo regras com orçamento válido.
    const r1 = "5561900002001";
    modoRegras(true);
    await receber(r1, "quanto custa a festa?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(chamadas.modelo, 0, "R1: modelo não chamado em modo regras (sem a 082)");
    assert.deepEqual(textosPara(r1), [MENSAGEM_ENCAMINHAMENTO], "R1: só o texto fixo de encaminhamento");
    assert.equal((await conversa(r1)).estado, "AGUARDANDO_HUMANO");
    modoRegras(false);
    const r1b = "5561900002002";
    await receber(r1b, "quanto custa a festa?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(chamadas.modelo, 1, "R1 controle: fora do modo regras a fase B chama o modelo (a guarda é o que impede)");

    // A 082 entra; Wall-e desligado na tela.
    for (const [up, post] of M07X) { await q(up); await q(post); }
    // R2 — com a 082 e o Wall-e desligado: ainda fase B; modo regras impede o modelo.
    modoRegras(true);
    const r2 = "5561900002003";
    await receber(r2, "tem vaga em dezembro?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(chamadas.modelo, 1, "R2: modelo não chamado (082 aplicada, Wall-e desligado)"); assert.equal(chamadas.wallE, 0);
    assert.deepEqual(textosPara(r2), [MENSAGEM_ENCAMINHAMENTO]);
    modoRegras(false);

    // Wall-e ligado para os cenários de desligamento.
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Buffet sintético", perguntas: [], wallE: { ativo: true } });
    // G4 (preparação, IA ligada): saída automática na fila; conversa com atendente e resposta manual.
    const g4 = "5561900002014", g4h = "5561900002015";
    await receber(g4, "qual o endereço?");
    await worker.processarLote(deps, { maxTarefas: 1 }); // só interpreta: a saída automática fica na fila
    assert.deepEqual(await mensagens(g4), ["ENTRADA:PROCESSADA", "SAIDA:PENDENTE"]);
    await receber(g4h, "oi, quero falar com alguém");
    let cvh = await conversa(g4h);
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cvh.id, versao: Number(cvh.versao) });
    const wallEAntes = chamadas.wallE, modeloAntes = chamadas.modelo, enviosAntes = envios.length;

    // ===== IA global DESLIGADA: recepção informada pela composition root; NENHUM ciclo do worker até religar. =====
    const g1 = "5561900002011", g2 = "5561900002012", g3 = "5561900002013";
    await receber(g1, "quanto custa a festa pra 50?", false);
    assert.deepEqual(await mensagens(g1), ["ENTRADA:PROCESSADA"], "G1: a entrada nasce fora da fila automática");
    const cv1 = await conversa(g1);
    assert.equal(cv1.estado, "AGUARDANDO_HUMANO"); assert.deepEqual(cv1.passagem?.motivos, ["SEM_RESPOSTA_AUTOMATICA"]);
    await receber(g2, PAUSA, false);
    const cv2 = await conversa(g2);
    assert.equal(cv2.contexto?.semAutomatico?.origem, "RECEPCAO"); assert.deepEqual(cv2.passagem?.motivos, ["PARAR_A_CONFIRMAR", "SEM_RESPOSTA_AUTOMATICA"]);
    await assert.rejects(servico.controlarAtendimento(sessao, { acao: "retomar", conversaId: cv2.id, versao: Number(cv2.versao) }), /ATENDIMENTO_PAUSA_PEDIDA/, "G2: Devolver ao Wall-e recusado");
    await receber(g3, PARAR, false);
    const cv3 = await conversa(g3);
    assert.equal(cv3.nao_contatar, true); assert.equal(cv3.estado, "ENCERRADA");
    await receber(g4, "e o horário?", false); // nova entrada durante o desligamento na conversa com saída automática na fila
    cvh = await conversa(g4h);
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cvh.id, versao: Number(cvh.versao), texto: "Olá! Resposta manual sintética." });
    assert.equal(envios.length, enviosAntes, "nada enviado durante o desligamento (nenhum ciclo)");

    // ===== RELIGAR (menos de 15 min depois) e só então processar. =====
    await worker.processarLote(deps, { maxTarefas: 20 });
    for (const ct of [g1, g2, g3]) assert.deepEqual(textosPara(ct), [], `G1–G3: nada respondido para ${ct} depois de religar`);
    assert.deepEqual(textosPara(g4), [], "G4: a saída automática antiga não sai depois de religar");
    assert.ok((await mensagens(g4)).includes("SAIDA:CANCELADA"), "G4: cancelada");
    assert.deepEqual(textosPara(g4h), ["Olá! Resposta manual sintética."], "G4: resposta manual preservada e enviada");
    assert.equal(chamadas.wallE, wallEAntes, "Wall-e não chamado para nada recebido no desligamento"); assert.equal(chamadas.modelo, modeloAntes);
    await receber(g1, "e então?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.deepEqual(textosPara(g1), [], "G1: mensagem nova depois de religar segue com a equipe");
    // G5 — contato novo depois de religar.
    const g5 = "5561900002016";
    await receber(g5, "quanto custa?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.deepEqual(textosPara(g5), ["Resposta sintética do Wall-e"], "G5: contato novo atendido normalmente");
    assert.equal(chamadas.modelo, 1, "modelo chamado só no controle do R1");
  } finally {
    if (ambienteAntes.modo === undefined) delete process.env.WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO; else process.env.WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO = ambienteAntes.modo;
    if (ambienteAntes.orcamento === undefined) delete process.env.AI_BUDGET_JSON; else process.env.AI_BUDGET_JSON = ambienteAntes.orcamento;
    if (ambienteAntes.autorizacao === undefined) delete process.env.WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO; else process.env.WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO = ambienteAntes.autorizacao;
    if (ambienteAntes.contatos === undefined) delete process.env.WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS; else process.env.WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS = ambienteAntes.contatos;
    await c.end();
  }
});
