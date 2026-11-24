import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod, withTransaction } from "./harness-postgres.ts";
import * as multiempresa from "./multiempresa.ts";
import type { PortaWallE } from "./worker.ts";
import * as tetoReal from "./teto-mensal.ts";
import { consumoDoMes, reservarConsumo, tetoDoMes } from "./teto-mensal.ts";

/**
 * 3b r5 (D-LAN-3, 23/11/2026): teto mensal do Wall-e pela Cloud API com a 135 (consumo reservado na mesma transação das
 * saídas). A piloto fica fora do teto em qualquer canal (recorte de 23/11). O harness roda em modo piloto (só a piloto é
 * processada), então T0–T6 e T9–T12 usam um módulo do teto em que a piloto, PARA O TETO, é B: A conta como uma empresa
 * comum, com a reserva real. T7 usa o módulo real (A = piloto) e prova que ela fica fora mesmo com o canal Meta. Worker, recepção, serviço da equipe e exclusão de conversa REAIS no PostgreSQL descartável (modelo "atual" +
 * 060/080/081/082, depois pre/135/post e o down), só pelo check:v1:postgres, com opt-in. Dados sintéticos; transporte
 * simulado (nenhuma rede). Teto
 * padrão 1.000 (o consumo é posto em 999 etc. direto na linha agregada, para não gerar 1.000 mensagens).
 *
 *  T0 sem a 135: sem teto, nada gravado; a 135 aplica com pre/post e a carga inicial conta só as saídas válidas do mês;
 *     pausa (Astra r3, P1): uma gravação aberta durante a 135 faz a migration esperar (LOCK) e entra na carga;
 *     portão de deploy (Astra r4, P1): sem `SET kidmais.portao_135` a 135 recusa sem efeito; postcheck recusa CHECK
 *     enfraquecida (regex do mês sem o grupo; usadas >= 1) (Astra r4, P3);
 *  T1 isolamento: 3 respostas para A ⇒ A=3; B=0; o outro ambiente de A=0;
 *  T2 grupo que não cabe: 999 + grupo de 2 saídas (texto + anexo) ⇒ nenhuma sai, LIMITE_MENSAL em silêncio, 999 intacto;
 *     grupo de 1 cabe ⇒ 1000; depois o atalho ATINGIDO nem chama o Wall-e;
 *  T3 exclusão da conversa (privacidade, a pedido) não devolve cota;
 *  T4 a equipe soma sem limite (1000 ⇒ 1001, acima da franquia);
 *  T5 duas reservas concorrentes com uma vaga: a trava da linha serializa, só uma passa; e dois lotes do worker em
 *     paralelo com uma vaga: só uma resposta sai;
 *  T6 falha transitória na leitura do teto (antes do modelo) e na reserva: a entrada volta a PENDENTE, nada sai, consumo
 *     intacto; o ciclo seguinte conclui;
 *  T7 piloto (módulo real), com WHATSAPP_ATENDIMENTO_CANAL_ENVIO=meta: sem teto e sem consumo, nem do Wall-e nem da equipe;
 *  T9 fallback sem vaga (Astra r2, P3): o Wall-e não devolve saídas e outra conversa ocupa a última vaga durante a chamada
 *     ⇒ a entrada termina PROCESSADA com LIMITE_MENSAL (não FALHOU), nada sai;
 *  T11 retry com a saída já gravada (Astra r3, P2): o INSERT não grava nada e a reserva é 0 (pelo RETURNING);
 *  T12 revogação no atalho ATINGIDO (Astra r3, P2): empresa revogada entre a leitura e a trava ⇒ entrada CANCELADA, sem
 *     passar à equipe;
 *  T8 down da 135: a tabela some e o Wall-e volta a responder sem teto.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIGRATIONS = [
  ["database/migrations/20261001_060_whatsapp_atendimento.sql", "database/checks/20261001_060_postcheck.sql"],
  ["database/migrations/20261011_080_whatsapp_mensagens_prontas.sql", "database/checks/20261011_080_postcheck.sql"],
  ["database/migrations/20261011_081_whatsapp_prontas_midia.sql", "database/checks/20261011_081_postcheck.sql"],
  ["database/migrations/20261011_082_wall_e_atendimento.sql", "database/checks/20261011_082_postcheck.sql"],
].map(([up, post]) => [ler(up), ler(post)]);
const PRE_135 = ler("database/checks/20261123_135_precheck.sql");
const UP_135 = ler("database/migrations/20261123_135_whatsapp_consumo_mensal.sql");
const POST_135 = ler("database/checks/20261123_135_postcheck.sql");
const DOWN_135 = ler("database/rollback/20261123_135_whatsapp_consumo_mensal_down.sql");
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const MES = "to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM')";
const GRUPO = "me manda o cardápio completo";
const SEM_SAIDAS = "pergunta que o Wall-e não sabe responder";

test("3b r5: teto mensal do Wall-e pela Meta com reserva atômica pelo gravado e pausa na 135, equipe sem limite, piloto fora em qualquer canal", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const envAntes = { teto: process.env.WHATSAPP_TETO_MENSAL_RESPOSTAS, canal: process.env.WHATSAPP_ATENDIMENTO_CANAL_ENVIO };
  delete process.env.WHATSAPP_TETO_MENSAL_RESPOSTAS;
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const extras: Awaited<ReturnType<typeof conectarDescartavel>>[] = [];
  try {
    for (const [up, post] of MIGRATIONS) { await q(up); await q(post); }
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const empresa = async (rotulo: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("tm"), `Buffet sintético ${rotulo} (teto mensal r2)`]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const A = await empresa("A"), B = await empresa("B");
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness teto', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO" } as never;
    // A conta no teto (para o teto, a piloto é B); o modo piloto do harness continua processando só A.
    const tetoA = { ...tetoReal, contaNoTeto: (e: string) => tetoReal.contaNoTeto(e, B) };
    const { servico, worker } = carregarAtendimento(A, "staging", {}, tetoA);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 10 }, wallE: { ativo: true } });

    const chamadas = { wallE: 0, faseB: 0 };
    const porta: PortaWallE = { async responder(e) {
      chamadas.wallE++;
      // T9: outra conversa ocupa a última vaga durante a chamada ao modelo, e o Wall-e não devolve saídas (fallback).
      if (e.texto === SEM_SAIDAS) { await fixar(1000); return { saidas: [], contexto: {} as never, passagem: null }; }
      const saidas = e.texto === GRUPO
        ? [{ texto: "Segue o cardápio (sintético)", anexo: null, fontes: [] }, { texto: "[anexo sintético: cardápio.pdf]", anexo: null, fontes: [] }]
        : [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }];
      return { saidas, contexto: {} as never, passagem: null };
    } };
    const envios: string[] = [];
    const deps = { interpretar: async () => { chamadas.faseB++; return { intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }; },
      enviar: async (contato: string) => { envios.push(contato); return cod("gs-"); }, wallE: porta };
    let seq = 6000;
    const novoContato = () => `55619000${String(seq++).padStart(5, "0")}`;
    const receber = (contato: string, texto = "quanto custa a festa?") => servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now(), nomePerfil: null });
    const processar = (w = worker) => w.processarLote(deps, { maxTarefas: 20 });
    const conversa = async (contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const saidasDe = async (contato: string) => Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas c ON c.id = m.conversa_id WHERE c.empresa_id = $1 AND c.contato = $2 AND m.direcao = 'SAIDA'", [A, contato])).rows[0].n);
    const entradaDe = async (contato: string) => (await q("SELECT m.estado FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas c ON c.id = m.conversa_id WHERE c.empresa_id = $1 AND c.contato = $2 AND m.direcao = 'ENTRADA' ORDER BY m.criada_em DESC LIMIT 1", [A, contato])).rows[0]?.estado as string;
    const usadas = async (e = A, amb = "staging") => (await consumoDoMes(c as never, e, amb))?.usadas ?? null;
    const fixar = (n: number, e = A) => q(`INSERT INTO whatsapp_atendimento_consumo_mensal (empresa_id, ambiente, mes, usadas) VALUES ($1, 'staging', ${MES}, $2)
      ON CONFLICT (empresa_id, ambiente, mes) DO UPDATE SET usadas = EXCLUDED.usadas`, [e, n]);
    // Conta só os envios para o contato (uma resposta da equipe ainda na fila pode sair no mesmo lote).
    const respondeu = async (contato: string, texto?: string) => { await receber(contato, texto); await processar(); return envios.filter((x) => x === contato).length; };

    // T0 — sem a 135: o Wall-e responde sem teto e nada é gravado; depois a 135 aplica com a carga inicial do mês.
    const c0 = novoContato();
    assert.equal(await respondeu(c0), 1, "T0: sem a 135 o Wall-e responde");
    assert.equal(await usadas(), null, "T0: sem a 135 não há consumo");
    const cv0 = await conversa(c0);
    await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, autor_usuario_id, versao_conversa, criada_em)
      VALUES ($1, $2, 'staging', 'SAIDA', 'sintética que falhou', 'FALHOU', $3, $4, clock_timestamp()),
             ($1, $2, 'staging', 'SAIDA', 'sintética cancelada', 'CANCELADA', $3, $4, clock_timestamp()),
             ($1, $2, 'staging', 'SAIDA', 'sintética do mês passado', 'ENTREGUE', $3, $4, clock_timestamp() - interval '40 days'),
             ($1, $2, 'staging', 'SAIDA', 'sintética da equipe', 'ENTREGUE', $3, $4, clock_timestamp())`, [cv0.id, A, u, cv0.versao]);
    // Pausa (Astra r3, P1): uma gravação de saída ABERTA quando a 135 começa faz a migration esperar (LOCK SHARE) e entra na carga.
    await q(PRE_135);
    const [g0, m0] = [await conectarDescartavel({ travar: false }), await conectarDescartavel({ travar: false })];
    extras.push(g0, m0);
    await g0.query("BEGIN");
    await g0.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, autor_usuario_id, versao_conversa, criada_em)
      VALUES ($1, $2, 'staging', 'SAIDA', 'sintética gravada durante a 135', 'ENTREGUE', $3, $4, clock_timestamp())`, [cv0.id, A, u, cv0.versao]);
    // Portão de deploy (Astra r4, P1): sem a declaração na sessão, a 135 recusa e nada muda.
    await assert.rejects(m0.query(UP_135), /portão de deploy não declarado/, "T0: sem o portão a 135 recusa");
    await m0.query("ROLLBACK");
    assert.equal((await q("SELECT to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NULL AS ausente")).rows[0].ausente, true, "T0: recusada sem efeito");
    await m0.query("SET kidmais.portao_135 = 'deploy-novo-live-sem-gravador-antigo'");
    const pid0 = (await m0.query("SELECT pg_backend_pid() AS p")).rows[0].p;
    const migracao = m0.query(UP_135);
    for (let i = 0; ; i++) {
      // Pelo pid: o texto em pg_stat_activity é cortado (track_activity_query_size) antes do LOCK.
      const r = await q("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid0]);
      if (r.rows.length) break;
      if (i > 160) throw new Error("T0: a 135 não esperou a gravação aberta (sem a pausa)");
      await new Promise((ok) => setTimeout(ok, 25));
    }
    await g0.query("COMMIT");
    await migracao;
    await q(POST_135);
    // Postcheck recusa travas enfraquecidas (Astra r4, P3), cada uma numa transação desfeita.
    for (const [nome, def] of [["whatsapp_atendimento_consumo_mensal_mes_check", "CHECK (mes ~ '^[0-9]{4}-0[1-9]|1[0-2]$')"],
      ["whatsapp_atendimento_consumo_mensal_usadas_check", "CHECK (usadas >= 1)"]]) {
      await q("BEGIN");
      await q(`ALTER TABLE whatsapp_atendimento_consumo_mensal DROP CONSTRAINT ${nome}, ADD CONSTRAINT ${nome} ${def}`);
      await assert.rejects(q(POST_135), /travas CHECK divergentes/, `T0: postcheck recusa ${def}`);
      await q("ROLLBACK");
    }
    await q(POST_135);
    await assert.rejects(q(PRE_135), /135 já presente/, "T0: o precheck recusa reaplicar");
    assert.equal(await usadas(), 3, "T0: carga inicial = Wall-e + equipe + a gravada durante a 135; FALHOU, CANCELADA e mês anterior fora");
    assert.equal(await usadas(B), 0, "T0: B sem saídas, sem linha");

    // T1 — isolamento por empresa e ambiente: 3 para A, 0 para B, 0 no outro ambiente de A.
    await fixar(0);
    for (let i = 0; i < 3; i++) assert.equal(await respondeu(novoContato()), 1, "T1: o Wall-e responde");
    assert.deepEqual([await usadas(), await usadas(B), await usadas(A, "production")], [3, 0, 0], "T1: A=3, B=0, outro ambiente=0");
    assert.equal(Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_consumo_mensal WHERE empresa_id = $1", [B])).rows[0].n), 0, "T1: nenhuma linha de B");

    // T2 — grupo que não cabe: 999 + texto e anexo ⇒ nada sai, LIMITE_MENSAL em silêncio, 999 intacto.
    await fixar(999);
    const cg = novoContato();
    const w0 = chamadas.wallE;
    assert.equal(await respondeu(cg, GRUPO), 0, "T2: o grupo de 2 não cabe em 1 vaga: nada sai");
    assert.equal(chamadas.wallE, w0 + 1, "T2: o Wall-e foi chamado (999 ainda não é ATINGIDO); a reserva recusou");
    const cvg = await conversa(cg);
    assert.equal(cvg.estado, "AGUARDANDO_HUMANO", "T2: com a equipe");
    assert.deepEqual(cvg.passagem?.motivos, ["LIMITE_MENSAL"], "T2: o resumo diz teto mensal");
    assert.equal(await saidasDe(cg), 0, "T2: nenhuma saída gravada (nem parcial, nem o texto fixo)");
    assert.equal(await usadas(), 999, "T2: consumo intacto");
    const c1 = novoContato();
    assert.equal(await respondeu(c1), 1, "T2: o grupo de 1 cabe");
    assert.equal(await usadas(), 1000, "T2: 1000 de 1000");
    const antes = { ...chamadas };
    const ca = novoContato();
    assert.equal(await respondeu(ca), 0, "T2: ATINGIDO, nada sai");
    assert.deepEqual(chamadas, antes, "T2: atalho ATINGIDO: nem Wall-e nem fase B");
    assert.deepEqual((await conversa(ca)).passagem?.motivos, ["LIMITE_MENSAL"], "T2: LIMITE_MENSAL");
    assert.equal((await tetoDoMes(c as never, A, "staging"))?.estado, "ATINGIDO");

    // T3 — excluir a conversa (privacidade, a pedido) não devolve cota.
    const cv1 = await conversa(c1);
    const { privacidade } = carregarAtendimento(A);
    const exclusao = await withTransaction((tx) => privacidade.excluirDadosConversa(tx, { empresa: A, ambiente: "staging", conversaId: cv1.id, origem: "PEDIDO", usuarioId: u, motivo: "PEDIDO_DO_TITULAR" }));
    assert.equal(exclusao.estado, "EXCLUIDA", "T3: conversa excluída");
    assert.equal(await usadas(), 1000, "T3: a exclusão não devolve cota");

    // T4 — a equipe soma sem limite: assume a conversa do T2 e responde ⇒ 1001, acima da franquia da Meta.
    let cvt = await conversa(cg);
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cvt.id, versao: Number(cvt.versao) });
    cvt = await conversa(cg);
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cvt.id, versao: Number(cvt.versao), texto: "Oi! Aqui é da equipe (sintético)." });
    assert.equal(await usadas(), 1001, "T4: a equipe soma mesmo acima do limite do Wall-e");
    assert.equal((await tetoDoMes(c as never, A, "staging"))?.acimaDaFranquia, true, "T4: acima da franquia de 1.000");

    // T5a — duas reservas concorrentes com uma vaga: a segunda espera a trava da linha e, depois do COMMIT, não cabe.
    await fixar(999);
    const [x1, x2] = [await conectarDescartavel({ travar: false }), await conectarDescartavel({ travar: false })];
    extras.push(x1, x2);
    await x1.query("BEGIN"); await x2.query("BEGIN");
    assert.equal(await reservarConsumo(x1 as never, A, "staging", 1, 1000), true, "T5a: a primeira cabe");
    const segunda = reservarConsumo(x2 as never, A, "staging", 1, 1000);
    for (let i = 0; ; i++) {
      const r = await q("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%whatsapp_atendimento_consumo_mensal%'");
      if (r.rows.length) break;
      if (i > 400) throw new Error("T5a: a segunda reserva não chegou à espera da trava");
      await new Promise((ok) => setTimeout(ok, 25));
    }
    await x1.query("COMMIT");
    assert.equal(await segunda, false, "T5a: a segunda não cabe (sem passar do teto)");
    await x2.query("COMMIT");
    assert.equal(await usadas(), 1000, "T5a: 1000, nunca 1001");
    // T5b — dois lotes do worker em paralelo, duas conversas, uma vaga: só uma resposta sai.
    await fixar(999);
    const [p1, p2] = [novoContato(), novoContato()];
    await receber(p1); await receber(p2);
    await Promise.all([processar(), processar()]);
    await processar();
    assert.equal(envios.filter((x) => x === p1 || x === p2).length, 1, "T5b: uma só resposta");
    assert.equal(await usadas(), 1000, "T5b: 1000, nunca 1001");
    const motivos5 = [(await conversa(p1)).passagem?.motivos ?? null, (await conversa(p2)).passagem?.motivos ?? null];
    assert.equal(motivos5.filter((x) => JSON.stringify(x) === '["LIMITE_MENSAL"]').length, 1, "T5b: a outra foi para a equipe com LIMITE_MENSAL");

    // T6 — falha transitória na leitura do teto (antes do modelo) e na reserva: a entrada volta à fila, nada sai.
    await fixar(0);
    for (const [ponto, trocas] of [
      ["leitura", { tetoDoMes: async () => { throw new Error("timeout sintético na leitura do teto"); } }],
      ["reserva", { reservarConsumo: async () => { throw new Error("timeout sintético na reserva"); } }],
    ] as const) {
      const { worker: falho } = carregarAtendimento(A, "staging", { "./teto-mensal.ts": { ...tetoA, ...trocas } }, tetoA);
      const ct = novoContato();
      await receber(ct);
      const w6 = chamadas.wallE, n6 = envios.length;
      await processar(falho);
      assert.equal(await entradaDe(ct), "PENDENTE", `T6 ${ponto}: a entrada volta a PENDENTE`);
      assert.equal(envios.length, n6, `T6 ${ponto}: nada enviado`);
      assert.equal(await saidasDe(ct), 0, `T6 ${ponto}: nenhuma saída gravada`);
      if (ponto === "leitura") assert.equal(chamadas.wallE, w6, "T6 leitura: o Wall-e não é chamado");
      assert.equal(await usadas(), 0, `T6 ${ponto}: consumo intacto`);
      await processar();
      assert.equal(await entradaDe(ct), "PROCESSADA", `T6 ${ponto}: o ciclo seguinte conclui`);
      assert.equal(await saidasDe(ct), 1, `T6 ${ponto}: e responde`);
      await fixar(0);
    }

    // T7 — piloto (módulo REAL do teto, A = piloto), mesmo com o canal Meta: sem teto e sem consumo (Astra r2, P1).
    process.env.WHATSAPP_ATENDIMENTO_CANAL_ENVIO = "meta";
    const real = carregarAtendimento(A);
    await fixar(1000);
    const cgs = novoContato();
    await receber(cgs);
    await real.worker.processarLote(deps, { maxTarefas: 20 });
    assert.equal(envios.filter((x) => x === cgs).length, 1, "T7: a piloto responde mesmo com 1000 de 1000 e canal Meta");
    assert.equal(await usadas(), 1000, "T7: o Wall-e da piloto não soma");
    let cv7 = await conversa(cgs);
    await real.servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv7.id, versao: Number(cv7.versao) });
    cv7 = await conversa(cgs);
    await real.servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv7.id, versao: Number(cv7.versao), texto: "Equipe da piloto (sintético)." });
    assert.equal(await usadas(), 1000, "T7: a equipe da piloto não soma");
    await real.worker.processarLote(deps, { maxTarefas: 20 });

    // T9 — fallback sem vaga: 999 antes do modelo; durante a chamada outra conversa leva a 1000 e o Wall-e não devolve
    // saídas ⇒ encaminharSemModelo reserva ANTES do estado final: PROCESSADA + LIMITE_MENSAL, nada sai (Astra r2, P3).
    await fixar(999);
    const c9 = novoContato();
    assert.equal(await respondeu(c9, SEM_SAIDAS), 0, "T9: nada sai (nem o texto fixo)");
    assert.equal(await entradaDe(c9), "PROCESSADA", "T9: a entrada termina PROCESSADA, não FALHOU");
    assert.deepEqual((await conversa(c9)).passagem?.motivos, ["LIMITE_MENSAL"], "T9: LIMITE_MENSAL");
    assert.equal(await saidasDe(c9), 0, "T9: nenhuma saída");
    assert.equal(await usadas(), 1000, "T9: 1000, nunca 1001");

    // T11 — retry com a saída já gravada (Astra r3, P2): o INSERT do Wall-e não grava nada (ON CONFLICT) e a reserva é 0.
    await fixar(999);
    const c11 = novoContato();
    await receber(c11);
    const cv11 = await conversa(c11);
    const e11 = (await q("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND direcao = 'ENTRADA'", [cv11.id])).rows[0].id;
    await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_id, direcao, texto, estado, versao_conversa, criada_em)
      VALUES ($1, $2, 'staging', $3, 'SAIDA', 'sintética já gravada por uma tentativa anterior', 'ENTREGUE', $4, clock_timestamp())`, [cv11.id, A, e11, cv11.versao]);
    const w11 = chamadas.wallE;
    await processar();
    assert.equal(chamadas.wallE, w11 + 1, "T11: o Wall-e foi chamado (999 não é ATINGIDO)");
    assert.equal(await saidasDe(c11), 1, "T11: nenhuma saída nova (a da tentativa anterior continua única)");
    assert.equal(await usadas(), 999, "T11: reserva 0 para o que não foi gravado");
    assert.equal(await entradaDe(c11), "PROCESSADA", "T11: a entrada conclui");

    // T12 — revogação no atalho ATINGIDO (Astra r3, P2): a habilitação cai entre a leitura do teto e a trava ⇒ CANCELADA.
    let revogado = false;
    const tetoT12 = { ...tetoA, tetoDoMes: async (...a: Parameters<typeof tetoReal.tetoDoMes>) => { revogado = true; return tetoReal.tetoDoMes(...a); } };
    const multiT12 = { ...multiempresa, empresaOperaAtendimento: async (...a: Parameters<typeof multiempresa.empresaOperaAtendimento>) => (revogado ? false : multiempresa.empresaOperaAtendimento(...a)) };
    const { worker: w12 } = carregarAtendimento(A, "staging", { "./multiempresa.ts": multiT12 }, tetoT12);
    await fixar(1000);
    const c12 = novoContato();
    await receber(c12);
    const antes12 = { ...chamadas };
    await processar(w12);
    assert.equal(revogado, true, "T12: passou pela leitura do teto");
    assert.equal(await entradaDe(c12), "CANCELADA", "T12: revogada sob a trava ⇒ CANCELADA");
    const cv12 = await conversa(c12);
    assert.notEqual(cv12.estado, "AGUARDANDO_HUMANO", "T12: não passa à equipe");
    assert.equal(cv12.passagem ?? null, null, "T12: sem resumo de passagem");
    assert.deepEqual(chamadas, antes12, "T12: nem Wall-e nem fase B");
    assert.equal(await saidasDe(c12), 0, "T12: nada sai");

    // T8 — down da 135: a tabela some e o Wall-e volta a responder sem teto.
    await q(DOWN_135);
    assert.equal((await q("SELECT to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NULL AS ausente")).rows[0].ausente, true, "T8: tabela removida");
    assert.equal(await respondeu(novoContato()), 1, "T8: sem a 135, sem teto");
  } finally {
    if (envAntes.teto === undefined) delete process.env.WHATSAPP_TETO_MENSAL_RESPOSTAS; else process.env.WHATSAPP_TETO_MENSAL_RESPOSTAS = envAntes.teto;
    if (envAntes.canal === undefined) delete process.env.WHATSAPP_ATENDIMENTO_CANAL_ENVIO; else process.env.WHATSAPP_ATENDIMENTO_CANAL_ENVIO = envAntes.canal;
    for (const x of extras) await x.end().catch(() => {});
    await c.end();
  }
});
