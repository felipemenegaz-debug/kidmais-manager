import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import * as core from "./core.ts";

/**
 * Migration 060 (atendimento WhatsApp) no PostgreSQL descartável. ESCRITO, NÃO EXECUTADO: só roda pelo
 * `check:v1:postgres`, com KIDMAIS_POSTGRES_DESCARTAVEL e no cluster descartável (127.0.0.1, cluster_name
 * kidmais_descartavel, sem o banco real), com autorização explícita do Felipe (docs/OPERACAO_AGENTES.md).
 *
 * Dados exclusivamente sintéticos. Modelo e Gupshup são portas simuladas: nenhuma chamada de rede.
 * O serviço e o worker REAIS rodam com conexões próprias por transação, para exercer concorrência de verdade.
 * O runner restaura o banco de trabalho a partir do modelo antes de cada suíte; o fim desta suíte roda o down real.
 *
 * Roteiro:
 *  1. up + postcheck; reaplicação recusada;
 *  2. isolamento: usuário de outra empresa recusado pelo tenant; chaves compostas recusam referência cruzada;
 *  3. deduplicação: o mesmo evento entregue em paralelo grava uma mensagem;
 *  4. concorrência: dois workers em paralelo — cada entrada processada uma vez, cada resposta enviada uma vez,
 *     no máximo uma tarefa ativa por conversa; rajada na mesma conversa gera uma única resposta;
 *  5. tomada humana durante a interpretação cancela a resposta automática;
 *  6. PARAR bloqueia envios; janela de 24 h recusa e cancela envio humano;
 *  7. status recebido antes do retorno do envio é aplicado e apagado; status sem correspondência (OTP) expira em 24 h;
 *  8. interrupção: PROCESSANDO/ENVIANDO antigos viram FALHOU/INCERTO, conversa para humano, nada reenviado;
 *     modelo indisponível envia só o texto fixo de encaminhamento; eventos fora de ordem respondem pelo mais
 *     recente; limite de respostas em 24 h encaminha sem chamar o modelo;
 *  9. rollback: precheck, down recusado com dados e com envio em andamento, down com descarte, pós-rollback.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261001_060_whatsapp_atendimento.sql");
const POST = ler("database/checks/20261001_060_postcheck.sql");
const DOWN = ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql");
const PRE_DOWN = ler("database/checks/20261001_060_rollback_precheck.sql");
const POS_DOWN = ler("database/checks/20261001_060_rollback_postcheck.sql");
const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

/** Uma conexão por transação, como o pool da aplicação: permite corridas reais entre "workers". */
async function withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  const c = await conectarDescartavel({ travar: false });
  try {
    await c.query("BEGIN");
    const r = await fn(c as unknown as DbExecutor);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
const db = () => ({ query: async (sql: string, v?: unknown[]) => { const c = await conectarDescartavel({ travar: false }); try { return await c.query(sql, v); } finally { await c.end(); } } });

type Servico = typeof import("./service.ts");
type Worker = typeof import("./worker.ts");
function carregar(empresaPiloto: string) {
  const configuracao = { ambienteAtendimento: () => "staging", empresaPiloto: () => empresaPiloto, atendimentoAtivo: () => true, recepcaoAtiva: () => true, receptorDoNumero: () => true, contatoPermitido: (contato: string) => contato.startsWith("55619") };
  const postgres = { withTransaction, db };
  const servico = carregarComponente("lib/whatsapp/atendimento/service.ts", {
    "../../db/postgres.ts": postgres,
    "../../saas/provar-tenant.ts": { withTenantTransaction: (s: SessaoParaTenant, e: string, w: Parameters<typeof executarNoTenant>[3]) => withTransaction((tx) => executarNoTenant(tx, s, e, w)) },
    "./configuracao.ts": configuracao,
    "./core.ts": core,
  }).modulo as Servico;
  const worker = carregarComponente("lib/whatsapp/atendimento/worker.ts", {
    "../../db/postgres.ts": postgres, "./configuracao.ts": configuracao, "./core.ts": core, "./service.ts": servico,
  }).modulo as Worker;
  return { servico, worker };
}
const adiado = () => { let liberar!: () => void; const p = new Promise<void>((r) => { liberar = r; }); return { p, liberar }; };

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("BEGIN");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK");
}

test("060: atendimento WhatsApp — isolamento, deduplicação, concorrência, tomada humana, janela, status e rollback", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
  try {
    // 1. Aplicação.
    assert.equal((await c.query("SELECT to_regclass('public.whatsapp_atendimento_conversas') AS t")).rows[0].t, null, "descartável começa sem a 060");
    const empresasAntes = Number((await c.query("SELECT count(*) AS n FROM empresas")).rows[0].n);
    await c.query(UP);
    await c.query(POST);
    await assert.rejects(c.query(semTransacaoExplicita(UP)), /060 já aplicada/);
    await c.query("ROLLBACK").catch(() => {});

    // Fixture sintética: empresa piloto A, empresa B, atendente de A, representante de A e usuário só de B.
    const empresa = async (nome: string) => { const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("wa"), nome]); await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]); return e; };
    const A = await empresa("Empresa sintética A"), B = await empresa("Empresa sintética B");
    const usuario = async (papel: string, empresaId: string) => {
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 060', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresaId, u, papel]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { usuario_id: u, papel } as SessaoParaTenant;
    };
    const atendente = await usuario("ADMINISTRATIVO", A), representante = await usuario("REPRESENTANTE_AUTORIZADO", A), deB = await usuario("REPRESENTANTE_AUTORIZADO", B);
    const { servico, worker } = carregar(A);
    await servico.salvarConfiguracao(representante, { ativo: true, nome: "Empresa sintética A", perguntas: [{ id: "endereco", pergunta: "Onde fica?", resposta: "Resposta aprovada sintética." }] });

    const agora = Date.now();
    const evento = (n: number, contato: string, texto: string | null, quando = agora) => ({ id: `evt-${n}-${cod("")}`, app: "KidmaisManager", source: contato, texto, timestamp: quando });
    const conversa = async (contato: string) => (await c.query("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const mensagens = async (conversaId: string) => (await c.query("SELECT direcao, estado, texto, provedor_id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 ORDER BY criada_em, id", [conversaId])).rows;
    const enviados: string[] = [];
    const deps = (extra: Partial<Parameters<Worker["processarLote"]>[0]> = {}) => ({
      interpretar: async () => ({ intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }),
      enviar: async (contato: string) => { enviados.push(contato); return cod("gs-"); },
      ...extra,
    });

    // 2. Isolamento entre empresas.
    await assert.rejects(servico.listarAtendimento(deB), /não comprova a empresa autorizada/, "usuário só de B não acessa o piloto A");
    await servico.receberEntrada(evento(1, "5561900000001", "Olá"));
    const c1 = await conversa("5561900000001");
    await recusa(c, `INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa) VALUES ($1, $2, 'staging', 'SAIDA', 'x', 'PENDENTE', 0)`, [c1.id, B], /foreign key|violates/);
    await recusa(c, `INSERT INTO whatsapp_atendimento_auditoria (empresa_id, ambiente, usuario_id, acao, conversa_id) VALUES ($1, 'staging', $2, 'assumir', $3)`, [B, deB.usuario_id, c1.id], /foreign key|violates/);
    await recusa(c, `INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa) VALUES ($1, $2, 'production', 'SAIDA', 'x', 'PENDENTE', 0)`, [c1.id, A], /foreign key|violates/);
    assert.equal((await servico.listarAtendimento(atendente)).conversas.every((x) => x.empresa_id === A), true);

    // 3. Deduplicação: o mesmo evento em paralelo (retry do provedor) grava uma única entrada.
    const repetido = evento(2, "5561900000002", "Quero uma festa");
    await Promise.all([servico.receberEntrada(repetido), servico.receberEntrada(repetido), servico.receberEntrada(repetido)]);
    assert.equal((await mensagens((await conversa("5561900000002")).id)).filter((m) => m.direcao === "ENTRADA").length, 1);

    // 4. Concorrência entre workers: várias conversas, dois lotes em paralelo.
    for (let i = 3; i <= 8; i++) await servico.receberEntrada(evento(i, `55619000000${10 + i}`, "Onde fica?"));
    enviados.length = 0;
    await c.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE empresa_id = $1 AND estado = 'PENDENTE' AND conversa_id IN (SELECT id FROM whatsapp_atendimento_conversas WHERE contato IN ('5561900000001','5561900000002'))", [A]);
    const lento = deps({ interpretar: async () => { await new Promise((r) => setTimeout(r, 50)); return { intencao: "DUVIDA" as const, perguntaId: "endereco", data: null, convidados: null }; } });
    await Promise.all([worker.processarLote(lento, { maxTarefas: 50 }), worker.processarLote(lento, { maxTarefas: 50 })]);
    await worker.processarLote(lento, { maxTarefas: 50 });
    const porContato = new Map<string, number>(); for (const e of enviados) porContato.set(e, (porContato.get(e) ?? 0) + 1);
    assert.equal(porContato.size, 6, "cada conversa recebeu resposta"); assert.ok([...porContato.values()].every((n) => n === 1), "nenhuma resposta duplicada");
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id = $1 AND estado IN ('PROCESSANDO','ENVIANDO')", [A])).rows[0].n), 0);
    // Rajada na mesma conversa: a entrada antiga é invalidada pela nova versão; só uma resposta.
    enviados.length = 0;
    await servico.receberEntrada(evento(20, "5561900000020", "Oi", agora - 2000));
    await servico.receberEntrada(evento(21, "5561900000020", "Onde fica?", agora - 1000));
    await worker.processarLote(lento, { maxTarefas: 50 });
    const rajada = await mensagens((await conversa("5561900000020")).id);
    assert.deepEqual(rajada.map((m) => `${m.direcao}:${m.estado}`), ["ENTRADA:CANCELADA", "ENTRADA:PROCESSADA", "SAIDA:SUBMETIDA"]);
    assert.equal(enviados.length, 1);

    // 5. Tomada humana durante a interpretação cancela a resposta automática.
    enviados.length = 0;
    await servico.receberEntrada(evento(30, "5561900000030", "Quanto custa?"));
    const trava = adiado(), entrou = adiado();
    const lote = worker.processarLote(deps({ interpretar: async () => { entrou.liberar(); await trava.p; return { intencao: "DUVIDA" as const, perguntaId: "endereco", data: null, convidados: null }; } }), { maxTarefas: 1 });
    await entrou.p;
    const c30 = await conversa("5561900000030");
    await servico.controlarAtendimento(atendente, { acao: "assumir", conversaId: c30.id, versao: Number(c30.versao) });
    trava.liberar(); await lote;
    assert.deepEqual((await mensagens(c30.id)).map((m) => `${m.direcao}:${m.estado}`), ["ENTRADA:CANCELADA"]);
    assert.equal(enviados.length, 0);
    assert.equal((await conversa("5561900000030")).estado, "HUMANO");

    // 6a. PARAR: encerra, bloqueia envio humano e nova entrada não reabre.
    await servico.receberEntrada(evento(40, "5561900000040", "PARAR"));
    const c40 = await conversa("5561900000040");
    assert.equal(c40.nao_contatar, true); assert.equal(c40.estado, "ENCERRADA");
    await assert.rejects(servico.controlarAtendimento(atendente, { acao: "assumir", conversaId: c40.id, versao: Number(c40.versao) }), /ATENDIMENTO_CONTATO_BLOQUEADO/);
    await servico.receberEntrada(evento(41, "5561900000040", "oi de novo"));
    assert.equal((await conversa("5561900000040")).estado, "ENCERRADA");
    // 6b. Janela de 24 h: envio humano recusado depois do prazo; mensagem já na fila é cancelada sem chamar o provedor.
    const c30h = await conversa("5561900000030");
    await servico.controlarAtendimento(atendente, { acao: "enviar", conversaId: c30h.id, versao: Number(c30h.versao), texto: "Resposta humana sintética" });
    await c.query("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '25 hours' WHERE id = $1", [c30h.id]);
    const c30v = await conversa("5561900000030");
    await assert.rejects(servico.controlarAtendimento(atendente, { acao: "enviar", conversaId: c30v.id, versao: Number(c30v.versao), texto: "Outra" }), /ATENDIMENTO_JANELA_EXPIRADA/);
    enviados.length = 0;
    await worker.processarLote(deps(), { maxTarefas: 10 });
    assert.equal(enviados.length, 0);
    assert.equal((await mensagens(c30v.id)).at(-1)?.estado, "CANCELADA");

    // 7. Status antes do retorno do envio e retenção de status sem correspondência.
    await servico.receberEntrada(evento(50, "5561900000050", "Onde fica?"));
    const antecipado = deps({ interpretar: async () => ({ intencao: "DUVIDA" as const, perguntaId: "endereco", data: null, convidados: null }), enviar: async () => { await servico.receberStatus({ payload: { gsId: "gs-antes", type: "delivered" } }); return "gs-antes"; } });
    await worker.processarLote(antecipado, { maxTarefas: 10 });
    const c50 = await conversa("5561900000050");
    assert.equal((await mensagens(c50.id)).at(-1)?.estado, "ENTREGUE");
    assert.equal((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE provedor_id = 'gs-antes'")).rows[0].n, "0", "status correlacionado sai da tabela");
    await servico.receberStatus({ payload: { gsId: "otp-antigo", type: "delivered" } });
    await servico.receberStatus({ payload: { gsId: "otp-recente", type: "delivered" } });
    await c.query("UPDATE whatsapp_atendimento_status SET recebido_em = clock_timestamp() - interval '25 hours' WHERE provedor_id = 'otp-antigo'");
    await servico.limparStatusExpirados();
    assert.deepEqual((await c.query("SELECT provedor_id FROM whatsapp_atendimento_status WHERE empresa_id = $1 ORDER BY 1", [A])).rows.map((r) => r.provedor_id), ["otp-recente"]);

    // 8. Interrupção do worker: nada é reenviado; a conversa vai para a equipe.
    await servico.receberEntrada(evento(60, "5561900000060", "Onde fica?"));
    const c60 = await conversa("5561900000060");
    await c.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSANDO', iniciada_em = clock_timestamp() - interval '11 minutes' WHERE conversa_id = $1", [c60.id]);
    await c.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, iniciada_em) VALUES ($1, $2, 'staging', 'SAIDA', 'Resposta sintética', 'ENVIANDO', $3, clock_timestamp() - interval '11 minutes')`, [c60.id, A, c60.versao]);
    enviados.length = 0;
    await worker.processarLote(deps(), { maxTarefas: 10 });
    assert.deepEqual((await mensagens(c60.id)).map((m) => m.estado).sort(), ["FALHOU", "INCERTO"]);
    assert.equal((await conversa("5561900000060")).estado, "AGUARDANDO_HUMANO");
    assert.equal(enviados.length, 0);

    // 8b. Modelo indisponível: a conversa vai para a equipe e o contato recebe só o texto fixo de encaminhamento.
    await servico.receberEntrada(evento(70, "5561900000070", "Qual o valor?"));
    enviados.length = 0;
    await worker.processarLote(deps({ interpretar: async () => { throw new Error("ATENDIMENTO_MODELO_INDISPONIVEL"); } }), { maxTarefas: 10 });
    const c70 = await conversa("5561900000070");
    assert.equal(c70.estado, "AGUARDANDO_HUMANO");
    assert.deepEqual((await mensagens(c70.id)).map((m) => `${m.direcao}:${m.estado}:${m.direcao === "SAIDA" ? m.texto : ""}`), ["ENTRADA:FALHOU:", `SAIDA:SUBMETIDA:${core.MENSAGEM_ENCAMINHAMENTO}`]);
    assert.deepEqual(enviados, ["5561900000070"]);

    // 8c. Ordem: o evento mais recente chega antes do anterior; a única resposta considera o mais recente.
    let pedido = "";
    await servico.receberEntrada(evento(81, "5561900000080", "Para 40 pessoas", agora - 1000));
    await servico.receberEntrada(evento(80, "5561900000080", "Oi", agora - 5000));
    enviados.length = 0;
    await worker.processarLote(deps({ interpretar: async (_e: string, texto: string) => { pedido = texto; return { intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }; } }), { maxTarefas: 10 });
    assert.equal(JSON.parse(pedido).mensagemAtual, "Para 40 pessoas");
    assert.deepEqual(JSON.parse(pedido).mensagens, ["Oi", "Para 40 pessoas"]);
    assert.equal(enviados.length, 1);

    // 8d. Limite de respostas em 24 h: atingido, encaminha sem chamar o modelo.
    await servico.salvarConfiguracao(representante, { ativo: true, nome: "Empresa sintética A", perguntas: [{ id: "endereco", pergunta: "Onde fica?", resposta: "Resposta aprovada sintética." }], limites: { respostasPor24h: 1 } });
    let chamadasModelo = 0;
    const contado = deps({ interpretar: async () => { chamadasModelo++; return { intencao: "DUVIDA" as const, perguntaId: "endereco", data: null, convidados: null }; } });
    await servico.receberEntrada(evento(90, "5561900000090", "Onde fica?"));
    await worker.processarLote(contado, { maxTarefas: 10 });
    await servico.receberEntrada(evento(91, "5561900000090", "E o horário?"));
    await worker.processarLote(contado, { maxTarefas: 10 });
    assert.equal(chamadasModelo, 1, "a segunda entrada não chama o modelo");
    const c90 = await conversa("5561900000090");
    assert.equal(c90.estado, "AGUARDANDO_HUMANO");
    assert.equal((await mensagens(c90.id)).at(-1)?.texto, core.MENSAGEM_ENCAMINHAMENTO);

    // 9. Rollback: precheck; down recusado com envio em andamento e com dados sem descarte; down com descarte.
    await c.query(PRE_DOWN);
    await c.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'ENVIANDO' WHERE id = (SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND estado = 'INCERTO')", [c60.id]);
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'");
    await assert.rejects(c.query(semTransacaoExplicita(DOWN)), /processamento ou envio/); await c.query("ROLLBACK");
    await c.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'INCERTO' WHERE conversa_id = $1 AND estado = 'ENVIANDO'", [c60.id]);
    await assert.rejects(c.query(DOWN), /há atendimento gravado/); await c.query("ROLLBACK").catch(() => {});
    await c.query("BEGIN"); await c.query("SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'");
    await c.query(semTransacaoExplicita(DOWN)); await c.query("COMMIT");
    await c.query(POS_DOWN);
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM empresas WHERE id NOT IN ($1, $2)", [A, B])).rows[0].n), empresasAntes, "Core fora da fixture intacto");
  } finally {
    await encerrarDescartavel(c);
  }
});
