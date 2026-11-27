import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hashCorte, hashEco } from "./service.ts";
import { setTimeout as esperar } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import { carregarAtendimento, cod, db, transporteSemRede, withTransaction } from "./harness-postgres.ts";
import * as credencial from "../credencial.ts";
import * as core from "./core.ts";
import * as configuracaoReal from "./configuracao.ts";
import * as multiempresa from "./multiempresa.ts";
import { contadorAnomaliasStatus } from "./multiempresa.ts";
import * as mesSaoPaulo from "./mes-sao-paulo.ts";
import * as tetoMensal from "./teto-mensal.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { PortaWallE } from "./worker.ts";

/**
 * Ecos do app WhatsApp Business (F1, plano r2–r6 + requisitos da Astra r6) no PostgreSQL descartável, só pelo
 * check:v1:postgres com opt-in. Serviço, worker, privacidade e Resultado REAIS (harness), dados sintéticos, nenhuma rede.
 * Modelos: "131" (082 + 117), "112" (082 sem a 117) e "063" (sem a 082).
 *
 *  E1 eco com conversa: saída ENTREGUE sem autor e sem provedor_id, fonte APP_WHATSAPP, versão atual; conversa idêntica
 *     (estado, versão, datas); a tela mostra origem APP_WHATSAPP; reentrega e corrida não duplicam;
 *  E2 sem conversa: só o hash eco: (nenhuma conversa criada); a conversa criada depois não recebe o retry;
 *  E3 conversa ENCERRADA por PARAR: o eco entra no histórico e o estado não muda; conteúdo sem texto aceito;
 *  E4 chave desligada: nada gravado;
 *  E5 R5-3: eco com falha injetada antes do COMMIT (nada fica, nem hash) → exclusão (corte) → ENTRADA antiga recria a
 *     conversa → retry do eco: só o hash; fronteira com a exclusão real (primeiro segundo inteiro > corte + 2 s entra);
 *  E6 exclusão depois do eco: o eco sai com a conversa, vira hash eco:, e o retry não volta (nem com conversa recriada);
 *  E7 fronteiras do corte (R6-4) com timestamps inteiros e corte em T.000, T.100 e T.999;
 *  E8 corte gravado (e purga rodada) enquanto a recepção espera o FOR UPDATE: só o hash (R6-2, corte);
 *  E9 idade atravessada durante a espera, sem corte: zero gravações (R6-2, idade); 29 d + 1 s com conversa: nada;
 *     29 d (no instante da chamada): nada; sem conversa a 29 d + 1 h: zero hashes;
 *  E10 colisão API → eco com o mesmo id: nada gravado; com a 117, marca + status posterior recusado; sem ela, anomalia;
 *  E11 status antes e depois do eco não mexem no eco;
 *  E12 limite diário do Wall-e e Resultado não contam o eco;
 *  E13 isolamento entre empresas (mesmo contato e mesmo id);
 *  E14 retenção (lote de 1): o eco não é atividade; o hash eco: impede o retry;
 *  E15 caminho real do webhook (receberEventosMeta): entrada e eco do mesmo lote, chave desligada, número desconhecido;
 *  135: no 131 a suíte aplica a 135 e confere que nenhum eco reserva consumo do teto mensal;
 *  E0 sem a 082: eco confirma sem gravar; tela, Resultado e limite rodam; exclusão recusada como hoje.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const LIGADA = { WHATSAPP_ATENDIMENTO_ECOS_META: "true" } as unknown as NodeJS.ProcessEnv;
const DIA = 86_400_000;
const seg = (ms: number) => Math.floor(ms / 1000) * 1000;

test("ecos do app WhatsApp Business: histórico sem mudar estado, corte, janela, colisão, limite, Resultado e retenção", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    const tem082 = (await q("SELECT 1 FROM pg_attribute WHERE attrelid='public.whatsapp_atendimento_mensagens'::regclass AND attname='fonte' AND NOT attisdropped")).rows.length > 0;
    const tem117 = (await q("SELECT to_regclass('public.whatsapp_atendimento_status_colisoes') IS NOT NULL AS e")).rows[0].e as boolean;
    // Teto mensal (135): no modelo 131 a suíte aplica a 135 (pre/up/post, com o portão de deploy) para o eco ser
    // conferido COM a tabela de consumo; o 112 segue sem ela.
    if (tem082 && tem117 && !(await q("SELECT to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NOT NULL AS e")).rows[0].e) {
      await q(readFileSync("database/checks/20261123_135_precheck.sql", "utf8"));
      await q("SET kidmais.portao_135 = 'deploy-novo-live-sem-gravador-antigo'");
      await q(readFileSync("database/migrations/20261123_135_whatsapp_consumo_mensal.sql", "utf8"));
      await q("RESET kidmais.portao_135");
      await q(readFileSync("database/checks/20261123_135_postcheck.sql", "utf8"));
    }
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    async function empresa(rotulo: string, config: Record<string, unknown> = {}) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("ec"), `Empresa sintética ${rotulo} (ecos)`]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness ecos', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
      await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
      const gestao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() };
      const h = carregarAtendimento(e);
      await h.servico.salvarConfiguracao(gestao as never, { ativo: true, nome: `Empresa sintética ${rotulo}`, perguntas: [], ...config });
      const { resultadoAtendimento } = carregarComponente("lib/whatsapp/atendimento/resultado.ts", {
        "./service.ts": h.servico, "./configuracao.ts": { ambienteAtendimento: () => "staging", canalEnvio: () => "GUPSHUP", empresaPiloto: () => e },
        "./mes-sao-paulo.ts": mesSaoPaulo, "./teto-mensal.ts": tetoMensal,
      }).modulo as typeof import("./resultado.ts");
      return { e, gestao, resultadoAtendimento, ...h };
    }
    type Emp = Awaited<ReturnType<typeof empresa>>;
    const receber = (h: Emp, contato: string, texto: string, timestamp = Date.now() - 1000) =>
      h.servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp, nomePerfil: null });
    const eco = (h: Emp, contato: string, wamid: string, timestamp = seg(Date.now() - 5000), texto: string | null = "Resposta sintética pelo app", env = LIGADA) =>
      h.servico.receberEco({ id: wamid, contato, texto, timestamp }, { empresa: h.e, env });
    const conversa = async (emp: string, contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND ambiente = 'staging' AND contato = $2", [emp, contato])).rows[0];
    const retratoConversa = async (conv: string) => (await q("SELECT c::text AS t FROM whatsapp_atendimento_conversas c WHERE id = $1", [conv])).rows[0]?.t as string | undefined;
    const nEcos = async (emp: string, wamid?: string) => Number((await q(`SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id = $1 ${tem082 ? "AND fonte->>'tipo' = 'APP_WHATSAPP'" : "AND false"}${wamid ? " AND fonte->>'id' = $2" : ""}`, wamid ? [emp, wamid] : [emp])).rows[0].n);
    const nHash = async (emp: string, hash: string) => Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_eventos_excluidos WHERE empresa_id = $1 AND ambiente = 'staging' AND provedor = 'GUPSHUP' AND evento_sha256 = $2", [emp, hash])).rows[0].n);
    const nMensagens = async (emp: string) => Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id = $1", [emp])).rows[0].n);
    const nEventos = async (emp: string) => Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_eventos_excluidos WHERE empresa_id = $1", [emp])).rows[0].n);

    if (!tem082) {
      // E0 — sem a 082 (R3-4/R4-4): a chave ligada não grava nada e nada cita `fonte`.
      const Z = await empresa("sem 082");
      const n0 = "5561900006001";
      await receber(Z, n0, "Olá, sem a 082");
      const cv0 = await conversa(Z.e, n0);
      const antes = await retratoConversa(cv0.id), mensagens = await nMensagens(Z.e);
      assert.equal(await eco(Z, n0, cod("wamid.Z")), "NADA", "E0: eco confirma sem gravar");
      assert.equal(await eco(Z, "5561900006002", cod("wamid.Z")), "NADA", "E0: sem conversa, idem");
      assert.equal(await nMensagens(Z.e), mensagens, "E0: nenhuma mensagem");
      assert.equal(await retratoConversa(cv0.id), antes, "E0: conversa idêntica");
      const tela = await Z.servico.listarAtendimento(Z.gestao as never, cv0.id);
      assert.ok(tela.mensagens.length >= 1 && tela.mensagens.every((m) => m.origem == null), "E0: a tela roda sem `fonte` (origem nula)");
      await Z.resultadoAtendimento(Z.gestao as never, new Date());
      const envios: string[] = [];
      await Z.worker.processarLote({ interpretar: async () => ({ intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }), enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo.tipo); return cod("gs-"); } }, { maxTarefas: 10 });
      await assert.rejects(Z.privacidade.excluirConversaAPedido(Z.gestao as never, { conversaId: cv0.id, motivo: "PEDIDO_DO_TITULAR" }), /082/, "E0: exclusão recusada como hoje");
      return;
    }


    // E12a — limite diário do Wall-e (o eco não gasta a resposta do dia). Primeiro, antes de haver entradas de outras
    // empresas na fila (o worker do harness processa a fila inteira).
    const L = await empresa("limite", { limites: { respostasPor24h: 1 }, wallE: { ativo: true } });
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    const porta: PortaWallE = { async responder() { return { saidas: [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }], contexto: {} as never, passagem: null }; } };
    const deps = { interpretar: async () => ({ intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }),
      enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); }, wallE: porta };
    const nL = "5561900006101";
    await receber(L, nL, "Olá");
    assert.equal(await eco(L, nL, cod("wamid.L1")), "MENSAGEM");
    assert.equal(await eco(L, nL, cod("wamid.L2")), "MENSAGEM");
    await L.worker.processarLote(deps, { maxTarefas: 20 });
    assert.deepEqual(envios.filter((x) => x.contato === nL).map((x) => (x.conteudo.tipo === "TEXTO" ? x.conteudo.texto : x.conteudo.tipo)), ["Resposta sintética do Wall-e"], "E12: dois ecos não esgotam o limite de 1 resposta");
    assert.notDeepEqual((await conversa(L.e, nL)).passagem?.motivos, ["LIMITE_DIARIO"], "E12: sem silêncio por limite");

    const A = await empresa("A"), B = await empresa("B");
    // Teto mensal (135): o eco nunca reserva consumo. Sem a tabela, reservarConsumo falharia (e o teste também).
    assert.equal(await q("SELECT to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NOT NULL AS e").then((r) => r.rows[0].e), tem117, "135 presente no 131 e ausente no 112");
    const temConsumo = (await q("SELECT to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NOT NULL AS e")).rows[0].e as boolean;
    const consumo = async () => temConsumo ? Number((await q("SELECT coalesce(sum(usadas),0)::int AS n FROM whatsapp_atendimento_consumo_mensal WHERE empresa_id = ANY($1::uuid[])", [[A.e, B.e]])).rows[0].n) : 0;
    const consumo0 = await consumo();

    // E1 — eco com conversa existente.
    const n1 = "5561900006201";
    await receber(A, n1, "Quero orçamento");
    const cv1 = await conversa(A.e, n1);
    const antes1 = await retratoConversa(cv1.id);
    const w1 = cod("wamid.E1-"), t1 = seg(Date.now() - 60_000);
    assert.equal(await eco(A, n1, w1, t1), "MENSAGEM", "E1: grava no histórico");
    const linha1 = (await q("SELECT * FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND fonte->>'id' = $2", [cv1.id, w1])).rows;
    assert.equal(linha1.length, 1);
    assert.equal(linha1[0].direcao, "SAIDA"); assert.equal(linha1[0].estado, "ENTREGUE");
    assert.equal(linha1[0].provedor_id, null, "E1: sem provedor_id (status nunca casa)"); assert.equal(linha1[0].externa_id, null); assert.equal(linha1[0].autor_usuario_id, null);
    assert.deepEqual(linha1[0].fonte, { tipo: "APP_WHATSAPP", id: w1 });
    assert.equal(String(linha1[0].versao_conversa), String(cv1.versao), "E1: versão atual, sem incremento");
    assert.equal(new Date(linha1[0].criada_em).getTime(), t1, "E1: hora do eco");
    assert.equal(await retratoConversa(cv1.id), antes1, "E1: conversa idêntica (estado, versão, datas, contexto)");
    const tela1 = await A.servico.listarAtendimento(A.gestao as never, cv1.id);
    assert.deepEqual(tela1.mensagens.filter((m) => m.origem === "APP_WHATSAPP").map((m) => m.texto), ["Resposta sintética pelo app"], "E1: a tela vê a origem do app");
    assert.ok(tela1.mensagens.filter((m) => m.direcao === "ENTRADA").every((m) => m.origem == null), "E1: entradas sem origem");
    assert.equal(await eco(A, n1, w1, t1), "NADA", "E1: reentrega não duplica");
    // Eco do futuro (relógio da Meta adiantado): criada_em fica no relógio do banco.
    const wF = cod("wamid.E1F-");
    assert.equal(await eco(A, n1, wF, seg(Date.now() + 120_000)), "MENSAGEM");
    assert.ok(new Date((await q("SELECT criada_em FROM whatsapp_atendimento_mensagens WHERE fonte->>'id' = $1", [wF])).rows[0].criada_em).getTime() <= Date.now() + 1000, "E1: LEAST(t, agora)");
    // Corrida: 6 recepções do mesmo eco ao mesmo tempo → uma mensagem.
    const wC = cod("wamid.E1C-");
    const corrida = await Promise.all(Array.from({ length: 6 }, () => eco(A, n1, wC)));
    assert.deepEqual(corrida.filter((d) => d === "MENSAGEM").length, 1, `E1: corrida ${JSON.stringify(corrida)}`);
    assert.equal(await nEcos(A.e, wC), 1);
    assert.equal(await retratoConversa(cv1.id), antes1, "E1: conversa ainda idêntica");

    // E2 — sem conversa: só o hash; nenhuma conversa criada; a conversa nova não recebe o retry.
    const n2 = "5561900006202", w2 = cod("wamid.E2-");
    const conversasAntes = Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_conversas WHERE empresa_id = $1", [A.e])).rows[0].n);
    assert.equal(await eco(A, n2, w2), "SO_HASH", "E2: sem conversa, só hash");
    assert.equal(Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_conversas WHERE empresa_id = $1", [A.e])).rows[0].n), conversasAntes, "E2: nenhuma conversa criada");
    assert.equal(await nHash(A.e, hashEco(w2)), 1, "E2: hash eco:");
    await receber(A, n2, "Oi, cheguei agora");
    assert.equal(await eco(A, n2, w2), "NADA", "E2: retry não entra na conversa criada depois");
    assert.equal(await nEcos(A.e, w2), 0);

    // E3 — conversa ENCERRADA por PARAR: histórico sim, estado não muda; conteúdo sem texto.
    const n3 = "5561900006203";
    await receber(A, n3, "PARAR");
    const cv3 = await conversa(A.e, n3);
    const antes3 = await retratoConversa(cv3.id);
    assert.equal(await eco(A, n3, cod("wamid.E3-"), seg(Date.now() - 2000), null), "MENSAGEM", "E3: eco sem texto (mídia) entra");
    assert.equal(await retratoConversa(cv3.id), antes3, `E3: conversa ${cv3.estado} idêntica`);
    assert.equal((await q("SELECT texto FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND fonte->>'tipo' = 'APP_WHATSAPP'", [cv3.id])).rows[0].texto, null);

    // E4 — chave desligada.
    const ecosA = await nEcos(A.e), eventosA = await nEventos(A.e);
    assert.equal(await eco(A, n1, cod("wamid.E4-"), undefined, "x", {} as NodeJS.ProcessEnv), "NADA");
    assert.equal(await eco(A, "5561900006204", cod("wamid.E4-"), undefined, "x", { WHATSAPP_ATENDIMENTO_ECOS_META: "1" } as unknown as NodeJS.ProcessEnv), "NADA");
    assert.equal(await nEcos(A.e), ecosA, "E4: nenhuma mensagem"); assert.equal(await nEventos(A.e), eventosA, "E4: nenhum hash");

    // E5 — R5-3: sem atalho pelo hash.
    const n5 = "5561900006205", w5 = cod("wamid.E5-");
    await receber(A, n5, "Mensagem das 10h00", Date.now() - 10 * 60_000);
    const t5 = seg(Date.now() - 5 * 60_000); // "10h05"
    await q(`CREATE FUNCTION teste_falha_eco() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.fonte->>'id' = '${w5}' THEN RAISE EXCEPTION 'falha sintética do eco'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER teste_falha_eco AFTER INSERT ON whatsapp_atendimento_mensagens FOR EACH ROW EXECUTE FUNCTION teste_falha_eco()");
    await assert.rejects(eco(A, n5, w5, t5), /falha sintética do eco/);
    await q("DROP TRIGGER teste_falha_eco ON whatsapp_atendimento_mensagens"); await q("DROP FUNCTION teste_falha_eco()");
    assert.equal(await nEcos(A.e, w5), 0, "E5.1: nenhuma mensagem"); assert.equal(await nHash(A.e, hashEco(w5)), 0, "E5.1: nenhum hash");
    const cv5 = await conversa(A.e, n5);
    await A.privacidade.excluirConversaAPedido(A.gestao as never, { conversaId: cv5.id, motivo: "PEDIDO_DO_TITULAR" });
    const corte5 = (await q("SELECT excluido_em FROM whatsapp_atendimento_eventos_excluidos WHERE empresa_id = $1 AND evento_sha256 = $2", [A.e, hashCorte(n5)])).rows;
    assert.equal(corte5.length, 1, "E5.2: corte gravado na exclusão");
    assert.ok(!JSON.stringify(corte5).includes(n5), "E5.2: corte sem o contato");
    await receber(A, n5, "Mensagem das 10h00 entregue com atraso", Date.now() - 10 * 60_000 + 1);
    assert.ok(await conversa(A.e, n5), "E5.3: a ENTRADA antiga recriou a conversa");
    assert.equal(await eco(A, n5, w5, t5), "SO_HASH", "E5.4: retry do eco anterior à exclusão não entra");
    assert.equal(await nEcos(A.e, w5), 0); assert.equal(await nHash(A.e, hashEco(w5)), 1, "E5.4: só o hash");
    const corteMs = new Date(corte5[0].excluido_em).getTime();
    const primeiroAceito = Math.floor(corteMs / 1000) * 1000 + 3000; // primeiro segundo inteiro > corte + 2 s (com fração; T+3 s)
    const igual = Math.floor(corteMs / 1000) * 1000 + 2000;
    assert.equal(await eco(A, n5, cod("wamid.E5b-"), igual), "SO_HASH", "E5: floor(corte) + 2 s não entra");
    assert.equal(await eco(A, n5, cod("wamid.E5c-"), primeiroAceito), "MENSAGEM", "E5: primeiro segundo inteiro depois de corte + 2 s entra");

    // E6 — exclusão depois do eco (a outra ordem).
    const n6 = "5561900006206", w6 = cod("wamid.E6-");
    await receber(A, n6, "Oi");
    assert.equal(await eco(A, n6, w6), "MENSAGEM");
    await A.privacidade.excluirConversaAPedido(A.gestao as never, { conversaId: (await conversa(A.e, n6)).id, motivo: "PEDIDO_DO_TITULAR" });
    assert.equal(await nEcos(A.e, w6), 0, "E6: o eco sai com a conversa");
    assert.equal(await nHash(A.e, hashEco(w6)), 1, "E6: o id do eco vira hash eco: (mesma expressão em SQL e em TypeScript)");
    assert.equal(await eco(A, n6, w6), "NADA", "E6: retry sem conversa: nada (hash já existe)");
    await receber(A, n6, "Voltei");
    assert.equal(await eco(A, n6, w6), "NADA", "E6: retry com a conversa recriada: nada");
    assert.equal(await nEcos(A.e, w6), 0);

    // E7 — fronteiras do corte (R6-4): T inteiro, corte em T.000 / T.100 / T.999, eco em T+2 s e T+3 s.
    const T = seg(Date.now() - 3600_000);
    for (const [i, frac, em2, em3] of [[0, 0, "SO_HASH", "MENSAGEM"], [1, 100, "SO_HASH", "MENSAGEM"], [2, 999, "SO_HASH", "MENSAGEM"]] as const) {
      const n = `556190000630${i}`;
      await receber(A, n, "Oi");
      await q("INSERT INTO whatsapp_atendimento_eventos_excluidos (empresa_id, ambiente, provedor, evento_sha256, excluido_em) VALUES ($1, 'staging', 'GUPSHUP', $2, to_timestamp($3::bigint / 1000.0))", [A.e, hashCorte(n), T + frac]);
      assert.equal(await eco(A, n, cod("wamid.E7-"), T + 1000), "SO_HASH", `E7 T.${frac}: T+1 s cortado`);
      assert.equal(await eco(A, n, cod("wamid.E7-"), T + 2000), em2, `E7 T.${frac}: T+2 s (igualdade em T.000) cortado`);
      assert.equal(await eco(A, n, cod("wamid.E7-"), T + 3000), em3, `E7 T.${frac}: T+3 s entra`);
    }
    // Fração muda o resultado só onde deve: corte em T.999 e eco em T+2.999 s não existe (segundos inteiros); corte em
    // T+1.000 corta T+3 s (igualdade), corte em T+0.999 não.
    {
      const n = "5561900006303";
      await receber(A, n, "Oi");
      await q("INSERT INTO whatsapp_atendimento_eventos_excluidos (empresa_id, ambiente, provedor, evento_sha256, excluido_em) VALUES ($1, 'staging', 'GUPSHUP', $2, to_timestamp($3::bigint / 1000.0))", [A.e, hashCorte(n), T + 1000]);
      assert.equal(await eco(A, n, cod("wamid.E7-"), T + 3000), "SO_HASH", "E7: corte T+1.000, eco T+3 s (igualdade) cortado");
      assert.equal(await eco(A, n, cod("wamid.E7-"), T + 4000), "MENSAGEM", "E7: corte T+1.000, eco T+4 s entra");
    }

    // Trava da conversa segurada pela conexão A (para E8 e E9).
    async function comConversaTravada<T>(convId: string, enquanto: (recepcao: Promise<unknown>) => Promise<T>, recepcao: () => Promise<unknown>) {
      const a = await conectarDescartavel({ travar: false });
      try {
        await a.query("BEGIN");
        await a.query("SELECT 1 FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [convId]);
        const p = recepcao();
        p.catch(() => {});
        for (let i = 0; ; i++) {
          const n = Number((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'")).rows[0].n);
          if (n > 0) break;
          if (i > 200) throw new Error("a recepção não ficou presa na trava");
          await esperar(25);
        }
        const r = await enquanto(p);
        await a.query("ROLLBACK");
        return { r, decisao: await p };
      } finally { await a.end(); }
    }

    // E8 — corte gravado e purga rodada enquanto a recepção espera (eco bem dentro da janela): só o hash.
    const n8 = "5561900006208", w8 = cod("wamid.E8-");
    await receber(A, n8, "Oi");
    const cv8 = await conversa(A.e, n8);
    const e8 = await comConversaTravada(cv8.id, async () => {
      await q("INSERT INTO whatsapp_atendimento_eventos_excluidos (empresa_id, ambiente, provedor, evento_sha256) VALUES ($1, 'staging', 'GUPSHUP', $2)", [A.e, hashCorte(n8)]);
      return A.privacidade.executarRetencao();
    }, () => eco(A, n8, w8, seg(Date.now() - 60_000)));
    assert.equal(e8.decisao, "SO_HASH", "E8: o corte gravado durante a espera vale (lido depois da trava)");
    assert.equal(await nEcos(A.e, w8), 0); assert.equal(await nHash(A.e, hashEco(w8)), 1);
    assert.equal(await nHash(A.e, hashCorte(n8)), 1, "E8: a purga não apagou o corte recente");

    // E9 — idade: sem corte, o limite de 29 dias é atravessado durante a espera → zero gravações.
    const n9 = "5561900006209", w9 = cod("wamid.E9-");
    await receber(A, n9, "Oi");
    const cv9 = await conversa(A.e, n9);
    const t9 = seg(Date.now() - 29 * DIA + 2000); // ainda dentro ao chamar; fora depois de ~2 s presa
    const eventos9 = await nEventos(A.e);
    const e9 = await comConversaTravada(cv9.id, () => esperar(3000), () => eco(A, n9, w9, t9));
    assert.equal(e9.decisao, "NADA", "E9: limite atravessado na espera: nada");
    assert.equal(await nEcos(A.e, w9), 0); assert.equal(await nEventos(A.e), eventos9, "E9: zero hashes");
    const mensagens9 = await nMensagens(A.e);
    assert.equal(await eco(A, n9, cod("wamid.E9b-"), seg(Date.now() - 29 * DIA - 1000)), "NADA", "E9: 29 d + 1 s com conversa e sem corte: nada");
    assert.equal(await eco(A, n9, cod("wamid.E9c-"), Date.now() - 29 * DIA), "NADA", "E9: 29 d no instante da chamada: nada");
    assert.equal(await nMensagens(A.e), mensagens9, "E9: 29 d + 1 s e 29 d exatos: zero mensagens"); assert.equal(await nEventos(A.e), eventos9, "E9: 29 d + 1 s e 29 d exatos: zero hashes");
    assert.equal(await eco(A, n9, cod("wamid.E9d-"), seg(Date.now() - 29 * DIA + 60_000)), "MENSAGEM", "E9: 29 d − 1 min entra");
    const eventos9b = await nEventos(A.e);
    assert.equal(await eco(A, "5561900006210", cod("wamid.E9e-"), seg(Date.now() - 29 * DIA - 3600_000)), "NADA", "E9: sem conversa a 29 d + 1 h: nada");
    assert.equal(await nEventos(A.e), eventos9b, "E9: sem conversa a 29 d + 1 h: zero hashes");

    // E10 — colisão: saída da API primeiro, eco com o mesmo id depois.
    const n10 = "5561900006211";
    await receber(A, n10, "Oi");
    let cv10 = await conversa(A.e, n10);
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "assumir", conversaId: cv10.id, versao: Number(cv10.versao) });
    cv10 = await conversa(A.e, n10);
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "enviar", conversaId: cv10.id, versao: Number(cv10.versao), texto: "Resposta sintética pela API" });
    const enviosA: string[] = [];
    await A.worker.processarLote({ interpretar: async () => { throw new Error("sem modelo"); }, enviar: async () => { const g = cod("wamid.API-"); enviosA.push(g); return g; } }, { maxTarefas: 30 });
    const api = (await q("SELECT id, provedor_id, estado FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND provedor_id IS NOT NULL", [cv10.id])).rows[0];
    assert.ok(api?.provedor_id, "E10: saída da API com provedor_id");
    const anomalias = contadorAnomaliasStatus(), antes10 = await retratoConversa(cv10.id);
    assert.equal(await eco(A, n10, api.provedor_id), "NADA", "E10: id de saída da API: o eco não grava");
    assert.equal(await nEcos(A.e, api.provedor_id), 0); assert.equal(await nHash(A.e, hashEco(api.provedor_id)), 0, "E10: nem hash");
    assert.equal(contadorAnomaliasStatus(), anomalias + 1, "E10: anomalia ECO_COM_ID_DE_SAIDA contada");
    assert.equal(await retratoConversa(cv10.id), antes10);
    if (tem117) {
      assert.equal(Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_status_colisoes WHERE ambiente = 'staging' AND provedor_id = $1", [api.provedor_id])).rows[0].n), 1, "E10: marca de colisão (117)");
      await A.servico.registrarStatus(A.e, api.provedor_id, "FALHOU");
      assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id = $1", [api.id])).rows[0].estado, api.estado, "E10: com a marca, failed posterior não muda a saída");
    }

    // E11 — status antes e depois do eco não mexem no eco.
    const n11 = "5561900006212", w11 = cod("wamid.E11-");
    await receber(A, n11, "Oi");
    await A.servico.registrarStatus(A.e, w11, "FALHOU");
    assert.equal(await eco(A, n11, w11), "MENSAGEM", "E11: status anterior não bloqueia");
    await A.servico.registrarStatus(A.e, w11, "FALHOU");
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE fonte->>'id' = $1", [w11])).rows[0].estado, "ENTREGUE", "E11: eco continua ENTREGUE");

    // E12b — Resultado não conta o eco.
    const nR = "5561900006213";
    await receber(A, nR, "Oi");
    const r0 = await A.resultadoAtendimento(A.gestao as never, new Date());
    assert.equal(await eco(A, nR, cod("wamid.R-")), "MENSAGEM");
    assert.equal(await eco(A, "5561900006214", cod("wamid.R-")), "SO_HASH");
    assert.deepEqual(await A.resultadoAtendimento(A.gestao as never, new Date()), r0, "E12: Resultado idêntico com o eco");

    // E13 — isolamento: mesmo contato e mesmo id em A e B.
    const n13 = "5561900006215", w13 = cod("wamid.E13-");
    await receber(A, n13, "Oi A"); await receber(B, n13, "Oi B");
    assert.equal(await eco(A, n13, w13), "MENSAGEM");
    assert.equal(await eco(B, n13, w13), "MENSAGEM", "E13: o hash e a deduplicação de A não alcançam B");
    await A.privacidade.excluirConversaAPedido(A.gestao as never, { conversaId: (await conversa(A.e, n13)).id, motivo: "PEDIDO_DO_TITULAR" });
    assert.equal(await nEcos(B.e, w13), 1, "E13: exclusão em A não toca B");
    assert.equal(await eco(B, n13, cod("wamid.E13b-"), seg(Date.now() - 60_000)), "MENSAGEM", "E13: o corte de A não corta B");
    assert.equal(await A.servico.receberEco({ id: cod("wamid.E13c-"), contato: n13, texto: "x", timestamp: Date.now() }, { empresa: B.e, env: LIGADA }), "NADA", "E13: o harness de A (piloto A) não grava em B");

    assert.equal(await consumo(), consumo0, "E12: nenhum eco reservou consumo do teto mensal");

    // E14 — retenção (lote de 1): o eco recente não segura a conversa antiga; o retry não volta.
    const n14 = "5561900006216", w14 = cod("wamid.E14-");
    await receber(B, n14, "Oi antigo");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE estado = 'PENDENTE' AND empresa_id = $1", [B.e]);
    await q("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '40 days', atualizada_em = clock_timestamp() - interval '40 days' WHERE empresa_id = $1", [B.e]);
    await q("UPDATE whatsapp_atendimento_mensagens SET criada_em = clock_timestamp() - interval '40 days' WHERE empresa_id = $1", [B.e]);
    assert.equal(await eco(B, n14, w14), "MENSAGEM");
    await B.privacidade.configurarRetencao(B.gestao as never, { prazoDias: 30 });
    const r14 = await B.privacidade.executarRetencao({ limitePorEmpresa: 1 });
    assert.ok(r14.estado === "CONCLUIDA" || r14.estado === "CONCLUIDA_COM_FALHAS", JSON.stringify(r14));
    for (let i = 0; i < 5 && (await conversa(B.e, n14)); i++) await B.privacidade.executarRetencao({ limitePorEmpresa: 1 });
    assert.equal(await conversa(B.e, n14), undefined, "E14: o eco recente não é atividade: a conversa antiga sai");
    assert.equal(await nHash(B.e, hashEco(w14)), 1, "E14: hash eco: gravado na retenção");
    assert.equal(await eco(B, n14, w14), "NADA", "E14: retry não volta");
    await B.privacidade.configurarRetencao(B.gestao as never, { prazoDias: null });

    // E15 — caminho real do webhook: receberEventosMeta resolve a empresa pelo número CONFIGURADO, grava as entradas e
    // DEPOIS os ecos do mesmo lote (a entrada cria a conversa, o eco da resposta entra nela); chave desligada: ignorado.
    const temConexoes = (await q("SELECT 1 FROM information_schema.columns WHERE table_name='whatsapp_conexoes' AND column_name='empresa_id'")).rows.length > 0;
    if (temConexoes) {
      const envAntes = { ...process.env };
      Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), WHATSAPP_CREDENTIAL_KEY_VERSION: "1", KIDMAIS_DEPLOY_ENV: "staging" });
      try {
        const waba = "29" + String(Date.now()).slice(-8), numero = "39" + String(Date.now()).slice(-8);
        const cifra = credencial.cifrarCredencialWhatsapp("token-sintetico-ecos", { ambiente: "STAGING", appId: "1622943079270352", businessId: "1591095999057604", wabaId: waba, phoneNumberId: numero, empresaId: A.e });
        await q(`WITH instante AS (SELECT clock_timestamp() AS agora)
          INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
          SELECT 'STAGING',$1::uuid,'1622943079270352','1591095999057604',$2,$3,'+55 61 90000-0000','Buffet sintético',true,'CONFIGURADA',ARRAY['whatsapp_business_messaging'],$4,$5,$6,$7,'bearer',NULL,agora,$8::uuid,$9::uuid,agora,agora FROM instante`,
          [A.e, waba, numero, cifra.ciphertext, cifra.iv, cifra.tag, cifra.keyVersion, A.gestao.usuario_id, randomUUID()]);
        const ecosA15 = await nEcos(A.e);
        const meta = carregarComponente("lib/whatsapp/atendimento/meta.ts", {
          "../../db/postgres.ts": { db, withTransaction }, "../credencial.ts": credencial, "./configuracao.ts": { ...configuracaoReal, ambienteAtendimento: () => "staging", empresaPiloto: () => A.e },
          "./core.ts": core, "./service.ts": A.servico, "./transporte.ts": transporteSemRede, "./multiempresa.ts": multiempresa,
        }).modulo as typeof import("./meta.ts");
        const n15 = "5561900006217", w15 = cod("wamid.E15-"), agora15 = seg(Date.now() - 3000);
        const lote = (wEco: string, wIn: string) => ({
          entradas: [{ phoneNumberId: numero, wabaId: waba, id: wIn, contato: n15, texto: "Oi pelo webhook", timestamp: agora15 - 1000, nomePerfil: null }],
          status: [], ecos: [{ phoneNumberId: numero, wabaId: waba, id: wEco, contato: n15, texto: "Resposta pelo app", timestamp: agora15 }],
        }) as unknown as Parameters<typeof meta.receberEventosMeta>[0];
        delete process.env.WHATSAPP_ATENDIMENTO_ECOS_META;
        const wDesligada = cod("wamid.E15off-");
        await meta.receberEventosMeta(lote(wDesligada, cod("wamid.IN15a-")));
        assert.ok(await conversa(A.e, n15), "E15: a entrada do lote criou a conversa");
        assert.equal(await nEcos(A.e, wDesligada), 0, "E15: chave desligada, eco ignorado");
        process.env.WHATSAPP_ATENDIMENTO_ECOS_META = "true";
        await meta.receberEventosMeta(lote(w15, cod("wamid.IN15b-")));
        assert.equal(await nEcos(A.e, w15), 1, "E15: eco do lote gravado na conversa da empresa dona do número");
        await meta.receberEventosMeta({ ...lote(cod("wamid.E15x-"), cod("wamid.IN15c-")), entradas: [], ecos: [{ phoneNumberId: "3999999999", wabaId: waba, id: cod("wamid.E15x-"), contato: n15, texto: "x", timestamp: agora15 }] } as never);
        assert.equal(await nEcos(A.e), ecosA15 + 1, "E15: número desconhecido não grava");
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in envAntes)) delete process.env[k];
        Object.assign(process.env, envAntes);
      }
    }
  } finally {
    await c.end();
  }
});

