import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, completarCliente, congelarEAssinarKidmais, decisoes, dia, executor, id, importacao,
  PARCIAL, poolNaTransacao, validarAgora, type Cenario, type Servico, integrarLegadoV1,
} from "../../scripts/integracao-importados-test-support.ts";
import { lerRegraCapacidadeAgenda, listarFechamentosConfirmadosPorPeriodo } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { consultarDisponibilidadeData, ocupacaoImpedeCandidato } from "../disponibilidade/services/availability.service.ts";
import { criarSalaoCombinado, impedimentosDesativacao } from "./configuracao-unidade.ts";
import { lerSalaoDaFesta, trocarSalaoDaFesta } from "./troca-salao.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";

/**
 * 098 pelos CAMINHOS DE SERVIÇO reais, no PostgreSQL DESCARTÁVEL com o inventário até a 098 (modelo 098):
 * importação + formalização (escolha do salão do contrato), proposta de remarcação sem hold (não bloqueia o D5), hold
 * com origem C e destino no combinado A+B (origem e destino ocupam juntos: paridade SQL × Core e D5 nos dois), aplicação
 * (libera a origem), cancelamento da revisão (libera o destino), troca manual do salão, disponibilidade do Core usada
 * pela proposta inicial e pelo calendário, guardas de contratos (DELETE, troca de festa) e hold × cadastro concorrentes
 * nas duas ordens (união ordenada de origem e destino antes do primeiro lock; espera observada, sem deadlock).
 * A confirmação por pagamento usa a mesma escolha (escolherSalao), coberta em saloes-combinados-098.postgres.test.ts.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "saloes-098" });
const HORA = { inicio: "10:00", fim: "22:00" };
const TURNO = { inicioMinutos: 10 * 60, fimMinutos: 22 * 60 };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => {
    assert.match(msg(e), trecho);
    return true;
  });
}
async function recusaSql(sql: string, valores: unknown[], trecho: RegExp) {
  await a.query("SAVEPOINT r");
  await recusa(a.query(sql, valores), trecho);
  await a.query("ROLLBACK TO SAVEPOINT r");
}
/** Aceita sem efeito (ponto de salvamento). */
async function aceitaSemEfeito(sql: string, valores: unknown[]) {
  await a.query("SAVEPOINT r");
  await a.query(sql, valores);
  await a.query("ROLLBACK TO SAVEPOINT r");
}

async function configurar(c: Cenario) {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
}

async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato de Festa Salões 098",
    contratada: { nome: "Buffet Salões 098 Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 98", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}

/** Contrato importado e integrado (formalização do importado escolhe o salão) e a remarcação pelos serviços reais. */
async function contratada(c: Cenario, nativo: Awaited<ReturnType<typeof catalogoNativo>>, data: string) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const ev = { data, ...HORA };
  const imp = await importacao(a, c, ev);
  const cpf = await completarCliente(a, imp.cliente);
  // Legado V1 (D2 da S-E restante): esta suíte prova revisões sobre contratos importados ANTES da importação V3.
  const r = await integrarLegadoV1(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()));
  await validarAgora(a);
  const festa = (await a.query<{ id: string }>(`SELECT fechamento_id::text id FROM contratos WHERE id = $1`, [r.contratoId])).rows[0]!.id;
  const tx = executor(a);
  const abrir = async (motivo: string) => {
    const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0]!.v;
    await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo, chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
    const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0]!.id;
    const revisao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0]!.revisao;
    const editar = async (destino: string, tema = "Circo") => {
      const fonte = (await rs.fontesPreparacao(v2, tx))!;
      return operar(v2, { acao: "editar_festa", revisao: await revisao(), motivo, fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
        dataEvento: destino, configuracaoAgendaId: nativo.turno, horarioInicio: HORA.inicio, horarioFim: HORA.fim, adicionais: fonte.adicionais,
        idadeAniversarianteEvento: 6, temaFesta: tema, buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
        observacoesEquipe: "Salões 098" }, c.token, ctxOp(), c.empresa);
    };
    const concluir = async () => {
      await congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, nativo.tokenRepresentante);
      await assinarComoCliente(r.contratoId, cpf);
      await validarAgora(a);
    };
    const cancelar = async () => operar(v2, { acao: "cancelar_revisao", revisao: await revisao(), motivo: "Desistiu do salão inteiro" }, c.token, ctxOp(), c.empresa);
    const preparacao = async () => (await a.query<{ id: string; estado: string; salao: string | null; hold: string | null; data: string }>(
      `SELECT id::text, estado, salao_id::text salao, hold_destino_adquirido_em::text hold, data_evento::text data FROM fechamento_revisoes WHERE contrato_versao_id = $1`, [v2])).rows[0]!;
    return { v2, editar, concluir, cancelar, preparacao };
  };
  return { festa, contrato: r.contratoId, abrir };
}

async function comCommit<T>(corpo: () => Promise<T>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
    await a.query("COMMIT");
    return r;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}

/** Salões A, B, C e D (simples) e o combinado "Salão inteiro" = A+B, pelo cadastro do Core (lock do escopo). */
async function saloes(c: Cenario) {
  const s = (nome: string, ordem: number) => id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, $2, $3) RETURNING id`, [c.empresa, nome, ordem]);
  const A = await s("Salão A", 1), B = await s("Salão B", 2), C = await s("Salão C", 3), D = await s("Salão D", 4);
  const { id: AB } = await criarSalaoCombinado(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() },
    { estabelecimentoId: null, nome: "Salão inteiro", capacidadeConvidados: 200, membros: [B, A] });
  return { A, B, C, D, AB };
}
const pacoteSo = async (c: Cenario, ...permitidos: string[]) => {
  await a.query(`DELETE FROM pacote_saloes WHERE pacote_id = $1::uuid`, [c.pacote]);
  for (const s of permitidos) await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [c.pacote, s]);
};

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("modelo 098: manifesto da Festa com o conjunto 098 e integridade 098", async () => {
  assert.equal((await a.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0]!.valida, true);
});

test("caminhos com combinado: importação/formalização, rascunho sem hold, hold origem C × destino A+B (paridade e D5), aplicação, troca manual, contratos", { timeout: 300_000 }, async () => {
  const D1 = dia(80);
  const r = await comCommit(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modeloContrato(c);
    await configurar(c);
    const { A, B, C, D, AB } = await saloes(c);
    const nomes: Record<string, string> = { [A]: "A", [B]: "B", [C]: "C", [D]: "D", [AB]: "AB" };
    // Importação + formalização: o pacote só permite C → a festa fica em C.
    await pacoteSo(c, C);
    const F = await contratada(c, nativo, D1);
    assert.equal((await a.query(`SELECT salao_id::text s FROM fechamentos WHERE id = $1`, [F.festa])).rows[0].s, C, "formalização escolheu C");
    // O pacote grande passa a permitir só o salão inteiro.
    await pacoteSo(c, AB);
    const rf = await F.abrir("Festa maior: salão inteiro");
    // Nova versão aberta: o serviço já segura o destino no mesmo horário, e o salão do destino é o permitido pelo pacote
    // (o salão inteiro), não a origem C.
    assert.deepEqual((await a.query<{ s: string }>(`SELECT salao_id::text s FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid`, [D1, F.festa])).rows.map((o) => nomes[o.s]).sort(), ["AB", "C"]);
    // Rascunho sem hold: no fluxo real a preparação aberta já tem hold, e a guarda existente não deixa desfazê-lo por SQL
    // direto. Sem hold, kidmais094_ocupacoes não conta o destino (definição da 094), e o D5 só olha essas ocupações.
    await a.query("SAVEPOINT rascunho");
    const semHold = await a.query(`UPDATE fechamento_revisoes SET hold_destino_adquirido_em = NULL WHERE fechamento_id = $1::uuid AND estado = 'EM_ELABORACAO'`, [F.festa]).then(() => true, () => false);
    await a.query("ROLLBACK TO SAVEPOINT rascunho");
    assert.equal(semHold, false, "hold não se desfaz por SQL direto");
    // Hold no mesmo dia: destino no combinado (o atual C não é permitido pelo pacote).
    await rf.editar(D1, "Fundo do mar");
    const p = await rf.preparacao();
    assert.equal(p.salao, AB, "destino no salão inteiro");
    assert.ok(p.hold, "hold adquirido");
    const ocup = (await a.query<{ s: string; origem: string }>(`SELECT salao_id::text s, origem FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid ORDER BY origem`, [D1, F.festa])).rows;
    assert.deepEqual(ocup.map((o) => [o.origem, nomes[o.s]]), [["CONFIRMADA", "C"], ["REVISAO_DESTINO", "AB"]], "origem e destino ocupam juntos");
    // Paridade SQL × Core no hold: A, B, C e AB ocupados; D livre (origem e destino separados, nunca consolidados).
    const tx = executor(a);
    const regra = await lerRegraCapacidadeAgenda(tx, { empresaId: c.empresa, estabelecimentoId: null });
    const ocupacoes = await listarFechamentosConfirmadosPorPeriodo(D1, D1, tx, { empresaId: c.empresa, estabelecimentoId: null });
    for (const candidato of [A, B, C, D, AB]) {
      const sql = (await a.query<{ x: boolean }>(`SELECT kidmais094_conflito_ocupacao($1::uuid, $2::date, $3::time, $4::time, $5::uuid, NULL, $6::uuid, $7::uuid) x`,
        [randomUUID(), D1, HORA.inicio, HORA.fim, c.empresa, nativo.turno, candidato])).rows[0]!.x;
      assert.equal(sql, candidato !== D, `SQL ${nomes[candidato]}`);
      assert.equal(ocupacaoImpedeCandidato(regra, nativo.turno, TURNO, ocupacoes, [candidato]), sql, `Core × SQL ${nomes[candidato]}`);
    }
    // Disponibilidade do Core (proposta inicial, calendário, Wall-e): pacote só com AB → indisponível no dia.
    const agenda = await consultarDisponibilidadeData(D1, tx, undefined, { empresaId: c.empresa, estabelecimentoId: null }, { saloesDoPacote: [AB] });
    assert.ok(agenda.periodos.every((per) => per.status !== "DISPONIVEL"), "salão inteiro ocupado pelo hold");
    const comD = await consultarDisponibilidadeData(D1, tx, undefined, { empresaId: c.empresa, estabelecimentoId: null }, { saloesDoPacote: [D] });
    assert.ok(comD.periodos.some((per) => per.status === "DISPONIVEL"), "D livre");
    // D5 no hold: origem (C) e destino (A, B, AB) não são desativados; a listagem mostra a remarcação.
    for (const s of [A, B, C, AB]) await recusaSql(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [s], /festa de hoje em diante/);
    assert.deepEqual((await impedimentosDesativacao(tx, [A])).map((i) => [i.salao, i.remarcacao]), [["Salão inteiro", true]]);
    await validarAgora(a);
    // Aplicação: a festa passa ao salão inteiro; a origem C fica livre (desativação aceita), A continua impedido.
    await rf.concluir();
    assert.equal((await a.query(`SELECT salao_id::text s FROM fechamentos WHERE id = $1`, [F.festa])).rows[0].s, AB);
    await aceitaSemEfeito(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [C]);
    await recusaSql(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [A], /festa de hoje em diante/);
    // Troca manual: as opções mostram o combinado com a composição; C não é permitido pelo pacote; com C liberado, troca.
    const ctx = { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() };
    const leitura = await lerSalaoDaFesta(tx, c.empresa, F.festa);
    const opcaoAB = leitura?.opcoes.find((o) => o.id === AB);
    assert.deepEqual([opcaoAB?.combinado, opcaoAB?.membros], [true, ["Salão A", "Salão B"]]);
    // S-E (27/10/2026, R-E3): a versão aplicada é V3 e fixa o salão inteiro; a troca direta passa a ser recusada (a troca
    // é o destino de uma nova revisão), qualquer que seja o salão pedido. Nada muda na festa.
    await a.query("SAVEPOINT troca");
    await recusa(trocarSalaoDaFesta(tx, ctx, F.festa, C), /O contrato assinado fixa o salão Salão inteiro/);
    await a.query("ROLLBACK TO SAVEPOINT troca");
    await pacoteSo(c, AB, C);
    await a.query("SAVEPOINT troca");
    await recusa(trocarSalaoDaFesta(tx, ctx, F.festa, C), /O contrato assinado fixa o salão Salão inteiro/);
    await a.query("ROLLBACK TO SAVEPOINT troca");
    assert.equal((await a.query(`SELECT salao_id::text s FROM fechamentos WHERE id = $1`, [F.festa])).rows[0].s, AB);
    // Contratos: não se apagam e não mudam de festa (SQL direto).
    await recusaSql(`DELETE FROM contratos WHERE id = $1::uuid`, [F.contrato], /contrato não é apagado/);
    const outraFesta = (await a.query<{ id: string }>(`SELECT id::text FROM fechamentos WHERE empresa_id = $1::uuid AND id <> $2::uuid LIMIT 1`, [c.empresa, F.festa])).rows[0]?.id ?? F.festa;
    await recusaSql(`UPDATE contratos SET fechamento_id = $2::uuid WHERE id = $1::uuid`, [F.contrato, outraFesta === F.festa ? randomUUID() : outraFesta], /não muda de festa/);
    await validarAgora(a);
    return { festa: F.festa, AB, revisao: p.id };
  });
  const b = await conectarDescartavel({ travar: false });
  try {
    assert.deepEqual((await b.query(`SELECT salao_id::text s, status FROM fechamentos WHERE id = $1`, [r.festa])).rows[0], { s: r.AB, status: "CONFIRMADO" });
    assert.equal((await b.query(`SELECT estado FROM fechamento_revisoes WHERE id = $1`, [r.revisao])).rows[0].estado, "APLICADA");
  } finally {
    await encerrarDescartavel(b, false);
  }
});

test("cancelar a revisão libera o destino (D5 aceita desativar A depois); a origem continua", { timeout: 300_000 }, async () => {
  await comCommit(async () => {
    const D1 = dia(82);
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modeloContrato(c);
    await configurar(c);
    const { A, C, AB } = await saloes(c);
    await pacoteSo(c, C);
    const F = await contratada(c, nativo, D1);
    await pacoteSo(c, AB);
    const rf = await F.abrir("Salão inteiro");
    await rf.editar(D1, "Fundo do mar");
    assert.equal((await rf.preparacao()).salao, AB);
    await recusaSql(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [A], /festa de hoje em diante/);
    await rf.cancelar();
    assert.equal((await rf.preparacao()).estado, "CANCELADA");
    await validarAgora(a);
    await aceitaSemEfeito(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [A]);
    await recusaSql(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [C], /festa de hoje em diante/);
  });
});

test("hold com origem e destino diferentes × cadastro (lock de todos os salões do escopo), nas duas ordens", { timeout: 300_000 }, async () => {
  // Preparação: festa em C com o pacote só permitindo o salão inteiro (destino A+B no hold), com COMMIT.
  const D1 = dia(84), D2 = dia(85);
  const base = await comCommit(async () => {
    const c = await cenario(a, 0);
    const nativo = await catalogoNativo(a, c);
    await modeloContrato(c);
    await configurar(c);
    const s = await saloes(c);
    await pacoteSo(c, s.C);
    const F = await contratada(c, nativo, D1);
    const G = await contratada(c, nativo, D2);
    await pacoteSo(c, s.AB);
    return { c, nativo, s, F, G };
  });
  const pid = async (db: Client) => Number((await db.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0]!.p);
  const esperando = async (quem: number, por: number) => {
    for (let i = 0; i < 400; i++) {
      if ((await d2.query<{ ok: boolean }>(`SELECT $2::int = ANY (pg_blocking_pids($1::int)) ok`, [quem, por])).rows[0]!.ok) return;
      await new Promise((fim) => setTimeout(fim, 25));
    }
    assert.fail(`espera não observada: ${quem} por ${por}`);
  };
  const cad = await conectarDescartavel({ travar: false });
  const d2 = await conectarDescartavel({ travar: false });
  try {
    const [pa, pc] = [await pid(a), await pid(cad)];
    const ctx = { empresaId: base.c.empresa, usuarioId: base.c.usuario, requestId: randomUUID() };
    const cadastro = (nome: string, membros: string[]) => (async () => {
      await cad.query("BEGIN");
      try {
        await criarSalaoCombinado(executor(cad), { ...ctx, requestId: randomUUID() }, { estabelecimentoId: null, nome, capacidadeConvidados: null, membros });
        await cad.query("COMMIT");
        return "ok";
      } catch (e) {
        await cad.query("ROLLBACK");
        return e;
      }
    })();
    // 1) Hold primeiro: a validação trava a UNIÃO ordenada {A, B, AB, C} (FOR SHARE); o cadastro espera e termina depois.
    await a.query("BEGIN");
    const restaurarPool = poolNaTransacao(a);
    const restaurarAmbiente = ambienteAssinatura();
    try {
      const rf = await base.F.abrir("Salão inteiro (hold)");
      await rf.editar(D1, "Fundo do mar");
      assert.equal((await rf.preparacao()).salao, base.s.AB);
      await a.query("SET CONSTRAINTS ALL IMMEDIATE");
      const r1 = cadastro("BC", [base.s.B, base.s.C]);
      await esperando(pc, pa);
      await a.query("COMMIT");
      assert.equal(await r1, "ok", "cadastro concluído depois do hold");
    } catch (e) {
      await a.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      restaurarAmbiente();
      restaurarPool();
    }
    // 2) Cadastro primeiro (todos os salões do escopo FOR NO KEY UPDATE por id, sem COMMIT): o hold da festa G (origem C
    //    em D2, destino no salão inteiro) espera na trava dos salões e passa depois do COMMIT do cadastro, sem deadlock.
    await cad.query("BEGIN");
    await criarSalaoCombinado(executor(cad), { ...ctx, requestId: randomUUID() }, { estabelecimentoId: null, nome: "CD", capacidadeConvidados: null, membros: [base.s.C, base.s.D] });
    const segundo = (async () => {
      await a.query("BEGIN");
      const restaurarPool2 = poolNaTransacao(a);
      const restaurarAmbiente2 = ambienteAssinatura();
      try {
        const rg = await base.G.abrir("Salão inteiro (G)");
        await rg.editar(D2, "Fundo do mar");
        await a.query("COMMIT");
        return (await rg.preparacao()).salao;
      } catch (e) {
        await a.query("ROLLBACK").catch(() => undefined);
        return e;
      } finally {
        restaurarAmbiente2();
        restaurarPool2();
      }
    })();
    await esperando(pa, pc);
    await cad.query("COMMIT");
    const fim = await segundo;
    assert.doesNotMatch(msg(fim), /deadlock/i);
    assert.equal(fim, base.s.AB, "hold de G no salão inteiro, depois da espera");
  } finally {
    await encerrarDescartavel(cad, false);
    await encerrarDescartavel(d2, false);
  }
  const preparacoes = (await a.query<{ s: string | null; hold: boolean }>(
    `SELECT r.salao_id::text s, r.hold_destino_adquirido_em IS NOT NULL hold FROM fechamento_revisoes r WHERE r.fechamento_id = $1::uuid AND r.estado IN ('EM_ELABORACAO','CONGELADA')`, [base.F.festa])).rows;
  assert.deepEqual(preparacoes, [{ s: base.s.AB, hold: true }], "o hold no salão inteiro ficou gravado");
});
