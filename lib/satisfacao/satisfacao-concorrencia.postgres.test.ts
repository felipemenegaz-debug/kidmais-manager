import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cod, executor, porTransacao, SENHA_FALSA } from "../marketing/harness-postgres.ts";
import { baseSintetica, type CriarEnvio } from "./harness-postgres.ts";
import { lerAnel, type AnelChaves } from "./token.ts";

/**
 * Pesquisa de satisfação (110, PS-1): concorrência no PostgreSQL descartável, modelo 110, com três conexões e dados
 * COMMITADOS. Prova, observando pg_stat_activity/pg_blocking_pids (nada de sleep como prova):
 *   - duas respostas do mesmo link serializam no envio (marcador satisfacao:travar-envio): uma grava, a outra "já respondida";
 *   - resposta × cancelamento com os pais ocupados (ordem de operarContrato: fechamento → contrato FOR UPDATE): a pesquisa
 *     NUNCA espera (NOWAIT), repete a transação inteira até 5 vezes e devolve "tente de novo" sem gravar; se o
 *     cancelamento confirma no meio, a próxima tentativa revoga;
 *   - resposta com os pais travados FOR SHARE: o cancelamento espera por ela (sem deadlock) e confirma depois;
 *   - criação do envio de duas execuções da mesma festa: a trava por cliente serializa, só um envio;
 *   - criação × troca do cliente da festa nas duas ordens: a troca espera a criação; a criação recebe 55P03 (NOWAIT);
 *   - regeneração do link em duas transações: uma regenera, a outra relê e devolve o MESMO link (geração 2);
 *   - bloqueio do WhatsApp transferido entre controles e conversa em transações concorrentes: a leitura numa instrução
 *     nunca vê "liberado".
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")},2:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
const soChave2 = lerAnel({ SATISFACAO_LINK_CHAVES: `2:${anel.chaves.get(2)!.toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "2" }) as AnelChaves;

type Publico = Record<"abrirPesquisa" | "responderPesquisa", (corpo: unknown, ctx: { ip: string | null }, deps: unknown) => Promise<Record<string, unknown>>>;
type Envios = { criarEnvio: CriarEnvio; linkDoEnvio(tx: unknown, anel: AnelChaves, envioId: string): Promise<{ token: string; geracao: number; regenerado: boolean } | null> };
type Pref = { bloqueioWhatsappDoDestino(tx: unknown, e: string, destino: string): Promise<boolean> };

/** Identidade sintética da suíte (senha em formato válido que não autentica). */
const identidade = async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
  VALUES ($1, 'Gestão sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@pesquisa.test`, SENHA_FALSA])).rows[0].id;

const erroDe = (code: string, status?: number) => (e: unknown) => (e as { code?: string }).code === code && (status === undefined || (e as { httpStatus?: number }).httpStatus === status);
const pid = async (c: Client) => Number((await c.query(`SELECT pg_backend_pid() AS p`)).rows[0].p);

/**
 * Espera (com prazo) até o backend `alvo` estar bloqueado por um dos `bloqueadores`, com o trecho de SQL esperado.
 * Prova, não sleep. Vários bloqueadores: na fila de uma linha, o segundo a esperar fica atrás do primeiro (trava de tupla).
 */
async function esperarBloqueio(obs: Client, alvo: number, bloqueadores: number | number[], trecho: string) {
  const lista = Array.isArray(bloqueadores) ? bloqueadores : [bloqueadores];
  for (let i = 0; i < 400; i++) {
    // pg_stat_activity é congelado por transação: o observador pode estar numa transação aberta (é o bloqueador).
    await obs.query(`SELECT pg_stat_clear_snapshot()`);
    const r = (await obs.query(`SELECT a.query, pg_blocking_pids(a.pid) && $2::int[] AS bloqueado FROM pg_stat_activity a WHERE a.pid = $1::int`, [alvo, lista])).rows[0];
    if (r?.bloqueado && String(r.query).includes(trecho)) return;
    await new Promise((fim) => setTimeout(fim, 10));
  }
  throw new Error(`backend ${alvo} não ficou bloqueado por ${lista.join('/')} em "${trecho}"`);
}

test("110: concorrência da pesquisa (três conexões)", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const c3 = await conectarDescartavel({ travar: false });
  try {
    const carregar = <T>(c: Client, f: string) => carregarComBanco(f, c, () => null, {}, new Map()) as unknown as T;
    const pub1 = carregar<Publico>(c1, "lib/satisfacao/publico.ts"), pub2 = carregar<Publico>(c2, "lib/satisfacao/publico.ts");
    const env1 = carregar<Envios>(c1, "lib/satisfacao/envios.ts"), env2 = carregar<Envios>(c2, "lib/satisfacao/envios.ts");
    const pref1 = carregar<Pref>(c1, "lib/marketing/automacoes/preferencias.ts");
    const { A, festa, execucao, envioPronto } = await baseSintetica(c3, anel, env1.criarEnvio, identidade);
    const [p1, p2, p3] = [await pid(c1), await pid(c2), await pid(c3)];
    let ipN = 0;
    const ip = () => `203.0.113.${++ipN}`;
    const deps = (c: Client, extra: Record<string, unknown> = {}) => ({ withTransaction: porTransacao(c), anel: () => anel, repeticao: { esperar: async () => {} }, ...extra });
    const um = async (sql: string, v: unknown[] = []) => (await c3.query(sql, v)).rows[0];
    const contar = async (sql: string, v: unknown[]) => Number((await um(sql, v)).n);

    await t.test("duas respostas do mesmo link: serializam no envio (FOR UPDATE observado); uma grava, a outra é 'já respondida'", async () => {
      const p = await envioPronto();
      await c3.query("BEGIN");
      await c3.query(`SELECT 1 FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [p.envio]);
      const r1 = pub1.responderPesquisa({ token: p.token, notaIndicacao: 5 }, { ip: ip() }, deps(c1)).then(() => "GRAVADA", (e) => e.code);
      const r2 = pub2.responderPesquisa({ token: p.token, notaIndicacao: 9 }, { ip: ip() }, deps(c2)).then(() => "GRAVADA", (e) => e.code);
      await esperarBloqueio(c3, p1, [p3, p2], "satisfacao:travar-envio");
      await esperarBloqueio(c3, p2, [p3, p1], "satisfacao:travar-envio");
      await c3.query("COMMIT");
      assert.deepEqual([await r1, await r2].sort(), ["GRAVADA", "JA_RESPONDIDA"]);
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio]), 1);
      const tarefas = await contar(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE envio_id = $1::uuid`, [p.envio]);
      const nota = (await um(`SELECT nota_indicacao FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio])).nota_indicacao;
      assert.equal(tarefas, nota <= 6 ? 1 : 0, "tarefa só da resposta gravada");
    });

    /** Transação de cancelamento na ordem de operarContrato (lib/contratos/services/administrativo.service.ts): fechamento e contrato FOR UPDATE. */
    async function travarComoCancelamento(f: string) {
      await c3.query("BEGIN");
      await c3.query(`SELECT id FROM fechamentos WHERE id = $1::uuid FOR UPDATE`, [f]);
      await c3.query(`SELECT id FROM contratos WHERE fechamento_id = $1::uuid FOR UPDATE`, [f]);
    }
    async function concluirCancelamento(f: string) {
      await c3.query(`UPDATE contratos SET status = 'CANCELADO', cancelado_em = clock_timestamp() WHERE fechamento_id = $1::uuid`, [f]);
      await c3.query(`UPDATE fechamentos SET status = 'CANCELADO' WHERE id = $1::uuid`, [f]);
      await c3.query("COMMIT");
    }

    await t.test("resposta × cancelamento com os pais ocupados: NOWAIT, 5 tentativas integrais, 'tente de novo' e nada gravado", async () => {
      const p = await envioPronto();
      await travarComoCancelamento(p.f);
      const repeticoes: string[] = [];
      try {
        await assert.rejects(pub1.responderPesquisa({ token: p.token, notaIndicacao: 2 }, { ip: ip() }, deps(c1, { repeticao: { esperar: async () => {}, aoRepetir: (_n: number, cod: string) => repeticoes.push(cod) } })),
          erroDe("TENTE_NOVAMENTE", 503));
      } finally {
        await c3.query("ROLLBACK");
      }
      assert.deepEqual(repeticoes, ["55P03", "55P03", "55P03", "55P03"], "4 repetições = 5 tentativas, todas por pai ocupado");
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).estado, "ATIVO");
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio]), 0);
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_entregas WHERE envio_id = $1::uuid AND estado = 'PENDENTE'`, [p.envio]), 2);
    });

    await t.test("resposta × cancelamento que confirma no meio das tentativas: a próxima tentativa revoga (FESTA_CANCELADA)", async () => {
      const p = await envioPronto();
      await travarComoCancelamento(p.f);
      // A primeira tentativa recebe 55P03; na espera antes da segunda, o cancelamento confirma.
      const codigos: string[] = [];
      let cancelado = false;
      const esperar = async () => { if (!cancelado) { cancelado = true; await concluirCancelamento(p.f); } };
      await assert.rejects(pub1.responderPesquisa({ token: p.token, notaIndicacao: 2 }, { ip: ip() },
        deps(c1, { repeticao: { esperar, aoRepetir: (_n: number, cod: string) => codigos.push(cod) } })), erroDe("LINK_INDISPONIVEL", 404));
      assert.deepEqual(codigos, ["55P03"]);
      assert.deepEqual(await um(`SELECT estado, motivo_revogacao FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio]), { estado: "REVOGADO", motivo_revogacao: "FESTA_CANCELADA" });
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio]), 0);
    });

    await t.test("resposta com os pais em FOR SHARE: o cancelamento ESPERA por ela (pg_blocking_pids) e confirma depois, sem deadlock", async () => {
      const p = await envioPronto();
      let liberar!: () => void, dentro!: () => void;
      const solto = new Promise<void>((r) => { liberar = r; }), entrou = new Promise<void>((r) => { dentro = r; });
      const criarTarefa = async (tx: { query: (s: string, v: unknown[]) => Promise<unknown> }, e: { empresa_id: string; estabelecimento_id: string | null; id: string }, respostaId: string) => {
        dentro();
        await solto;
        await tx.query(`INSERT INTO satisfacao_tarefas (empresa_id, estabelecimento_id, envio_id, resposta_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`, [e.empresa_id, e.estabelecimento_id, e.id, respostaId]);
      };
      const resposta = pub1.responderPesquisa({ token: p.token, notaIndicacao: 3 }, { ip: ip() }, deps(c1, { criarTarefa }));
      await entrou;
      const cancelamento = (async () => { await travarComoCancelamento(p.f); await concluirCancelamento(p.f); })();
      await esperarBloqueio(c2, p3, p1, "FOR UPDATE");
      liberar();
      assert.deepEqual(await resposta, { gravada: true });
      await cancelamento;
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).estado, "RESPONDIDO", "resposta confirmada antes do cancelamento");
      assert.equal((await um(`SELECT status FROM fechamentos WHERE id = $1::uuid`, [p.f])).status, "CANCELADO");
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE envio_id = $1::uuid`, [p.envio]), 1);
      assert.equal((await pub1.abrirPesquisa({ token: p.token }, { ip: ip() }, deps(c1))).situacao, "RESPONDIDA", "RESPONDIDO é preservado depois do cancelamento");
    });

    await t.test("criação: duas execuções da mesma festa em transações concorrentes → um envio (a trava por cliente serializa)", async () => {
      const { cl, f } = await festa();
      const x1 = await execucao(A, cl, f), x2 = await execucao(A, cl, f);
      const entrada = (x: string) => ({ empresaId: A, execucaoId: x, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 });
      await c1.query("BEGIN");
      const r1 = await env1.criarEnvio(executor(c1), anel, entrada(x1));
      const segunda = porTransacao(c2)((tx) => env2.criarEnvio(tx, anel, entrada(x2)));
      await esperarBloqueio(c3, p2, p1, "pg_advisory_xact_lock");
      await c1.query("COMMIT");
      assert.equal(r1.criado, true);
      assert.deepEqual(await segunda, { criado: false, motivo: "PESQUISA_JA_EXISTE" });
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_envios WHERE fechamento_id = $1::uuid`, [f]), 1);
    });

    await t.test("vínculos (N2): criar o envio × trocar o cliente da festa — quem chega depois espera ou recebe 55P03; o envio nasce coerente", async () => {
      const { cl, f } = await festa();
      const outro = await festa();
      const entrada = (x: string) => ({ empresaId: A, execucaoId: x, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 });
      // Ordem 1: a criação segura a festa (FOR SHARE); a troca do cliente ESPERA por ela (observado) e só segue depois do COMMIT.
      const x1 = await execucao(A, cl, f);
      await c1.query("BEGIN");
      const r1 = await env1.criarEnvio(executor(c1), anel, entrada(x1));
      await c2.query("BEGIN");
      const troca = c2.query(`UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = $1::uuid`, [f, outro.cl]).then(() => "ok", (e: { code?: string }) => e.code ?? "erro");
      await esperarBloqueio(c3, p2, p1, "UPDATE fechamentos");
      await c1.query("COMMIT");
      await troca;
      await c2.query("ROLLBACK");
      assert.equal(r1.criado, true);
      assert.equal((await um(`SELECT cliente_id::text AS c FROM satisfacao_envios WHERE id = $1::uuid`, [r1.envioId])).c, cl, "o envio mantém o cliente da criação");
      // Ordem 2: a troca do cliente segura a festa; a criação recebe 55P03 na hora (NOWAIT), sem esperar, e nada é criado.
      const g = await festa();
      const x2 = await execucao(A, g.cl, g.f);
      await c2.query("BEGIN");
      await c2.query(`UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = $1::uuid`, [g.f, outro.cl]);
      try {
        await assert.rejects(porTransacao(c1)((tx) => env1.criarEnvio(tx, anel, entrada(x2))), (e: { code?: string }) => e.code === "55P03");
      } finally {
        await c2.query("ROLLBACK");
      }
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_envios WHERE fechamento_id = $1::uuid`, [g.f]), 0);
    });

    await t.test("regeneração concorrente: uma transação regenera, a outra espera, relê e devolve o MESMO link (geração 2)", async () => {
      const p = await envioPronto();
      await c1.query("BEGIN");
      const primeiro = await env1.linkDoEnvio(executor(c1), soChave2, p.envio);
      const segundo = porTransacao(c2)((tx) => env2.linkDoEnvio(tx, soChave2, p.envio));
      await esperarBloqueio(c3, p2, p1, "UPDATE satisfacao_envios");
      await c1.query("COMMIT");
      const s = await segundo;
      assert.equal(primeiro?.geracao, 2);
      assert.equal(primeiro?.regenerado, true);
      assert.deepEqual(s, { token: primeiro!.token, geracao: 2, regenerado: false });
      assert.equal((await um(`SELECT geracao FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).geracao, 2);
    });

    await t.test("bloqueio do WhatsApp transferido entre controles e conversa (outra conexão): a leitura nunca vê 'liberado'", async () => {
      const numero = "5511977720001";
      await c3.query(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'staging', $2, true)`, [A, numero]);
      let parar = false, transferencias = 0;
      const transferir = (async () => {
        while (!parar) {
          await c3.query("BEGIN");
          await c3.query(`INSERT INTO whatsapp_atendimento_controles_contato (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'production', $2, true)`, [A, numero]);
          await c3.query(`UPDATE whatsapp_atendimento_conversas SET nao_contatar = false WHERE empresa_id = $1::uuid AND contato = $2`, [A, numero]);
          await c3.query("COMMIT");
          await c3.query("BEGIN");
          await c3.query(`UPDATE whatsapp_atendimento_conversas SET nao_contatar = true WHERE empresa_id = $1::uuid AND contato = $2`, [A, numero]);
          await c3.query(`DELETE FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1::uuid AND contato = $2`, [A, numero]);
          await c3.query("COMMIT");
          transferencias += 2;
        }
      })();
      const leituras: boolean[] = [];
      try {
        for (let i = 0; i < 400; i++) leituras.push(await pref1.bloqueioWhatsappDoDestino(executor(c1), A, numero));
      } finally {
        parar = true;
        await transferir;
      }
      assert.ok(transferencias >= 10, `transferências concorrentes: ${transferencias}`);
      assert.equal(leituras.filter((b) => !b).length, 0, "nenhuma leitura viu o destino liberado");
    });
  } finally {
    await encerrarDescartavel(c3, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});
