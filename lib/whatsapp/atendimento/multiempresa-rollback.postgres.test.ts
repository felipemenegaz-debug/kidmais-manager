import test from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import * as arquivos from "./arquivos.ts";
import { MENSAGEM_ENCAMINHAMENTO, type Interpretacao } from "./core.ts";
import { adiado, noPrazo } from "./harness-postgres.ts";
import { barreira, carregarMultiempresa, cod, comGancho, db, fixturesMultiempresa, flags, semGanchos, SENHA } from "./harness-multiempresa.ts";
import * as rollback from "./rollback-multiempresa.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { AlvoEnvio, DependenciasWorker } from "./worker.ts";

/**
 * E-ME1 r2 — isolamento entre empresas e rollback MULTI → PILOTO (§6, §8 casos 9, 10, 11–11e) no PostgreSQL DESCARTÁVEL
 * (modelo 112; a 117 é aplicada pela suíte). A = piloto, B = não piloto (isenta, conectada, ligada, Wall-e ligado).
 *
 *  10   Wall-e REAL (porta.ts + fontes PostgreSQL) com bibliotecas distintas: a resposta de B só traz o material de B (texto,
 *       PDF e fontes registradas), nada de A; B sem link de disponibilidade (a página pública é da A — I-8);
 *  9a   PARAR e pausa do MESMO número em A não afetam a conversa desse número em B;
 *  11   rollback com B em PENDENTE, PROCESSANDO (worker vivo preso no modelo e worker morto), ENVIANDO (11b), INCERTO e uma
 *       saída presa antes do marco (11d); prévia → (11c: outra saída de B vira ENVIANDO depois da prévia) → chave removida →
 *       corte T no relógio do banco → workers liberados → recuperação com relógio controlado (−12 min) → lista oficial em voo
 *       (rollback-multiempresa.ts) e critérios de §6.10; 0 reenvios;
 *  11b  saída de B ENVIANDO antes de T, transporte liberado depois de T: 1 chamada, SUBMETIDA, na lista (prévia e reconstrução);
 *  11c  ENVIANDO depois da prévia e antes de T: fora da prévia, DENTRO da lista reconstruída;
 *  11d  worker vivo com saída PROCESSANDO de B chega ao marco depois de T: CANCELADA com iniciada_em > T, aceita pelo critério;
 *  11e  worker morto: saída de B ENVIANDO há 12 min na prévia → INCERTO pela recuperação; na lista pela parte (i), fora de (ii);
 *       os critérios também MORDEM (mensagem não piloto com iniciada_em > T, PROCESSANDO presa);
 *  F9   depois do rollback, o processador (com e sem automação global) não toca a PENDENTE de B;
 *  F3   depois do rollback, a sessão de B lê o próprio histórico e NÃO envia nem configura;
 *  9    depois do rollback: B exclui conversa a pedido, configura retenção, a rotina de retenção apaga a conversa velha de B,
 *       o arquivo público de B é servido e, revogado, deixa de ser.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261104_117_atendimento_multiempresa.sql");
const POS = ler("database/checks/20261104_117_postcheck.sql");
const SEGREDO = Buffer.alloc(32, 7).toString("base64");
Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: SEGREDO, WHATSAPP_CREDENTIAL_KEY_VERSION: "1", META_GRAPH_API_VERSION: "v23.0" });
const CHAVE = "WHATSAPP_ATENDIMENTO_MULTIEMPRESA";
const chave = (v: string | undefined) => { if (v === undefined) delete process.env[CHAVE]; else process.env[CHAVE] = v; };
const PAUSA = "por enquanto não precisa me mandar mais nada, depois eu chamo vcs";
const PARAR = "não quero receber mais nada de vocês";
const PDF = (rotulo: string) => Buffer.from(`%PDF-1.4\n% tabela sintética ${rotulo}\n%%EOF\n`);
const EMPRESA_SQL = "SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE";
const PLANO: Interpretacao = { intencao: "INTERESSE", perguntaId: null, data: null, convidados: null } as Interpretacao;
const publico = carregarComponente("lib/whatsapp/atendimento/arquivos-publico.ts", {
  "node:crypto": nodeCrypto, "../../db/postgres.ts": { db }, "./configuracao.ts": { ambienteAtendimento: () => "staging" }, "./arquivos.ts": arquivos,
}).modulo as typeof import("./arquivos-publico.ts");

test("E-ME1 r2: isolamento (9, 10) e rollback MULTI → PILOTO (11–11e, F3, F9)", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const ex = { query: (s: string, v?: readonly unknown[]) => c.query(s, v ? [...v] : []) } as never;
  const linkAntes = { id: process.env.AGENDA_PUBLICA_EMPRESA_ID, origem: process.env.AGENDA_PUBLICA_ORIGEM };
  try {
    await q(UP); await q(POS);
    chave("true");
    const criarUsuario = async (papel: string) => (await q(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness rollback', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel])).rows[0].id as string;
    const f = fixturesMultiempresa(q, criarUsuario);
    const A = await f.empresa("A piloto"), B = await f.empresa("B");
    flags.piloto = A; flags.kproc = true; flags.regras = true;
    const sA = await f.sessao(A), sB = await f.sessao(B);
    const autor = sA.usuario_id;
    for (const e of [A, B]) await f.conectar(e, autor);
    await f.isentar(B, autor);
    const { servico, worker, meta, biblioteca, privacidade, portaWallE } = carregarMultiempresa();
    for (const s of [sA, sB]) await servico.salvarConfiguracao(s as never, { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 50 }, wallE: { ativo: true } });
    Object.assign(process.env, { AGENDA_PUBLICA_EMPRESA_ID: A, AGENDA_PUBLICA_ORIGEM: "https://agenda.kidmais.example/" });

    const conta = async (sql: string, v: unknown[] = []) => Number((await q(sql, v)).rows[0].n);
    const estadoDe = async (id: string) => (await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id=$1", [id])).rows[0].estado as string;
    const conversaDe = async (e: string, ct: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND contato=$2", [e, ct])).rows[0];
    let seq = 10;
    const contato = () => `556192${String(seq++).padStart(7, "0")}`;
    const entrada = (e: string, ct: string, texto: string) => ({ phoneNumberId: f.numero(e), wabaId: f.waba(e), id: cod("wamid.in."), contato: ct, texto, timestamp: Date.now(), nomePerfil: "Cliente Sintético" });
    const receber = (...l: ReturnType<typeof entrada>[]) => meta.receberEventosMeta({ entradas: l, status: [] }, { automacaoGlobal: true });
    const semPendentes = () => q("UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE estado IN ('PENDENTE','PROCESSANDO')");

    // Transporte espião com portões por SAÍDA (o envio fica preso dentro de `enviar`, já ENVIANDO).
    const envios: { alvo: AlvoEnvio; conteudo: ConteudoSaida }[] = [];
    const portoes = new Map<string, { chegou: ReturnType<typeof adiado<void>>; solta: ReturnType<typeof adiado<void>> }>();
    const prender = (saidaId: string) => { const p = { chegou: adiado<void>(), solta: adiado<void>() }; portoes.set(saidaId, p); return { chegou: p.chegou.p, liberar: () => p.solta.liberar() }; };
    let modelo: null | (() => Promise<Interpretacao>) = null;
    const deps: DependenciasWorker = {
      interpretar: async () => (modelo ? modelo() : PLANO),
      enviar: async (_c, conteudo, alvo) => {
        envios.push({ alvo, conteudo });
        const p = portoes.get(alvo.saidaId);
        if (p) { portoes.delete(alvo.saidaId); p.chegou.liberar(); await p.solta.p; }
        return cod("wamid.");
      },
      wallE: portaWallE.criarPortaWallE(null),
    };
    const enviosDe = (id: string) => envios.filter((x) => x.alvo.saidaId === id).length;

    // ——— 10: Wall-e com bibliotecas distintas ———
    const base = { categoria: "Comercial", link: null, atalho: null };
    const arqA = await biblioteca.salvarArquivo(sA as never, { nome: "tabela-A.pdf", bytes: PDF("A"), tipoEsperado: "DOCUMENTO" });
    const prontaA = (await biblioteca.salvarPronta(sA as never, { ...base, titulo: "Tabela de A", tipo: "DOCUMENTO", texto: "Tabela de preços da empresa A", arquivoId: arqA.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" } as never)).id;
    const arqB = await biblioteca.salvarArquivo(sB as never, { nome: "tabela-B.pdf", bytes: PDF("B"), tipoEsperado: "DOCUMENTO" });
    const prontaB = (await biblioteca.salvarPronta(sB as never, { ...base, titulo: "Tabela de B", tipo: "DOCUMENTO", texto: "Tabela de preços da empresa B", arquivoId: arqB.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" } as never)).id;
    const comum = contato();
    await receber(entrada(A, comum, "Quanto custa?"), entrada(B, comum, "Quanto custa?"));
    await worker.processarLote(deps, { maxTarefas: 10 });
    const deB = envios.filter((x) => x.alvo.empresaId === B), deA = envios.filter((x) => x.alvo.empresaId === A);
    assert.ok(deB.length >= 1 && deA.length >= 1, `10: as duas responderam (A ${deA.length}, B ${deB.length})`);
    const textoB = JSON.stringify(deB.map((x) => x.conteudo));
    assert.doesNotMatch(textoB, /empresa A|tabela-A|Tabela de A/, "10: nada da biblioteca de A na resposta de B");
    assert.doesNotMatch(textoB, /disponibilidade/, "10: B sem link de disponibilidade (I-8)");
    assert.ok(deB.some((x) => x.conteudo.tipo === "DOCUMENTO" && x.conteudo.nome === "tabela-B.pdf"), "10: B envia o PRÓPRIO material");
    assert.ok(deA.some((x) => x.conteudo.tipo === "DOCUMENTO" && x.conteudo.nome === "tabela-A.pdf"), "10: A envia o próprio material");
    const fontesB = (await q("SELECT fonte FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND direcao='SAIDA' AND fonte IS NOT NULL", [B])).rows.flatMap((l) => (l.fonte?.fontes ?? []) as { tipo: string; id?: string }[]);
    assert.ok(fontesB.some((x) => x.tipo === "PRONTA" && x.id === prontaB) && !fontesB.some((x) => x.id === prontaA), "10: fontes registradas de B só de B");

    // ——— 9a: PARAR e pausa do mesmo número em A não afetam B ———
    {
      const ctPausa = contato();
      await receber(entrada(A, comum, PARAR), entrada(A, ctPausa, PAUSA), entrada(B, ctPausa, "Oi, quero orçamento"));
      await worker.processarLote(deps, { maxTarefas: 10 });
      const [aParar, bParar, aPausa, bPausa] = [await conversaDe(A, comum), await conversaDe(B, comum), await conversaDe(A, ctPausa), await conversaDe(B, ctPausa)];
      assert.equal(aParar.nao_contatar, true, "9a: A bloqueou o número");
      assert.equal(bParar.nao_contatar, false, "9a: o mesmo número em B segue livre");
      assert.ok(aPausa.contexto?.semAutomatico, "9a: pausa marcada em A");
      assert.equal(bPausa.contexto?.semAutomatico ?? null, null, "9a: sem marca de pausa em B");
      assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_controles_contato WHERE empresa_id=$1", [B]), 0, "9a: nenhum controle de contato criado para B");
    }
    await semPendentes();

    // ——— 11: rollback ——— (Wall-e de B desligado: a entrada viva passa pela fase B, presa no modelo)
    await q("UPDATE whatsapp_atendimento_config SET configuracao = jsonb_set(configuracao, '{wallE,ativo}', 'false'::jsonb) WHERE empresa_id=$1", [B]);
    flags.regras = false;
    const T0 = { ambiente: "staging", piloto: A };
    const saidaPronta = async (e: string, extra: { estado?: string; haMin?: number } = {}) => {
      const conv = (await q("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em) VALUES ($1, 'staging', $2, 'AGUARDANDO_HUMANO', clock_timestamp()) RETURNING id", [e, contato()])).rows[0].id as string;
      return (await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, iniciada_em)
        VALUES ($1, $2, 'staging', 'SAIDA', $3, $4, 0, CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp() - make_interval(mins => $5::int) END) RETURNING id`, [conv, e, MENSAGEM_ENCAMINHAMENTO, extra.estado ?? "PENDENTE", extra.haMin ?? null])).rows[0].id as string;
    };
    // PROCESSANDO com worker VIVO: entrada de B presa dentro do modelo.
    const ctViva = contato();
    await receber(entrada(B, ctViva, "Oi, quero orçamento"));
    const eViva = (await q("SELECT m.id FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas c ON c.id=m.conversa_id WHERE c.empresa_id=$1 AND c.contato=$2 AND m.direcao='ENTRADA'", [B, ctViva])).rows[0].id as string;
    const dentro = adiado<void>(), solta = adiado<void>();
    modelo = async () => { dentro.liberar(); await solta.p; return PLANO; };
    const wViva = worker.processarLote(deps, { maxTarefas: 1 });
    await noPrazo(dentro.p, 15_000, "11: worker vivo dentro do modelo");
    // 11b: ENVIANDO antes de T, transporte preso.
    const s11b = await saidaPronta(B); const p11b = prender(s11b);
    const w11b = worker.processarLote(deps, { maxTarefas: 1 });
    await noPrazo(p11b.chegou, 15_000, "11b: transporte preso");
    // 11d: saída de B reservada e presa antes do marco ENVIANDO.
    const s11d = await saidaPronta(B);
    let reservada11d = false;
    const pararArme = comGancho((sql, _o, v) => { if (sql.startsWith("UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1") && !sql.includes("AND estado") && v[0] === s11d) reservada11d = true; });
    const b11d = barreira((sql, o) => reservada11d && o === "tx" && sql === EMPRESA_SQL);
    const w11d = worker.processarLote(deps, { maxTarefas: 1 });
    await noPrazo(b11d.chegou, 15_000, "11d: preso antes do marco");
    // Worker MORTO: entrada PROCESSANDO; 11e: saída ENVIANDO há 12 min; INCERTO.
    const ctMorta = contato();
    const convMorta = (await q("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em) VALUES ($1, 'staging', $2, 'IA', clock_timestamp()) RETURNING id", [B, ctMorta])).rows[0].id as string;
    const eMorta = (await q("INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, externa_id, iniciada_em) VALUES ($1,$2,'staging','ENTRADA','oi','PROCESSANDO',0,$3,clock_timestamp()) RETURNING id", [convMorta, B, cod("ext.")])).rows[0].id as string;
    const s11e = await saidaPronta(B, { estado: "ENVIANDO", haMin: 12 });
    const sIncerto = await saidaPronta(B, { estado: "INCERTO", haMin: 2 });

    // 1. Prévia.
    const previa = await rollback.capturarPrevia(ex, T0);
    assert.ok(previa.enviando.includes(s11b) && previa.enviando.includes(s11e), "11: prévia com os ENVIANDO de B (qualquer idade)");
    assert.ok(previa.contagens.some((x) => x.empresa_id === B && x.estado === "PROCESSANDO" && x.n >= 3), "11: prévia conta PROCESSANDO de B (vivo, morto, 11d)");
    // 11c: depois da prévia e antes de T, outra saída de B vira ENVIANDO (sobreposição simulada).
    const s11c = await saidaPronta(B); const p11c = prender(s11c);
    const w11c = worker.processarLote(deps, { maxTarefas: 1 });
    await noPrazo(p11c.chegou, 15_000, "11c: transporte preso");
    assert.ok(!previa.enviando.includes(s11c), "11c: fora da prévia");
    // PENDENTE de B (recepção ainda no MULTI).
    const ctPend = contato();
    await receber(entrada(B, ctPend, "Oi, quero orçamento"));
    const ePend = (await q("SELECT m.id FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas c ON c.id=m.conversa_id WHERE c.empresa_id=$1 AND c.contato=$2", [B, ctPend])).rows[0].id as string;
    assert.equal(await estadoDe(ePend), "PENDENTE");

    // 2. Desligar: chave removida (web e worker deste processo) e corte T no relógio do banco.
    chave(undefined);
    const T = await rollback.corteT(ex);
    // Workers liberados DEPOIS de T.
    p11b.liberar(); p11c.liberar(); b11d.liberar(); solta.liberar();
    await noPrazo(Promise.all([wViva, w11b, w11c, w11d]), 20_000, "11: workers terminam depois de T");
    pararArme(); b11d.remover(); modelo = null;
    assert.deepEqual([enviosDe(s11b), await estadoDe(s11b)], [1, "SUBMETIDA"], "11b: transporte uma vez, resultado registrado");
    assert.deepEqual([enviosDe(s11c), await estadoDe(s11c)], [1, "SUBMETIDA"], "11c: transporte uma vez, resultado registrado");
    assert.deepEqual([enviosDe(s11d), await estadoDe(s11d)], [0, "CANCELADA"], "11d: barrado no marco, nada enviado");
    assert.ok((await q("SELECT iniciada_em > $2::timestamptz AS depois FROM whatsapp_atendimento_mensagens WHERE id=$1", [s11d, T])).rows[0].depois, "11d: CANCELADA com iniciada_em > T");
    assert.equal(await estadoDe(eViva), "CANCELADA", "11 passo 6: worker vivo barrado ao persistir, sem resposta");
    assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas c ON c.id=m.conversa_id WHERE c.contato=$1 AND m.direcao='SAIDA'", [ctViva]), 0, "11 passo 6: nenhuma saída criada");

    // F9 + passo 5: processador depois do rollback, com e sem automação global: a PENDENTE de B fica preservada.
    const n0 = envios.length;
    await worker.processarLote(deps, { maxTarefas: 5 });
    await worker.processarLote(deps, { maxTarefas: 5, semAutomacao: true });
    assert.equal(await estadoDe(ePend), "PENDENTE", "F9/§6.5: PENDENTE de B preservada (processador com e sem automação)");
    assert.equal((await conversaDe(B, ctPend)).estado, "IA", "F9: conversa de B intacta");

    // Passo 7 + 11e: relógio controlado (−12 min) e recuperação.
    await q("UPDATE whatsapp_atendimento_mensagens SET iniciada_em = iniciada_em - interval '12 minutes' WHERE id = $1", [eMorta]);
    await servico.recuperarTrabalhosInterrompidos();
    assert.deepEqual([await estadoDe(eMorta), await estadoDe(s11e), (await q("SELECT estado FROM whatsapp_atendimento_conversas WHERE id=$1", [convMorta])).rows[0].estado], ["FALHOU", "INCERTO", "AGUARDANDO_HUMANO"], "11: worker morto → FALHOU/INCERTO e equipe");
    await worker.processarLote(deps, { maxTarefas: 5 });
    assert.deepEqual([enviosDe(s11e), enviosDe(sIncerto), envios.length - n0], [0, 0, 0], "11: 0 reenvios (INCERTO nunca reenviado; nada de B depois de T)");

    // Lista oficial e critérios (§6.10).
    const lista = await rollback.listaEmVoo(ex, { ...T0, previa, T });
    const item = (id: string) => lista.find((x) => x.id === id);
    assert.deepEqual([item(s11b)?.origem, item(s11b)?.estado], ["AMBAS", "SUBMETIDA"], "11b: na lista (prévia e reconstrução)");
    assert.deepEqual([item(s11c)?.origem, item(s11c)?.estado], ["RECONSTRUCAO", "SUBMETIDA"], "11c: fora da prévia, dentro da reconstrução");
    assert.deepEqual([item(s11e)?.origem, item(s11e)?.estado], ["PREVIA", "INCERTO"], "11e: pela parte (i), INCERTO, fora da janela (ii)");
    assert.equal(item(sIncerto)?.estado, "INCERTO");
    assert.equal(item(s11d), undefined, "11d: CANCELADA não é envio em voo");
    assert.ok(lista.every((x) => x.empresa_id !== A), "lista só de empresas não piloto");
    const criterios = await rollback.criteriosRollback(ex, { ...T0, T, emVoo: lista });
    assert.deepEqual(criterios, { ok: true, presasMaisDe10Min: [], depoisDeT: [], emVooNaoTerminadas: [] }, "§6.10: critérios atendidos (11d aceita pela exceção CANCELADA)");
    // Os critérios mordem.
    const intrusa = await saidaPronta(B, { estado: "SUBMETIDA" });
    await q("UPDATE whatsapp_atendimento_mensagens SET iniciada_em = clock_timestamp() WHERE id=$1", [intrusa]);
    const presa = await saidaPronta(B, { estado: "PROCESSANDO", haMin: 11 });
    const ruins = await rollback.criteriosRollback(ex, { ...T0, T, emVoo: [...lista, { id: presa, empresa_id: B, estado: "PROCESSANDO", iniciada_em: null, origem: "RECONSTRUCAO", naoEnviadaOuRecusada: false }] });
    assert.deepEqual([ruins.ok, ruins.depoisDeT, ruins.presasMaisDe10Min, ruins.emVooNaoTerminadas], [false, [intrusa], [presa], [presa]], "§6.10: violações detectadas");
    await q("DELETE FROM whatsapp_atendimento_mensagens WHERE id = ANY($1::uuid[])", [[intrusa, presa]]);

    // ——— F3: B depois do rollback ———
    const telaB = await servico.listarAtendimento(sB as never);
    assert.ok(telaB.conversas.some((x) => x.contato === ctPend) && telaB.conversas.every((x) => x.empresa_id === B), "F3: B lê o próprio histórico");
    assert.equal(telaB.automacaoDisponivel, false, "F3: sem automação para B");
    const cvPend = await conversaDe(B, ctPend);
    await servico.controlarAtendimento(sB as never, { acao: "assumir", conversaId: cvPend.id, versao: Number(cvPend.versao) });
    const cvPend2 = await conversaDe(B, ctPend);
    await assert.rejects(servico.controlarAtendimento(sB as never, { acao: "enviar", conversaId: cvPend.id, versao: Number(cvPend2.versao), texto: "Resposta humana" }), /ATENDIMENTO_RECURSO_NAO_INCLUIDO|ATENDIMENTO_AUTOMACAO_DESLIGADA/, "F3: B não envia");
    await assert.rejects(servico.salvarConfiguracao(sB as never, { ativo: false, nome: "Buffet sintético", perguntas: [] }), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "F3: B não configura");
    await assert.rejects(biblioteca.salvarPronta(sB as never, { ...base, titulo: "Nova de B", tipo: "TEXTO", texto: "x", estado: "RASCUNHO", envioAutomatico: false, finalidade: "PRECOS" } as never), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "F3: B não escreve na biblioteca");

    // ——— 9: privacidade, retenção e arquivo público de B depois do rollback ———
    {
      const cvExcluir = await conversaDe(B, ctViva);
      assert.equal((await privacidade.excluirConversaAPedido(sB as never, { conversaId: cvExcluir.id, motivo: "PEDIDO_DO_TITULAR" })).estado, "EXCLUIDA", "9: B exclui a pedido");
      await privacidade.configurarRetencao(sB as never, { prazoDias: 30 });
      const ctVelha = contato();
      const velha = (await q("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em, atualizada_em) VALUES ($1,'staging',$2,'AGUARDANDO_HUMANO', clock_timestamp() - interval '40 days', clock_timestamp() - interval '40 days') RETURNING id", [B, ctVelha])).rows[0].id as string;
      await q("INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, externa_id, criada_em) VALUES ($1,$2,'staging','ENTRADA','antiga','PROCESSADA',0,$3, clock_timestamp() - interval '40 days')", [velha, B, cod("ext.")]);
      const r = await privacidade.executarRetencao();
      assert.ok(r.estado === "CONCLUIDA" || r.estado === "CONCLUIDA_COM_FALHAS", `9: retenção executada (${r.estado})`);
      assert.equal(await conversaDe(B, ctVelha), undefined, "9: retenção apaga a conversa velha de B depois do rollback");
      const token = (await q("SELECT token FROM whatsapp_atendimento_arquivos WHERE id=$1", [arqB.id])).rows[0].token as string;
      assert.ok(await publico.lerArquivoPublico(arqB.id, token), "9: arquivo público de B servido depois do rollback");
      await privacidade.revogarArquivo(sB as never, { arquivoId: arqB.id });
      assert.equal(await publico.lerArquivoPublico(arqB.id, token), null, "9: B revoga o próprio arquivo depois do rollback");
      assert.ok(await conversaDe(A, comum), "9: nada de A tocado");
    }
  } finally {
    semGanchos();
    chave(undefined);
    if (linkAntes.id === undefined) delete process.env.AGENDA_PUBLICA_EMPRESA_ID; else process.env.AGENDA_PUBLICA_EMPRESA_ID = linkAntes.id;
    if (linkAntes.origem === undefined) delete process.env.AGENDA_PUBLICA_ORIGEM; else process.env.AGENDA_PUBLICA_ORIGEM = linkAntes.origem;
    await c.end();
  }
});
