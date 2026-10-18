import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cod, comercial, empresa, executor, fechamento, porTransacao, vincular, SENHA_FALSA } from "./harness-postgres.ts";

/**
 * F1 da revisão de f917f98 (15/10/2026): corrida entre o formulário do site (autorização de WhatsApp) e a saída do
 * número do cadastro. PostgreSQL descartável (modelo 085), TRÊS conexões reais (formulário, edição, observador), dados
 * COMMITADOS e barreiras explícitas:
 *   - a pausa do formulário acontece no executor, exatamente antes do INSERT da autorização (depois das leituras);
 *   - "a outra transação está bloqueada" é observado no próprio servidor (pg_stat_activity.wait_event_type = 'Lock' e
 *     pg_blocking_pids), nunca por espera de tempo; se nada acontecer em 15 s o teste falha como TEMPO_DO_TESTE,
 *     separado das asserções funcionais.
 * Serviços reais: registrarAutorizacaoDoFormulario, alterarPreferencia, atualizarCliente (CRM) e o motor com transporte
 * simulado. Gatilhos sempre ligados. Telefones sintéticos 55119444xxxxx.
 */
type Elegibilidade = { ok: boolean; telefone?: string; autorizacaoId?: string; motivo?: string };
type Pref = {
  registrarAutorizacaoDoFormulario(tx: unknown, e: string, c: string, k: string, tel: string): Promise<string>;
  alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<unknown>;
  elegivelParaMensagem(tx: unknown, e: string, c: string): Promise<Elegibilidade>;
};
type Crm = { atualizarCliente(id: string, escopo: unknown, patch: Record<string, unknown>, db: unknown): Promise<unknown> };
type Regras = {
  CATALOGO_REGRAS: Record<string, { texto: string }>;
  salvarRegra(tx: unknown, e: string, u: string, i: unknown): Promise<{ id: string; versao: number }>;
  revisarModelo(tx: unknown, e: string, u: string, id: string, v: number): Promise<{ versao: number }>;
  ativarRegra(tx: unknown, e: string, u: string, id: string, v: number): Promise<{ versao: number }>;
};
type Motor = { executarCiclo(b: unknown, t: unknown, agora: Date, o?: unknown): Promise<unknown> };
type Transp = { transporteSimulado(c: () => unknown): { enviar(m: { telefone: string; execucaoId: string }): Promise<unknown> } };
type Q = { query(sql: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const n = (i: number) => `5511944${String(i).padStart(6, "0")}`;

test("F1: formulário × saída do número do cadastro em transações concorrentes", { timeout: 600_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const c3 = await conectarDescartavel({ travar: false });
  try {
    const modulos = (c: Client) => {
      const cache = new Map();
      const carregar = <T>(f: string) => carregarComBanco(f, c, () => null, {}, cache) as unknown as T;
      return { pref: carregar<Pref>("lib/marketing/automacoes/preferencias.ts"), crm: carregar<Crm>("lib/clientes/repositories/cliente.repository.ts"),
        regras: carregar<Regras>("lib/marketing/automacoes/regras.ts"), motor: carregar<Motor>("lib/marketing/automacoes/motor.ts"),
        transp: carregar<Transp>("lib/marketing/automacoes/transporte.ts") };
    };
    const m1 = modulos(c1), m2 = modulos(c2);
    const pid = async (c: Client) => Number((await c.query("SELECT pg_backend_pid() AS p")).rows[0].p);
    const pid1 = await pid(c1), pid2 = await pid(c2);
    const ex1 = executor(c1), ex2 = executor(c2), ex3 = executor(c3);

    // Fixtures COMMITADAS (empresa, pessoa, clientes, contatos captados).
    await c1.query("BEGIN");
    const E = await empresa(c1, `F1 ${cod("")}`), F = await empresa(c1, `F1 outra ${cod("")}`);
    const usuario = (await c1.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão F1 sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`,
      [`${cod("u")}@marketing.test`, SENHA_FALSA])).rows[0].id;
    await vincular(c1, E, usuario, "REPRESENTANTE_AUTORIZADO");
    await c1.query("COMMIT");
    const cliente = async (telefone: string | null, whatsapp: string | null, empresaId = E) =>
      (await c3.query<{ id: string }>(`INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp) VALUES ($1, 'Cliente F1 sintético', $2, $3) RETURNING id::text AS id`, [empresaId, telefone, whatsapp])).rows[0].id;
    const contato = async (k: string, telefone: string) => (await c3.query<{ id: string }>(`INSERT INTO marketing_contatos (empresa_id, cliente_id, canal_atendimento, nome, telefone, chave_idempotencia, vinculo_cliente)
      VALUES ($1, $2, 'FORMULARIO_SITE', 'Pessoa do Site', $3, $4, 'EXISTENTE_CONTATO') RETURNING id::text AS id`, [E, k, telefone, `f1-${cod("")}-0000`])).rows[0].id;
    const autorizacoes = async (k: string) => (await c3.query(`SELECT destino, estado, origem, motivo_revogacao, confirmada_em IS NOT NULL AS tem_data, confirmacao
      FROM marketing_contato_autorizacoes WHERE cliente_id = $1 ORDER BY criado_em, id`, [k])).rows;
    const vivas = async (k: string, destino: string) => Number((await c3.query(`SELECT count(*)::int AS n FROM marketing_contato_autorizacoes
      WHERE cliente_id = $1 AND destino = $2 AND estado <> 'REVOGADA'`, [k, destino])).rows[0].n);
    const elegivel = (k: string) => m2.pref.elegivelParaMensagem(ex3, E, k);
    /** Edição do CRM pelo repositório real (dentro da transação aberta pelo chamador). */
    const editar = (k: string, telefone: string | null, whatsapp: string | null) =>
      m2.crm.atualizarCliente(k, { tipo: "TENANT", empresaId: E }, { telefone, whatsapp, usuarioId: usuario }, ex2);
    /** Volta o número ao cadastro (transação curta, confirmada). */
    const voltar = async (k: string, numero: string) => { await c3.query(`UPDATE clientes SET telefone = $2, whatsapp = $2 WHERE id = $1`, [k, numero]); };

    /** Barreira do servidor: espera a promessa terminar OU a sessão `alvo` ficar presa numa trava (sem tempo fixo). */
    const bloqueadaOuConcluida = async (p: Promise<unknown>, alvo: number, quemTrava: number) => {
      let fim = false;
      p.then(() => { fim = true; }, () => { fim = true; });
      const limite = Date.now() + 15_000;
      while (Date.now() < limite) {
        if (fim) return { estado: "CONCLUIDA" as const, bloqueadores: [] as number[] };
        const w = (await c3.query(`SELECT wait_event_type, pg_blocking_pids(pid) AS b FROM pg_stat_activity WHERE pid = $1`, [alvo])).rows[0];
        if (w?.wait_event_type === "Lock") {
          const bloqueadores = (w.b as number[]).map(Number);
          assert.ok(bloqueadores.includes(quemTrava), `bloqueada pela sessão esperada (${quemTrava}); bloqueadores: ${bloqueadores}`);
          return { estado: "BLOQUEADA" as const, bloqueadores };
        }
        await new Promise((r) => setImmediate(r));
      }
      throw new Error("TEMPO_DO_TESTE: a operação nem terminou nem ficou presa em trava em 15 s");
    };
    /** Executor do formulário que PARA antes do INSERT da autorização (depois das leituras decisórias). */
    const pausadoAntesDoInsert = () => {
      let liberar!: () => void, chegou!: () => void;
      const barreira = new Promise<void>((r) => { liberar = r; });
      const noInsert = new Promise<void>((r) => { chegou = r; });
      const tx: Q = { async query(sql, v) { if (sql.includes("INSERT INTO marketing_contato_autorizacoes")) { chegou(); await barreira; } return ex1.query(sql, v); } };
      return { tx, liberar, noInsert };
    };
    const registros: string[] = [];

    await t.test("leitura → INSERT: edição A→B intercalada depois da leitura e antes do INSERT; ao voltar A, a autorização obsoleta não vale", async () => {
      const A = n(1), B = n(2);
      const k = await cliente(A, A);
      const ct = await contato(k, A);
      const f = pausadoAntesDoInsert();
      await c1.query("BEGIN");
      const p1 = m1.pref.registrarAutorizacaoDoFormulario(f.tx, E, k, ct, A);
      await f.noInsert;
      await c2.query("BEGIN");
      const p2 = editar(k, B, B);
      const s = await bloqueadaOuConcluida(p2, pid2, pid1);
      registros.push(`leitura→INSERT: edição ${s.estado} (bloqueadores ${s.bloqueadores.join(",") || "-"})`);
      if (s.estado === "CONCLUIDA") await c2.query("COMMIT");
      f.liberar();
      const r1 = await p1;
      await c1.query("COMMIT");
      if (s.estado === "BLOQUEADA") { await p2; await c2.query("COMMIT"); }
      assert.equal(r1, "CONFIRMADA", "o formulário viu A no cadastro (leu antes da edição)");
      assert.deepEqual((await autorizacoes(k)).map((a) => [a.destino, a.estado]), [[A, "REVOGADA"]], "a edição alcançou a autorização do formulário");
      assert.match(String((await autorizacoes(k))[0].motivo_revogacao), /^NUMERO_SAIU_DO_CADASTRO: /);
      assert.equal((await autorizacoes(k))[0].tem_data, true, "evidência de confirmação preservada na revogação");
      await voltar(k, A);
      assert.deepEqual(await elegivel(k), { ok: false, motivo: "SEM_AUTORIZACAO" }, "autorização anterior à saída não volta a valer");
      assert.equal(s.estado, "BLOQUEADA", "protocolo: a edição espera a trava do formulário");
    });

    await t.test("INSERT → COMMIT: autorização inserida e ainda não confirmada quando a edição A→B tenta prosseguir", async () => {
      const A = n(3), B = n(4);
      const k = await cliente(A, A);
      const ct = await contato(k, A);
      await c1.query("BEGIN");
      const r1 = await m1.pref.registrarAutorizacaoDoFormulario(ex1, E, k, ct, A);
      await c2.query("BEGIN");
      const p2 = editar(k, B, B);
      const s = await bloqueadaOuConcluida(p2, pid2, pid1);
      registros.push(`INSERT→COMMIT: edição ${s.estado} (bloqueadores ${s.bloqueadores.join(",") || "-"})`);
      if (s.estado === "CONCLUIDA") await c2.query("COMMIT");
      await c1.query("COMMIT");
      if (s.estado === "BLOQUEADA") { await p2; await c2.query("COMMIT"); }
      assert.equal(r1, "CONFIRMADA");
      assert.deepEqual((await autorizacoes(k)).map((a) => [a.destino, a.estado]), [[A, "REVOGADA"]]);
      await voltar(k, A);
      assert.deepEqual(await elegivel(k), { ok: false, motivo: "SEM_AUTORIZACAO" });
      assert.equal(s.estado, "BLOQUEADA");
    });

    await t.test("ordem inversa: edição A→B com a linha travada antes da leitura; o formulário lê o cadastro novo e fica PENDENTE", async () => {
      const A = n(5), B = n(6);
      const k = await cliente(A, A);
      const ct = await contato(k, A);
      await c2.query("BEGIN");
      await editar(k, B, B);
      await c1.query("BEGIN");
      const p1 = m1.pref.registrarAutorizacaoDoFormulario(ex1, E, k, ct, A);
      const s = await bloqueadaOuConcluida(p1, pid1, pid2);
      registros.push(`ordem inversa (edição aberta): formulário ${s.estado} (bloqueadores ${s.bloqueadores.join(",") || "-"})`);
      let r1: string;
      if (s.estado === "CONCLUIDA") { r1 = await p1; await c1.query("COMMIT"); await c2.query("COMMIT"); }
      else { await c2.query("COMMIT"); r1 = await p1; await c1.query("COMMIT"); }
      assert.equal(r1, "PENDENTE", "número fora do cadastro (já alterado) fica pendente");
      assert.deepEqual((await autorizacoes(k)).map((a) => [a.destino, a.estado]), [[A, "PENDENTE"]]);
      await voltar(k, A);
      assert.deepEqual(await elegivel(k), { ok: false, motivo: "SEM_AUTORIZACAO" }, "pendente não autoriza envio");
      assert.equal(s.estado, "BLOQUEADA");
      // Edição já confirmada antes do formulário: mesma semântica, sem espera.
      const k2 = await cliente(n(7), n(7));
      await voltar(k2, n(8));
      assert.equal(await m1.pref.registrarAutorizacaoDoFormulario(ex3, E, k2, await contato(k2, n(7)), n(7)), "PENDENTE");
    });

    await t.test("descadastro concorrente ao formulário: a autorização do formulário não sobrevive ao descadastro nem volta na reativação", async () => {
      const A = n(9);
      const k = await cliente(A, A);
      const ct = await contato(k, A);
      const f = pausadoAntesDoInsert();
      await c1.query("BEGIN");
      const p1 = m1.pref.registrarAutorizacaoDoFormulario(f.tx, E, k, ct, A);
      await f.noInsert;
      await c2.query("BEGIN");
      const p2 = m2.pref.alterarPreferencia(ex2, E, usuario, { acao: "preferencia", operacao: "descadastrar", clienteId: k, confirmacao: "Pediu para parar (sintético)" });
      const s = await bloqueadaOuConcluida(p2, pid2, pid1);
      registros.push(`descadastro: equipe ${s.estado} (bloqueadores ${s.bloqueadores.join(",") || "-"})`);
      if (s.estado === "CONCLUIDA") await c2.query("COMMIT");
      f.liberar();
      await p1;
      await c1.query("COMMIT");
      if (s.estado === "BLOQUEADA") { await p2; await c2.query("COMMIT"); }
      assert.deepEqual((await autorizacoes(k)).map((a) => a.estado), ["REVOGADA"], "descadastro revogou a autorização do formulário");
      await m2.pref.alterarPreferencia(ex3, E, usuario, { acao: "preferencia", operacao: "reativar", clienteId: k, confirmacao: "Novo pedido da pessoa (sintético)" });
      assert.deepEqual(await elegivel(k), { ok: false, motivo: "SEM_AUTORIZACAO" }, "reativar não devolve autorização");
      assert.equal(s.estado, "BLOQUEADA");
    });

    await t.test("formulário × equipe e formulário × formulário no mesmo número: serializados, sem deadlock e sem duas vivas", async () => {
      const A = n(10);
      const k = await cliente(A, A);
      const f = pausadoAntesDoInsert();
      await c1.query("BEGIN");
      const p1 = m1.pref.registrarAutorizacaoDoFormulario(f.tx, E, k, await contato(k, A), A);
      await f.noInsert;
      await c2.query("BEGIN");
      const p2 = m2.pref.alterarPreferencia(ex2, E, usuario, { acao: "preferencia", operacao: "autorizar", clienteId: k, destino: A, confirmacao: "Autorizou por ligação (sintético)" });
      const s = await bloqueadaOuConcluida(p2, pid2, pid1);
      if (s.estado === "CONCLUIDA") await c2.query("COMMIT");
      f.liberar();
      await p1;
      await c1.query("COMMIT");
      if (s.estado === "BLOQUEADA") { await p2; await c2.query("COMMIT"); }
      assert.equal(await vivas(k, A), 1);
      // Dois formulários: o segundo espera o primeiro e encontra a autorização viva.
      const k2 = await cliente(n(11), n(11));
      const g = pausadoAntesDoInsert();
      await c1.query("BEGIN");
      const q1 = m1.pref.registrarAutorizacaoDoFormulario(g.tx, E, k2, await contato(k2, n(11)), n(11));
      await g.noInsert;
      await c2.query("BEGIN");
      const q2 = m2.pref.registrarAutorizacaoDoFormulario(ex2, E, k2, await contato(k2, n(11)), n(11));
      const s2 = await bloqueadaOuConcluida(q2, pid2, pid1);
      // Sem a trava (código antigo) o 2º formulário termina primeiro: confirmar a transação dele antes de soltar o 1º
      // evita que o próprio teste prenda o INSERT do 1º na chave única (o que viraria TEMPO, não asserção).
      if (s2.estado === "CONCLUIDA") await c2.query("COMMIT");
      g.liberar();
      const a1 = await q1;
      await c1.query("COMMIT");
      const a2 = await q2;
      if (s2.estado === "BLOQUEADA") await c2.query("COMMIT");
      assert.deepEqual([a1, a2, s2.estado], ["CONFIRMADA", "JA_EXISTENTE", "BLOQUEADA"]);
      assert.equal(await vivas(k2, n(11)), 1);
    });

    await t.test("sequencial pelo formulário: só telefone, só WhatsApp, NULL, formatação, outro campo, pendente que entrou e saiu, outro cliente e outra empresa", async () => {
      const form = async (k: string, numero: string) => m1.pref.registrarAutorizacaoDoFormulario(ex3, E, k, await contato(k, numero), numero);
      // WhatsApp A + telefone A: troca só do telefone mantém (A segue no WhatsApp).
      const k1 = await cliente(n(20), n(20));
      assert.equal(await form(k1, n(20)), "CONFIRMADA");
      await c3.query(`UPDATE clientes SET telefone = $2 WHERE id = $1`, [k1, n(21)]);
      assert.equal((await elegivel(k1)).telefone, n(20));
      // WhatsApp vira NULL: A saiu dos dois campos → revogada.
      await c3.query(`UPDATE clientes SET whatsapp = NULL WHERE id = $1`, [k1]);
      assert.deepEqual((await autorizacoes(k1)).map((a) => a.estado), ["REVOGADA"]);
      // Só formatação (sem DDI ↔ com DDI) e troca de campo: não revoga.
      const k2 = await cliente(n(22), null);
      assert.equal(await form(k2, n(22)), "CONFIRMADA");
      await c3.query(`UPDATE clientes SET telefone = $2 WHERE id = $1`, [k2, n(22).slice(2)]);
      await c3.query(`UPDATE clientes SET telefone = NULL, whatsapp = $2 WHERE id = $1`, [k2, n(22)]);
      assert.deepEqual((await autorizacoes(k2)).map((a) => a.estado), ["CONFIRMADA"]);
      assert.equal((await elegivel(k2)).telefone, n(22));
      // Pendente de número que nunca esteve no cadastro: intacta; entrou e saiu: revogada.
      const k3 = await cliente(n(23), n(23));
      assert.equal(await form(k3, n(24)), "PENDENTE");
      await c3.query(`UPDATE clientes SET telefone = $2 WHERE id = $1`, [k3, n(25)]);
      assert.deepEqual((await autorizacoes(k3)).map((a) => a.estado), ["PENDENTE"]);
      await c3.query(`UPDATE clientes SET telefone = $2 WHERE id = $1`, [k3, n(24)]);
      await c3.query(`UPDATE clientes SET telefone = $2 WHERE id = $1`, [k3, n(26)]);
      assert.deepEqual((await autorizacoes(k3)).map((a) => a.estado), ["REVOGADA"]);
      // Outro cliente da mesma empresa e cliente de outra empresa com o mesmo número: inalterados.
      const k4 = await cliente(n(27), n(27)), k5 = await cliente(n(27), n(27));
      const k6 = await cliente(n(27), n(27), F);
      assert.equal(await form(k4, n(27)), "CONFIRMADA");
      assert.equal(await form(k5, n(27)), "CONFIRMADA");
      await c3.query(`UPDATE clientes SET telefone = $2, whatsapp = $2 WHERE id = $1`, [k4, n(28)]);
      assert.deepEqual([(await autorizacoes(k4))[0].estado, (await autorizacoes(k5))[0].estado, (await autorizacoes(k6)).length], ["REVOGADA", "CONFIRMADA", 0]);
    });

    await t.test("controle positivo: depois do retorno, NOVA autorização vale e o motor envia ao número (transporte simulado)", async () => {
      const A = n(30), B = n(31);
      const k = await cliente(A, A);
      // Corrida do cenário do parecer, depois volta e a equipe autoriza de novo.
      const f = pausadoAntesDoInsert();
      await c1.query("BEGIN");
      const p1 = m1.pref.registrarAutorizacaoDoFormulario(f.tx, E, k, await contato(k, A), A);
      await f.noInsert;
      await c2.query("BEGIN");
      const p2 = editar(k, B, B);
      const s = await bloqueadaOuConcluida(p2, pid2, pid1);
      if (s.estado === "CONCLUIDA") await c2.query("COMMIT");
      f.liberar();
      await p1;
      await c1.query("COMMIT");
      if (s.estado === "BLOQUEADA") { await p2; await c2.query("COMMIT"); }
      await voltar(k, A);
      assert.deepEqual(await elegivel(k), { ok: false, motivo: "SEM_AUTORIZACAO" });
      await m2.pref.alterarPreferencia(ex3, E, usuario, { acao: "preferencia", operacao: "autorizar", clienteId: k, destino: A, confirmacao: "Autorizou de novo por ligação (sintético)" });
      const ok = await elegivel(k);
      assert.equal(ok.telefone, A);
      // Envio simulado pelo motor real: regra de mensagem revisada e ativa + negociação parada do cliente.
      await c3.query("BEGIN");
      const regra = await m2.regras.salvarRegra(ex3, E, usuario, { acao: "salvar-regra", tipo: "PROPOSTA_PARADA", versao: 0, acaoRegra: "MENSAGEM_WHATSAPP", esperaDias: 3,
        janelaInicio: "00:00", janelaFim: "23:59", fuso: "America/Sao_Paulo", fimDeSemana: true, limiteFrequenciaDias: 1, maxTentativas: 3,
        templateTexto: m2.regras.CATALOGO_REGRAS.PROPOSTA_PARADA.texto, templateProvedor: "retomar_proposta_v1" });
      const revisada = await m2.regras.revisarModelo(ex3, E, usuario, regra.id, regra.versao);
      await m2.regras.ativarRegra(ex3, E, usuario, regra.id, revisada.versao);
      await fechamento(c3, E, await comercial(c3, E), k, { data: "2027-05-10", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 10 });
      await c3.query("COMMIT");
      const destinos = new Map<string, string>();
      const simulado = m2.transp.transporteSimulado(() => ex2);
      const transporte = { nome: "SIMULADO", simulado: true, async enviar(msg: { telefone: string; execucaoId: string }) { destinos.set(msg.execucaoId, msg.telefone); return simulado.enviar(msg); } };
      await m2.motor.executarCiclo({ transacao: porTransacao(c2) }, transporte, new Date(), { empresaId: E });
      const exec = (await c3.query(`SELECT id::text, estado FROM marketing_automacao_execucoes WHERE cliente_id = $1`, [k])).rows[0];
      assert.deepEqual([exec.estado, destinos.get(String(exec.id))], ["ACEITA", A], "nova autorização válida permite o envio simulado ao número");
    });

    await t.test("nenhuma transação pendurada nas conexões do teste", async () => {
      const r = (await c3.query(`SELECT pid, state FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state LIKE 'idle in transaction%'`, [[pid1, pid2]])).rows;
      assert.deepEqual(r, []);
      t.diagnostic(registros.join(" | "));
    });
  } finally {
    for (const c of [c1, c2, c3]) await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c3, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});
