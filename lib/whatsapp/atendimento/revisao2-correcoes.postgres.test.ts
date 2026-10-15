import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { adiado, carregarAtendimento, cod, noPrazo } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Correções da revisão independente de 5699dfc (12/10/2026), no modelo "082", com serviço, worker e privacidade REAIS,
 * transporte simulado e dados sintéticos. Ordem imposta por travas e confirmada em pg_stat_activity, nunca por tempo.
 *
 *  A1 retenção × configuração: (a) o salvamento chega primeiro (desligar; ampliar o prazo) → a retenção já em curso usa a
 *     configuração vigente e não apaga; (b) a retenção chega primeiro → a exclusão confirmada vale (não retroativa) e o
 *     salvamento termina depois; nas duas ordens, sem deadlock.
 *  M1 posse da execução (arrendamento renovado + cerca): (a) execução viva e lenta, com a linha envelhecida em 3 h → a
 *     segunda chamada recebe EM_EXECUCAO (idade não prova abandono); (b) morte real do PROCESSO (filho encerrado com
 *     SIGKILL) → nada apagado; enquanto o arrendamento vale, ninguém entra; vencido, a seguinte vira dona e apaga;
 *     (c) a execução que parou de renovar não apaga e não sobrescreve o encerramento da nova.
 *  M2 callback "failed" do provedor: (K1) depois do retorno do POST, irmã ainda na fila; (K2) ANTES do retorno do POST
 *     (status guardado e aplicado pelo worker); (K3) irmã já segura pelo worker na transação de envio → o envio iniciado é
 *     preservado e a conversa vai para a equipe; (K4) irmã reservada (PROCESSANDO) e não segura → cancelada; (K5) guarda do
 *     worker: irmã anterior já FALHOU; (K6) a falha é do PDF (última parte); (K7) INCERTO + "failed" → FALHOU, nunca
 *     reenviado; "delivered" depois de INCERTO → ENTREGUE, sem tratamento de falha.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% material sintético da revisão 2\n%%EOF\n");

test("correções da revisão de 5699dfc: A1, M1 e M2 com concorrência e callbacks", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const x = await conectarDescartavel({ travar: false });
  try {
    assert.ok((await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'whatsapp_atendimento_retencao_execucoes' AND column_name IN ('posse_token','posse_ate','por_empresa','config_alterada')")).rows[0].n === 4, "modelo com a 082 desta rodada");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética (revisão 2)', 'PROVISIONAMENTO') RETURNING id`, [cod("r2")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness revisão 2', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
    const gestao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() };
    const A = carregarAtendimento(e);
    await A.servico.salvarConfiguracao(gestao as never, { ativo: true, nome: "Empresa sintética (revisão 2)", perguntas: [] });
    const conversa = async (contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [e, contato])).rows[0];
    const receber = (contato: string, texto: string) => A.servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now() - 1000, nomePerfil: null });
    const limparFila = () => q("UPDATE whatsapp_atendimento_mensagens SET estado = CASE WHEN direcao = 'ENTRADA' THEN 'PROCESSADA' ELSE 'CANCELADA' END WHERE empresa_id = $1 AND estado = 'PENDENTE'", [e]);
    async function antiga(contato: string) {
      await receber(contato, "mensagem antiga sintética"); await limparFila();
      const cv = await conversa(contato);
      await q("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '40 days', atualizada_em = clock_timestamp() - interval '40 days' WHERE id = $1", [cv.id]);
      await q("UPDATE whatsapp_atendimento_mensagens SET criada_em = clock_timestamp() - interval '40 days' WHERE conversa_id = $1", [cv.id]);
      return cv.id as string;
    }
    async function esperando(trechos: string[]) {
      for (let i = 0; i < 400; i++) {
        const r = (await q("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows.map((l) => String(l.query));
        if (trechos.every((tr) => r.some((l) => l.includes(tr)))) return;
        await new Promise((ok) => setTimeout(ok, 25));
      }
      throw new Error(`não chegou à espera: ${trechos.join(" | ")}`);
    }
    const CONFIG = "SELECT prazo_dias FROM whatsapp_atendimento_retencao_config";
    const EMPRESA_RETENCAO = "SELECT id FROM empresas WHERE id=$1 FOR KEY SHARE";
    const EMPRESA_TENANT = "SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE";
    const SALVAR = "INSERT INTO whatsapp_atendimento_retencao_config";
    const CONVERSA_RETENCAO = "SELECT id,contato,nao_contatar,estado,contexto FROM whatsapp_atendimento_conversas";
    const prazo = async () => (await q("SELECT prazo_dias FROM whatsapp_atendimento_retencao_config WHERE empresa_id = $1", [e])).rows[0]?.prazo_dias ?? null;
    const travarConfig = async () => { await x.query("BEGIN"); await x.query("SELECT 1 FROM whatsapp_atendimento_retencao_config WHERE empresa_id = $1 FOR UPDATE", [e]); };

    // ---------- A1 (a) o salvamento chega primeiro: desligar ----------
    await A.privacidade.configurarRetencao(gestao, { prazoDias: 30 });
    const a1 = await antiga("5561900000971");
    await travarConfig();
    const salvarNull = A.privacidade.configurarRetencao(gestao, { prazoDias: null });
    await esperando([SALVAR]);
    const ret1 = A.privacidade.executarRetencao();
    // O salvamento (empresa travada) espera a configuração; a retenção espera a empresa: ordem empresa → configuração.
    await esperando([SALVAR, EMPRESA_RETENCAO]);
    await x.query("COMMIT");
    await noPrazo(salvarNull, 15_000, "A1a salvamento");
    const r1 = await noPrazo(ret1, 15_000, "A1a retenção");
    assert.ok(r1.estado === "CONCLUIDA" && r1.excluidas === 0 && r1.alteradas === 1, `A1a: desligada antes → nada apagado (${JSON.stringify(r1)})`);
    assert.ok((await q("SELECT 1 FROM whatsapp_atendimento_conversas WHERE id = $1", [a1])).rows.length, "A1a: conversa preservada");
    assert.equal(await prazo(), null);

    // ---------- A1 (a') o salvamento chega primeiro: ampliar o prazo ----------
    await A.privacidade.configurarRetencao(gestao, { prazoDias: 30 });
    await travarConfig();
    const salvar365 = A.privacidade.configurarRetencao(gestao, { prazoDias: 365 });
    await esperando([SALVAR]);
    const ret2 = A.privacidade.executarRetencao();
    await esperando([SALVAR, EMPRESA_RETENCAO]);
    await x.query("COMMIT");
    await noPrazo(salvar365, 15_000, "A1a' salvamento");
    const r2 = await noPrazo(ret2, 15_000, "A1a' retenção");
    assert.ok(r2.estado === "CONCLUIDA" && r2.excluidas === 0 && r2.alteradas === 1, `A1a': prazo ampliado antes → 40 dias não bastam (${JSON.stringify(r2)})`);
    assert.ok((await q("SELECT 1 FROM whatsapp_atendimento_conversas WHERE id = $1", [a1])).rows.length, "A1a': conversa preservada");

    // ---------- A1 (b) a retenção chega primeiro: exclusão confirmada vale; o salvamento termina depois ----------
    await A.privacidade.configurarRetencao(gestao, { prazoDias: 30 });
    await travarConfig();
    const ret3 = A.privacidade.executarRetencao();
    await esperando([CONFIG]);
    const salvarDepois = A.privacidade.configurarRetencao(gestao, { prazoDias: null });
    // A retenção (empresa em KEY SHARE) espera a configuração; o salvamento espera a empresa.
    await esperando([CONFIG, EMPRESA_TENANT]);
    await x.query("COMMIT");
    const r3 = await noPrazo(ret3, 15_000, "A1b retenção");
    await noPrazo(salvarDepois, 15_000, "A1b salvamento (sem deadlock)");
    assert.ok(r3.estado === "CONCLUIDA" && r3.excluidas === 1, `A1b: a retenção, primeira na fila, apaga com o prazo vigente (${JSON.stringify(r3)})`);
    assert.equal((await q("SELECT 1 FROM whatsapp_atendimento_conversas WHERE id = $1", [a1])).rows.length, 0);
    assert.equal(await prazo(), null, "A1b: o salvamento termina em seguida");
    assert.equal((await q("SELECT prazo_dias FROM whatsapp_atendimento_privacidade WHERE conversa_id = $1", [a1])).rows[0].prazo_dias, 30, "A1b: registro com o prazo vigente usado");
    assert.equal((await A.privacidade.executarRetencao()).estado, "CONCLUIDA");

    // ---------- M1 (a) viva e lenta: idade não prova abandono ----------
    await A.privacidade.configurarRetencao(gestao, { prazoDias: 30 });
    const m1 = await antiga("5561900000972");
    await x.query("BEGIN"); await x.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [m1]);
    const lenta = A.privacidade.executarRetencao();
    await esperando([CONVERSA_RETENCAO]);
    await q("UPDATE whatsapp_atendimento_retencao_execucoes SET iniciada_em = clock_timestamp() - interval '3 hours' WHERE estado = 'EM_ANDAMENTO'");
    assert.equal((await A.privacidade.executarRetencao()).estado, "EM_EXECUCAO", "M1a: execução viva, mesmo 'velha', mantém a posse");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_retencao_execucoes WHERE estado = 'INTERROMPIDA'")).rows[0].n, 0, "M1a: ninguém marcou a viva como interrompida");
    await x.query("ROLLBACK");
    const rl = await noPrazo(lenta, 15_000, "M1a lenta");
    assert.ok(rl.estado === "CONCLUIDA" && rl.excluidas === 1, `M1a: a lenta termina normalmente (${JSON.stringify(rl)})`);

    // ---------- M1 (b) morte real do PROCESSO que tem a posse: nada apagado; depois do arrendamento, a seguinte assume ----------
    const m2 = await antiga("5561900000973");
    await x.query("BEGIN"); await x.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [m2]);
    const codigoFilho = `const h = await import(${JSON.stringify(pathToFileURL(resolve("lib/whatsapp/atendimento/harness-postgres.ts")).href)});
      await h.carregarAtendimento(${JSON.stringify(e)}).privacidade.executarRetencao({ posseMs: 3000 }); console.log("FILHO_TERMINOU");`;
    const filho = spawn(process.execPath, [...process.execArgv.filter((a) => !a.startsWith("--test")), "--input-type=module", "-e", codigoFilho], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let saidaFilho = ""; filho.stdout.on("data", (d) => { saidaFilho += d; }); filho.stderr.on("data", (d) => { saidaFilho += d; });
    const fimFilho = new Promise<number | null>((ok) => filho.on("exit", (codigo) => ok(codigo)));
    await esperando([CONVERSA_RETENCAO]);
    const linhaFilho = (await q("SELECT id, posse_ate > clock_timestamp() AS vigente FROM whatsapp_atendimento_retencao_execucoes WHERE estado = 'EM_ANDAMENTO'")).rows[0];
    assert.ok(linhaFilho?.vigente, "M1b: o processo filho tem a posse");
    assert.equal((await A.privacidade.executarRetencao()).estado, "EM_EXECUCAO", "M1b: enquanto vivo, ninguém entra");
    filho.kill("SIGKILL");
    await noPrazo(fimFilho, 10_000, "M1b fim do processo");
    assert.doesNotMatch(saidaFilho, /FILHO_TERMINOU/, "M1b: o processo morreu antes de terminar");
    await x.query("ROLLBACK");
    assert.ok((await q("SELECT 1 FROM whatsapp_atendimento_conversas WHERE id = $1", [m2])).rows.length, "M1b: o processo morto não apagou nada");
    assert.equal((await A.privacidade.executarRetencao()).estado, "EM_EXECUCAO", "M1b: arrendamento ainda vigente logo depois da morte");
    for (let i = 0; i < 400 && (await q("SELECT posse_ate > clock_timestamp() AS v FROM whatsapp_atendimento_retencao_execucoes WHERE id = $1", [linhaFilho.id])).rows[0].v; i++) await new Promise((ok) => setTimeout(ok, 50));
    const seguinte = await A.privacidade.executarRetencao();
    assert.ok(seguinte.estado === "CONCLUIDA" && seguinte.excluidas === 1, `M1b: vencido o arrendamento, a seguinte assume e apaga (${JSON.stringify(seguinte)})`);
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_retencao_execucoes WHERE id = $1", [linhaFilho.id])).rows[0].estado, "INTERROMPIDA", "M1b: a do processo morto vira INTERROMPIDA");

    // ---------- M1 (c) a que perdeu a posse (parou de renovar) não apaga nem sobrescreve a nova ----------
    const m3 = await antiga("5561900000974");
    await x.query("BEGIN"); await x.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [m3]);
    const velha = A.privacidade.executarRetencao({ posseMs: 3000 });
    await esperando([CONVERSA_RETENCAO]);
    const linhaVelha = (await q("SELECT id FROM whatsapp_atendimento_retencao_execucoes WHERE estado = 'EM_ANDAMENTO'")).rows[0];
    // Simula o processo parado além do arrendamento: a validade passa sem renovação.
    await q("UPDATE whatsapp_atendimento_retencao_execucoes SET posse_ate = clock_timestamp() - interval '1 second' WHERE id = $1", [linhaVelha.id]);
    const nova = A.privacidade.executarRetencao({ posseMs: 3000 });
    for (let i = 0; i < 400 && (await q("SELECT estado FROM whatsapp_atendimento_retencao_execucoes WHERE id = $1", [linhaVelha.id])).rows[0].estado === "EM_ANDAMENTO"; i++) await new Promise((ok) => setTimeout(ok, 25));
    const marcadaEm = (await q("SELECT estado, terminada_em::text AS fim FROM whatsapp_atendimento_retencao_execucoes WHERE id = $1", [linhaVelha.id])).rows[0];
    assert.equal(marcadaEm.estado, "INTERROMPIDA", "M1c: a nova (com a posse) marca a anterior");
    await x.query("ROLLBACK");
    const [rv, rn] = await Promise.all([noPrazo(velha, 15_000, "M1c velha"), noPrazo(nova, 15_000, "M1c nova")]);
    assert.ok(rv.estado === "INTERROMPIDA" && rv.excluidas === 0, `M1c: a velha não apaga (${JSON.stringify(rv)})`);
    assert.ok(rn.estado === "CONCLUIDA" && rn.excluidas === 1, `M1c: a nova apaga (${JSON.stringify(rn)})`);
    assert.deepEqual((await q("SELECT estado, terminada_em::text AS fim FROM whatsapp_atendimento_retencao_execucoes WHERE id = $1", [linhaVelha.id])).rows[0], marcadaEm, "M1c: a velha não sobrescreveu o encerramento");
    await A.privacidade.configurarRetencao(gestao, { prazoDias: null });

    // ---------- M2 — callbacks ----------
    async function grupo(contato: string) {
      const arq = await A.biblioteca.salvarArquivo(gestao as never, { nome: `${cod("k-")}.pdf`, bytes: PDF, tipoEsperado: "DOCUMENTO" });
      const pronta = (await A.biblioteca.salvarPronta(gestao as never, { titulo: cod("PDF "), categoria: "Teste", tipo: "DOCUMENTO", texto: "Material", link: null, atalho: null, arquivoId: arq.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PACOTES" })).id;
      const versaoP = Number((await q("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta])).rows[0].versao);
      await receber(contato, "quero a tabela"); await limparFila();
      const cv = await conversa(contato);
      const entrada = (await q("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND direcao = 'ENTRADA' ORDER BY criada_em DESC LIMIT 1", [cv.id])).rows[0].id as string;
      await q(`UPDATE whatsapp_atendimento_conversas SET estado = 'IA', contexto = jsonb_build_object('enviados', jsonb_build_array(jsonb_build_object('prontaId', $2::text, 'versao', $3::int, 'finalidade', 'PACOTES', 'em', now()::text))) WHERE id = $1`, [cv.id, pronta, versaoP]);
      const versao = Number((await conversa(contato)).versao);
      const fonte = JSON.stringify({ tipo: "WALLE", fontes: [{ tipo: "PRONTA", id: pronta, versao: versaoP }] });
      const texto = await id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_id, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, fonte)
        VALUES ($1, $2, 'staging', $3, $3, 0, 'SAIDA', 'Segue o PDF com os pacotes.', 'PENDENTE', $4, $5::jsonb) RETURNING id`, [cv.id, e, entrada, versao, fonte]);
      const pdf = await id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, midia_tipo, midia_arquivo_id, midia_nome, midia_pronta_id, midia_pronta_versao, fonte, criada_em)
        VALUES ($1, $2, 'staging', $3, 1, 'SAIDA', 'Material', 'PENDENTE', $4, 'DOCUMENTO', $5, 'material.pdf', $6, $7, $8::jsonb, clock_timestamp() + interval '1 millisecond') RETURNING id`, [cv.id, e, entrada, versao, arq.id, pronta, versaoP, fonte]);
      return { texto, pdf, conversa: cv.id, pronta };
    }
    const estado = async (mid: string) => (await q("SELECT estado, motivo_cancelamento FROM whatsapp_atendimento_mensagens WHERE id = $1", [mid])).rows[0];
    const conv = async (cid: string) => (await q("SELECT estado, contexto FROM whatsapp_atendimento_conversas WHERE id = $1", [cid])).rows[0];
    const falhou = (provedorId: string) => A.servico.receberStatus({ app: "KidmaisManager", type: "message-event", payload: { id: provedorId, type: "failed" } });
    const entregue = (provedorId: string) => A.servico.receberStatus({ app: "KidmaisManager", type: "message-event", payload: { id: provedorId, type: "delivered" } });
    const enviados: string[] = [];
    const enviarOk = async (_c: string, ct: ConteudoSaida) => { const pid = cod(`gs-${ct.tipo}-`); enviados.push(pid); return pid; };
    const provedor = async (mid: string) => (await q("SELECT provedor_id FROM whatsapp_atendimento_mensagens WHERE id = $1", [mid])).rows[0].provedor_id as string;

    // K1 — depois do retorno do POST, a irmã (PDF) ainda na fila.
    const k1 = await grupo("5561900000981");
    await A.worker.processarLote({ interpretar: null, enviar: enviarOk } as never, { maxTarefas: 1 });
    assert.equal((await estado(k1.texto)).estado, "SUBMETIDA");
    await falhou(await provedor(k1.texto));
    assert.equal((await estado(k1.texto)).estado, "FALHOU");
    assert.deepEqual(await estado(k1.pdf), { estado: "CANCELADA", motivo_cancelamento: "GRUPO_INCOMPLETO" }, "K1: PDF cancelado com motivo");
    let cv = await conv(k1.conversa);
    assert.equal(cv.estado, "AGUARDANDO_HUMANO", "K1: equipe chamada"); assert.deepEqual(cv.contexto.enviados, [], "K1: memória sem o PDF");
    const antesK1 = enviados.length;
    await A.worker.processarLote({ interpretar: null, enviar: enviarOk } as never, { maxTarefas: 5 });
    assert.equal(enviados.length, antesK1, "K1: o PDF não sai depois");

    // K2 — o "failed" chega ANTES do retorno do POST (guardado e aplicado pelo worker).
    const k2 = await grupo("5561900000982");
    const portao = adiado<string>();
    const lote2 = A.worker.processarLote({ interpretar: null, enviar: async () => portao.p } as never, { maxTarefas: 1 });
    for (let i = 0; i < 400 && (await estado(k2.texto)).estado !== "ENVIANDO"; i++) await new Promise((ok) => setTimeout(ok, 25));
    const idK2 = cod("gs-k2-");
    await falhou(idK2);
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_status WHERE provedor_id = $1", [idK2])).rows[0]?.estado, "FALHOU", "K2: status guardado sem mensagem correspondente ainda");
    assert.equal((await estado(k2.pdf)).estado, "PENDENTE", "K2: nada aplicado antes do retorno");
    portao.liberar(idK2);
    await noPrazo(lote2, 10_000, "K2 worker");
    assert.equal((await estado(k2.texto)).estado, "FALHOU", "K2: aplicado no retorno do POST");
    assert.deepEqual(await estado(k2.pdf), { estado: "CANCELADA", motivo_cancelamento: "GRUPO_INCOMPLETO" }, "K2: irmã cancelada no mesmo passo");
    assert.equal((await conv(k2.conversa)).estado, "AGUARDANDO_HUMANO");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_status WHERE provedor_id = $1", [idK2])).rows[0].n, 0, "K2: status auxiliar consumido");

    // K3 — a irmã já está na transação de envio do worker (travas da conversa): o envio iniciado é preservado.
    const k3 = await grupo("5561900000983");
    await A.worker.processarLote({ interpretar: null, enviar: enviarOk } as never, { maxTarefas: 1 });
    const portao3 = adiado<string>();
    let chamadas3 = 0;
    await x.query("BEGIN"); await x.query("SELECT empresa_id FROM whatsapp_atendimento_config WHERE empresa_id = $1 FOR UPDATE", [e]);
    const lote3 = A.worker.processarLote({ interpretar: null, enviar: async () => { chamadas3++; return portao3.p; } } as never, { maxTarefas: 1 });
    await esperando(["FROM whatsapp_atendimento_config WHERE empresa_id=$1 AND ambiente=$2 FOR SHARE"]);
    const cb3 = falhou(await provedor(k3.texto));
    await esperando(["FROM whatsapp_atendimento_config WHERE empresa_id=$1 AND ambiente=$2 FOR SHARE", "SELECT id FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE"]);
    await x.query("COMMIT");
    await noPrazo(cb3, 10_000, "K3 callback (sem deadlock)");
    assert.equal(chamadas3, 1, "K3: o PDF já estava em envio e saiu");
    assert.equal((await estado(k3.pdf)).estado, "ENVIANDO", "K3: envio iniciado preservado (não recolhido)");
    cv = await conv(k3.conversa);
    assert.equal(cv.estado, "AGUARDANDO_HUMANO", "K3: equipe chamada");
    assert.equal(cv.contexto.enviados.length, 1, "K3: o PDF em envio continua na memória");
    portao3.liberar(cod("gs-k3-"));
    await noPrazo(lote3, 10_000, "K3 worker");
    assert.equal((await estado(k3.pdf)).estado, "SUBMETIDA");

    // K4 — irmã reservada (PROCESSANDO) e não segura: cancelada pelo callback; o worker não a envia.
    const k4 = await grupo("5561900000984");
    await A.worker.processarLote({ interpretar: null, enviar: enviarOk } as never, { maxTarefas: 1 });
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSANDO', iniciada_em = clock_timestamp() WHERE id = $1", [k4.pdf]);
    await falhou(await provedor(k4.texto));
    assert.deepEqual(await estado(k4.pdf), { estado: "CANCELADA", motivo_cancelamento: "GRUPO_INCOMPLETO" }, "K4: reservada e livre → cancelada");

    // K5 — guarda do worker: a irmã anterior já FALHOU (sem tratamento), o PDF entra na fila e não sai.
    const k5 = await grupo("5561900000985");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'FALHOU', provedor_id = $2 WHERE id = $1", [k5.texto, cod("gs-")]);
    const antesK5 = enviados.length;
    await A.worker.processarLote({ interpretar: null, enviar: enviarOk } as never, { maxTarefas: 5 });
    assert.equal(enviados.length, antesK5, "K5: nada enviado");
    assert.deepEqual(await estado(k5.pdf), { estado: "CANCELADA", motivo_cancelamento: "GRUPO_INCOMPLETO" }, "K5: o próprio worker cancela com motivo");
    cv = await conv(k5.conversa);
    assert.equal(cv.estado, "AGUARDANDO_HUMANO"); assert.deepEqual(cv.contexto.enviados, [], "K5: memória ajustada");

    // K6 — a falha é do PDF (última parte), depois do texto entregue.
    const k6 = await grupo("5561900000986");
    await A.worker.processarLote({ interpretar: null, enviar: enviarOk } as never, { maxTarefas: 2 });
    await entregue(await provedor(k6.texto));
    assert.equal((await estado(k6.pdf)).estado, "SUBMETIDA");
    await falhou(await provedor(k6.pdf));
    assert.equal((await estado(k6.pdf)).estado, "FALHOU");
    cv = await conv(k6.conversa);
    assert.equal(cv.estado, "AGUARDANDO_HUMANO", "K6: falha do PDF também chama a equipe"); assert.deepEqual(cv.contexto.enviados, [], "K6: PDF que não chegou sai da memória");
    assert.equal((await estado(k6.texto)).estado, "ENTREGUE", "K6: o texto entregue não muda");

    // K7 — INCERTO: "failed" → FALHOU e tratamento; nunca reenviado. "delivered" → ENTREGUE, sem tratamento.
    const k7 = await grupo("5561900000987");
    const idK7 = cod("gs-k7-");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'INCERTO', provedor_id = $2 WHERE id = $1", [k7.texto, idK7]);
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'CANCELADA', motivo_cancelamento = 'GRUPO_INCOMPLETO' WHERE id = $1", [k7.pdf]);
    await falhou(idK7);
    assert.equal((await estado(k7.texto)).estado, "FALHOU");
    const antesK7 = enviados.length;
    await A.worker.processarLote({ interpretar: null, enviar: enviarOk } as never, { maxTarefas: 5 });
    assert.equal(enviados.length, antesK7, "K7: incerto/falho nunca é reenviado");
    const k8 = await grupo("5561900000988");
    const idK8 = cod("gs-k8-");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'INCERTO', provedor_id = $2 WHERE id = $1", [k8.texto, idK8]);
    await q("UPDATE whatsapp_atendimento_conversas SET estado = 'IA' WHERE id = $1", [k8.conversa]);
    await entregue(idK8);
    assert.equal((await estado(k8.texto)).estado, "ENTREGUE", "K7: delivered depois de INCERTO");
    assert.equal((await estado(k8.pdf)).estado, "PENDENTE", "K7: entrega não dispara tratamento de falha");
  } finally {
    await x.query("ROLLBACK").catch(() => {});
    await x.end();
    await c.end();
  }
});
