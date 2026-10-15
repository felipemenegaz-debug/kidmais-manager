import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComBanco, cliente, cod, comercial, contratoAssinado, empresa, executor, fechamento, pedido, porSavepoint, porTransacao, type Resposta, vincular, SENHA_FALSA } from "../harness-postgres.ts";
import type { Client as ClientePg } from "pg";

/** Identidade sintética da suíte (senha_hash falsa: não autentica) + vínculo com a empresa. */
async function pessoa(c: ClientePg, empresaId: string, papel: "REPRESENTANTE_AUTORIZADO" | "ADMINISTRATIVO", nome = "Pessoa sintética") {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, $4, true) RETURNING id::text AS id`,
    [`${cod("u")}@marketing.test`, nome, SENHA_FALSA, papel])).rows[0].id;
  return vincular(c, empresaId, usuario, papel, nome);
}

/**
 * Entrega B (automações) no PostgreSQL descartável, modelo 084, com o TRANSPORTE SIMULADO (caixa de saída local; nenhuma
 * rede). Evidência 7 do goal: disparo elegível funciona; repetição não duplica envio; descadastro e contrato fechado
 * suprimem; falha do provedor fica visível e é recuperável; pausa cancela pendentes; tarefa interna sem provedor;
 * concorrência (2 conexões): reserva sem sobreposição, planejamento sem duplicar e envio uma vez só.
 */
type Banco = { transacao<T>(w: (tx: unknown) => Promise<T>): Promise<T> };
type Motor = {
  planejarEmpresa(tx: unknown, empresa: string, agora: Date): Promise<{ criadas: number; existentes: number }>;
  executarCiclo(b: Banco, t: unknown, agora: Date, o?: unknown): Promise<{ planejamento: { criadas: number }; processadas: number; resultados: Record<string, number> }>;
  reservar(tx: unknown, agora: Date, limite: number, empresa: string | null): Promise<{ token: string; ids: string[] }>;
  aplicarRetorno(tx: unknown, id: string, status: string, detalhe: string | null): Promise<string>;
  acaoManualExecucao(tx: unknown, empresa: string, id: string, acao: string, agora: Date): Promise<string | null>;
  simularEmpresa(tx: unknown, empresa: string, regra: unknown, agora: Date): Promise<{ alvos: Array<{ clienteId: string; impedimento: string | null }> }>;
};
type Regras = {
  CATALOGO_REGRAS: Record<string, { texto: string }>;
  salvarRegra(tx: unknown, e: string, u: string, i: unknown): Promise<{ id: string; versao: number }>;
  revisarModelo(tx: unknown, e: string, u: string, id: string, v: number): Promise<{ versao: number }>;
  ativarRegra(tx: unknown, e: string, u: string, id: string, v: number): Promise<unknown>;
  pausarRegra(tx: unknown, e: string, u: string, id: string): Promise<{ canceladas: number }>;
  regraDaEmpresa(tx: unknown, e: string, id: string): Promise<unknown>;
};
type Pref = { alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<{ canceladas: number }> };
type Transp = { transporteSimulado(c: () => unknown): unknown };

const JANELA = { janelaInicio: "00:00", janelaFim: "23:59", fuso: "America/Sao_Paulo", fimDeSemana: true };
const regraMensagem = (texto: string, versao = 0) => ({ acao: "salvar-regra", tipo: "PROPOSTA_PARADA", versao, acaoRegra: "MENSAGEM_WHATSAPP", esperaDias: 3, ...JANELA,
  limiteFrequenciaDias: 30, maxTentativas: 3, templateTexto: texto, templateProvedor: "retomar_proposta_v1" });

function modulos(c: Client, sessao: () => unknown = () => null, cache = new Map()) {
  const carregar = <T>(f: string) => carregarComBanco(f, c, sessao, {}, cache) as unknown as T;
  return {
    motor: carregar<Motor>("lib/marketing/automacoes/motor.ts"), regras: carregar<Regras>("lib/marketing/automacoes/regras.ts"),
    pref: carregar<Pref>("lib/marketing/automacoes/preferencias.ts"), transp: carregar<Transp>("lib/marketing/automacoes/transporte.ts"),
    rota: carregar<{ POST(r: unknown): Promise<Resposta> }>("app/api/admin/marketing/automacoes/route.ts"),
  };
}

test("Entrega B: disparo elegível, idempotência, supressões, falhas recuperáveis, pausa, tarefa e isolamento", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  let sessao: unknown = null;
  try {
    const { motor, regras, pref, transp, rota } = modulos(c, () => sessao);
    const tx = executor(c);
    const banco: Banco = { transacao: porSavepoint(c) as Banco["transacao"] };
    const transporte = transp.transporteSimulado(() => tx);
    const n = async (sql: string, v: unknown[] = []) => Number((await c.query(sql, v)).rows[0].n);
    const estadoDe = async (clienteId: string) => (await c.query(`SELECT estado, motivo, tentativas FROM marketing_automacao_execucoes WHERE cliente_id = $1 ORDER BY criado_em DESC LIMIT 1`, [clienteId])).rows[0];
    await c.query("BEGIN");
    const A = await empresa(c, "Automação A sintética"), B = await empresa(c, "Automação B sintética");
    const g = await pessoa(c, A, "REPRESENTANTE_AUTORIZADO"), gb = await pessoa(c, B, "REPRESENTANTE_AUTORIZADO");
    const base = await comercial(c, A);
    const novoAlvo = async (nome: string, telefone: string, autorizar: boolean, data = "2026-12-05") => {
      const cl = await cliente(c, A, nome, telefone);
      if (autorizar) await pref.alterarPreferencia(tx, A, g.usuario, { acao: "preferencia", clienteId: cl, operacao: "autorizar", confirmacao: "Autorizou por telefone (sintético)" });
      const f = await fechamento(c, A, base, cl, { data, status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 10 });
      return { cl, f };
    };

    await t.test("regra: texto sem PARAR recusado; mensagem não ativa sem revisão humana; ativa depois de revisada", async () => {
      await assert.rejects(regras.salvarRegra(tx, A, g.usuario, regraMensagem("Olá {{nome}}, venha ao buffet!")), { code: "MARKETING_MODELO_INVALIDO" });
      await assert.rejects(regras.salvarRegra(tx, A, g.usuario, regraMensagem("Olá {{cpf}}! Responda PARAR.")), { code: "MARKETING_MODELO_INVALIDO" });
      const r = await regras.salvarRegra(tx, A, g.usuario, regraMensagem(regras.CATALOGO_REGRAS.PROPOSTA_PARADA.texto));
      await assert.rejects(regras.ativarRegra(tx, A, g.usuario, r.id, r.versao), { code: "MARKETING_MODELO_NAO_REVISADO" });
      const revisada = await regras.revisarModelo(tx, A, g.usuario, r.id, r.versao);
      await regras.ativarRegra(tx, A, g.usuario, r.id, revisada.versao);
    });

    const alvos: Record<string, { cl: string; f: string }> = {};
    await t.test("7. ciclo: elegível ACEITA; sem autorização, contrato fechado e descadastro suprimem; falhas classificadas", async () => {
      alvos.ok = await novoAlvo("Olga Ok", "5511988887771", true);
      alvos.semAut = await novoAlvo("Sem Autorização", "5511988887772", false);
      alvos.contrato = await novoAlvo("Fecha Contrato", "5511988887773", true);
      alvos.descad = await novoAlvo("Descadastra", "5511988887774", true);
      alvos.recusa = await novoAlvo("Número Recusado", "5511988880000", true);
      alvos.temp = await novoAlvo("Provedor Instável", "5511988881111", true);
      alvos.incerto = await novoAlvo("Sem Confirmação", "5511988889999", true);
      const agora = new Date();
      const regra = (await c.query(`SELECT id::text FROM marketing_automacao_regras WHERE empresa_id = $1 AND tipo = 'PROPOSTA_PARADA'`, [A])).rows[0].id;
      const sim = await motor.simularEmpresa(tx, A, await regras.regraDaEmpresa(tx, A, regra), agora);
      assert.equal(sim.alvos.find((x) => x.clienteId === alvos.semAut.cl)?.impedimento, "SEM_AUTORIZACAO", "simulação mostra a supressão");
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [A]), 0, "simular não grava");
      const plano = await banco.transacao((t2) => motor.planejarEmpresa(t2, A, agora));
      assert.equal(plano.criadas, 7);
      // Entre o planejamento e o envio: contrato assinado e pedido de descadastro.
      await contratoAssinado(c, alvos.contrato.f, 4500, null);
      const desc = await pref.alterarPreferencia(tx, A, g.usuario, { acao: "preferencia", clienteId: alvos.descad.cl, operacao: "descadastrar", confirmacao: "Pediu para parar (sintético)" });
      assert.equal(desc.canceladas, 1, "descadastro suprime na hora o que estava agendado");
      const ciclo = await motor.executarCiclo(banco, transporte, agora, { empresaId: A });
      assert.equal(ciclo.planejamento.criadas, 0, "replanejar não duplica");
      const e = async (k: string) => estadoDe(alvos[k].cl);
      assert.equal((await e("ok")).estado, "ACEITA");
      assert.deepEqual([(await e("semAut")).estado, (await e("semAut")).motivo], ["SUPRIMIDA", "SEM_AUTORIZACAO"]);
      assert.deepEqual([(await e("contrato")).estado, (await e("contrato")).motivo], ["SUPRIMIDA", "ALVO_NAO_ELEGIVEL"]);
      assert.deepEqual([(await e("descad")).estado, (await e("descad")).motivo], ["SUPRIMIDA", "DESCADASTRADO"]);
      assert.equal((await e("recusa")).estado, "FALHOU");
      assert.match((await e("recusa")).motivo, /^RECUSADO/);
      assert.deepEqual([(await e("temp")).estado, (await e("temp")).tentativas], ["AGENDADA", 1], "indisponibilidade: nova tentativa com espera");
      assert.equal((await e("incerto")).estado, "INCERTA");
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_transporte_simulado WHERE empresa_id = $1`, [A]), 1, "só a elegível saiu (simulada)");
      const msg = (await c.query(`SELECT texto, destinatario_mascarado FROM marketing_transporte_simulado WHERE empresa_id = $1`, [A])).rows[0];
      assert.match(msg.texto, /^Olá, Olga! .*PARAR/);
      assert.equal(msg.destinatario_mascarado, "*********7771", "número nunca gravado inteiro na caixa de saída");
    });

    await t.test("7. repetição não duplica; incerta nunca é reenviada; temporária esgota as tentativas e fica visível", async () => {
      const agora = new Date();
      const de = await motor.executarCiclo(banco, transporte, agora, { empresaId: A });
      assert.equal(de.processadas, 0, "nada vencido: a temporária espera");
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_transporte_simulado WHERE empresa_id = $1`, [A]), 1);
      await motor.executarCiclo(banco, transporte, new Date(agora.getTime() + 2 * 3600_000), { empresaId: A });
      await motor.executarCiclo(banco, transporte, new Date(agora.getTime() + 5 * 3600_000), { empresaId: A });
      const temp = await estadoDe(alvos.temp.cl);
      assert.deepEqual([temp.estado, temp.tentativas], ["FALHOU", 3]);
      assert.equal((await estadoDe(alvos.incerto.cl)).estado, "INCERTA");
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_transporte_simulado WHERE empresa_id = $1`, [A]), 1, "nenhum envio duplicado");
      assert.ok(await n(`SELECT count(*)::int AS n FROM marketing_automacao_eventos WHERE empresa_id = $1`, [A]) >= 20, "histórico de cada transição");
    });

    await t.test("7. retorno verificado: ACEITA → ENTREGUE uma vez; fora de ordem ignorado", async () => {
      const id = (await c.query(`SELECT provedor_mensagem_id FROM marketing_automacao_execucoes WHERE cliente_id = $1`, [alvos.ok.cl])).rows[0].provedor_mensagem_id;
      assert.equal(await motor.aplicarRetorno(tx, id, "ENTREGUE", null), "ENTREGUE");
      assert.equal(await motor.aplicarRetorno(tx, id, "ENTREGUE", null), "IGNORADO");
      assert.equal(await motor.aplicarRetorno(tx, id, "FALHOU", "atrasado"), "IGNORADO");
      assert.equal((await estadoDe(alvos.ok.cl)).estado, "ENTREGUE");
      assert.equal(await motor.aplicarRetorno(tx, "sim_00000000-0000-4000-8000-000000000000", "ENTREGUE", null), "DESCONHECIDA");
    });

    await t.test("7. falha recuperável: pessoa re-agenda a FALHOU (revalida tudo); INCERTA só se encerra manualmente", async () => {
      const exec = (await c.query(`SELECT id::text FROM marketing_automacao_execucoes WHERE cliente_id = $1`, [alvos.recusa.cl])).rows[0].id;
      assert.equal(await motor.acaoManualExecucao(tx, A, exec, "tentar-novamente", new Date()), "AGENDADA");
      await motor.executarCiclo(banco, transporte, new Date(), { empresaId: A });
      assert.equal((await estadoDe(alvos.recusa.cl)).estado, "FALHOU", "o provedor (simulado) continua recusando; visível");
      const incerta = (await c.query(`SELECT id::text FROM marketing_automacao_execucoes WHERE cliente_id = $1`, [alvos.incerto.cl])).rows[0].id;
      assert.equal(await motor.acaoManualExecucao(tx, A, incerta, "tentar-novamente", new Date()), "SEM_EFEITO", "incerta não é reenviada");
      assert.equal(await motor.acaoManualExecucao(tx, A, incerta, "encerrar", new Date()), "CANCELADA");
      assert.equal(await motor.acaoManualExecucao(tx, B, exec, "tentar-novamente", new Date()), null, "outra empresa não acha");
      sessao = gb.sessao;
      const r = await rota.POST(pedido("http://127.0.0.1:3000/api/admin/marketing/automacoes", { acao: "execucao", execucaoId: exec, operacao: "encerrar" }));
      assert.equal(r.status, 404, "API: empresa B não mexe na execução de A");
      const p = await rota.POST(pedido("http://127.0.0.1:3000/api/admin/marketing/automacoes", { acao: "preferencia", clienteId: alvos.ok.cl, operacao: "descadastrar", confirmacao: "tentativa cruzada" }));
      assert.equal(p.status, 404, "API: empresa B não altera preferência de cliente de A");
      sessao = null;
    });

    await t.test("frequência por cliente e pausa da regra (cancela pendentes, nada sai)", async () => {
      await fechamento(c, A, base, alvos.ok.cl, { data: "2026-12-26", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 10 });
      await motor.executarCiclo(banco, transporte, new Date(), { empresaId: A });
      assert.deepEqual([(await estadoDe(alvos.ok.cl)).estado, (await estadoDe(alvos.ok.cl)).motivo], ["SUPRIMIDA", "LIMITE_FREQUENCIA"]);
      const nova = await novoAlvo("Antes da Pausa", "5511988887775", true);
      const regra = (await c.query(`SELECT id::text FROM marketing_automacao_regras WHERE empresa_id = $1 AND tipo = 'PROPOSTA_PARADA'`, [A])).rows[0].id;
      await banco.transacao((t2) => motor.planejarEmpresa(t2, A, new Date()));
      const pausa = await regras.pausarRegra(tx, A, g.usuario, regra);
      assert.equal(pausa.canceladas, 1);
      const r = await motor.executarCiclo(banco, transporte, new Date(), { empresaId: A });
      assert.equal(r.processadas, 0);
      assert.deepEqual([(await estadoDe(nova.cl)).estado, (await estadoDe(nova.cl)).motivo], ["CANCELADA", "REGRA_PAUSADA"]);
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_transporte_simulado WHERE empresa_id = $1`, [A]), 1);
    });

    await t.test("pós-festa como tarefa interna (sem provedor): criada uma vez", async () => {
      const cl = await cliente(c, A, "Festa Feita", "5511988887776");
      // Dois dias antes no calendário de São Paulo (a regra conta dias no fuso dela, não em UTC).
      const ontem = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() - 2 * 86_400_000));
      const f = await fechamento(c, A, base, cl, { data: ontem, status: "CONFIRMADO" });
      await contratoAssinado(c, f, 3000, 3000);
      const r = await regras.salvarRegra(tx, A, g.usuario, { acao: "salvar-regra", tipo: "POS_FESTA", versao: 0, acaoRegra: "TAREFA_INTERNA", esperaDias: 1, ...JANELA,
        limiteFrequenciaDias: 30, maxTentativas: 3, templateTexto: null, templateProvedor: null });
      await regras.ativarRegra(tx, A, g.usuario, r.id, r.versao);
      await motor.executarCiclo(banco, transporte, new Date(), { empresaId: A });
      await motor.executarCiclo(banco, transporte, new Date(), { empresaId: A });
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_tarefas WHERE empresa_id = $1 AND cliente_id = $2`, [A, cl]), 1);
      assert.match((await c.query(`SELECT titulo FROM marketing_tarefas WHERE cliente_id = $1`, [cl])).rows[0].titulo, /^Pós-festa/);
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

test("Entrega B: concorrência com duas conexões (dados commitados): reserva sem sobreposição, planejamento e envio uma vez só", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  try {
    const m1 = modulos(c1), m2 = modulos(c2);
    const tx1 = executor(c1);
    const n = async (sql: string, v: unknown[] = []) => Number((await c1.query(sql, v)).rows[0].n);
    // Preparação commitada (sem contrato: nada de validação diferida).
    await c1.query("BEGIN");
    const E = await empresa(c1, `Concorrência ${cod("")}`);
    const g = await pessoa(c1, E, "REPRESENTANTE_AUTORIZADO");
    const base = await comercial(c1, E);
    const clientes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const cl = await cliente(c1, E, `Concorrente ${i}`, `55119888770${i}${i}`.slice(0, 13));
      await m1.pref.alterarPreferencia(tx1, E, g.usuario, { acao: "preferencia", clienteId: cl, operacao: "autorizar", confirmacao: "Autorizou (sintético)" });
      await fechamento(c1, E, base, cl, { data: "2026-12-10", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 10 });
      clientes.push(cl);
    }
    const r = await m1.regras.salvarRegra(tx1, E, g.usuario, regraMensagem(m1.regras.CATALOGO_REGRAS.PROPOSTA_PARADA.texto));
    const rev = await m1.regras.revisarModelo(tx1, E, g.usuario, r.id, r.versao);
    await m1.regras.ativarRegra(tx1, E, g.usuario, r.id, rev.versao);
    await c1.query("COMMIT");

    // Planejamento concorrente: o segundo espera o primeiro e não duplica.
    const agora = new Date();
    await c1.query("BEGIN");
    const p1 = await m1.motor.planejarEmpresa(tx1, E, agora);
    await c2.query("BEGIN");
    const p2Promessa = m2.motor.planejarEmpresa(executor(c2), E, agora);
    await new Promise((ok) => setTimeout(ok, 300));
    await c1.query("COMMIT");
    const p2 = await p2Promessa;
    await c2.query("COMMIT");
    assert.equal(p1.criadas, 6);
    assert.deepEqual([p2.criadas, p2.existentes], [0, 6], "segundo planejador não duplica");
    assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1`, [E]), 6);

    // Reserva concorrente: conjuntos disjuntos (SKIP LOCKED).
    await c1.query("BEGIN"); await c2.query("BEGIN");
    const r1 = await m1.motor.reservar(tx1, agora, 3, E);
    const r2 = await m2.motor.reservar(executor(c2), agora, 3, E);
    await c1.query("ROLLBACK"); await c2.query("ROLLBACK");
    assert.equal(r1.ids.length, 3); assert.equal(r2.ids.length, 3);
    assert.equal(new Set([...r1.ids, ...r2.ids]).size, 6, "nenhuma execução reservada pelos dois");

    // Ciclos concorrentes completos: cada mensagem sai uma vez só.
    const t1 = m1.transp.transporteSimulado(() => tx1), t2 = m2.transp.transporteSimulado(() => executor(c2));
    const [a, b] = await Promise.all([
      m1.motor.executarCiclo({ transacao: porTransacao(c1) as Banco["transacao"] }, t1, agora, { empresaId: E, limite: 6 }),
      m2.motor.executarCiclo({ transacao: porTransacao(c2) as Banco["transacao"] }, t2, agora, { empresaId: E, limite: 6 }),
    ]);
    assert.equal(a.processadas + b.processadas, 6, "as 6 processadas, divididas entre os dois");
    assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_transporte_simulado WHERE empresa_id = $1`, [E]), 6, "uma mensagem por cliente");
    assert.equal(await n(`SELECT count(DISTINCT execucao_id)::int AS n FROM marketing_transporte_simulado WHERE empresa_id = $1`, [E]), 6);
    assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_automacao_execucoes WHERE empresa_id = $1 AND estado = 'ACEITA'`, [E]), 6);
    assert.deepEqual(clientes.length, 6);
  } finally {
    await c2.query("ROLLBACK").catch(() => undefined);
    await c1.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});
