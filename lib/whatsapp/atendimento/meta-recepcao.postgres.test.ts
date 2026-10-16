import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import * as credencial from "../credencial.ts";
import * as core from "./core.ts";
import { carregarAtendimento, cod, db, transporteSemRede, withTransaction } from "./harness-postgres.ts";
import { receberWebhookMeta } from "../../integracoes/meta/webhook.ts";

/**
 * WhatsApp Cloud API (Meta) como canal do atendimento, no PostgreSQL descartável (modelo "083": 060–083), só pelo
 * check:v1:postgres, com opt-in. Webhook REAL (assinatura HMAC) → recepção REAL → banco; conexões em whatsapp_conexoes
 * com credencial cifrada de verdade (chave sintética). Dados sintéticos; nenhuma rede (a Meta é uma porta simulada).
 *
 *  R1 número conectado à empresa piloto: grava a entrada NA PILOTO (conversa, mensagem, nome de perfil); replay não duplica;
 *  R2 número conectado a OUTRA empresa: confirma sem gravar nada (nem na piloto, nem na outra);
 *  R3 número sem conexão, conexão DESCONECTADA, ou conta WhatsApp (WABA) divergente: nada gravado;
 *  R4 contato fora da lista permitida (staging): nada gravado;
 *  R5 status: delivered/read → ENTREGUE e failed → FALHOU só nas saídas da piloto; status vindo do número da outra empresa
 *     não toca a saída da piloto, mesmo com o mesmo id;
 *  R6 envio: a credencial é a da conexão da empresa (decifrada com a identidade dela) e o POST vai ao número dela; a
 *     credencial da outra empresa não abre com a identidade da piloto;
 *  R7 assinatura inválida: 401 e nada gravado.
 */
const SEGREDO_APP = "segredo-sintetico-do-app-meta-0001";
const CHAVE = Buffer.alloc(32, 9).toString("base64");
Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: CHAVE, WHATSAPP_CREDENTIAL_KEY_VERSION: "1", META_GRAPH_API_VERSION: "v23.0" });
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const APP = "1622943079270352", NEGOCIO = "1591095999057604";

test("Meta: webhook → empresa dona do número → recepção, status e envio", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    assert.ok((await q("SELECT 1 FROM information_schema.columns WHERE table_name='whatsapp_conexoes' AND column_name='empresa_id'")).rows.length, "modelo com a 083");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const empresa = async (nome: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("mt"), nome]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const A = await empresa("Buffet sintético piloto (Meta)"), B = await empresa("Buffet sintético outro (Meta)");
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness Meta', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const conectar = async (empresaId: string, wabaId: string, phoneNumberId: string) => {
      const cifra = credencial.cifrarCredencialWhatsapp(`token-sintetico-${phoneNumberId}`, { ambiente: "STAGING", appId: APP, businessId: NEGOCIO, wabaId, phoneNumberId, empresaId });
      return id(`WITH instante AS (SELECT clock_timestamp() AS agora)
        INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
        SELECT 'STAGING',$1::uuid,$2,$3,$4,$5,'+55 61 90000-0000','Buffet sintético',true,'CONFIGURADA',ARRAY['whatsapp_business_messaging'],$6,$7,$8,$9,'bearer',NULL,agora,$10::uuid,$11::uuid,agora,agora FROM instante RETURNING id`,
        [empresaId, APP, NEGOCIO, wabaId, phoneNumberId, cifra.ciphertext, cifra.iv, cifra.tag, cifra.keyVersion, u, randomUUID()]);
    };
    // A: número antigo desconectado, depois o atual. B: o próprio número.
    const antiga = await conectar(A, "2000000001", "3000000009");
    await q(`UPDATE whatsapp_conexoes SET status='DESCONECTADA',desconectada_em=clock_timestamp(),desconectada_por_usuario_id=$2,motivo_desconexao='troca sintética',revisao=revisao+1,atualizada_em=clock_timestamp() WHERE id=$1`, [antiga, u]);
    await conectar(A, "2000000001", "3000000001");
    await conectar(B, "2000000002", "3000000002");

    const { servico } = carregarAtendimento(A);
    const configuracao = { ambienteAtendimento: () => "staging", empresaPiloto: () => A };
    const meta = carregarComponente("lib/whatsapp/atendimento/meta.ts", {
      "../../db/postgres.ts": { db, withTransaction }, "../credencial.ts": credencial, "./configuracao.ts": configuracao, "./core.ts": core, "./service.ts": servico, "./transporte.ts": transporteSemRede,
    }).modulo as typeof import("./meta.ts");

    const env = { META_APP_SECRET: SEGREDO_APP, KIDMAIS_DEPLOY_ENV: "staging" };
    const evento = (phoneNumberId: string, wabaId: string, value: Record<string, unknown>) => ({ object: "whatsapp_business_account", entry: [{ id: wabaId, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, ...value } }] }] });
    const mensagem = (from: string, wamid: string, body: string) => ({ contacts: [{ wa_id: from, profile: { name: "Cliente Sintético" } }], messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] });
    const postar = async (corpo: unknown, segredo = SEGREDO_APP) => {
      const bruto = JSON.stringify(corpo);
      const assinatura = `sha256=${createHmac("sha256", segredo).update(bruto).digest("hex")}`;
      const req = new Request("https://staging.example/api/integracoes/meta/webhook", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinatura }, body: bruto });
      return (await receberWebhookMeta(req, env, () => {}, (e) => meta.receberEventosMeta(e, { automacaoGlobal: true }))).status;
    };
    const conta = async (sql: string, v: unknown[] = []) => Number((await q(sql, v)).rows[0].n);
    const entradas = (empresaId: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND direcao='ENTRADA'", [empresaId]);
    const conversas = (empresaId: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_conversas WHERE empresa_id=$1", [empresaId]);

    // R1
    assert.equal(await postar(evento("3000000001", "2000000001", mensagem("5561900002001", "wamid.R1", "Oi, quero orçamento"))), 200);
    const r1 = (await q("SELECT c.contato, c.estado, c.nome_perfil, m.externa_id, m.texto, m.estado AS m_estado FROM whatsapp_atendimento_conversas c JOIN whatsapp_atendimento_mensagens m ON m.conversa_id=c.id WHERE c.empresa_id=$1", [A])).rows;
    assert.deepEqual(r1, [{ contato: "5561900002001", estado: "AGUARDANDO_HUMANO", nome_perfil: "Cliente Sintético", externa_id: "wamid.R1", texto: "Oi, quero orçamento", m_estado: "PROCESSADA" }], "R1: na piloto, sem configuração = equipe");
    assert.equal(await postar(evento("3000000001", "2000000001", mensagem("5561900002001", "wamid.R1", "Oi, quero orçamento"))), 200);
    assert.equal(await entradas(A), 1, "R1: replay não duplica");

    // R2, R3, R4
    assert.equal(await postar(evento("3000000002", "2000000002", mensagem("5561900002002", "wamid.R2", "Oi"))), 200);
    assert.equal(await postar(evento("3000000099", "2000000001", mensagem("5561900002003", "wamid.R3a", "Oi"))), 200);
    assert.equal(await postar(evento("3000000009", "2000000001", mensagem("5561900002003", "wamid.R3b", "Oi"))), 200);
    assert.equal(await postar(evento("3000000001", "2000000002", mensagem("5561900002003", "wamid.R3c", "Oi"))), 200);
    assert.equal(await postar(evento("3000000001", "2000000001", mensagem("5511900002004", "wamid.R4", "Oi"))), 200);
    assert.deepEqual([await entradas(A), await conversas(A), await entradas(B), await conversas(B)], [1, 1, 0, 0], "R2–R4: nada gravado");

    // R5: saídas da piloto já submetidas (ids da Meta).
    const conversa = (await q("SELECT id, versao FROM whatsapp_atendimento_conversas WHERE empresa_id=$1", [A])).rows[0];
    for (const provedor of ["wamid.S1", "wamid.S2", "wamid.S3"]) await q(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,direcao,texto,estado,versao_conversa,autor_usuario_id,provedor_id) VALUES($1,$2,'staging','SAIDA','Resposta sintética','SUBMETIDA',$3,$4,$5)`, [conversa.id, A, conversa.versao, u, provedor]);
    const status = (lista: [string, string][]) => ({ statuses: lista.map(([idS, s]) => ({ id: idS, status: s, recipient_id: "5561900002001", timestamp: "1" })) });
    assert.equal(await postar(evento("3000000002", "2000000002", status([["wamid.S1", "failed"]]))), 200);
    assert.equal(await postar(evento("3000000001", "2000000001", status([["wamid.S1", "delivered"], ["wamid.S2", "read"], ["wamid.S3", "failed"], ["wamid.S4", "sent"]]))), 200);
    const estados = Object.fromEntries((await q("SELECT provedor_id, estado FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND direcao='SAIDA'", [A])).rows.map((x) => [x.provedor_id, x.estado]));
    assert.deepEqual(estados, { "wamid.S1": "ENTREGUE", "wamid.S2": "ENTREGUE", "wamid.S3": "FALHOU" }, "R5");
    assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE empresa_id=$1", [B]), 0, "R5: nada guardado para a outra empresa");

    // R6
    const deA = await meta.conexaoEnvioMeta(c as never, A);
    assert.deepEqual(deA, { phoneNumberId: "3000000001", token: "token-sintetico-3000000001" });
    assert.deepEqual(await meta.conexaoEnvioMeta(c as never, B), { phoneNumberId: "3000000002", token: "token-sintetico-3000000002" });
    const chamadas: string[] = [];
    const buscar = (async (url: string) => { chamadas.push(String(url)); return new Response(JSON.stringify({ messages: [{ id: "wamid.ENVIO" }] }), { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await meta.enviarPelaEmpresa("5561900002001", { tipo: "TEXTO", texto: "Oi!" }, { buscar, gupshup: async () => assert.fail("sem Gupshup") }), "wamid.ENVIO");
    assert.deepEqual(chamadas, ["https://graph.facebook.com/v23.0/3000000001/messages"]);
    // Credencial de B copiada para a linha de A não abre (identidade da cifragem).
    await q("BEGIN");
    try {
      await q(`ALTER TABLE whatsapp_conexoes DISABLE TRIGGER USER`);
      await q(`UPDATE whatsapp_conexoes a SET credencial_cifrada=b.credencial_cifrada,credencial_iv=b.credencial_iv,credencial_tag=b.credencial_tag FROM whatsapp_conexoes b WHERE a.empresa_id=$1 AND a.status='CONFIGURADA' AND b.empresa_id=$2`, [A, B]);
      await assert.rejects(meta.conexaoEnvioMeta(c as never, A), /TRANSPORTE_NAO_CONFIGURADO/);
    } finally { await q("ROLLBACK"); }

    // R7
    assert.equal(await postar(evento("3000000001", "2000000001", mensagem("5561900002001", "wamid.R7", "Oi")), "segredo-de-outro-app-00000002"), 401);
    assert.equal(await entradas(A), 1, "R7: nada gravado");
  } finally {
    await c.end();
  }
});
