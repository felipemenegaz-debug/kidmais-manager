import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id,
  poolNaTransacao, validarAgora, type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * S-E parte 2 (plano S-E/S-D rev. 4.1, R-E1/R-E2/R3-E2/R3-E3/R3-E5) no PostgreSQL DESCARTÁVEL, contratos NATIVOS pelos
 * serviços reais (gerarContrato → assinatura Kidmais → aceite do cliente), COMMIT real e conferência por outra conexão:
 * - emissão em POR_SALAO fixa no snapshot V3 o menor salão livre que comporta (sem fallback para quem não comporta),
 *   sem gravar fechamentos.salao_id e sem ocupar a agenda; a assinatura grava o salão EXIGIDO;
 * - nunca troca em silêncio: equipe muda o salão depois da emissão → assinatura recusada; outra festa ocupa o salão
 *   (segunda conexão segurando o lock da data, espera observada) → recusada, nada gravado, sem salão substituto;
 * - duas festas emitidas com o mesmo salão: a primeira assinatura vence, a segunda é recusada (sem cair no salão livre);
 * - festa com a data mudada depois da emissão: versão desatualizada;
 * - um salão (POR_HORARIO): documento como antes (sem V3) e assinatura normal.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "se-parte2" });

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

async function configurar(c: Cenario, tipo: "POR_HORARIO" | "POR_SALAO") {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`, [c.empresa, tipo, c.usuario]);
}
async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato S-E parte 2", contratada: { nome: "Buffet S-E Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}
const salao = (c: Cenario, nome: string, ordem: number, capacidade: number | null) =>
  id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo, capacidade_convidados) VALUES ($1::uuid, $2, $3, true, $4) RETURNING id`, [c.empresa, nome, ordem, capacidade]);

/** Proposta nativa (10:00–22:00, o horário que o turno do cenário oferece; N convidados) e o contrato gerado pela emissão real; ainda sem assinatura. */
async function emitida(c: Cenario, nativo: Nativo, data: string, convidados = 30, forma: string | null = null) {
  const cpf = cpfValido();
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
      VALUES ('Cliente S-E', $1::uuid, $2, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [c.empresa, cpf, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante S-E') RETURNING id`, [cliente]);
  const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status, forma_pagamento_pretendida)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', $7, $7, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO', $8
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante, convidados, forma]);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  return { festa, contrato: gerado.contrato.id, versao: gerado.versao.id, cpf };
}
const snapshotDe = async (versao: string) => (await a.query<{ s: { schemaVersao: number; evento: { salao?: { id: string; nome: string } | null; configuracaoAgendaId?: string } } }>(
  `SELECT snapshot s FROM contrato_versoes WHERE id = $1::uuid`, [versao])).rows[0].s;
const festaDe = async (db: Client, f: string) => (await db.query<{ salao: string | null; ocupa: boolean; status: string }>(
  `SELECT salao_id::text salao, kidmais019_ocupa(id) ocupa, status FROM fechamentos WHERE id = $1::uuid`, [f])).rows[0];
const contratoAssinado = async (db: Client, contrato: string) => (await db.query<{ s: string }>(`SELECT status s FROM contratos WHERE id = $1::uuid`, [contrato])).rows[0].s;

async function comCommit<T>(corpo: () => Promise<T>, fim: "COMMIT" | "ROLLBACK" = "COMMIT") {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
    await a.query(fim);
    return r;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}
async function empresa(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  const nativo = await catalogoNativo(a, c);
  await modeloContrato(c);
  await configurar(c, tipo);
  return { c, nativo };
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("emissão fixa o menor salão que comporta, sem gravar nem ocupar; a assinatura grava o salão exigido", { timeout: 300_000 }, async () => {
  const D = dia(100);
  const r = await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const pequeno = await salao(c, "Pequeno", 1, 20);
    const medio = await salao(c, "Médio", 2, 40);
    const grande = await salao(c, "Grande", 3, 120);
    const semLimite = await salao(c, "Sem limite", 4, null);
    const e = await emitida(c, nativo, D, 30);
    const snap = await snapshotDe(e.versao);
    assert.equal(snap.schemaVersao, 3);
    assert.deepEqual(snap.evento.salao, { id: medio, nome: "Médio" }, "menor que comporta (20 não comporta 30; nulos por último)");
    assert.equal(snap.evento.configuracaoAgendaId, nativo.turno);
    assert.deepEqual(await festaDe(a, e.festa), { salao: null, ocupa: false, status: "AGUARDANDO_CONTRATO" }, "emitir não grava nem ocupa");
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    return { e, pequeno, medio, grande, semLimite };
  });
  const b = await conectarDescartavel({ travar: false });
  try {
    const f = await festaDe(b, r.e.festa);
    assert.equal(f.salao, r.medio, "assinatura gravou o salão do documento");
    assert.equal(f.ocupa, true);
  } finally { await encerrarDescartavel(b, false); }
});

test("sem troca silenciosa: equipe mudou o salão depois da emissão, ou a data mudou → assinatura recusada, nada gravado", { timeout: 300_000 }, async () => {
  const D = dia(101), D2 = dia(102);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50), s2 = await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, D, 30);
    assert.equal((await snapshotDe(e.versao)).evento.salao?.id, s1);
    await a.query(`UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid`, [e.festa, s2]);
    await recusa(assinarComoCliente(e.contrato, e.cpf), /salão deste contrato não está mais disponível/);
    assert.notEqual(await contratoAssinado(a, e.contrato), "ASSINADO");
    assert.equal((await festaDe(a, e.festa)).salao, s2, "a escolha da equipe não foi desfeita nem trocada");
    // Data mudada depois da emissão: a versão está desatualizada (não é dispensa do salão).
    const e2 = await emitida(c, nativo, D, 30);
    await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1::uuid`, [e2.festa, D2]);
    await recusa(assinarComoCliente(e2.contrato, e2.cpf), /versão do contrato está desatualizada/);
    assert.notEqual(await contratoAssinado(a, e2.contrato), "ASSINADO");
  });
});

test("duas festas emitidas com o mesmo salão: a primeira assinatura vence; a segunda é recusada sem cair no salão livre", { timeout: 300_000 }, async () => {
  const D = dia(103);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    const e1 = await emitida(c, nativo, D, 30);
    const e2 = await emitida(c, nativo, D, 30);
    assert.equal((await snapshotDe(e1.versao)).evento.salao?.id, s1);
    assert.equal((await snapshotDe(e2.versao)).evento.salao?.id, s1, "emissão não segura o salão (D-E2)");
    const s2 = await salao(c, "S2 livre", 2, 50);
    await assinarComoCliente(e1.contrato, e1.cpf);
    await validarAgora(a);
    await recusa(assinarComoCliente(e2.contrato, e2.cpf), /salão deste contrato não está mais disponível/);
    assert.equal((await festaDe(a, e2.festa)).salao, null, "sem substituto: S2 livre não foi usado");
    assert.ok(s2);
  });
});

test("ocupação concorrente: outra conexão segura o lock da data e ocupa o salão; a assinatura espera e é recusada", { timeout: 300_000 }, async () => {
  const D = dia(104);
  const prep = await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    await salao(c, "S2", 2, 50);
    const e = await emitida(c, nativo, D, 30);
    return { c, nativo, s1, e };
  });
  const b = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  const pidA = (await a.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0].p;
  const esperandoLock = async (p: number) => {
    for (let i = 0; i < 400; i++) {
      if ((await obs.query<{ w: string | null }>("SELECT wait_event_type w FROM pg_stat_activity WHERE pid = $1", [p])).rows[0]?.w === "Lock") return;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`conexão ${p} não chegou a esperar lock`);
  };
  try {
    await b.query("BEGIN");
    const x = await id(b, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT f.data_evento, f.horario_inicio, f.horario_fim, f.configuracao_agenda_id, f.empresa_id, f.pacote_id, f.tabela_preco_id, f.preco_pacote_id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $2::uuid FROM fechamentos f WHERE f.id = $1::uuid RETURNING fechamentos.id`, [prep.e.festa, prep.s1]);
    await b.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [x]);
    const assinatura = comCommit(async () => { await assinarComoCliente(prep.e.contrato, prep.e.cpf); }).then(() => "assinou", (e: Error) => e);
    await esperandoLock(pidA);
    await b.query("COMMIT");
    const r = await assinatura;
    assert.ok(r instanceof Error && /salão deste contrato não está mais disponível/.test(r.message), `recusada: ${r instanceof Error ? r.message : r}`);
    assert.notEqual(await contratoAssinado(obs, prep.e.contrato), "ASSINADO");
    assert.deepEqual(await festaDe(obs, prep.e.festa), { salao: null, ocupa: false, status: "AGUARDANDO_CONTRATO" }, "nada gravado, sem salão substituto");
    assert.equal((await festaDe(obs, x)).salao, prep.s1);
  } finally {
    await b.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(obs, false);
  }
});

test("um salão (POR_HORARIO): documento como antes (sem V3) e assinatura normal", { timeout: 300_000 }, async () => {
  const D = dia(105);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const e = await emitida(c, nativo, D, 30);
    assert.notEqual((await snapshotDe(e.versao)).schemaVersao, 3);
    assert.equal((await snapshotDe(e.versao)).evento.salao, undefined);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal(await contratoAssinado(a, e.contrato), "ASSINADO");
  });
});

test("troca depois da assinatura (R-E3/R3-E1): direta recusada; pela revisão o salão atual vale até a aplicação; desistir preserva; aplicar move", { timeout: 300_000 }, async () => {
  const D = dia(106);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50), s2 = await salao(c, "S2", 2, 50);
    const e = await emitida(c, nativo, D, 30);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal((await festaDe(a, e.festa)).salao, s1);
    const troca = carregar<typeof import("./troca-salao.ts")>("lib/agenda/troca-salao.ts");
    const ctx = { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() };
    await recusa(troca.trocarSalaoDaFesta(executor(a), ctx, e.festa, s2), /fixa o salão S1/);
    assert.equal((await festaDe(a, e.festa)).salao, s1, "sem revisão a festa não muda");
    const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
    const operar = adm.operarContrato as unknown as Operar;
    const abrir = async () => {
      await operar(e.versao, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Troca de salão", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
      return (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [e.contrato])).rows[0].id;
    };
    const revisaoDe = async (v: string) => (await a.query<{ estado: string; salao: string | null; hold: boolean }>(
      `SELECT estado, salao_id::text salao, hold_destino_adquirido_em IS NOT NULL hold FROM fechamento_revisoes WHERE contrato_versao_id = $1`, [v])).rows[0];
    const edicao = async (v: string) => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v])).rows[0].revisao;
    // Revisão 1: troca para S2 no destino; desistir (cancelar) preserva S1 e libera S2.
    const v2 = await abrir();
    const leitura = await troca.trocarSalaoDaFesta(executor(a), ctx, e.festa, s2);
    assert.equal(leitura?.trocaEmAndamento?.salao?.id, s2);
    assert.equal(leitura?.contratoFixa?.id, s1);
    assert.equal((await festaDe(a, e.festa)).salao, s1, "A continua vigente");
    assert.deepEqual(await revisaoDe(v2), { estado: "EM_ELABORACAO", salao: s2, hold: true });
    await operar(v2, { acao: "cancelar_revisao", revisao: await edicao(v2), motivo: "Desistiu da troca" }, c.token, ctxOp(), c.empresa);
    await validarAgora(a);
    assert.equal((await revisaoDe(v2)).estado, "CANCELADA");
    assert.equal((await festaDe(a, e.festa)).salao, s1);
    // Revisão 2: troca para S2, o documento é recomposto (salvar), assinaturas e aplicação movem a festa para S2.
    const v3 = await abrir();
    await troca.trocarSalaoDaFesta(executor(a), ctx, e.festa, s2);
    await operar(v3, { acao: "salvar", revisao: await edicao(v3), observacoesDocumentais: "" }, c.token, ctxOp(), c.empresa);
    const doc = (await a.query<{ s: { schemaVersao: number; evento: { salao: { id: string } | null } } }>(`SELECT snapshot s FROM contrato_versoes WHERE id = $1`, [v3])).rows[0].s;
    assert.equal(doc.schemaVersao, 3);
    assert.equal(doc.evento.salao?.id, s2, "o documento da revisão traz o salão do destino");
    await congelarEAssinarKidmais(a, operar, v3, c.empresa, c.token, nativo.tokenRepresentante);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal((await revisaoDe(v3)).estado, "APLICADA");
    assert.equal((await festaDe(a, e.festa)).salao, s2, "aplicação atômica moveu a festa para S2");
  });
});

/**
 * Rodada 2 (parecer do Astra de 27/10: P1, três P2 e os PG que precedem o aceite). Preparação de revisão do contrato
 * NATIVO assinado pelos serviços reais (nova versão → editar festa → revalidar/gerar PDF), nos modelos 103 (hash v1)
 * e 104 (hash v2).
 */
type Emitida = Awaited<ReturnType<typeof emitida>>;
async function revisaoNativa(c: Cenario, nativo: Nativo, e: Emitida) {
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [e.contrato])).rows[0].v;
  await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "S-E rodada 2", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
  const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [e.contrato])).rows[0].id;
  const edicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
  const editar = async (m: { convidados?: number; dataEvento?: string }) => {
    const fonte = (await rs.fontesPreparacao(v2, executor(a)))!;
    return operar(v2, { acao: "editar_festa", revisao: await edicao(), motivo: "S-E rodada 2", fonteHash: fonte.fonteHash, pacoteId: c.pacote,
      convidados: m.convidados ?? fonte.fechamento.convidados, dataEvento: m.dataEvento ?? fonte.fechamento.dataEvento, configuracaoAgendaId: nativo.turno,
      horarioInicio: "10:00", horarioFim: "22:00", adicionais: fonte.adicionais, idadeAniversarianteEvento: 6, temaFesta: "Circo", buffetStatus: "PENDENTE",
      buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: "S-E rodada 2" }, c.token, ctxOp(), c.empresa);
  };
  const salvar = async () => operar(v2, { acao: "salvar", revisao: await edicao(), observacoesDocumentais: "" }, c.token, ctxOp(), c.empresa);
  const gerarPdf = async () => operar(v2, { acao: "gerar_pdf", revisao: await edicao() }, c.token, ctxOp(), c.empresa);
  const revalidar = async () => operar(v2, { acao: "revalidar_destino", revisao: await edicao() }, c.token, ctxOp(), c.empresa);
  const preparacao = async () => (await a.query<{ id: string; estado: string; salao: string | null; versao: number | null; revisao: number; hash: string }>(
    `SELECT id::text, estado, salao_id::text salao, (to_jsonb(r)->>'hash_versao')::int versao, revisao, conteudo_hash hash
       FROM fechamento_revisoes r WHERE contrato_versao_id = $1`, [v2])).rows[0];
  const concluir = async () => {
    await congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, nativo.tokenRepresentante);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
  };
  return { v2, editar, salvar, gerarPdf, revalidar, preparacao, concluir };
}
const com104 = async () => (await a.query<{ ok: boolean }>(
  `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped) ok`)).rows[0].ok;
/** Outra festa CONFIRMADA no mesmo dia e horário da festa `base`, no salão `s`. */
const ocupar = async (base: string, s: string) => {
  const x = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
    SELECT f.data_evento, f.horario_inicio, f.horario_fim, f.configuracao_agenda_id, f.empresa_id, f.pacote_id, f.tabela_preco_id, f.preco_pacote_id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
           'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $2::uuid FROM fechamentos f WHERE f.id = $1::uuid RETURNING fechamentos.id`, [base, s]);
  await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [x]);
  return x;
};

test("P1 (27/10): o salão do destino muda na revalidação (com hash v1 também) e gerar o PDF recusa; revalidar recompõe o documento", { timeout: 300_000 }, async () => {
  const D = dia(107);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 35), s2 = await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, D, 30);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    const rv = await revisaoNativa(c, nativo, e);
    const antes = await rv.preparacao();
    assert.equal(antes.salao, s1);
    assert.equal(antes.versao, (await com104()) ? 2 : null, "modelo 103: revisão sem hash_versao (hash v1)");
    assert.equal((await snapshotDe(rv.v2)).evento.salao?.id, s1, "documento da revisão em S1");
    // S1 deixa de comportar os 30 convidados: a revalidação do destino (estrita) passa a S2.
    await a.query(`UPDATE agenda_saloes SET capacidade_convidados = 20 WHERE id = $1::uuid`, [s1]);
    await recusa(rv.gerarPdf(), /O salão do destino mudou/);
    const recusada = await rv.preparacao();
    assert.equal(recusada.salao, s1, "a recusa não gravou o destino novo");
    assert.equal(recusada.hash, antes.hash);
    // Revalidar o destino recompõe o documento (v1: o hash não mudou, mas o salão do documento mudou).
    await rv.revalidar();
    assert.equal((await rv.preparacao()).salao, s2);
    assert.equal((await snapshotDe(rv.v2)).evento.salao?.id, s2, "documento recomposto em S2");
    await rv.concluir();
    assert.equal((await festaDe(a, e.festa)).salao, s2, "aplicação moveu a festa para o salão do documento");
  });
});

test("P2 (27/10): destino estrito: mais convidados que o salão atual comporta vai para o menor que comporta; nenhum serve = recusa", { timeout: 300_000 }, async () => {
  const D = dia(108);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 35), s2 = await salao(c, "S2", 2, 50);
    await salao(c, "S3", 3, 80);
    const e = await emitida(c, nativo, D, 30);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal((await festaDe(a, e.festa)).salao, s1);
    const rv = await revisaoNativa(c, nativo, e);
    await rv.editar({ convidados: 45 });
    assert.equal((await rv.preparacao()).salao, s2, "S1 (35) não comporta 45: o menor que comporta é S2 (50), nem o atual nem o S3");
    assert.equal((await snapshotDe(rv.v2)).evento.salao?.id, s2);
    await recusa(rv.editar({ convidados: 120 }), /Destino da revisão indisponível/);
    assert.equal((await rv.preparacao()).salao, s2, "a recusa não gravou nada");
  });
});

test("P2 (27/10): na remarcação D1 → D2 o painel oferece os salões do DESTINO; o ocupado em D1 e livre em D2 pode ser escolhido", { timeout: 300_000 }, async () => {
  const D1 = dia(109), D2 = dia(110);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50), s2 = await salao(c, "S2", 2, 50);
    const e = await emitida(c, nativo, D1, 30);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    await ocupar(e.festa, s2);
    await validarAgora(a);
    const rv = await revisaoNativa(c, nativo, e);
    await rv.editar({ dataEvento: D2 });
    assert.equal((await rv.preparacao()).salao, s1, "o destino mantém S1, que serve em D2");
    const troca = carregar<typeof import("./troca-salao.ts")>("lib/agenda/troca-salao.ts");
    const ctx = { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() };
    const leitura = (await troca.lerSalaoDaFesta(executor(a), c.empresa, e.festa))!;
    assert.deepEqual(leitura.opcoes.find((o) => o.id === s2), { id: s2, nome: "S2", livre: true, permitido: true }, "S2 está livre no DESTINO (D2)");
    await troca.trocarSalaoDaFesta(executor(a), ctx, e.festa, s2);
    assert.equal((await rv.preparacao()).salao, s2);
    assert.equal((await festaDe(a, e.festa)).salao, s1, "a festa continua em S1 até a aplicação");
  });
});

test("P2 (27/10): pagamento depois da revisão aplicada (data e salão novos) confirma a reserva no salão da versão vigente", { timeout: 300_000 }, async () => {
  const D1 = dia(111), D2 = dia(112);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50), s2 = await salao(c, "S2", 2, 50);
    const e = await emitida(c, nativo, D1, 30, "PIX_AVISTA");
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal((await festaDe(a, e.festa)).salao, s1);
    const rv = await revisaoNativa(c, nativo, e);
    await rv.editar({ dataEvento: D2 });
    const troca = carregar<typeof import("./troca-salao.ts")>("lib/agenda/troca-salao.ts");
    await troca.trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, e.festa, s2);
    await rv.salvar();
    await rv.concluir();
    assert.equal((await rv.preparacao()).estado, "APLICADA");
    const festa = (await a.query<{ data: string; salao: string }>(`SELECT data_evento::text data, salao_id::text salao FROM fechamentos WHERE id = $1`, [e.festa])).rows[0];
    assert.deepEqual([festa.data, festa.salao], [D2, s2]);
    const pag = carregar<typeof import("../pagamentos/services/pagamento.service.ts")>("lib/pagamentos/services/pagamento.service.ts");
    const tx = executor(a);
    const total = Number((await a.query<{ t: string }>(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' t FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id = cf.versao_vigente_id WHERE cf.contrato_id = $1`, [e.contrato])).rows[0].t);
    const contexto = { token: c.token, usuarioId: c.usuario, origem: "ADMIN_FINANCEIRO", requestId: randomUUID(), ip: null, userAgent: "se-r2", executor: tx };
    const criado = await pag.criarPagamentoDoFechamento({ fechamentoId: e.festa, plano: { meioPagamento: "PIX", modalidade: "AVISTA", parcelas: [{ valor: total, vencimento: dia(1), confirmaReserva: true }] } } as never, contexto as never) as { detalhe: { pagamento: { id: string } } };
    const pagamento = criado.detalhe.pagamento.id;
    const parcela = (await a.query<{ id: string }>(`SELECT pp.id FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id WHERE pl.pagamento_id = $1`, [pagamento])).rows[0].id;
    await pag.registrarRecebimentoPagamento({ pagamentoId: pagamento, meioPagamento: "PIX", valorBruto: total, confirmarAgora: true, chaveIdempotencia: randomUUID(),
      alocacoes: [{ parcelaId: parcela, valor: total }] } as never, contexto as never);
    const reserva = (await a.query<{ r: string }>(`SELECT reserva_status r FROM pagamentos WHERE id = $1`, [pagamento])).rows[0].r;
    assert.equal(reserva, "CONFIRMADA", "antes da correção, a base da revisão (S1 em D1) acusava conflito");
    assert.deepEqual(await festaDe(a, e.festa), { salao: s2, ocupa: true, status: "CONFIRMADO" });
    await validarAgora(a);
  });
});

test("pagamento V3 com o salão do contrato ocupado: CONFLITO, recebimento preservado, sem salão substituto", { timeout: 300_000 }, async () => {
  const D = dia(114);
  // Termina em ROLLBACK: tirar o salão da festa formalizada e ocupar S1 com outra festa é um estado que o validador
  // diferido do banco já recusa no COMMIT ("Conflito entre contratações"); aqui só se prova o caminho do pagamento.
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    await salao(c, "S2 livre", 2, 50);
    const e = await emitida(c, nativo, D, 30, "PIX_AVISTA");
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal((await festaDe(a, e.festa)).salao, s1);
    // Simula a perda do salão (festa sem salão e outra confirmada em S1) antes do pagamento.
    await a.query(`UPDATE fechamentos SET salao_id = NULL WHERE id = $1::uuid`, [e.festa]);
    const x = await ocupar(e.festa, s1);
    const pag = carregar<typeof import("../pagamentos/services/pagamento.service.ts")>("lib/pagamentos/services/pagamento.service.ts");
    const tx = executor(a);
    const total = Number((await a.query<{ t: string }>(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' t FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id = cf.versao_vigente_id WHERE cf.contrato_id = $1`, [e.contrato])).rows[0].t);
    const contexto = { token: c.token, usuarioId: c.usuario, origem: "ADMIN_FINANCEIRO", requestId: randomUUID(), ip: null, userAgent: "se-r2", executor: tx };
    const criado = await pag.criarPagamentoDoFechamento({ fechamentoId: e.festa, plano: { meioPagamento: "PIX", modalidade: "AVISTA", parcelas: [{ valor: total, vencimento: dia(1), confirmaReserva: true }] } } as never, contexto as never) as { detalhe: { pagamento: { id: string } } };
    const pagamento = criado.detalhe.pagamento.id;
    const parcela = (await a.query<{ id: string }>(`SELECT pp.id FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id WHERE pl.pagamento_id = $1`, [pagamento])).rows[0].id;
    await pag.registrarRecebimentoPagamento({ pagamentoId: pagamento, meioPagamento: "PIX", valorBruto: total, confirmarAgora: true, chaveIdempotencia: randomUUID(),
      alocacoes: [{ parcelaId: parcela, valor: total }] } as never, contexto as never);
    const r = (await a.query<{ r: string; n: number }>(`SELECT p.reserva_status r, (SELECT count(*)::int FROM pagamento_recebimentos WHERE pagamento_id = p.id AND status = 'CONFIRMADO') n FROM pagamentos p WHERE p.id = $1`, [pagamento])).rows[0];
    assert.deepEqual([r.r, r.n], ["CONFLITO", 1], "conflito com o recebimento preservado");
    const f = await festaDe(a, e.festa);
    assert.equal(f.salao, null, "sem salão substituto (S2 livre não foi usado)");
    assert.notEqual(f.status, "CONFIRMADO");
    assert.equal((await festaDe(a, x)).salao, s1);
  }, "ROLLBACK");
});

test("revisão inicial (antes da 1ª assinatura do cliente) com salão diferente: a proposta fixa o novo salão e a formalização o exige", { timeout: 300_000 }, async () => {
  const D = dia(113);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 35), s2 = await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, D, 30);
    assert.equal((await snapshotDe(e.versao)).evento.salao?.id, s1);
    const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
    const operar = adm.operarContrato as unknown as Operar;
    const nova = await operar(e.versao, { acao: "substituir_preparacao", motivo: "Mais convidados", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa) as { versaoId: string };
    const v2 = nova.versaoId;
    const edicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
    const fonte = await adm.fontesEdicao(e.festa, executor(a));
    await operar(v2, { acao: "editar_festa", revisao: await edicao(), motivo: "Mais convidados", fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 45,
      dataEvento: D, configuracaoAgendaId: nativo.turno, horarioInicio: "10:00", horarioFim: "22:00", adicionais: fonte.adicionais, idadeAniversarianteEvento: 6, temaFesta: "Circo",
      buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: "S-E rodada 2" }, c.token, ctxOp(), c.empresa);
    const snap = await snapshotDe(v2);
    assert.equal(snap.schemaVersao, 3);
    assert.equal(snap.evento.salao?.id, s2, "S1 (35) não comporta 45: a proposta fixa S2");
    assert.deepEqual(await festaDe(a, e.festa), { salao: null, ocupa: false, status: "AGUARDANDO_CONTRATO" }, "a proposta não mexe na festa");
    await congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, nativo.tokenRepresentante);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    const f = await festaDe(a, e.festa);
    assert.equal(f.salao, s2, "formalização exigiu e gravou o salão da proposta");
    assert.equal(f.ocupa, true);
    assert.equal((await a.query<{ n: number }>(`SELECT convidados n FROM fechamentos WHERE id = $1`, [e.festa])).rows[0].n, 45);
  });
});
