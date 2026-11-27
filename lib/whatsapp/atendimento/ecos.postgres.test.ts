import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { SIGNATURE_HEADER, receberWebhookMeta } from "../../integracoes/meta/webhook.ts";
import { hashCorte, hashEco } from "./service.ts";
import { setTimeout as esperar } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import { carregarAtendimento, cod, db, noPrazo, transporteSemRede, withTransaction } from "./harness-postgres.ts";
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
    // R1-1: o eco só grava com o número CONFIGURADO da empresa (conferido sob trava). Cada empresa sintética recebe uma
    // conexão própria (credencial sintética: ninguém decifra aqui; o envio do harness é injetado).
    const temConexoes = (await q("SELECT 1 FROM information_schema.columns WHERE table_name='whatsapp_conexoes' AND column_name='empresa_id'")).rows.length > 0;
    let seqNumero = 0;
    async function conectar(e: string, usuario: string, numero: string, waba: string) {
      await q(`WITH instante AS (SELECT clock_timestamp() AS agora)
        INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
        SELECT 'STAGING',$1::uuid,'1622943079270352','1591095999057604',$2,$3,'+55 61 90000-0000','Buffet sintético',true,'CONFIGURADA',ARRAY['whatsapp_business_messaging'],$4,$5,$6,1,'bearer',NULL,agora,$7::uuid,$8::uuid,agora,agora FROM instante`,
        [e, waba, numero, randomBytes(48), randomBytes(12), randomBytes(16), usuario, randomUUID()]);
    }
    const desconectar = (e: string, usuario: string, cx: { query: typeof q } = { query: q }) =>
      cx.query("UPDATE whatsapp_conexoes SET status='DESCONECTADA',desconectada_em=clock_timestamp(),desconectada_por_usuario_id=$2,motivo_desconexao='revogação sintética',revisao=revisao+1,atualizada_em=clock_timestamp() WHERE empresa_id=$1 AND status='CONFIGURADA'", [e, usuario]);
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
      seqNumero += 1;
      const numero = "39" + String(Date.now()).slice(-7) + seqNumero, waba = "29" + String(Date.now()).slice(-7) + seqNumero;
      if (temConexoes) await conectar(e, u, numero, waba);
      return { e, gestao, resultadoAtendimento, numero, waba, ...h };
    }
    type Emp = Awaited<ReturnType<typeof empresa>>;
    const receber = (h: Emp, contato: string, texto: string, timestamp = Date.now() - 1000) =>
      h.servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp, nomePerfil: null });
    const eco = (h: Emp, contato: string, wamid: string, timestamp = seg(Date.now() - 5000), texto: string | null = "Resposta sintética pelo app", env = LIGADA) =>
      h.servico.receberEco({ id: wamid, contato, texto, timestamp }, { empresa: h.e, numero: { phoneNumberId: h.numero, wabaId: h.waba }, env });
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
      // E0 (P2 do 2º parecer): POST assinado só com ecos, chave ligada, esquema sem a 083/082 → 200 e zero gravações.
      const meta0 = carregarComponente("lib/whatsapp/atendimento/meta.ts", {
        "../../db/postgres.ts": { db, withTransaction }, "../credencial.ts": credencial, "./configuracao.ts": { ...configuracaoReal, ambienteAtendimento: () => "staging", empresaPiloto: () => Z.e },
        "./core.ts": core, "./service.ts": Z.servico, "./transporte.ts": transporteSemRede, "./multiempresa.ts": multiempresa,
      }).modulo as typeof import("./meta.ts");
      const segredo = "synthetic-meta-app-secret-not-real-0001";
      const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1555933295860010", changes: [{ field: "smb_message_echoes", value: {
        messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: "1317246918141796" },
        message_echoes: [{ from: "5561999990000", to: n0, id: cod("wamid.Z0-"), timestamp: String(Math.floor(Date.now() / 1000) - 5), type: "text", text: { body: "Resposta pelo app" } }] } }] }] });
      const pedido = new Request("https://staging.example/api/integracoes/meta/webhook", { method: "POST", headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: "sha256=" + createHmac("sha256", segredo).update(corpo).digest("hex") }, body: corpo });
      const mensagensPost = await nMensagens(Z.e);
      const chaveAntes = process.env.WHATSAPP_ATENDIMENTO_ECOS_META;
      process.env.WHATSAPP_ATENDIMENTO_ECOS_META = "true";
      try {
        const resp = await receberWebhookMeta(pedido, { META_APP_SECRET: segredo, KIDMAIS_DEPLOY_ENV: "staging" } as never, () => {}, (e) => meta0.receberEventosMeta(e));
        assert.equal(resp.status, 200, "E0: POST só de ecos sem a 083: 200 (sem 503)");
      } finally { if (chaveAntes === undefined) delete process.env.WHATSAPP_ATENDIMENTO_ECOS_META; else process.env.WHATSAPP_ATENDIMENTO_ECOS_META = chaveAntes; }
      assert.equal(await nMensagens(Z.e), mensagensPost, "E0: POST: zero gravações");
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
    // Relógio fixo da decisão (R1-5 e R2-3): a transação do serviço troca o clock_timestamp() da CTE por instanteFixo.
    let instanteFixo = 0, trocasRelogio = 0;
    const relogioFixo = {
      db,
      withTransaction: <R,>(fn: Parameters<typeof withTransaction<R>>[0]) => withTransaction<R>((tx) => fn(new Proxy(tx, {
        get(alvo, k) {
          if (k === "query") return (sql: unknown, v?: unknown[]) => {
            let s = sql;
            if (typeof s === "string" && s.includes("SELECT clock_timestamp() AS agora, to_timestamp($5")) {
              trocasRelogio += 1;
              s = s.replace("SELECT clock_timestamp() AS agora", () => "SELECT '" + new Date(instanteFixo).toISOString() + "'::timestamptz AS agora");
            }
            return (alvo.query as (a: unknown, b?: unknown[]) => unknown).call(alvo, s, v);
          };
          const val = (alvo as unknown as Record<string | symbol, unknown>)[k];
          return typeof val === "function" ? (val as (...a: unknown[]) => unknown).bind(alvo) : val;
        },
      }))),
    } as unknown as Parameters<typeof carregarAtendimento>[4];
    const F = carregarAtendimento(A.e, "staging", {}, tetoMensal, relogioFixo);

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
    // Eco do futuro (R1-2): adiantado dentro de DESVIO_FUTURO_MS entra com criada_em no relógio do banco (LEAST);
    // adiantado além disso (2 min) é descartado: nem mensagem, nem hash.
    // R2-3: com o relógio da CTE fixo, criada_em é exatamente o instante da decisão.
    const fixoF = seg(Date.now()) - 10_000 + 123, trocasF = trocasRelogio;
    instanteFixo = fixoF;
    const ecoF = (wamid: string, t: number) => F.servico.receberEco({ id: wamid, contato: n1, texto: "Resposta sintética pelo app", timestamp: t }, { empresa: A.e, numero: { phoneNumberId: A.numero, wabaId: A.waba }, env: LIGADA });
    const wF = cod("wamid.E1F-");
    assert.equal(await ecoF(wF, fixoF + 1500), "MENSAGEM", "E1: 1,5 s adiantado (dentro do desvio) entra");
    assert.ok(trocasRelogio > trocasF, "E1: o relógio da CTE foi de fato fixado");
    const criadaF = new Date((await q("SELECT criada_em FROM whatsapp_atendimento_mensagens WHERE fonte->>'id' = $1", [wF])).rows[0].criada_em).getTime();
    assert.equal(criadaF, fixoF, "E1: LEAST(t, agora) = instante da decisão");
    const wF2 = cod("wamid.E1F2-"), eventosF = await nEventos(A.e), mensagensF = await nMensagens(A.e);
    assert.equal(await ecoF(cod("wamid.E1F3-"), fixoF + 2001), "NADA", "E1: desvio + 1 ms (relógio fixo): descartado");
    assert.equal(await eco(A, n1, wF2, seg(Date.now() + 120_000)), "NADA", "E1: 2 min adiantado: descartado");
    assert.equal(await nMensagens(A.e), mensagensF, "E1: adiantado: zero mensagens"); assert.equal(await nEventos(A.e), eventosF, "E1: adiantado: zero hashes");
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
    // R1-2: o corte é de agora; o primeiro segundo aceito fica ~3 s no futuro. Espera até ele caber no desvio admitido
    // (≤ 1 s adiantado), para a fronteira testada ser só a do corte.
    while (Date.now() < primeiroAceito - 1000) await esperar(100);
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
    // R1-5: 29 d exatos com o relógio da decisão FIXO (a transação do serviço troca o clock_timestamp() da CTE por um
    // instante conhecido, com milissegundos): t = agora − 29 d → NADA, zero mensagens e zero hashes; t + 1 ms entra.
    const fixo = seg(Date.now()) - 10_000 + 123;
    instanteFixo = fixo;
    const ecoFixo = (wamid: string, t: number) => F.servico.receberEco({ id: wamid, contato: n9, texto: "x", timestamp: t }, { empresa: A.e, numero: { phoneNumberId: A.numero, wabaId: A.waba }, env: LIGADA });
    const trocasE9 = trocasRelogio; // R3-2: o incremento tem de vir desta chamada, não de E1.
    assert.equal(await ecoFixo(cod("wamid.E9c-"), fixo - 29 * DIA), "NADA", "E9 (R1-5): t = agora − 29 d exatos (relógio fixo): nada");
    assert.ok(trocasRelogio > trocasE9, "E9 (R1-5): o relógio da CTE foi de fato fixado nesta chamada");
    assert.equal(await nMensagens(A.e), mensagens9, "E9: 29 d + 1 s e 29 d exatos: zero mensagens"); assert.equal(await nEventos(A.e), eventos9, "E9: 29 d + 1 s e 29 d exatos: zero hashes");
    // Sem conversa: t = agora − 29 d → NADA e zero hashes (dentro da janela seria SO_HASH); + 1 ms → SO_HASH.
    const ecoFixoSem = (wamid: string, t: number) => F.servico.receberEco({ id: wamid, contato: "5561900006225", texto: "x", timestamp: t }, { empresa: A.e, numero: { phoneNumberId: A.numero, wabaId: A.waba }, env: LIGADA });
    const trocasAntes = trocasRelogio;
    assert.equal(await ecoFixoSem(cod("wamid.E9s-"), fixo - 29 * DIA), "NADA", "E9 (R1-5): sem conversa, 29 d exatos: nada");
    assert.ok(trocasRelogio > trocasAntes, "E9 (R1-5): relógio fixado também sem conversa");
    assert.equal(await nEventos(A.e), eventos9, "E9 (R1-5): sem conversa, 29 d exatos: zero hashes");
    assert.equal(await ecoFixoSem(cod("wamid.E9s2-"), fixo - 29 * DIA + 1), "SO_HASH", "E9 (R1-5): sem conversa, 29 d − 1 ms: só hash");
    assert.equal(await ecoFixo(cod("wamid.E9c2-"), fixo - 29 * DIA + 1), "MENSAGEM", "E9 (R1-5): agora − 29 d + 1 ms entra");
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
    const t10 = seg(Date.now() - 5000);
    assert.equal(await eco(A, n10, api.provedor_id, t10), "NADA", "E10: id de saída da API: o eco não grava");
    assert.equal(await nEcos(A.e, api.provedor_id), 0); assert.equal(await nHash(A.e, hashEco(api.provedor_id)), 0, "E10: nem hash");
    assert.equal(contadorAnomaliasStatus(), anomalias + 1, "E10: anomalia ECO_COM_ID_DE_SAIDA contada");
    assert.equal(await retratoConversa(cv10.id), antes10);
    // R3-1: reentrega do mesmo eco (mesmo wamid e timestamp) antes do failed: nada gravado; com a 117 a marca já vigente
    // não conta de novo (sem a 117 não há onde lembrar e cada entrega conta).
    assert.equal(await eco(A, n10, api.provedor_id, t10), "NADA", "E10 (R3-1): reentrega da colisão: nada");
    assert.equal(await nEcos(A.e, api.provedor_id), 0, "E10 (R3-1): reentrega: zero mensagens de eco");
    assert.equal(await nHash(A.e, hashEco(api.provedor_id)), 0, "E10 (R3-1): reentrega: zero hashes");
    assert.equal(contadorAnomaliasStatus(), anomalias + (tem117 ? 1 : 2), "E10 (R3-1): reentrega com marca vigente não conta de novo");
    assert.equal(await retratoConversa(cv10.id), antes10, "E10 (R3-1): reentrega não muda a conversa");
    if (tem117) {
      assert.equal(Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_status_colisoes WHERE ambiente = 'staging' AND provedor_id = $1", [api.provedor_id])).rows[0].n), 1, "E10: marca de colisão (117)");
      await A.servico.registrarStatus(A.e, api.provedor_id, "FALHOU");
      assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id = $1", [api.id])).rows[0].estado, api.estado, "E10: com a marca, failed posterior não muda a saída");
    }
    // R2-1: eco FORA da janela (adiantado ou atrasado) com o id de uma saída da API não marca colisão nem conta anomalia;
    // o failed posterior atualiza a saída.
    cv10 = await conversa(A.e, n10);
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "enviar", conversaId: cv10.id, versao: Number(cv10.versao), texto: "Segunda resposta sintética pela API" });
    await A.worker.processarLote({ interpretar: async () => { throw new Error("sem modelo"); }, enviar: async () => { const g = cod("wamid.API2-"); enviosA.push(g); return g; } }, { maxTarefas: 30 });
    const api2 = (await q("SELECT id, provedor_id, estado FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND provedor_id IS NOT NULL AND id <> $2", [cv10.id, api.id])).rows[0];
    assert.ok(api2?.provedor_id, "R2-1: segunda saída da API com provedor_id");
    assert.notEqual(api2.estado, "FALHOU");
    const anomalias2 = contadorAnomaliasStatus(), eventos2 = await nEventos(A.e);
    assert.equal(await eco(A, n10, api2.provedor_id, seg(Date.now() + 120_000)), "NADA", "R2-1: adiantado além do desvio: nada");
    assert.equal(await eco(A, n10, api2.provedor_id, seg(Date.now() - 29 * DIA - 60_000)), "NADA", "R2-1: atrasado além da janela: nada");
    assert.equal(contadorAnomaliasStatus(), anomalias2, "R2-1: fora da janela: sem anomalia de colisão");
    assert.equal(await nEventos(A.e), eventos2, "R2-1: zero hashes");
    if (tem117) assert.equal(Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_status_colisoes WHERE ambiente = 'staging' AND provedor_id = $1", [api2.provedor_id])).rows[0].n), 0, "R2-1: sem marca de colisão");
    await A.servico.registrarStatus(A.e, api2.provedor_id, "FALHOU");
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id = $1", [api2.id])).rows[0].estado, "FALHOU", "R2-1: o failed posterior atualiza a saída");

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
    assert.equal(await A.servico.receberEco({ id: cod("wamid.E13c-"), contato: n13, texto: "x", timestamp: Date.now() }, { empresa: B.e, numero: { phoneNumberId: B.numero, wabaId: B.waba }, env: LIGADA }), "NADA", "E13: o harness de A (piloto A) não grava em B");

    // R1-1 — o dono do número é conferido DENTRO da transação, sob trava da conexão CONFIGURADA.
    if (temConexoes) {
      const C = await empresa("conexão");
      const nC = "5561900006220";
      await receber(C, nC, "Oi C");
      const ecoC = (wamid: string, numero = { phoneNumberId: C.numero, wabaId: C.waba }) =>
        C.servico.receberEco({ id: wamid, contato: nC, texto: "Resposta sintética pelo app", timestamp: seg(Date.now() - 5000) }, { empresa: C.e, numero, env: LIGADA });
      assert.equal(await ecoC(cod("wamid.R11a-")), "MENSAGEM", "R1-1: número CONFIGURADO da empresa: grava");
      const mensagensC = await nMensagens(C.e), eventosC = await nEventos(C.e);
      assert.equal(await ecoC(cod("wamid.R11b-"), { phoneNumberId: B.numero, wabaId: B.waba }), "NADA", "R1-1: número de outra empresa: nada");
      assert.equal(await ecoC(cod("wamid.R11c-"), { phoneNumberId: C.numero, wabaId: B.waba }), "NADA", "R1-1: WABA diferente: nada");
      // Corrida: a desconexão (não commitada) segura a linha; o eco espera e, depois do COMMIT, não grava nada.
      const x = await conectarDescartavel({ travar: false });
      try {
        await x.query("BEGIN");
        await desconectar(C.e, C.gestao.usuario_id, x as never);
        const wR = cod("wamid.R11d-"), p = ecoC(wR);
        p.catch(() => {});
        for (let i = 0; ; i++) {
          const n = Number((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%whatsapp_conexoes%FOR SHARE%'")).rows[0].n);
          if (n > 0) break;
          if (i > 200) throw new Error("R1-1: o eco não esperou a trava da conexão");
          await esperar(25);
        }
        await x.query("COMMIT");
        assert.equal(await p, "NADA", "R1-1: desconexão commitada durante a espera: nada");
        assert.equal(await nEcos(C.e, wR), 0);
      } finally { await x.end(); }
      assert.equal(await ecoC(cod("wamid.R11e-")), "NADA", "R1-1: número desconectado: nada");
      assert.equal(await nMensagens(C.e), mensagensC, "R1-1: zero mensagens"); assert.equal(await nEventos(C.e), eventosC, "R1-1: zero hashes");
    }

    // R1-3 — sem deadlock com quem trava a empresa (FOR UPDATE) e depois a conversa: o eco pega FOR SHARE na empresa
    // ANTES da conversa, então espera na empresa e não segura a conversa.
    {
      const D = await empresa("trava");
      const nD = "5561900006221";
      await receber(D, nD, "Oi D");
      const cvD = await conversa(D.e, nD);
      const x = await conectarDescartavel({ travar: false });
      try {
        await x.query("BEGIN");
        const pidX = Number((await x.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await x.query("SELECT id FROM empresas WHERE id = $1 FOR UPDATE", [D.e]);
        const p = eco(D, nD, cod("wamid.R13-"));
        p.catch(() => {});
        for (let i = 0; ; i++) {
          // R2-4: só a consulta do eco na empresa, bloqueada pela transação x.
          const n = Number((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM empresas WHERE id=$1 AND status=''ATIVA'' FOR SHARE%' AND $1::int = ANY(pg_blocking_pids(pid))", [pidX])).rows[0].n);
          if (n > 0) break;
          if (i > 200) throw new Error("R1-3: o eco não esperou a trava da empresa");
          await esperar(25);
        }
        await noPrazo(x.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [cvD.id]), 5000, "R1-3: conversa livre enquanto o eco espera a empresa");
        await x.query("COMMIT");
        assert.equal(await p, "MENSAGEM", "R1-3: sem 40P01, o eco grava depois do COMMIT");
      } finally { await x.query("ROLLBACK").catch(() => {}); await x.end(); }
    }

    // R2-2 — a empresa fica em FOR SHARE até o commit do eco: um UPDATE comum de status (suspensão) espera o eco terminar,
    // então o ATIVA lido vale até a gravação. Com FOR KEY SHARE a suspensão passaria enquanto o eco espera a conexão.
    if (temConexoes) {
      const S = await empresa("suspensão");
      const nS = "5561900006223";
      await receber(S, nS, "Oi S");
      const y = await conectarDescartavel({ travar: false }), z = await conectarDescartavel({ travar: false });
      try {
        await y.query("BEGIN");
        const pidY = Number((await y.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await y.query("SELECT 1 FROM whatsapp_conexoes WHERE empresa_id = $1::uuid FOR UPDATE", [S.e]);
        const p = eco(S, nS, cod("wamid.R22-"));
        p.catch(() => {});
        for (let i = 0; ; i++) {
          const n = Number((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%whatsapp_conexoes%FOR SHARE%' AND $1::int = ANY(pg_blocking_pids(pid))", [pidY])).rows[0].n);
          if (n > 0) break;
          if (i > 200) throw new Error("R2-2: o eco não esperou a trava da conexão");
          await esperar(25);
        }
        await z.query("BEGIN");
        const pidZ = Number((await z.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        const suspensao = z.query("UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1", [S.e]);
        suspensao.catch(() => {});
        for (let i = 0; ; i++) {
          const n = Number((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pidZ])).rows[0].n);
          if (n > 0) break;
          if (i > 200) throw new Error("R2-2: a suspensão não esperou o eco (empresa sem FOR SHARE)");
          await esperar(25);
        }
        await y.query("COMMIT");
        assert.equal(await p, "MENSAGEM", "R2-2: o eco grava com a empresa ainda ATIVA");
        await noPrazo(suspensao, 5000, "R2-2: a suspensão segue depois do commit do eco");
        await z.query("ROLLBACK");
      } finally {
        await y.query("ROLLBACK").catch(() => {}); await y.end();
        await z.query("ROLLBACK").catch(() => {}); await z.end();
      }
    }

    // R1-2 — conversa recriada depois da exclusão: eco 2 min no futuro não fura o corte (nada, nem hash).
    {
      const n = "5561900006222";
      await receber(A, n, "Oi");
      await A.privacidade.excluirConversaAPedido(A.gestao as never, { conversaId: (await conversa(A.e, n)).id, motivo: "PEDIDO_DO_TITULAR" });
      await receber(A, n, "Voltei");
      const mensagens = await nMensagens(A.e), eventos = await nEventos(A.e), w = cod("wamid.R12-");
      assert.equal(await eco(A, n, w, seg(Date.now() + 120_000)), "NADA", "R1-2: futuro além do desvio com conversa recriada: nada");
      assert.equal(await nMensagens(A.e), mensagens); assert.equal(await nEventos(A.e), eventos, "R1-2: zero hashes");
    }

    // R1-4 — U+0000: id com nulo é descartado; texto com nulo vira texto nulo; o eco válido seguinte grava.
    {
      const n = "5561900006223";
      await receber(A, n, "Oi");
      assert.equal(await eco(A, n, "wamid.nulo\u0000" + cod("x")), "NADA", "R1-4: id com U+0000: nada");
      const wN = cod("wamid.R14-");
      assert.equal(await eco(A, n, wN, undefined, "a\u0000b"), "MENSAGEM", "R1-4: texto com U+0000 entra sem texto");
      assert.equal((await q("SELECT texto FROM whatsapp_atendimento_mensagens WHERE fonte->>'id' = $1", [wN])).rows[0].texto, null);
      assert.equal(await eco(A, n, cod("wamid.R14b-")), "MENSAGEM", "R1-4: eco válido seguinte grava");
    }

    assert.equal(await consumo(), consumo0, "E12: nenhum eco reservou consumo do teto mensal");
    // P3 do 2º parecer: A e B são isentas no harness; aqui o teto injetado FALHA se o eco chamar reservarConsumo.
    {
      const tetoQueFalha = { ...tetoMensal, reservarConsumo: async () => { throw new Error("o eco reservou consumo do teto mensal"); } };
      const Tf = carregarAtendimento(A.e, "staging", {}, tetoQueFalha);
      const nT = "5561900006224";
      await receber(A, nT, "Oi");
      assert.equal(await Tf.servico.receberEco({ id: cod("wamid.TETO-"), contato: nT, texto: "x", timestamp: seg(Date.now() - 5000) }, { empresa: A.e, numero: { phoneNumberId: A.numero, wabaId: A.waba }, env: LIGADA }), "MENSAGEM", "E12: o eco não chama reservarConsumo");
    }

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
    if (temConexoes) {
      const envAntes = { ...process.env };
      Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), WHATSAPP_CREDENTIAL_KEY_VERSION: "1", KIDMAIS_DEPLOY_ENV: "staging" });
      try {
        // A já tem a conexão CONFIGURADA (uma por empresa, índice da 083): só troca a credencial sintética por uma cifrada de verdade.
        const waba = A.waba, numero = A.numero;
        const cifra = credencial.cifrarCredencialWhatsapp("token-sintetico-ecos", { ambiente: "STAGING", appId: "1622943079270352", businessId: "1591095999057604", wabaId: waba, phoneNumberId: numero, empresaId: A.e });
        await q("UPDATE whatsapp_conexoes SET credencial_cifrada=$2, credencial_iv=$3, credencial_tag=$4, credencial_chave_versao=$5, revisao=revisao+1, atualizada_em=clock_timestamp() WHERE empresa_id=$1::uuid AND status='CONFIGURADA'",
          [A.e, cifra.ciphertext, cifra.iv, cifra.tag, cifra.keyVersion]);
        const ecosA15 = await nEcos(A.e);
        const meta = carregarComponente("lib/whatsapp/atendimento/meta.ts", {
          "../../db/postgres.ts": { db, withTransaction }, "../credencial.ts": credencial, "./configuracao.ts": { ...configuracaoReal, ambienteAtendimento: () => "staging", empresaPiloto: () => A.e },
          "./core.ts": core, "./service.ts": A.servico, "./transporte.ts": transporteSemRede, "./multiempresa.ts": multiempresa,
        }).modulo as typeof import("./meta.ts");
        const n15 = "5561900006217", w15 = cod("wamid.E15-"), agora15 = seg(Date.now() - 3000);
        const lote = (wEco: string, wIn: string, contato = n15) => ({
          entradas: [{ phoneNumberId: numero, wabaId: waba, id: wIn, contato, texto: "Oi pelo webhook", timestamp: agora15 - 1000, nomePerfil: null }],
          status: [], ecos: [{ phoneNumberId: numero, wabaId: waba, id: wEco, contato, texto: "Resposta pelo app", timestamp: agora15 }],
        }) as unknown as Parameters<typeof meta.receberEventosMeta>[0];
        delete process.env.WHATSAPP_ATENDIMENTO_ECOS_META;
        const wDesligada = cod("wamid.E15off-");
        await meta.receberEventosMeta(lote(wDesligada, cod("wamid.IN15a-")));
        assert.ok(await conversa(A.e, n15), "E15: a entrada do lote criou a conversa");
        assert.equal(await nEcos(A.e, wDesligada), 0, "E15: chave desligada, eco ignorado");
        process.env.WHATSAPP_ATENDIMENTO_ECOS_META = "true";
        // Contato NOVO no 2º lote (P3 do 2º parecer): só passa se a entrada do lote for gravada antes do eco.
        const n15b = "5561900006218";
        await meta.receberEventosMeta(lote(w15, cod("wamid.IN15b-"), n15b));
        assert.equal(await nEcos(A.e, w15), 1, "E15: eco do lote gravado na conversa criada pela entrada do mesmo lote");
        assert.equal(await nHash(A.e, hashEco(w15)), 0, "E15: não virou só hash (eco antes da entrada)");
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

