import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarComBanco, cod, executor, porTransacao, SENHA_FALSA } from "../marketing/harness-postgres.ts";
import { baseSintetica, travaAgendaFixture, type CriarEnvio } from "./harness-postgres.ts";
import { lerAnel, type AnelChaves } from "./token.ts";

/**
 * Pesquisa de satisfação (110, PS-1): concorrência no PostgreSQL descartável, modelo 110, com três conexões e dados
 * COMMITADOS. Prova, observando pg_stat_activity/pg_blocking_pids (nada de sleep como prova):
 *   - duas respostas do mesmo link serializam no envio (marcador satisfacao:travar-envio): uma grava, a outra "já respondida";
 *   - resposta × cancelamento SIMULADO em SQL com os pais ocupados (fechamento → contrato FOR UPDATE, a ordem das duas
 *     entradas reais; elas mesmas são exercitadas em satisfacao-cancelamento.postgres.test.ts): a pesquisa
 *     NUNCA espera (NOWAIT), repete a transação inteira até 5 vezes e devolve "tente de novo" sem gravar; se o
 *     cancelamento confirma no meio, a próxima tentativa revoga;
 *   - resposta com os pais travados FOR SHARE: o cancelamento espera por ela (sem deadlock) e confirma depois;
 *   - criação do envio de duas execuções da mesma festa: a trava por cliente serializa, só um envio;
 *   - criação × troca do cliente da festa nas duas ordens: a troca espera a criação; a criação recebe 55P03 (NOWAIT);
 *   - regeneração do link em duas transações: uma regenera, a outra relê e devolve o MESMO link (geração 2);
 *   - bloqueio do WhatsApp transferido entre controles e conversa (K1/K2), pelo chamador real elegivelParaMensagem: uma
 *     BARREIRA confirma a transferência logo depois da primeira leitura das tabelas do atendimento, nas duas direções;
 *     a leitura numa instrução continua bloqueando (dois SELECTs separados liberariam — mutantes M29a/M29b).
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")},2:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
const soChave2 = lerAnel({ SATISFACAO_LINK_CHAVES: `2:${anel.chaves.get(2)!.toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "2" }) as AnelChaves;

type Publico = Record<"abrirPesquisa" | "responderPesquisa" | "sairDasPesquisas", (corpo: unknown, ctx: { ip: string | null }, deps: unknown) => Promise<Record<string, unknown>>>;
type Envios = { criarEnvio: CriarEnvio; linkDoEnvio(tx: unknown, anel: AnelChaves, envioId: string): Promise<{ token: string; geracao: number; regenerado: boolean } | null> };
type Pref = {
  alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<unknown>;
  elegivelParaMensagem(tx: DbExecutor, e: string, clienteId: string): Promise<{ ok: boolean; motivo?: string }>;
};

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
  const c4 = await conectarDescartavel({ travar: false });
  try {
    const carregar = <T>(c: Client, f: string) => carregarComBanco(f, c, () => null, {}, new Map()) as unknown as T;
    const pub1 = carregar<Publico>(c1, "lib/satisfacao/publico.ts"), pub2 = carregar<Publico>(c2, "lib/satisfacao/publico.ts");
    const env1 = carregar<Envios>(c1, "lib/satisfacao/envios.ts"), env2 = carregar<Envios>(c2, "lib/satisfacao/envios.ts");
    const pref1 = carregar<Pref>(c1, "lib/marketing/automacoes/preferencias.ts");
    const { A, usuario, festa, execucao, envioPronto } = await baseSintetica(c3, anel, env1.criarEnvio, identidade);
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

    /**
     * Simulação em SQL da ordem das entradas reais de cancelamento (protocolo da 114: empresa FOR UPDATE pelo provarTenant →
     * configuração compartilhada → fechamento e contrato FOR UPDATE), para esgotar as 5 tentativas.
     */
    async function travarComoCancelamento(f: string) {
      await c3.query("BEGIN");
      await c3.query(`SELECT 1 FROM empresas WHERE id = $1::uuid FOR UPDATE`, [A]);
      await travaAgendaFixture(c3, A);
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

    await t.test("P3: empresa compatível e advisory da configuração EXCLUSIVA ocupada → 55P03 em todas as tentativas, nada gravado; liberada, a repetição grava", async () => {
      const p = await envioPronto();
      const travasDeC1 = async () => Number((await c1.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND locktype IN ('advisory', 'tuple', 'transactionid') AND granted`)).rows[0].n);
      const base = await travasDeC1(); // a trava de sessão do harness (advisory) permanece
      // Mudança de configuração da agenda (114): só a advisory exclusiva, sem trava na linha da empresa (KEY SHARE segue compatível).
      await c3.query("BEGIN");
      await c3.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [A]);
      const repeticoes: string[] = [];
      try {
        await assert.rejects(pub1.responderPesquisa({ token: p.token, notaIndicacao: 2 }, { ip: ip() }, deps(c1, { repeticao: { esperar: async () => {}, aoRepetir: (_n: number, cod: string) => repeticoes.push(cod) } })),
          erroDe("TENTE_NOVAMENTE", 503));
        // Rollback integral: c1 fora de transação e sem nenhuma trava além da de sessão do harness depois da recusa.
        assert.equal(await travasDeC1(), base);
        assert.equal((await c1.query(`SELECT pg_current_xact_id_if_assigned() IS NULL AS livre`)).rows[0].livre, true);
      } finally {
        await c3.query("ROLLBACK");
      }
      assert.deepEqual(repeticoes, ["55P03", "55P03", "55P03", "55P03"], "4 repetições = 5 tentativas, todas pela configuração ocupada");
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).estado, "ATIVO");
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio]), 0);
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_entregas WHERE envio_id = $1::uuid AND estado = 'PENDENTE'`, [p.envio]), 2);
      // Liberada no meio das tentativas: a seguinte grava.
      await c3.query("BEGIN");
      await c3.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [A]);
      const codigos: string[] = [];
      let liberou = false;
      const esperar = async () => { if (!liberou) { liberou = true; await c3.query("COMMIT"); } };
      try {
        assert.deepEqual(await pub1.responderPesquisa({ token: p.token, notaIndicacao: 2 }, { ip: ip() }, deps(c1, { repeticao: { esperar, aoRepetir: (_n: number, cod: string) => codigos.push(cod) } })),
          { gravada: true, linkAvaliacao: null });
      } finally { if (!liberou) await c3.query("ROLLBACK"); }
      assert.deepEqual(codigos, ["55P03"]);
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).estado, "RESPONDIDO");
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio]), 1);
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
      assert.deepEqual(await resposta, { gravada: true, linkAvaliacao: null });
      await cancelamento;
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).estado, "RESPONDIDO", "resposta confirmada antes do cancelamento");
      assert.equal((await um(`SELECT status FROM fechamentos WHERE id = $1::uuid`, [p.f])).status, "CANCELADO");
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE envio_id = $1::uuid`, [p.envio]), 1);
      assert.equal((await pub1.abrirPesquisa({ token: p.token }, { ip: ip() }, deps(c1))).situacao, "ENCERRADA", "PS-3 (G'): abre como ENCERRADA depois do cancelamento; o estado RESPONDIDO segue no banco");
    });

    /*
     * Saída × despacho × alteração administrativa (parecer do Astra, P2): três transações da mesma empresa/cliente/envio.
     * Administrativa = provarTenant (empresa FOR UPDATE) → alterarPreferencia (cliente FOR UPDATE); despacho = trava por
     * cliente → cliente FOR SHARE → envio FOR UPDATE (as duas simuladas em SQL, na ordem real); c4 só observa.
     */
    const admin = (cl: string) => c3.query(`SELECT status FROM empresas WHERE id = $1::uuid FOR UPDATE`, [A])
      .then(() => c3.query(`SELECT id FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [cl, A]));
    async function despachoAteOEnvio(cl: string, envio: string) {
      await c2.query("BEGIN");
      await c2.query(`SELECT pg_advisory_xact_lock(hashtext('marketing:' || $1 || ':' || $2))`, [A, cl]);
      await c2.query(`SELECT 1 FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid FOR SHARE`, [cl, A]);
      return c2.query(`SELECT 1 FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [envio]);
    }
    const codigo = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "erro");

    await t.test("saída na ordem antiga (envio FOR UPDATE → INSERT da saída): o ciclo com despacho e administrativa existe (40P01)", async () => {
      const p = await envioPronto();
      await c1.query("BEGIN");
      await c1.query(`SELECT 1 FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [p.envio]);
      const desp = codigo(despachoAteOEnvio(p.cl, p.envio));
      await esperarBloqueio(c4, p2, p1, "satisfacao_envios");
      await c3.query("BEGIN");
      const adm = codigo(admin(p.cl));
      await esperarBloqueio(c4, p3, p2, "FROM clientes");
      const saida = codigo(c1.query(`INSERT INTO satisfacao_saidas (empresa_id, cliente_id, origem) VALUES ($1::uuid, $2::uuid, 'PAGINA')`, [A, p.cl]));
      // O detector de deadlock aborta uma das três; as outras seguem ou esperam. Desfaz tudo e confere que houve 40P01.
      await Promise.race([saida, desp, adm]);
      await Promise.all([c1, c2, c3].map((c) => c.query("ROLLBACK")));
      const todos = await Promise.all([saida, desp, adm]);
      assert.equal(todos.filter((x) => x === "40P01").length, 1, `esperado um deadlock entre as três: ${todos.join("/")}`);
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_saidas WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`, [A, p.cl]), 0);
    });

    await t.test("saída pelo serviço (empresa KEY SHARE antes do envio) × despacho × administrativa: todos esperam em fila, sem deadlock", async () => {
      const p = await envioPronto();
      const chegou = { p: null as unknown as Promise<void>, ok: () => {} }, seguir = { p: null as unknown as Promise<void>, ok: () => {} };
      chegou.p = new Promise<void>((r) => { chegou.ok = r; }); seguir.p = new Promise<void>((r) => { seguir.ok = r; });
      const comBarreira = (base: DbExecutor): DbExecutor => ({
        async query(sql: string, v?: unknown[]) {
          const r = await base.query(sql, v);
          if (sql.includes("satisfacao:travar-envio")) { chegou.ok(); await seguir.p; }
          return r;
        },
      } as DbExecutor);
      const saida = pub1.sairDasPesquisas({ token: p.token, origem: "PAGINA" }, { ip: ip() }, deps(c1, {
        withTransaction: <T>(work: (tx: DbExecutor) => Promise<T>) => porTransacao(c1)((tx) => work(comBarreira(tx))) }));
      await chegou.p;                                   // a saída segura a empresa (KEY SHARE) e o envio (FOR UPDATE)
      const desp = codigo(despachoAteOEnvio(p.cl, p.envio));
      await esperarBloqueio(c4, p2, p1, "satisfacao_envios");
      await c3.query("BEGIN");
      const adm = codigo(admin(p.cl));
      await esperarBloqueio(c4, p3, p1, "FROM empresas");  // a administrativa espera a saída já na empresa
      seguir.ok();
      assert.deepEqual(await saida, { saiu: true });
      assert.equal(await desp, "ok");
      await esperarBloqueio(c4, p3, p2, "FROM clientes"); // depois da saída, a administrativa espera o despacho
      await c2.query("COMMIT");
      assert.equal(await adm, "ok");
      await c3.query("ROLLBACK");
      assert.equal(await contar(`SELECT count(*) AS n FROM satisfacao_saidas WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`, [A, p.cl]), 1);
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
      await travaAgendaFixture(c2, A);
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
      await travaAgendaFixture(c2, A);
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

    /**
     * K1/K2 com barreira determinística: o executor da conexão 1 confirma, na conexão 3, a TRANSFERÊNCIA do bloqueio logo
     * depois da PRIMEIRA leitura das tabelas do atendimento (`FROM whatsapp_atendimento_`). Numa instrução só, essa leitura
     * já decidiu com um snapshot (antes da transferência: bloqueia). Com dois SELECTs, o segundo veria o estado novo e o
     * destino sairia liberado. Pelo chamador real (elegivelParaMensagem), com autorização CONFIRMADA do número.
     */
    const comBarreira = (base: DbExecutor, depoisDaLeitura: () => Promise<void>) => {
      const estado = { disparou: false };
      const tx: DbExecutor = {
        async query(sql, valores) {
          const r = await base.query(sql, valores);
          if (!estado.disparou && /FROM whatsapp_atendimento_/.test(sql)) { estado.disparou = true; await depoisDaLeitura(); }
          return r;
        },
      } as DbExecutor;
      return { tx, estado };
    };
    const autorizado = async () => {
      const { cl, telefone } = await festa();
      await porTransacao(c1)((tx) => pref1.alterarPreferencia(tx, A, usuario, { acao: "preferencia", clienteId: cl, operacao: "autorizar", destino: telefone, confirmacao: "Autorizou (sintético)" }));
      assert.equal((await porTransacao(c1)((tx) => pref1.elegivelParaMensagem(tx, A, cl))).ok, true, "antes do bloqueio: elegível");
      return { cl, telefone };
    };
    const transferir = async (passos: Array<[string, unknown[]]>) => {
      await c3.query("BEGIN");
      for (const [sql, v] of passos) await c3.query(sql, v);
      await c3.query("COMMIT");
    };
    const contagem = async (telefone: string) => (await c3.query(`SELECT (SELECT count(*) FROM whatsapp_atendimento_controles_contato WHERE contato = $1)::int AS controles,
      (SELECT count(*) FROM whatsapp_atendimento_conversas WHERE contato = $1 AND nao_contatar)::int AS conversas`, [telefone])).rows[0];

    await t.test("K1/K2 barreira: bloqueio transferido da conversa para os controles depois da primeira leitura → continua bloqueado", async () => {
      const { cl, telefone } = await autorizado();
      await c3.query(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'staging', $2, true)`, [A, telefone]);
      const r = await porTransacao(c1)(async (base) => {
        const b = comBarreira(base, () => transferir([
          [`INSERT INTO whatsapp_atendimento_controles_contato (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'production', $2, true)`, [A, telefone]],
          [`UPDATE whatsapp_atendimento_conversas SET nao_contatar = false WHERE empresa_id = $1::uuid AND contato = $2`, [A, telefone]],
        ]));
        const e = await pref1.elegivelParaMensagem(b.tx, A, cl);
        assert.equal(b.estado.disparou, true, "a barreira disparou no meio da leitura");
        return e;
      });
      assert.deepEqual(r, { ok: false, motivo: "NAO_CONTATAR_ATENDIMENTO" });
      assert.deepEqual(await contagem(telefone), { controles: 1, conversas: 0 }, "a transferência foi confirmada");
      assert.deepEqual(await porTransacao(c1)((tx) => pref1.elegivelParaMensagem(tx, A, cl)), { ok: false, motivo: "NAO_CONTATAR_ATENDIMENTO" }, "depois: bloqueado");
    });

    await t.test("K1/K2 barreira: bloqueio transferido dos controles para a conversa depois da primeira leitura → continua bloqueado", async () => {
      const { cl, telefone } = await autorizado();
      await c3.query(`INSERT INTO whatsapp_atendimento_controles_contato (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'production', $2, true)`, [A, telefone]);
      await c3.query(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1::uuid, 'staging', $2)`, [A, telefone]);
      const r = await porTransacao(c1)(async (base) => {
        const b = comBarreira(base, () => transferir([
          [`UPDATE whatsapp_atendimento_conversas SET nao_contatar = true WHERE empresa_id = $1::uuid AND contato = $2`, [A, telefone]],
          [`DELETE FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1::uuid AND contato = $2`, [A, telefone]],
        ]));
        const e = await pref1.elegivelParaMensagem(b.tx, A, cl);
        assert.equal(b.estado.disparou, true, "a barreira disparou no meio da leitura");
        return e;
      });
      assert.deepEqual(r, { ok: false, motivo: "NAO_CONTATAR_ATENDIMENTO" });
      assert.deepEqual(await contagem(telefone), { controles: 0, conversas: 1 }, "a transferência foi confirmada");
      assert.deepEqual(await porTransacao(c1)((tx) => pref1.elegivelParaMensagem(tx, A, cl)), { ok: false, motivo: "NAO_CONTATAR_ATENDIMENTO" }, "depois: bloqueado");
    });
  } finally {
    await encerrarDescartavel(c4, false);
    await encerrarDescartavel(c3, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});
