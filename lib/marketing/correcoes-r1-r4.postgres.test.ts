import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  carregarComBanco, cliente, cod, comercial, contratoAssinado, empresa, executor, fechamento, pedido, porSavepoint, porTransacao, type Resposta, vincular, SENHA_FALSA,
} from "./harness-postgres.ts";

/**
 * Correções R1–R4 da revisão de bc379ad no PostgreSQL descartável (modelo 086), com TRANSPORTE SIMULADO gravando o
 * destino efetivamente escolhido pelo motor. Dados 100% sintéticos (telefones 551197777xxxx/55119666xxxxx).
 *   R1 — autorização por destino: e-mail reaproveitado com número diferente; telefone ≠ WhatsApp; 55; cliente novo;
 *        caixa desmarcada; descadastro anterior; troca de número; confirmação pela equipe; isolamento entre empresas.
 *   R2 — empresa inativa, sem MARKETING ou com acesso comercial restrito depois do planejamento (inclusive reservada):
 *        nada de tarefa nem transporte; a outra empresa segue; tarefa e mensagem.
 *   R3 — contrato sem valor legível: não vira zero; zero real; misto; total incompleto.
 *   R4 — 501 alvos: lotes de 500 avançam; cada alvo uma vez; primeiros continuam elegíveis; empates; novo ciclo; outra
 *        regra; terminal não recriado; revalidação do agendado; concorrência com duas conexões.
 */
type Banco = { transacao<T>(w: (tx: unknown) => Promise<T>): Promise<T> };
type Motor = {
  planejarEmpresa(tx: unknown, empresa: string, agora: Date, o?: { lote?: number }): Promise<{ criadas: number; existentes: number; bloqueio: string | null }>;
  executarCiclo(b: Banco, t: unknown, agora: Date, o?: unknown): Promise<{ planejamento: { criadas: number; bloqueadas: Array<{ empresaId: string; motivo: string }> }; processadas: number; resultados: Record<string, number> }>;
  reservar(tx: unknown, agora: Date, limite: number, empresa: string | null): Promise<{ token: string; ids: string[] }>;
  processarReservada(b: Banco, t: unknown, id: string, token: string, agora: Date): Promise<string>;
};
type Regras = {
  CATALOGO_REGRAS: Record<string, { texto: string }>;
  salvarRegra(tx: unknown, e: string, u: string, i: unknown): Promise<{ id: string; versao: number }>;
  revisarModelo(tx: unknown, e: string, u: string, id: string, v: number): Promise<{ versao: number }>;
  ativarRegra(tx: unknown, e: string, u: string, id: string, v: number): Promise<{ versao: number }>;
};
type Pref = { alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<unknown> };
type Contatos = { capturarContatoPublico(tx: unknown, s: unknown, e: unknown, c: unknown): Promise<{ contatoId: string }> };
type Metricas = { painelMarketing(tx: unknown, e: string, f: unknown): Promise<{ total: Record<string, unknown>; linhas: Array<Record<string, unknown>> }> };
type Transp = { transporteSimulado(c: () => unknown): { enviar(m: { telefone: string; execucaoId: string }): Promise<{ provedorMensagemId: string }> } };

const JANELA = { janelaInicio: "00:00", janelaFim: "23:59", fuso: "America/Sao_Paulo", fimDeSemana: true };
const regraProposta = (acao: "TAREFA_INTERNA" | "MENSAGEM_WHATSAPP", texto: string | null, versao = 0, esperaDias = 3) => ({
  acao: "salvar-regra", tipo: "PROPOSTA_PARADA", versao, acaoRegra: acao, esperaDias, ...JANELA, limiteFrequenciaDias: 1, maxTentativas: 3,
  templateTexto: texto, templateProvedor: acao === "MENSAGEM_WHATSAPP" ? "retomar_proposta_v1" : null });

async function pessoa(c: Client, empresaId: string, papel: "REPRESENTANTE_AUTORIZADO" | "ADMINISTRATIVO" = "REPRESENTANTE_AUTORIZADO") {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa sintética', $2, $3, true) RETURNING id::text AS id`,
    [`${cod("u")}@marketing.test`, SENHA_FALSA, papel])).rows[0].id;
  return vincular(c, empresaId, usuario, papel);
}

function modulos(c: Client, sessao: () => unknown = () => null) {
  const cache = new Map();
  const carregar = <T>(f: string) => carregarComBanco(f, c, sessao, {}, cache) as unknown as T;
  return {
    motor: carregar<Motor>("lib/marketing/automacoes/motor.ts"), regras: carregar<Regras>("lib/marketing/automacoes/regras.ts"),
    pref: carregar<Pref>("lib/marketing/automacoes/preferencias.ts"), contatos: carregar<Contatos>("lib/marketing/contatos.ts"),
    metricas: carregar<Metricas>("lib/marketing/metricas.ts"), transp: carregar<Transp>("lib/marketing/automacoes/transporte.ts"),
    rota: carregar<{ GET(r: unknown): Promise<Resposta>; POST(r: unknown): Promise<Resposta> }>("app/api/admin/marketing/automacoes/route.ts"),
  };
}

/** Transporte simulado que também registra o DESTINO real recebido do motor (o que a caixa guarda só mascarado). */
function transporteGravando(t: ReturnType<Transp["transporteSimulado"]>) {
  const destinos = new Map<string, string>();
  return { destinos, nome: "SIMULADO", simulado: true, async enviar(m: { telefone: string; execucaoId: string }) { destinos.set(m.execucaoId, m.telefone); return t.enviar(m as never); } };
}

const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const n = async (c: Client, sql: string, v: unknown[] = []) => Number((await c.query(sql, v)).rows[0].n);

test("R1: autorização por destino — o motor só envia ao número autorizado que está no cadastro", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  let sessao: unknown = null;
  try {
    const m = modulos(c, () => sessao);
    const tx = executor(c);
    const banco: Banco = { transacao: porSavepoint(c) as Banco["transacao"] };
    await c.query("BEGIN");
    const A = await empresa(c, "R1 A sintética"), B = await empresa(c, "R1 B sintética");
    const ga = await pessoa(c, A), gb = await pessoa(c, B);
    const base = await comercial(c, A);
    const site = (await c.query<{ id: string }>(`INSERT INTO marketing_sites (empresa_id, slug, rascunho, criado_por, atualizado_por) VALUES ($1, $2, '{}'::jsonb, $3, $3) RETURNING id::text AS id`,
      [A, cod("r1-site-"), ga.usuario])).rows[0].id;
    const r = await m.regras.salvarRegra(tx, A, ga.usuario, regraProposta("MENSAGEM_WHATSAPP", m.regras.CATALOGO_REGRAS.PROPOSTA_PARADA.texto));
    const rev = await m.regras.revisarModelo(tx, A, ga.usuario, r.id, r.versao);
    await m.regras.ativarRegra(tx, A, ga.usuario, r.id, rev.versao);
    const transporte = transporteGravando(m.transp.transporteSimulado(() => tx));
    const formulario = (telefone: string, email: string | null, autoriza: boolean) => m.contatos.capturarContatoPublico(tx, { siteId: site, empresaId: A, estabelecimentoId: null },
      { nome: "Pessoa do Site", telefone, email, dataDesejada: null, convidados: 30, mensagem: null, chave: `r1-${randomUUID()}`, autorizaWhatsapp: autoriza }, { codigoCampanha: null, utm: {} });
    let dia = 0;
    /** Nova negociação parada do cliente → um ciclo do motor → estado, motivo e destino real (se houve envio). */
    const ciclo = async (clienteId: string) => {
      await fechamento(c, A, base, clienteId, { data: `2027-0${1 + (dia % 9)}-${String(10 + (dia++ % 18)).padStart(2, "0")}`, status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 10 });
      await m.motor.executarCiclo(banco, transporte, new Date(), { empresaId: A });
      const e = (await c.query(`SELECT id::text, estado, motivo FROM marketing_automacao_execucoes WHERE cliente_id = $1 ORDER BY criado_em DESC LIMIT 1`, [clienteId])).rows[0];
      return { estado: e.estado as string, motivo: e.motivo as string | null, destino: transporte.destinos.get(e.id) ?? null };
    };
    const autorizacoes = async (clienteId: string) => (await c.query(`SELECT destino, estado, origem FROM marketing_contato_autorizacoes WHERE cliente_id = $1 ORDER BY criado_em`, [clienteId])).rows;
    const clienteCom = async (nome: string, telefone: string | null, whatsapp: string | null, email: string | null = null) =>
      (await c.query<{ id: string }>(`INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp, email) VALUES ($1, $2, $3, $4, $5) RETURNING id::text AS id`, [A, nome, telefone, whatsapp, email])).rows[0].id;

    await t.test("e-mail existente com número diferente: pendente; o número do cadastro não recebe nada; CRM intacto", async () => {
      const x = await clienteCom("Xênia Email", "5511977770001", "5511977770001", "xenia@marketing.test");
      const { contatoId } = await formulario("11977770002", "xenia@marketing.test", true);
      assert.equal((await c.query(`SELECT cliente_id::text, telefone FROM marketing_contatos WHERE id = $1`, [contatoId])).rows[0].cliente_id, x, "reaproveitou pelo e-mail");
      assert.equal((await c.query(`SELECT telefone FROM marketing_contatos WHERE id = $1`, [contatoId])).rows[0].telefone, "11977770002", "número do pedido guardado no contato");
      assert.deepEqual(await autorizacoes(x), [{ destino: "5511977770002", estado: "PENDENTE", origem: "FORMULARIO_SITE" }]);
      assert.deepEqual((await c.query(`SELECT telefone, whatsapp FROM clientes WHERE id = $1`, [x])).rows[0], { telefone: "5511977770001", whatsapp: "5511977770001" }, "CRM não sobrescrito");
      assert.deepEqual(await ciclo(x), { estado: "SUPRIMIDA", motivo: "SEM_AUTORIZACAO", destino: null });
      // Equipe confirma o número do pedido, mas ele não está no cadastro: continua sem destino válido.
      const pendente = (await c.query(`SELECT id::text FROM marketing_contato_autorizacoes WHERE cliente_id = $1 AND estado = 'PENDENTE'`, [x])).rows[0].id;
      await m.pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "confirmar", clienteId: x, autorizacaoId: pendente, confirmacao: "Confirmou por ligação (sintético)" });
      assert.deepEqual(await ciclo(x), { estado: "SUPRIMIDA", motivo: "SEM_AUTORIZACAO_DESTINO", destino: null });
      // Autorizar número fora do cadastro é recusado; o do cadastro, com registro da equipe, passa a valer.
      await assert.rejects(m.pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "autorizar", clienteId: x, destino: "11977770003", confirmacao: "x" + "yz" }),
        { code: "MARKETING_DESTINO_FORA_DO_CADASTRO" });
      await m.pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "autorizar", clienteId: x, destino: "11977770001", confirmacao: "Autorizou o WhatsApp do cadastro (sintético)" });
      assert.deepEqual(await ciclo(x), { estado: "ACEITA", motivo: null, destino: "5511977770001" });
    });

    await t.test("telefone e WhatsApp diferentes: autoriza só o informado e o motor envia exatamente a ele", async () => {
      const y = await clienteCom("Yara Dois Números", "551133330004", "5511977770004");
      await formulario("1133330004", null, true);
      assert.deepEqual(await autorizacoes(y), [{ destino: "551133330004", estado: "CONFIRMADA", origem: "FORMULARIO_SITE" }]);
      const r1 = await ciclo(y);
      assert.deepEqual(r1, { estado: "ACEITA", motivo: null, destino: "551133330004" }, "nunca o WhatsApp não autorizado");
      const ev = (await c.query(`SELECT detalhe FROM marketing_automacao_eventos ev JOIN marketing_automacao_execucoes e ON e.id = ev.execucao_id
        WHERE e.cliente_id = $1 AND ev.estado_novo = 'ENVIANDO' ORDER BY ev.criado_em DESC LIMIT 1`, [y])).rows[0].detalhe;
      const aut = (await c.query(`SELECT id::text FROM marketing_contato_autorizacoes WHERE cliente_id = $1`, [y])).rows[0].id;
      assert.equal(ev.autorizacaoId, aut, "envio rastreável à autorização usada");
    });

    await t.test("número equivalente com e sem 55; cliente novo com autorização; caixa desmarcada", async () => {
      const z = await clienteCom("Zé Sem DDI", null, "11977770005");
      await formulario("5511977770005", null, true);
      assert.deepEqual(await autorizacoes(z), [{ destino: "5511977770005", estado: "CONFIRMADA", origem: "FORMULARIO_SITE" }]);
      assert.deepEqual(await ciclo(z), { estado: "ACEITA", motivo: null, destino: "5511977770005" });
      const { contatoId } = await formulario("11977770006", "nova@marketing.test", true);
      const novo = (await c.query(`SELECT cliente_id::text, vinculo_cliente FROM marketing_contatos WHERE id = $1`, [contatoId])).rows[0];
      assert.equal(novo.vinculo_cliente, "NOVO");
      assert.deepEqual(await ciclo(novo.cliente_id), { estado: "ACEITA", motivo: null, destino: "5511977770006" });
      const semCaixa = (await c.query(`SELECT cliente_id::text FROM marketing_contatos WHERE id = $1`, [(await formulario("11977770007", null, false)).contatoId])).rows[0].cliente_id;
      assert.deepEqual(await autorizacoes(semCaixa), []);
      assert.deepEqual(await ciclo(semCaixa), { estado: "SUPRIMIDA", motivo: "SEM_AUTORIZACAO", destino: null });
    });

    await t.test("descadastro anterior prevalece; troca de número no cadastro não herda autorização", async () => {
      const w = await clienteCom("Wanda Descadastrada", "5511977770008", "5511977770008");
      await m.pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "descadastrar", clienteId: w, confirmacao: "Pediu para parar (sintético)" });
      await formulario("11977770008", null, true);
      assert.deepEqual(await autorizacoes(w), [], "formulário não cria autorização para descadastrado");
      assert.deepEqual(await ciclo(w), { estado: "SUPRIMIDA", motivo: "DESCADASTRADO", destino: null });
      const v = await clienteCom("Vítor Troca", "5511977770009", "5511977770009");
      await formulario("11977770009", null, true);
      await c.query(`UPDATE clientes SET telefone = '5511977770099', whatsapp = '5511977770099' WHERE id = $1`, [v]);
      // O1 (15/10/2026): o número que saiu do cadastro é revogado pelo banco; nenhuma confirmada sobra.
      assert.deepEqual((await autorizacoes(v)).map((a) => a.estado), ["REVOGADA"]);
      assert.deepEqual(await ciclo(v), { estado: "SUPRIMIDA", motivo: "SEM_AUTORIZACAO", destino: null });
      // Descadastro revoga as vivas (histórico mantido).
      await m.pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "autorizar", clienteId: v, destino: "5511977770099", confirmacao: "Autorizou o número novo (sintético)" });
      assert.deepEqual((await autorizacoes(v)).map((a) => a.estado), ["REVOGADA", "CONFIRMADA"], "número novo do cadastro autorizado de novo");
      await m.pref.alterarPreferencia(tx, A, ga.usuario, { acao: "preferencia", operacao: "descadastrar", clienteId: v, confirmacao: "Pediu para parar (sintético)" });
      assert.deepEqual((await autorizacoes(v)).map((a) => a.estado), ["REVOGADA", "REVOGADA"]);
    });

    await t.test("isolamento: empresa B não lê nem confirma autorização de cliente de A; o banco recusa autorização cruzada", async () => {
      const x = (await c.query(`SELECT cliente_id::text, id::text FROM marketing_contato_autorizacoes WHERE destino = '551133330004'`)).rows[0];
      sessao = gb.sessao;
      assert.equal((await m.rota.GET(pedido(`http://127.0.0.1:3000/api/admin/marketing/automacoes?clienteId=${x.cliente_id}`))).status, 404);
      const r2 = await m.rota.POST(pedido("http://127.0.0.1:3000/api/admin/marketing/automacoes", { acao: "preferencia", operacao: "revogar", clienteId: x.cliente_id, autorizacaoId: x.id, confirmacao: "tentativa cruzada" }));
      assert.equal(r2.status, 404);
      sessao = null;
      await c.query("SAVEPOINT cruzada");
      await assert.rejects(c.query(`INSERT INTO marketing_contato_autorizacoes (empresa_id, cliente_id, destino, estado, origem, evidencia, confirmada_em) VALUES ($1, $2, '5511977770004', 'CONFIRMADA', 'EQUIPE', 'cruzada', now())`, [B, x.cliente_id]), /outra empresa/);
      await c.query("ROLLBACK TO SAVEPOINT cruzada");
      assert.equal((await c.query(`SELECT estado FROM marketing_contato_autorizacoes WHERE id = $1`, [x.id])).rows[0].estado, "CONFIRMADA");
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

test("R2: aptidão da empresa revalidada antes de agir — inativa, sem MARKETING, acesso restrito, reservada; outra empresa segue", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const m = modulos(c);
    const tx = executor(c);
    const banco: Banco = { transacao: porSavepoint(c) as Banco["transacao"] };
    const transporte = transporteGravando(m.transp.transporteSimulado(() => tx));
    await c.query("BEGIN");
    /** Empresa com regra ativa (tarefa ou mensagem) e um alvo planejado. */
    const cenario = async (nome: string, acao: "TAREFA_INTERNA" | "MENSAGEM_WHATSAPP") => {
      const E = await empresa(c, nome);
      const g = await pessoa(c, E);
      const base = await comercial(c, E);
      const cl = await cliente(c, E, `Cliente ${nome}`, `55119777${String(Math.floor(Math.random() * 1e5)).padStart(5, "0")}`);
      if (acao === "MENSAGEM_WHATSAPP") {
        const tel = (await c.query(`SELECT whatsapp FROM clientes WHERE id = $1`, [cl])).rows[0].whatsapp;
        await m.pref.alterarPreferencia(tx, E, g.usuario, { acao: "preferencia", operacao: "autorizar", clienteId: cl, destino: tel, confirmacao: "Autorizou (sintético)" });
      }
      const r = await m.regras.salvarRegra(tx, E, g.usuario, regraProposta(acao, acao === "MENSAGEM_WHATSAPP" ? m.regras.CATALOGO_REGRAS.PROPOSTA_PARADA.texto : null));
      const v = acao === "MENSAGEM_WHATSAPP" ? (await m.regras.revisarModelo(tx, E, g.usuario, r.id, r.versao)).versao : r.versao;
      await m.regras.ativarRegra(tx, E, g.usuario, r.id, v);
      await fechamento(c, E, base, cl, { data: "2027-03-10", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 10 });
      assert.equal((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, E, new Date()))).criadas, 1, `${nome}: apta no planejamento`);
      return { E, g, cl };
    };
    const execucao = async (cl: string) => (await c.query(`SELECT id::text, estado, motivo FROM marketing_automacao_execucoes WHERE cliente_id = $1`, [cl])).rows[0];
    const efeitos = async (E: string) => ({
      tarefas: await n(c, `SELECT count(*)::int AS n FROM marketing_tarefas WHERE empresa_id = $1`, [E]),
      envios: await n(c, `SELECT count(*)::int AS n FROM marketing_transporte_simulado WHERE empresa_id = $1`, [E]),
    });
    /** Plano Essencial confirmado (sem MARKETING), pelas guardas reais da 068/074a. */
    /** Plano Essencial confirmado (sem MARKETING), pelas guardas reais da 067/068/074a: contratação nasce EM_ABERTO e é confirmada. */
    const planoEssencial = async (E: string, usuario: string) => {
      await c.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', clock_timestamp() - interval '2 days', clock_timestamp() + interval '20 days')`, [E]);
      const contratacao = (await c.query<{ id: string }>(`INSERT INTO assinatura_contratacoes (empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, valor_final_centavos, criada_por)
        VALUES ($1, $2, 'ESSENCIAL', 'MENSAL', 'sintetico', 9900, 9900, $3) RETURNING id::text AS id`, [E, randomUUID(), usuario])).rows[0].id;
      const sub = `sub-${cod("")}`;
      await c.query(`UPDATE assinatura_contratacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(), pagamento_confirmacao_id = $2, provedor_assinatura_id = $3 WHERE id = $1`,
        [contratacao, `pg-${cod("")}`, sub]);
      await c.query(`UPDATE empresa_assinaturas SET situacao = 'ATIVA', plano = 'ESSENCIAL', ciclo = 'MENSAL', provedor = 'ASAAS', contratacao_atual_id = $2, provedor_assinatura_id = $3,
          periodo_atual_fim = clock_timestamp() + interval '29 days' WHERE empresa_id = $1`, [E, contratacao, sub]);
    };

    await t.test("empresa apta no planejamento e suspensa antes da execução (worker global): cancelada; a outra empresa executa", async () => {
      const a = await cenario("R2 Suspensa", "TAREFA_INTERNA");
      const b = await cenario("R2 Apta", "TAREFA_INTERNA");
      await c.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1`, [a.E]);
      const r = await m.motor.executarCiclo(banco, transporte, new Date(), {});
      assert.deepEqual(await execucao(a.cl).then((e) => [e.estado, e.motivo]), ["CANCELADA", "EMPRESA_INAPTA: EMPRESA_NAO_ATIVA"]);
      assert.deepEqual(await efeitos(a.E), { tarefas: 0, envios: 0 });
      assert.equal((await execucao(b.cl)).estado, "TAREFA_CRIADA");
      assert.deepEqual(await efeitos(b.E), { tarefas: 1, envios: 0 });
      assert.ok((r.resultados.CANCELADA ?? 0) >= 1 && (r.resultados.TAREFA_CRIADA ?? 0) >= 1);
    });

    await t.test("perda do recurso MARKETING (plano Essencial confirmado): mensagem não chega ao transporte; planejamento bloqueado", async () => {
      const a = await cenario("R2 Sem Marketing", "MENSAGEM_WHATSAPP");
      await planoEssencial(a.E, a.g.usuario);
      const r = await m.motor.executarCiclo(banco, transporte, new Date(), { empresaId: a.E });
      assert.deepEqual(r.planejamento.bloqueadas, [{ empresaId: a.E, motivo: "SEM_RECURSO_MARKETING" }], "processamento manual da empresa também bloqueia");
      assert.deepEqual(await execucao(a.cl).then((e) => [e.estado, e.motivo]), ["CANCELADA", "EMPRESA_INAPTA: SEM_RECURSO_MARKETING"]);
      assert.deepEqual(await efeitos(a.E), { tarefas: 0, envios: 0 });
    });

    await t.test("acesso comercial restrito (teste encerrado) e pendência JÁ RESERVADA antes da mudança", async () => {
      const a = await cenario("R2 Teste Vencido", "MENSAGEM_WHATSAPP");
      await c.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', clock_timestamp() - interval '60 days', clock_timestamp() - interval '30 days')`, [a.E]);
      await m.motor.executarCiclo(banco, transporte, new Date(), { empresaId: a.E });
      assert.match((await execucao(a.cl)).motivo, /^EMPRESA_INAPTA: ACESSO_COMERCIAL_(SOMENTE_LEITURA|BLOQUEADO)$/);
      assert.deepEqual(await efeitos(a.E), { tarefas: 0, envios: 0 });
      const b = await cenario("R2 Reservada", "TAREFA_INTERNA");
      const { token, ids } = await banco.transacao((t2) => m.motor.reservar(t2, new Date(), 10, b.E));
      assert.equal(ids.length, 1);
      await c.query(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1`, [b.E]);
      assert.equal(await m.motor.processarReservada(banco, transporte, ids[0], token, new Date()), "CANCELADA");
      assert.deepEqual(await efeitos(b.E), { tarefas: 0, envios: 0 });
    });

    await t.test("empresa apta envia a mensagem normalmente (sem efeito colateral das outras)", async () => {
      const ok = await cenario("R2 Mensagem Apta", "MENSAGEM_WHATSAPP");
      await m.motor.executarCiclo(banco, transporte, new Date(), { empresaId: ok.E });
      assert.equal((await execucao(ok.cl)).estado, "ACEITA");
      assert.deepEqual(await efeitos(ok.E), { tarefas: 0, envios: 1 });
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

test("R3: contrato sem valor legível não vira zero; zero real; misto; incompletude no total", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const m = modulos(c);
    const tx = executor(c);
    await c.query("BEGIN");
    /** Contrato assinado SEM pagamento: valor só pelo snapshot (null = ilegível nas três fontes). */
    const contratoSoSnapshot = async (fechamentoId: string, valor: number | null) => {
      const contrato = (await c.query<{ id: string }>(`INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1, 'ASSINADO', now()) RETURNING id::text AS id`, [fechamentoId])).rows[0].id;
      await c.query(`INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
        VALUES ($1, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP')`, [contrato, JSON.stringify(valor === null ? {} : { comercial: { valorFinalContrato: valor } }), "a".repeat(64), "c".repeat(64)]);
    };
    const hoje = new Date().toISOString().slice(0, 10);
    const filtro = { de: "2026-01-01", ate: "2027-12-31", unidadeId: null };
    const novaEmpresa = async (nome: string) => { const E = await empresa(c, nome); return { E, base: await comercial(c, E) }; };
    const fech = async (x: { E: string; base: Awaited<ReturnType<typeof comercial>> }, i: number) =>
      fechamento(c, x.E, x.base, await cliente(c, x.E, `Contrato ${i}`, `5511966${String(i).padStart(6, "0")}`), { data: hoje, status: "CONFIRMADO" });

    const so = await novaEmpresa("R3 Só Desconhecido");
    await contratoSoSnapshot(await fech(so, 1), null);
    let p = await m.metricas.painelMarketing(tx, so.E, filtro);
    assert.deepEqual([p.total.contratos, p.total.contratosSemValor, p.total.receitaContratadaCentavos, p.total.receitaContratadaSituacao], [1, 1, null, "INDISPONIVEL"]);

    const zero = await novaEmpresa("R3 Zero Real");
    await contratoSoSnapshot(await fech(zero, 2), 0);
    p = await m.metricas.painelMarketing(tx, zero.E, filtro);
    assert.deepEqual([p.total.receitaContratadaCentavos, p.total.receitaContratadaSituacao], [0, "COMPLETA"], "zero legível é zero");

    const misto = await novaEmpresa("R3 Misto");
    await contratoAssinado(c, await fech(misto, 3), 4500, null);
    await contratoSoSnapshot(await fech(misto, 4), null);
    await contratoSoSnapshot(await fech(misto, 5), 1200);
    p = await m.metricas.painelMarketing(tx, misto.E, filtro);
    assert.deepEqual([p.total.contratos, p.total.contratosSemValor, p.total.receitaContratadaCentavos, p.total.receitaContratadaSituacao], [3, 1, 570000, "PARCIAL"]);

    const nenhum = await novaEmpresa("R3 Nenhum");
    p = await m.metricas.painelMarketing(tx, nenhum.E, filtro);
    assert.deepEqual([p.total.contratos, p.total.receitaContratadaCentavos, p.total.receitaContratadaSituacao], [0, 0, "COMPLETA"]);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

test("R4: 501 alvos — lotes avançam, cada alvo uma vez, empates, novo ciclo, outra regra, terminal não recriado, revalidação", { timeout: 600_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const m = modulos(c);
    const tx = executor(c);
    const banco: Banco = { transacao: porSavepoint(c) as Banco["transacao"] };
    const transporte = transporteGravando(m.transp.transporteSimulado(() => tx));
    await c.query("BEGIN");
    const E = await empresa(c, "R4 Muitos Alvos");
    const g = await pessoa(c, E);
    const base = await comercial(c, E);
    const empate = (await c.query(`SELECT (now() - interval '10 days')::text AS t`)).rows[0].t;
    // 501 clientes e negociações paradas com o MESMO atualizado_em (empate total no critério principal da fila).
    await c.query(`INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp)
      SELECT $1::uuid, 'Alvo ' || g, '5511966' || lpad(g::text, 6, '0'), '5511966' || lpad(g::text, 6, '0') FROM generate_series(1, 501) g`, [E]);
    await c.query(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status,
        atualizado_em, iniciado_em)
      SELECT '2027-06-01', '14:00', '18:00', $2::uuid, $1::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 50, 50, 4500, 4500, 4500, 'ATENDIMENTO_KIDMAIS', cl.id,
             'AGUARDANDO_CONTRATO', $6::timestamptz, $6::timestamptz
        FROM clientes cl WHERE cl.empresa_id = $1::uuid`, [E, base.agenda, base.pacote, base.tabela, base.preco, empate]);
    const r = await m.regras.salvarRegra(tx, E, g.usuario, regraProposta("TAREFA_INTERNA", null));
    await m.regras.ativarRegra(tx, E, g.usuario, r.id, r.versao);
    const agora = new Date();
    const execs = () => n(c, `SELECT count(*)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [E]);
    const distintos = () => n(c, `SELECT count(DISTINCT alvo_id)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [E]);

    await t.test("1º ciclo: 500 (lote) na ordem estável do desempate; 2º: o 501º; 3º: nada; cada alvo uma vez", async () => {
      assert.equal((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, E, agora))).criadas, 500);
      const esperados = (await c.query(`SELECT f.id::text FROM fechamentos f WHERE f.empresa_id = $1 ORDER BY f.atualizado_em, f.id::text LIMIT 500`, [E])).rows.map((x) => x.id).sort();
      const planejados = (await c.query(`SELECT alvo_id::text AS id FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [E])).rows.map((x) => x.id).sort();
      assert.deepEqual(planejados, esperados, "empate desfeito pelo id: lote determinístico");
      // Conclui os 500 (tarefas) — continuam elegíveis pelo gatilho, mas não seguram a fila.
      const { token, ids } = await banco.transacao((t2) => m.motor.reservar(t2, agora, 600, E));
      assert.equal(ids.length, 500);
      for (const id of ids) await m.motor.processarReservada(banco, transporte, id, token, agora);
      assert.equal(await n(c, `SELECT count(*)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1 AND estado = 'TAREFA_CRIADA'`, [E]), 500,
        "revalidação confirma o alvo já agendado (não é excluída pelo filtro do planejamento)");
      assert.equal(await n(c, `SELECT count(*)::int AS n FROM fechamentos f WHERE f.empresa_id = $1 AND f.status = 'AGUARDANDO_CONTRATO'`, [E]), 501, "os 500 seguem elegíveis");
      assert.equal((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, E, agora))).criadas, 1, "o 501º entra");
      assert.equal((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, E, agora))).criadas, 0);
      assert.deepEqual([await execs(), await distintos()], [501, 501]);
    });

    await t.test("terminal (suprimida/cancelada) do mesmo ciclo não é recriado; novo ciclo do mesmo alvo é; outra regra planeja o mesmo alvo", async () => {
      const ultimo = (await c.query(`SELECT id::text, alvo_id::text FROM marketing_automacao_execucoes WHERE empresa_id = $1 AND estado = 'AGENDADA'`, [E])).rows[0];
      await c.query(`UPDATE marketing_automacao_execucoes SET estado = 'CANCELADA', motivo = 'TESTE', concluida_em = clock_timestamp() WHERE id = $1`, [ultimo.id]);
      assert.equal((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, E, agora))).criadas, 0, "cancelada não volta");
      // Novo ciclo: a negociação se mexe (qualquer atualização carimba atualizado_em) e volta a parar 4 dias depois.
      await c.query(`UPDATE fechamentos SET atualizado_em = now() WHERE id = $1`, [ultimo.alvo_id]);
      const cicloNovo = (await c.query(`SELECT status || ':' || to_char(atualizado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ciclo FROM fechamentos WHERE id = $1`, [ultimo.alvo_id])).rows[0].ciclo;
      // Outra regra (a chave inclui o id da regra; regra de outra unidade é outra regra) já tem execução para o MESMO alvo
      // e o MESMO ciclo novo: isso não pode impedir o planejamento desta regra.
      const outra = await m.regras.salvarRegra(tx, E, g.usuario, { acao: "salvar-regra", tipo: "RECOMPRA", versao: 0, acaoRegra: "TAREFA_INTERNA", esperaDias: 45, ...JANELA,
        limiteFrequenciaDias: 30, maxTentativas: 3, templateTexto: null, templateProvedor: null });
      await c.query(`INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, chave_idempotencia, agendada_para, max_tentativas)
        SELECT $1, $2, 1, 'TAREFA_INTERNA', 'FECHAMENTO', f.id, f.cliente_id, $3, now() + interval '30 days', 3 FROM fechamentos f WHERE f.id = $4`,
        [E, outra.id, `${outra.id}:TAREFA_INTERNA:${ultimo.alvo_id}:${cicloNovo}`, ultimo.alvo_id]);
      const depois = new Date(agora.getTime() + 4 * 86_400_000);
      assert.equal((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, E, depois))).criadas, 1, "só o alvo com ciclo novo; a execução de OUTRA regra não o exclui");
      assert.equal(await n(c, `SELECT count(*)::int AS n FROM marketing_automacao_execucoes WHERE alvo_id = $1 AND regra_id = $2`, [ultimo.alvo_id, r.id]), 2, "ciclo antigo (cancelado) + ciclo novo");
      assert.equal((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, E, depois))).criadas, 0);
    });

    await t.test("pós-festa e recompra também avançam por lote (lote 2 em 5 alvos: 2 + 2 + 1 + 0)", async () => {
      for (const tipo of ["POS_FESTA", "RECOMPRA"] as const) {
        const F = await empresa(c, `R4 ${tipo}`);
        const gf = await pessoa(c, F);
        const bf = await comercial(c, F);
        const quando = tipo === "POS_FESTA"
          ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() - 2 * 86_400_000))
          : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() - 330 * 86_400_000));
        for (let i = 0; i < 5; i++) {
          const cl = await cliente(c, F, `${tipo} ${i}`, `55119655${String(i).padStart(5, "0")}`);
          await contratoAssinado(c, await fechamento(c, F, bf, cl, { data: quando, status: "CONFIRMADO" }), 3000, null);
        }
        const rr = await m.regras.salvarRegra(tx, F, gf.usuario, { acao: "salvar-regra", tipo, versao: 0, acaoRegra: "TAREFA_INTERNA", esperaDias: tipo === "POS_FESTA" ? 1 : 45, ...JANELA,
          limiteFrequenciaDias: 30, maxTentativas: 3, templateTexto: null, templateProvedor: null });
        await m.regras.ativarRegra(tx, F, gf.usuario, rr.id, rr.versao);
        const lotes = [];
        for (let i = 0; i < 4; i++) lotes.push((await banco.transacao((t2) => m.motor.planejarEmpresa(t2, F, new Date(), { lote: 2 }))).criadas);
        assert.deepEqual(lotes, [2, 2, 1, 0], tipo);
        assert.equal(await n(c, `SELECT count(DISTINCT alvo_id)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [F]), 5, tipo);
      }
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

test("R4: concorrência — dois planejadores (duas conexões, dados commitados) planejam 501 alvos exatamente uma vez", { timeout: 600_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  try {
    const m1 = modulos(c1), m2 = modulos(c2);
    const tx1 = executor(c1);
    await c1.query("BEGIN");
    const E = await empresa(c1, `R4 Concorrência ${cod("")}`);
    const g = await pessoa(c1, E);
    const base = await comercial(c1, E);
    await c1.query(`INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp)
      SELECT $1::uuid, 'Concorrente ' || g, '5511955' || lpad(g::text, 6, '0'), '5511955' || lpad(g::text, 6, '0') FROM generate_series(1, 501) g`, [E]);
    await c1.query(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status,
        atualizado_em, iniciado_em)
      SELECT '2027-06-01', '14:00', '18:00', $2::uuid, $1::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 50, 50, 4500, 4500, 4500, 'ATENDIMENTO_KIDMAIS', cl.id,
             'AGUARDANDO_CONTRATO', now() - interval '10 days', now() - interval '10 days' FROM clientes cl WHERE cl.empresa_id = $1::uuid`, [E, base.agenda, base.pacote, base.tabela, base.preco]);
    const r = await m1.regras.salvarRegra(tx1, E, g.usuario, regraProposta("TAREFA_INTERNA", null));
    await m1.regras.ativarRegra(tx1, E, g.usuario, r.id, r.versao);
    await c1.query("COMMIT");
    const agora = new Date();
    const rodar = (m: ReturnType<typeof modulos>, c: Client) => porTransacao(c)((t2) => m.motor.planejarEmpresa(t2, E, agora));
    const rodadas = [];
    for (let i = 0; i < 3; i++) rodadas.push(await Promise.all([rodar(m1, c1), rodar(m2, c2)]));
    const criadas = rodadas.flat().reduce((s, x) => s + x.criadas, 0);
    assert.equal(criadas, 501, "soma exata, sem duplicar nem perder");
    assert.deepEqual([await n(c1, `SELECT count(*)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [E]),
      await n(c1, `SELECT count(DISTINCT alvo_id)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [E])], [501, 501]);
  } finally {
    await c2.query("ROLLBACK").catch(() => undefined);
    await c1.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});
