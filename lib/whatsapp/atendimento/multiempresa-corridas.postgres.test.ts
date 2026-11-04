import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { MENSAGEM_ENCAMINHAMENTO } from "./core.ts";
import * as multiempresa from "./multiempresa.ts";
import { adiado, noPrazo } from "./harness-postgres.ts";
import { aoFimDaTransacao, carregarMultiempresa, cod, comGancho, conexaoExtra, fixturesMultiempresa, flags, semGanchos, SENHA } from "./harness-multiempresa.ts";
import type { AlvoEnvio, DependenciasWorker } from "./worker.ts";

/**
 * E-ME1 r2 — corridas de status e de rodízio (§4, §5, §8) no PostgreSQL DESCARTÁVEL, modelo 112 + 117 aplicada pela suíte.
 * Cada transação do worker e do callback é uma CONEXÃO própria; barreiras determinísticas (promessas dentro de `enviar` e
 * travas seguradas por uma TERCEIRA conexão) e espera OBSERVADA em pg_stat_activity. Nenhuma rede, nenhum modelo.
 *
 *  1c-AB  status antecipado só no buffer de A; A e B presos no POST com o MESMO identificador; A grava primeiro: A aplica
 *         (única), B vê duas, grava a marca e não aplica; B nunca recebe status;
 *  1c-BA  mesmo cenário, B grava primeiro: B é única, mas sem buffer de B nada é aplicado; A vê duas, marca, não aplica;
 *         nenhuma aplicação; o buffer de A fica (expira em 24 h);
 *  1d     dois workers gravando o mesmo identificador AO MESMO TEMPO: os dois ficam observados esperando a trava wa-prov
 *         (segurada por uma terceira conexão); liberada, serializam: no máximo uma aplicação e a marca gravada;
 *  3      dois workers, a conversa-cabeça de A travada por uma terceira conexão, backlog de A e 1 tarefa de B: nenhum worker
 *         espera trava de conversa (prazo), a cabeça de B é reservada em ≤ 1 + K = 2 reservas e A não é reservada duas
 *         vezes antes de B;
 *  3b     igual ao 3 com uma tarefa anterior de B em ENVIANDO antiga e a recuperação rodando durante as reservas: o rodízio
 *         só muda nas reservas (uma escrita por reserva), a ordem de B não muda com a recuperação;
 *  3d     B já atendida e única elegível; C nova (sem linha) entra antes da próxima reserva: [C, B, C];
 *  3e     B com duas tarefas em conversas distintas + A elegível: [B(cabeça), A, B(2ª)];
 *  M      medição de §4: 20 empresas × 5.000 pendentes; seleção do rodízio ≤ 50 ms (mediana de 20);
 *  M-r3   reserva INTEGRAL do worker (processarAtendimento real: trava do rodízio → seleção → C1–C4 → travas → reserva
 *         gravada → RELEASE → vez no rodízio → COMMIT), 20 empresas que operam × 5.000 pendentes com commit: mediana, p95 e máx
 *         RELATADOS (o §4 limita a seleção, não a reserva integral); cada intervalo medido contém a gravação da vez.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261104_117_atendimento_multiempresa.sql");
const POS = ler("database/checks/20261104_117_postcheck.sql");
const SEGREDO = Buffer.alloc(32, 7).toString("base64");
Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: SEGREDO, WHATSAPP_CREDENTIAL_KEY_VERSION: "1", META_GRAPH_API_VERSION: "v23.0", WHATSAPP_ATENDIMENTO_MULTIEMPRESA: "true" });

test("E-ME1 r2: corridas de status (1c-AB, 1c-BA, 1d) e de rodízio (3, 3b, 3d, 3e) + medição 20×5.000", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const extra = await conexaoExtra();
  try {
    await q(UP); await q(POS);
    const criarUsuario = async (papel: string) => (await q(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness corridas', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel])).rows[0].id as string;
    const f = fixturesMultiempresa(q, criarUsuario);
    const A = await f.empresa("A piloto"), B = await f.empresa("B"), C = await f.empresa("C");
    flags.piloto = A; flags.kproc = true; flags.regras = true;
    const sA = await f.sessao(A), sB = await f.sessao(B), sC = await f.sessao(C);
    const autor = sA.usuario_id;
    for (const e of [A, B, C]) await f.conectar(e, autor);
    for (const e of [B, C]) await f.isentar(e, autor);
    const { servico, worker, meta } = carregarMultiempresa();
    for (const s of [sA, sB, sC]) await servico.salvarConfiguracao(s as never, { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 50 } });
    assert.equal(await multiempresa.modoEfetivo({ query: (s: string, v?: readonly unknown[]) => c.query(s, v ? [...v] : []) } as never), "MULTI");

    const nome = new Map([[A, "A"], [B, "B"], [C, "C"]]);
    const conta = async (sql: string, v: unknown[] = []) => Number((await q(sql, v)).rows[0].n);
    const estadoDe = async (id: string) => (await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id=$1", [id])).rows[0].estado as string;
    let contatoSeq = 100;
    // Saída automática pronta para sair (texto fixo de encaminhamento: não depende de respostas publicadas), numa conversa
    // própria aguardando a equipe, janela aberta.
    const saidaPronta = async (e: string, opcoes: { estado?: string; iniciadaHaMin?: number } = {}) => {
      const contato = `556190${String(contatoSeq++).padStart(7, "0")}`;
      const conversa = (await q("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em) VALUES ($1, 'staging', $2, 'AGUARDANDO_HUMANO', clock_timestamp()) RETURNING id", [e, contato])).rows[0].id as string;
      const id = (await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, iniciada_em)
        VALUES ($1, $2, 'staging', 'SAIDA', $3, $4, 0, CASE WHEN $5::int IS NULL THEN NULL ELSE clock_timestamp() - make_interval(mins => $5::int) END) RETURNING id`, [conversa, e, MENSAGEM_ENCAMINHAMENTO, opcoes.estado ?? "PENDENTE", opcoes.iniciadaHaMin ?? null])).rows[0].id as string;
      return { conversa, id };
    };
    // Reservas observadas: a transição para PROCESSANDO feita pela reserva (consulta exata de reservarMensagem).
    const reservas: string[] = [];
    const escritasRodizio: string[] = [];
    comGancho((sql, _o, v) => {
      if (sql.startsWith("UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1") && !sql.includes("AND estado='PROCESSANDO'") && v[1] === "PROCESSANDO") reservas.push(String(v[0]));
      if (sql.includes("INSERT INTO whatsapp_atendimento_rodizio")) escritasRodizio.push(String(v[0]));
    });
    const empresaDaMensagem = async (id: string) => nome.get((await q("SELECT empresa_id FROM whatsapp_atendimento_mensagens WHERE id=$1", [id])).rows[0].empresa_id as string) ?? "?";
    const sequencia = async (ids: string[]) => Promise.all(ids.map(empresaDaMensagem));
    const zerarRodizio = async (ordens: [string, number][]) => {
      await q("DELETE FROM whatsapp_atendimento_rodizio WHERE ambiente='staging'");
      for (const [e, o] of ordens) await q("INSERT INTO whatsapp_atendimento_rodizio (empresa_id, ambiente, ordem) VALUES ($1, 'staging', $2)", [e, o]);
      reservas.length = 0; escritasRodizio.length = 0;
    };
    const semPendentes = () => q("UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE estado IN ('PENDENTE','PROCESSANDO')");

    // Transporte com portões por empresa: o envio da empresa fica preso DENTRO de `enviar` (já ENVIANDO) até liberar.
    type Portao = { chegou: ReturnType<typeof adiado<void>>; solta: ReturnType<typeof adiado<void>> };
    const portoes = new Map<string, Portao>();
    let idFixo: string | null = null;
    const envios: AlvoEnvio[] = [];
    const deps: DependenciasWorker = {
      interpretar: null,
      enviar: async (_contato, _conteudo, alvo) => {
        envios.push(alvo);
        const p = portoes.get(alvo.empresaId);
        if (p) { portoes.delete(alvo.empresaId); p.chegou.liberar(); await p.solta.p; }
        return idFixo ?? cod("wamid.");
      },
    };
    const prender = (e: string) => { const p: Portao = { chegou: adiado<void>(), solta: adiado<void>() }; portoes.set(e, p); return { chegou: p.chegou.p, liberar: () => p.solta.liberar() }; };
    const statusDe = (e: string, provedorId: string, tipo: "delivered" | "failed" = "delivered") =>
      meta.receberEventosMeta({ entradas: [], status: [{ phoneNumberId: f.numero(e), wabaId: f.waba(e), id: provedorId, tipo }] }, { automacaoGlobal: true });
    const buffer = (e: string, id: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE empresa_id=$1 AND provedor_id=$2", [e, id]);
    const marca = (id: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_status_colisoes WHERE ambiente='staging' AND provedor_id=$1", [id]);

    // ——— 1c-AB ———
    {
      const X = cod("wamid.1cab.");
      await statusDe(A, X);
      assert.deepEqual([await buffer(A, X), await buffer(B, X)], [1, 0], "1c-AB: status antecipado só no buffer de A");
      await zerarRodizio([[A, 1], [B, 2]]);
      const sa = await saidaPronta(A), sb = await saidaPronta(B);
      idFixo = X;
      const pa = prender(A), pb = prender(B);
      const w1 = worker.processarLote(deps, { maxTarefas: 1 }), w2 = worker.processarLote(deps, { maxTarefas: 1 });
      await noPrazo(Promise.all([pa.chegou, pb.chegou]), 20_000, "1c-AB: os dois POSTs presos");
      assert.deepEqual([await estadoDe(sa.id), await estadoDe(sb.id)], ["ENVIANDO", "ENVIANDO"], "1c-AB: os dois em voo ao mesmo tempo (conexões distintas)");
      pa.liberar();
      const [primeiro] = await Promise.race([w1.then(() => [1]), w2.then(() => [2])]);
      assert.equal(await estadoDe(sa.id), "ENTREGUE", "1c-AB: A grava primeiro e aplica (única naquele momento)");
      pb.liberar();
      await noPrazo(primeiro === 1 ? w2 : w1, 20_000, "1c-AB: B termina");
      assert.deepEqual([await estadoDe(sa.id), await estadoDe(sb.id), await marca(X), await buffer(B, X)], ["ENTREGUE", "SUBMETIDA", 1, 0], "1c-AB: B vê duas, grava a marca, não aplica; B sem status");
      await statusDe(B, X);
      assert.equal(await estadoDe(sb.id), "SUBMETIDA", "1c-AB: B nunca recebe status (marca vigente)");
    }
    // ——— 1c-BA ———
    {
      const X = cod("wamid.1cba.");
      await statusDe(A, X);
      await zerarRodizio([[A, 1], [B, 2]]);
      const sa = await saidaPronta(A), sb = await saidaPronta(B);
      idFixo = X;
      const pa = prender(A), pb = prender(B);
      const wa = worker.processarLote(deps, { maxTarefas: 1 }), wb = worker.processarLote(deps, { maxTarefas: 1 });
      await noPrazo(Promise.all([pa.chegou, pb.chegou]), 20_000, "1c-BA: os dois POSTs presos");
      pb.liberar();
      for (let i = 0; i < 400 && (await estadoDe(sb.id)) === "ENVIANDO"; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(await estadoDe(sb.id), "SUBMETIDA", "1c-BA: B grava primeiro; única, mas sem buffer de B nada é aplicado");
      pa.liberar();
      await noPrazo(Promise.all([wa, wb]), 20_000, "1c-BA: workers terminam");
      assert.deepEqual([await estadoDe(sa.id), await estadoDe(sb.id), await marca(X), await buffer(A, X)], ["SUBMETIDA", "SUBMETIDA", 1, 1], "1c-BA: A vê duas, marca, não aplica; nenhuma aplicação; buffer de A mantido (expira em 24 h)");
    }
    // ——— 1d ———
    {
      const X = cod("wamid.1d.");
      await statusDe(A, X);
      await zerarRodizio([[A, 1], [B, 2]]);
      const sa = await saidaPronta(A), sb = await saidaPronta(B);
      idFixo = X;
      // Terceira conexão segura a trava por identificador (mesma chave da aplicação) antes dos POSTs voltarem.
      await extra.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`wa-prov:staging:${X}`]);
      const w1 = worker.processarLote(deps, { maxTarefas: 1 }), w2 = worker.processarLote(deps, { maxTarefas: 1 });
      let esperando = 0;
      for (let i = 0; i < 600 && esperando < 2; i++) {
        esperando = Number((await q("SELECT count(*) AS n FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted AND l.locktype='advisory' WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND a.query LIKE 'SELECT pg_advisory_xact_lock%'")).rows[0].n);
        if (esperando < 2) await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(esperando, 2, "1d: os DOIS workers observados esperando a trava wa-prov (pg_locks não concedida)");
      assert.deepEqual([await estadoDe(sa.id), await estadoDe(sb.id)], ["ENVIANDO", "ENVIANDO"], "1d: nenhum gravou o identificador antes da trava");
      await extra.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`wa-prov:staging:${X}`]);
      await noPrazo(Promise.all([w1, w2]), 20_000, "1d: serializados depois da trava");
      const finais = [await estadoDe(sa.id), await estadoDe(sb.id)];
      assert.ok(finais.every((x) => x === "SUBMETIDA" || x === "ENTREGUE"), `1d: estados finais ${finais}`);
      assert.ok(finais.filter((x) => x === "ENTREGUE").length <= 1, "1d: nunca duas aplicações");
      assert.equal(await marca(X), 1, "1d: o segundo viu duas saídas e gravou a marca");
    }
    idFixo = null;

    // ——— 3: dois workers, conversa-cabeça de A travada ———
    await semPendentes();
    {
      await zerarRodizio([[A, 1], [B, 2]]);
      const cabecaA = await saidaPronta(A);
      const backlogA = [await saidaPronta(A), await saidaPronta(A), await saidaPronta(A)];
      const cabecaB = await saidaPronta(B);
      await extra.query("BEGIN");
      await extra.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE", [cabecaA.conversa]);
      const w1 = worker.processarLote(deps, { maxTarefas: 2 }), w2 = worker.processarLote(deps, { maxTarefas: 2 });
      await noPrazo(Promise.all([w1, w2]), 15_000, "3: nenhum worker espera a conversa travada de A");
      const seq = await sequencia(reservas);
      const posB = reservas.indexOf(cabecaB.id);
      assert.ok(posB >= 0 && posB <= 1, `3: cabeça de B reservada em ≤ 1 + K = 2 reservas (sequência ${seq})`);
      assert.ok(seq.slice(0, posB).filter((x) => x === "A").length <= 1, "3: A não é reservada duas vezes antes de B");
      assert.ok(!reservas.includes(cabecaA.id), "3: a conversa travada foi PULADA (SKIP LOCKED), não esperada");
      assert.equal(await estadoDe(cabecaA.id), "PENDENTE", "3: a cabeça de A continua na fila");
      assert.ok(backlogA.some((x) => reservas.includes(x.id)), "3: A foi atendida pela próxima conversa dela");
      await extra.query("COMMIT");
    }
    // ——— 3b: recuperação e envio de B não mexem no rodízio ———
    await semPendentes();
    {
      await zerarRodizio([[A, 1], [B, 2]]);
      const antigaB = await saidaPronta(B, { estado: "ENVIANDO", iniciadaHaMin: 12 });
      const cabecaA = await saidaPronta(A); await saidaPronta(A);
      const cabecaB = await saidaPronta(B);
      await extra.query("BEGIN");
      await extra.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id=$1 FOR UPDATE", [cabecaA.conversa]);
      const ordemB = async () => Number((await q("SELECT ordem FROM whatsapp_atendimento_rodizio WHERE empresa_id=$1 AND ambiente='staging'", [B])).rows[0].ordem);
      const w1 = worker.processarLote(deps, { maxTarefas: 2 });
      await servico.recuperarTrabalhosInterrompidos();
      const w2 = worker.processarLote(deps, { maxTarefas: 2 });
      await noPrazo(Promise.all([w1, w2]), 15_000, "3b");
      await extra.query("COMMIT");
      assert.equal(await estadoDe(antigaB.id), "INCERTO", "3b: a recuperação rodou (ENVIANDO antiga → INCERTO), sem reenviar");
      assert.ok(!envios.some((x) => x.saidaId === antigaB.id), "3b: nada reenviado");
      assert.equal(escritasRodizio.length, reservas.length, "3b: uma escrita no rodízio por reserva, nenhuma outra");
      const posB = reservas.indexOf(cabecaB.id);
      assert.ok(posB >= 0 && posB <= 1, "3b: a garantia se mantém (B em ≤ 2 reservas)");
      const ordemDepois = await ordemB();
      await servico.recuperarTrabalhosInterrompidos();
      assert.equal(await ordemB(), ordemDepois, "3b: a recuperação não altera a ordem de B");
    }
    // ——— 3d: C nova entra antes da próxima reserva ———
    await semPendentes();
    {
      await zerarRodizio([[B, 5]]);
      await q("DELETE FROM whatsapp_atendimento_rodizio WHERE empresa_id=$1", [C]);
      await saidaPronta(B);
      await saidaPronta(C); await saidaPronta(C);
      await noPrazo(worker.processarLote(deps, { maxTarefas: 3 }), 20_000, "3d");
      assert.deepEqual(await sequencia(reservas), ["C", "B", "C"], "3d: C (sem linha) uma vez antes de B; C não volta antes de B (K=1, limite 2)");
    }
    // ——— 3e: garantia por empresa, não por tarefa ———
    await semPendentes();
    {
      await zerarRodizio([[B, 1], [A, 2]]);
      const b1 = await saidaPronta(B), b2 = await saidaPronta(B), a1 = await saidaPronta(A);
      await noPrazo(worker.processarLote(deps, { maxTarefas: 3 }), 20_000, "3e");
      assert.deepEqual(reservas, [b1.id, a1.id, b2.id], "3e: cabeça de B, depois A, depois a 2ª de B");
    }
    semGanchos();

    // ——— M: medição de §4 (20 empresas × 5.000 pendentes), numa transação desfeita ao final ———
    await semPendentes();
    {
      await q("BEGIN");
      const empresas: string[] = [];
      for (let i = 0; i < 20; i++) {
        const e = (await q(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("med"), `Medição ${i}`])).rows[0].id as string;
        await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
        empresas.push(e);
        const conversas = (await q(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em)
          SELECT $1, 'staging', '5561' || lpad(($2::int * 1000 + g)::text, 9, '0'), 'AGUARDANDO_HUMANO', clock_timestamp() FROM generate_series(1, 50) g RETURNING id`, [e, i])).rows.map((r) => r.id as string);
        await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, criada_em)
          SELECT ($2::uuid[])[1 + (g % 50)], $1, 'staging', 'SAIDA', 'medição', 'PENDENTE', 0, clock_timestamp() - make_interval(secs => g) FROM generate_series(1, 5000) g`, [e, conversas]);
      }
      for (let i = 0; i < 10; i++) await q("INSERT INTO whatsapp_atendimento_rodizio (empresa_id, ambiente, ordem) VALUES ($1, 'staging', $2)", [empresas[i], 1000 + i]);
      await q("ANALYZE whatsapp_atendimento_mensagens"); await q("ANALYZE whatsapp_atendimento_rodizio");
      const tx = { query: (s: string, v?: readonly unknown[]) => c.query(s, v ? [...v] : []) } as never;
      const medir = async (f2: () => Promise<unknown>) => { const tempos: number[] = []; for (let i = 0; i < 20; i++) { const t0 = performance.now(); await f2(); tempos.push(performance.now() - t0); } tempos.sort((a, b) => a - b); return tempos[10]; };
      const selecao = await medir(() => multiempresa.empresasNaOrdemDoRodizio(tx, "staging"));
      assert.equal((await multiempresa.empresasNaOrdemDoRodizio(tx, "staging")).filter((e) => empresas.includes(e)).length, 20);
      console.log(`[medição §4] 20×5.000 pendentes: seleção do rodízio mediana ${selecao.toFixed(2)} ms`);
      await q("ROLLBACK");
      assert.ok(selecao <= 50, `M: seleção do rodízio ${selecao.toFixed(2)} ms ≤ 50 ms`);
    }

    // ——— M-r3: tempo INTEGRAL da transação de reserva do worker (revisão r2 do Astra) ———
    // 20 empresas que OPERAM (conectadas, isentas, configuração ligada), 50 conversas × 5.000 saídas PENDENTE cada, com
    // commit (o worker usa outra conexão). Medido por ganchos no próprio worker: da trava consultiva do rodízio (início da
    // seleção) até logo DEPOIS do COMMIT da transação que gravou a reserva (antes de executarTarefa) — inclui
    // seleção do rodízio, C1/C3/C2/C4, travas de linha (SKIP LOCKED), revalidação, reservarMensagem, RELEASE SAVEPOINT, a vez no
    // rodízio e o COMMIT (o fim é o aviso de fim de transação do harness, logo depois do COMMIT). Mediana de 20.
    await semPendentes();
    {
      const empresas: string[] = [];
      for (let i = 0; i < 20; i++) {
        const e = await f.empresa(`Medição ${i}`);
        const s = await f.sessao(e);
        await f.conectar(e, autor); await f.isentar(e, autor);
        await servico.salvarConfiguracao(s as never, { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 50 } });
        empresas.push(e);
        const conversas = (await q(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em)
          SELECT $1, 'staging', '5562' || lpad(($2::int * 1000 + g)::text, 9, '0'), 'AGUARDANDO_HUMANO', clock_timestamp() - interval '3 hours' FROM generate_series(1, 50) g RETURNING id`, [e, i])).rows.map((r) => r.id as string);
        await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, criada_em)
          SELECT ($2::uuid[])[1 + (g % 50)], $1, 'staging', 'SAIDA', $3, 'PENDENTE', 0, clock_timestamp() - make_interval(secs => g * 0.1) FROM generate_series(1, 5000) g`, [e, conversas, MENSAGEM_ENCAMINHAMENTO]);
      }
      await q("DELETE FROM whatsapp_atendimento_rodizio WHERE ambiente='staging'");
      for (let i = 0; i < 10; i++) await q("INSERT INTO whatsapp_atendimento_rodizio (empresa_id, ambiente, ordem) VALUES ($1, 'staging', $2)", [empresas[i], 1000 + i]);
      await q("ANALYZE whatsapp_atendimento_mensagens"); await q("ANALYZE whatsapp_atendimento_rodizio"); await q("ANALYZE whatsapp_atendimento_conversas");
      const tempos: number[] = [];
      let t0: number | null = null, reservou = false, vez = false; const reservadas: string[] = []; let comVez = 0;
      const tirar = comGancho((sql, _o, v) => {
        if (sql.includes('pg_advisory_xact_lock') && String(v[0] ?? '').startsWith('wa-rodizio:')) { t0 = performance.now(); reservou = false; vez = false; return; }
        if (t0 === null) return;
        if (sql.startsWith('UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1') && v[1] === 'PROCESSANDO') { reservou = true; reservadas.push(String(v[0])); return; }
        if (reservou && sql.includes('whatsapp_atendimento_rodizio') && /^s*(INSERT|UPDATE)/i.test(sql)) vez = true;
      });
      // Fim = logo depois do COMMIT da transação que gravou a reserva (inclui RELEASE SAVEPOINT, a vez no rodízio e o
      // COMMIT), antes de executarTarefa (revisão r3 do Astra, P3).
      const commits: number[] = [];
      const tirarFim = aoFimDaTransacao(({ commitMs }) => { if (t0 !== null && reservou) { tempos.push(performance.now() - t0); commits.push(commitMs); if (vez) comVez++; t0 = null; reservou = false; vez = false; } });
      for (let i = 0; i < 20; i++) {
        assert.notEqual(await worker.processarAtendimento(deps), "SEM_TAREFA", "M-r3: há tarefa");
      }
      tirar(); tirarFim();
      assert.equal(tempos.length, 20, `M-r3: 20 reservas medidas (${tempos.length})`);
      assert.equal(comVez, 20, `M-r3: cada intervalo inclui a gravação da vez no rodízio (${comVez})`);
      const empresasReservadas = new Set((await q("SELECT empresa_id FROM whatsapp_atendimento_mensagens WHERE id = ANY($1::uuid[])", [reservadas])).rows.map((r) => r.empresa_id as string));
      assert.equal(empresasReservadas.size, 20, `M-r3: o rodízio passou pelas 20 empresas (${empresasReservadas.size})`);
      const semCommit = tempos.map((x, i) => x - commits[i]).sort((a, b) => a - b);
      commits.sort((a, b) => a - b);
      tempos.sort((a, b) => a - b);
      const reserva = tempos[10], p95 = tempos[18];
      console.log(`[medição §4 r3b] reserva INTEGRAL do worker (trava do rodízio → reserva → RELEASE → vez → COMMIT), 20×5.000 pendentes: mediana ${reserva.toFixed(2)} ms; p95 ${p95.toFixed(2)} ms; máx ${tempos[19].toFixed(2)} ms | sem o COMMIT: mediana ${semCommit[10].toFixed(2)} ms, p95 ${semCommit[18].toFixed(2)} ms, máx ${semCommit[19].toFixed(2)} ms | só o COMMIT: mediana ${commits[10].toFixed(2)} ms, p95 ${commits[18].toFixed(2)} ms, máx ${commits[19].toFixed(2)} ms`);
      // Plano de execução da consulta de reserva de reservarDaEmpresa (texto idêntico ao do worker, com a trava de linha),
      // numa transação desfeita: base para decidir um índice com medição válida (revisão r3 do Astra).
      await q("BEGIN");
      const plano = (await q(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT m.* FROM whatsapp_atendimento_mensagens m
        WHERE m.empresa_id=$1 AND m.ambiente=$2 AND m.estado='PENDENTE' AND NOT (m.conversa_id = ANY($3::uuid[]))
        AND NOT EXISTS(SELECT 1 FROM whatsapp_atendimento_mensagens ativa WHERE ativa.conversa_id=m.conversa_id AND ativa.estado IN ('PROCESSANDO','ENVIANDO'))
        ORDER BY m.criada_em,m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1`, [empresas[19], "staging", []])).rows.map((r) => r["QUERY PLAN"]).join(" | ");
      await q("ROLLBACK");
      console.log(`[medição §4 r3b] plano da consulta de reserva (empresa com 5.000 pendentes):
${plano}`);
      await semPendentes();
    }
  } finally {
    semGanchos();
    await extra.query("ROLLBACK").catch(() => {});
    await extra.end().catch(() => {});
    await c.end();
  }
});
