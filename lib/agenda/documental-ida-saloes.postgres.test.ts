import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, ctxIntegracao, decisoes, dia, executor, id,
  importacao, integrar, PARCIAL, poolNaTransacao, validarAgora, type Cenario, type Servico,
} from "../../scripts/integracao-importados-test-support.ts";
import { idSalaoFixture } from "../../scripts/guarda-salao-fixture-test-support.ts";
import { travarConfiguracaoAgenda } from "./trava-configuracao.ts";
import { lerRegraCapacidadeAgenda, listarFechamentosConfirmadosPorPeriodo } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { ocupacaoImpedeCandidato } from "../disponibilidade/services/availability.service.ts";

/** Guarda de escritores de salão (camada C): as escritas de salão desta suíte levam a marca da fixture. */
const ARQUIVO_FIXTURE = "lib/agenda/documental-ida-saloes.postgres.test.ts";

/**
 * Plano "liberar agenda com mais de um salão" (D-LIB-4, testes C'' da rev. 4–7) no PostgreSQL DESCARTÁVEL (modelo 114),
 * pelos serviços reais (emissão, assinatura Kidmais, aceite público, revisão inicial e operacional, integração de
 * importado). A "ida" (POR_HORARIO → POR_SALAO) é montada pela fixture (o save real da ida tem as baterias C/C'):
 * - C''4/7: V1 emitida antes da ida e assinada depois → festa nula, curinga em S1 e S2 (SQL × Core); RETRY reaproveita;
 * - C''4b: primeira assinatura de V3 com o salão ocupado → recusa; prova OTP não consumida, versão não marcada, sem vigência;
 * - C''3: revisão inicial V1 preparada antes da ida e assinada depois → festa nula, curinga;
 * - C''2: revisão inicial V3 com o salão indisponível → recusa; assinatura, prova e versão desfeitas;
 * - C''6/19: revisão operacional sobre base sem salão → o destino fica só na revisão; a festa recebe o salão na aplicação,
 *   visto por uma terceira conexão só depois do COMMIT;
 * - B (PG): bloco "Local" do convite pela versão vigente — unidade na V1, salão da V3 com o nome congelado (renomear não muda),
 *   nenhum bloco fora de "por salão";
 * - C''14: importação que ocupa a agenda, sem salão, com a ida entre a simulação e a confirmação → recusa sem nenhum DML;
 * - C''15: importação que não ocupa (festa passada, quitada) → com salão bloqueia; sem salão integra com salao_id nulo;
 * - controle da entrada 5: o aceite público grava na pré-assinatura com ACEITE_PUBLICO (conferido pela guarda dinâmica);
 * - C''20–22 (rodada 2): o script real de reconciliação (entrada 16) em processo filho contra `kidmais_019_<n>`: vigente sem
 *   salão → curinga; V3 → B1 com RECONCILIACAO_OPERACIONAL, e salão indisponível → recusa sem COMMIT; ASSINADA sem prova
 *   nativa → recusa antes do primeiro DML. Origem, ordem das travas e sequência vêm do registro do filho.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
type Nativo = Awaited<ReturnType<typeof catalogoNativo>>;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "c-linha-dupla" });
const TURNO = { inicio: "10:00", fim: "22:00" };

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}
const adm = () => carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
const operar = () => adm().operarContrato as unknown as Operar;

async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato C''", contratada: { nome: "Buffet C Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}
const salao = (c: Cenario, nome: string, ordem: number, capacidade: number | null) =>
  id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo, capacidade_convidados) VALUES ($1::uuid, $2, $3, true, $4) RETURNING id`, [c.empresa, nome, ordem, capacidade]);

/** A 114 exige a trava da configuração nos gatilhos: a fixture a toma como a entrada administrativa (os serviços também tomam). */
const travar = (c: Cenario) => travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "JA_TRAVADA" });

async function empresa(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  await travar(c);
  const nativo = await catalogoNativo(a, c);
  await modeloContrato(c);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`, [c.empresa, tipo, c.usuario]);
  return { c, nativo };
}
/** Ida montada pela fixture: a regra passa a POR_SALAO e a empresa ganha S1 e S2 (sem mexer nas festas). */
async function ida(c: Cenario) {
  await a.query(`UPDATE agenda_escopo_config SET capacidade_tipo = 'POR_SALAO' WHERE empresa_id = $1::uuid AND estabelecimento_id IS NULL`, [c.empresa]);
  return { s1: await salao(c, "S1", 1, 50), s2: await salao(c, "S2", 2, 80) };
}

/** Proposta nativa (10:00–22:00) e o contrato emitido + assinado pela Kidmais; ainda sem a assinatura do cliente. */
async function emitida(c: Cenario, nativo: Nativo, data: string, convidados = 30, forma: string | null = null) {
  const cpf = cpfValido();
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
      VALUES ('Cliente C', $1::uuid, $2, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`, [c.empresa, cpf, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante C') RETURNING id`, [cliente]);
  const festa = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status, forma_pagamento_pretendida)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', $7, $7, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO', $8
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, nativo.turno, c.empresa, c.pacote, cliente, aniversariante, convidados, forma]);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: festa } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  await congelarEAssinarKidmais(a, operar(), gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  return { festa, contrato: gerado.contrato.id, versao: gerado.versao.id, cpf, cliente };
}
type Emitida = Awaited<ReturnType<typeof emitida>>;

const schemaDe = async (versao: string) => (await a.query<{ n: number; salao: string | null }>(
  `SELECT (snapshot->>'schemaVersao')::int n, snapshot->'evento'->'salao'->>'id' salao FROM contrato_versoes WHERE id = $1::uuid`, [versao])).rows[0]!;
const festaDe = async (db: Client, f: string) => (await db.query<{ salao: string | null; ocupa: boolean; convidados: number }>(
  `SELECT salao_id::text salao, kidmais019_ocupa(id) ocupa, convidados FROM fechamentos WHERE id = $1::uuid`, [f])).rows[0]!;
/** O que uma recusa precisa ter desfeito: assinatura do cliente, consumo da prova OTP, status da versão e vigência. */
const rastroDaVersao = async (contrato: string, versao: string) => (await a.query<{ status: string; cliente: number; prova: number; vigente: string | null; contrato: string }>(
  `SELECT v.status, (SELECT count(*)::int FROM contrato_assinaturas s WHERE s.contrato_versao_id = v.id AND s.parte = 'CLIENTE') cliente,
          (SELECT count(*)::int FROM validacoes_identidade_cliente i WHERE i.consumido_por_contrato_versao_id = v.id) prova,
          (SELECT versao_vigente_id::text FROM contrato_fluxos WHERE contrato_id = $1::uuid) vigente,
          (SELECT status FROM contratos WHERE id = $1::uuid) contrato
     FROM contrato_versoes v WHERE v.id = $2::uuid`, [contrato, versao])).rows[0]!;

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

/** Outra festa CONFIRMADA no mesmo dia e horário da festa `base`, no salão `s`. */
async function ocupar(base: string, s: string) {
  const x = await idSalaoFixture(a, ARQUIVO_FIXTURE, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
    SELECT f.data_evento, f.horario_inicio, f.horario_fim, f.configuracao_agenda_id, f.empresa_id, f.pacote_id, f.tabela_preco_id, f.preco_pacote_id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
           'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $2::uuid FROM fechamentos f WHERE f.id = $1::uuid RETURNING fechamentos.id`, [base, s]);
  await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [x]);
  return x;
}

const min = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));
/** Candidato no salão `s` no mesmo intervalo: SQL (kidmais094_conflito_ocupacao) e Core precisam concordar. */
async function conflito(empresa: string, cfg: string, data: string, s: string) {
  const sql = (await a.query<{ x: boolean }>(`SELECT kidmais094_conflito_ocupacao($1::uuid, $2::date, $3::time, $4::time, $5::uuid, NULL, $6::uuid, $7::uuid) AS x`,
    [randomUUID(), data, TURNO.inicio, TURNO.fim, empresa, cfg, s])).rows[0]!.x;
  const tx = executor(a);
  const escopo = { empresaId: empresa, estabelecimentoId: null };
  const regra = await lerRegraCapacidadeAgenda(tx, escopo, { incluirCombinados: true });
  const ocupacoes = await listarFechamentosConfirmadosPorPeriodo(data, data, tx, escopo);
  const core = ocupacaoImpedeCandidato(regra, cfg, { inicioMinutos: min(TURNO.inicio), fimMinutos: min(TURNO.fim) }, ocupacoes, [s]);
  assert.equal(core, sql, `Core × SQL ${data} salão ${s} (Core ${core}, SQL ${sql})`);
  return sql;
}

/** Revisão inicial (antes da 1ª assinatura do cliente): nova versão em preparação com `convidados`. */
async function revisaoInicial(c: Cenario, nativo: Nativo, e: Emitida, data: string, convidados: number) {
  const op = operar();
  const nova = await op(e.versao, { acao: "substituir_preparacao", motivo: "Mais convidados", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa) as { versaoId: string };
  const v2 = nova.versaoId;
  const edicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0]!.revisao;
  const fonte = await adm().fontesEdicao(e.festa, executor(a));
  await op(v2, { acao: "editar_festa", revisao: await edicao(), motivo: "Mais convidados", fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados,
    dataEvento: data, configuracaoAgendaId: nativo.turno, horarioInicio: TURNO.inicio, horarioFim: TURNO.fim, adicionais: fonte.adicionais, idadeAniversarianteEvento: 6, temaFesta: "Circo",
    buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: "C''" }, c.token, ctxOp(), c.empresa);
  await congelarEAssinarKidmais(a, op, v2, c.empresa, c.token, nativo.tokenRepresentante);
  return v2;
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("C''4/7: V1 emitida antes da ida e assinada depois → festa nula e curinga em S1 e S2; RETRY reaproveita sem gravar salão", { timeout: 300_000 }, async () => {
  const D = dia(150);
  const r = await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const e = await emitida(c, nativo, D);
    assert.notEqual((await schemaDe(e.versao)).n, 3, "emitida em POR_HORARIO: sem V3");
    const { s1, s2 } = await ida(c);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.deepEqual(await festaDe(a, e.festa), { salao: null, ocupa: true, convidados: 30 }, "assinada depois da ida: nula, ocupando");
    assert.equal(await conflito(c.empresa, nativo.turno, D, s1), true, "curinga ocupa S1");
    assert.equal(await conflito(c.empresa, nativo.turno, D, s2), true, "curinga ocupa S2");
    const { garantirFestaFormalizada } = carregar<typeof import("../festas/formalizacao.ts")>("lib/festas/formalizacao.ts");
    const vigente = (await rastroDaVersao(e.contrato, e.versao)).vigente!;
    await travar(c);
    assert.equal((await garantirFestaFormalizada(executor(a), e.contrato, vigente, {}, "RETRY")).reutilizado, true);
    assert.equal((await festaDe(a, e.festa)).salao, null, "RETRY não escolhe salão");
    return { c, e, s1 };
  });
  const obs = await conectarDescartavel({ travar: false });
  try {
    assert.deepEqual(await festaDe(obs, r.e.festa), { salao: null, ocupa: true, convidados: 30 }, "terceira conexão depois do COMMIT");
  } finally { await encerrarDescartavel(obs, false); }
});

test("C''4b: primeira assinatura de V3 com o salão ocupado → recusa; prova OTP não consumida, versão não marcada, sem vigência", { timeout: 300_000 }, async () => {
  const D = dia(151);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 50);
    await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, D);
    assert.deepEqual(await schemaDe(e.versao), { n: 3, salao: s1 });
    const antes = await rastroDaVersao(e.contrato, e.versao);
    await ocupar(e.festa, s1);
    await recusa(assinarComoCliente(e.contrato, e.cpf), /salão deste contrato não está mais disponível/);
    assert.deepEqual(await rastroDaVersao(e.contrato, e.versao), { ...antes, cliente: 0, prova: 0, vigente: null }, "nada da assinatura ficou");
    assert.deepEqual(await festaDe(a, e.festa), { salao: null, ocupa: false, convidados: 30 }, "sem salão substituto (S2 livre)");
  }, "ROLLBACK");
});

test("C''3: revisão inicial V1 preparada antes da ida e assinada depois → festa nula com os convidados novos, curinga", { timeout: 300_000 }, async () => {
  const D = dia(152);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const e = await emitida(c, nativo, D);
    const v2 = await revisaoInicial(c, nativo, e, D, 45);
    assert.notEqual((await schemaDe(v2)).n, 3, "preparada em POR_HORARIO: sem V3");
    const { s1, s2 } = await ida(c);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    assert.equal((await rastroDaVersao(e.contrato, v2)).vigente, v2);
    assert.deepEqual(await festaDe(a, e.festa), { salao: null, ocupa: true, convidados: 45 }, "aplicada, nula, ocupando");
    assert.equal(await conflito(c.empresa, nativo.turno, D, s1), true);
    assert.equal(await conflito(c.empresa, nativo.turno, D, s2), true, "outra festa em OUTRO salão no mesmo intervalo continua bloqueada");
  });
});

test("C''2: revisão inicial V3 com o salão indisponível → recusa; assinatura, prova e versão desfeitas; a festa não muda", { timeout: 300_000 }, async () => {
  const D = dia(153);
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_SALAO");
    const s1 = await salao(c, "S1", 1, 35), s2 = await salao(c, "S2", 2, 80);
    const e = await emitida(c, nativo, D);
    assert.equal((await schemaDe(e.versao)).salao, s1);
    const v2 = await revisaoInicial(c, nativo, e, D, 45);
    assert.deepEqual(await schemaDe(v2), { n: 3, salao: s2 }, "S1 (35) não comporta 45: a proposta fixa S2");
    const antes = await rastroDaVersao(e.contrato, v2);
    await ocupar(e.festa, s2);
    await recusa(assinarComoCliente(e.contrato, e.cpf), /salão deste contrato não está mais disponível/);
    assert.deepEqual(await rastroDaVersao(e.contrato, v2), { ...antes, cliente: 0, prova: 0, vigente: null }, "nada da assinatura ficou");
    assert.deepEqual(await festaDe(a, e.festa), { salao: null, ocupa: false, convidados: 30 }, "revisão não aplicada");
  }, "ROLLBACK");
});

test("C''6/19 + B: revisão operacional sobre base sem salão → destino só na revisão; a festa recebe o salão na aplicação, visível só depois do COMMIT; bloco do convite segue a versão", { timeout: 300_000 }, async () => {
  const D = dia(154);
  const prep = await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const e = await emitida(c, nativo, D);
    await assinarComoCliente(e.contrato, e.cpf);
    await validarAgora(a);
    const { s1, s2 } = await ida(c);
    assert.equal((await festaDe(a, e.festa)).salao, null);
    return { c, nativo, e, s1, s2 };
  });
  const { c, nativo, e, s1, s2 } = prep;
  const obs = await conectarDescartavel({ travar: false });
  try {
    await comCommit(async () => {
      await travar(c);
      const op = operar();
      const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
      await op(e.versao, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "C''6", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
      const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [e.contrato])).rows[0]!.id;
      const edicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0]!.revisao;
      const fonte = (await rs.fontesPreparacao(v2, executor(a)))!;
      await op(v2, { acao: "editar_festa", revisao: await edicao(), motivo: "C''6", fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 60,
        dataEvento: D, configuracaoAgendaId: nativo.turno, horarioInicio: TURNO.inicio, horarioFim: TURNO.fim, adicionais: fonte.adicionais, idadeAniversarianteEvento: 6, temaFesta: "Circo",
        buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: "C''6" }, c.token, ctxOp(), c.empresa);
      const revisao = (await a.query<{ salao: string | null; estado: string }>(`SELECT salao_id::text salao, estado FROM fechamento_revisoes WHERE contrato_versao_id = $1`, [v2])).rows[0]!;
      assert.equal(revisao.salao, s2, "S1 (50) não comporta 60: o destino da revisão é S2");
      assert.deepEqual(await schemaDe(v2), { n: 3, salao: s2 }, "o documento da revisão identifica o salão");
      assert.equal((await festaDe(a, e.festa)).salao, null, "C''19: a preparação grava só na revisão");
      await congelarEAssinarKidmais(a, op, v2, c.empresa, c.token, nativo.tokenRepresentante);
      await assinarComoCliente(e.contrato, e.cpf);
      await validarAgora(a);
      assert.equal((await festaDe(a, e.festa)).salao, s2, "aplicação copiou o destino na mesma transação");
      assert.equal((await festaDe(obs, e.festa)).salao, null, "terceira conexão antes do COMMIT: ainda nula");
    });
    assert.deepEqual(await festaDe(obs, e.festa), { salao: s2, ocupa: true, convidados: 60 }, "terceira conexão depois do COMMIT");
    assert.ok(s1);
    // Bateria B (PG): bloco "Local" do convite pela versão vigente lida do banco (a que o serviço usa e grava ao publicar).
    const { blocoLocalDaFesta } = carregar<typeof import("../convites/bloco-local.ts")>("lib/convites/bloco-local.ts");
    const { contrato } = carregar<typeof import("../festas/repository.ts")>("lib/festas/repository.ts");
    const bloco = async (versao?: string) => {
      const co = await contrato(executor(a), e.contrato);
      const snapshot = versao ? (await a.query<{ s: unknown }>(`SELECT snapshot s FROM contrato_versoes WHERE id = $1::uuid`, [versao])).rows[0]!.s : co.snapshot;
      return blocoLocalDaFesta(executor(a), { empresaId: c.empresa, estabelecimentoId: null, snapshot });
    };
    assert.equal((await bloco())?.origem, "SALAO");
    assert.deepEqual(await bloco(), { origem: "SALAO", nome: "Salão S2", endereco: "" }, "vigente V3: o salão do documento, com o rótulo do convite (rotuloSalao)");
    assert.equal((await bloco(e.versao))?.origem, "UNIDADE", "versão antiga (V1, sem salão) em \"por salão\": a unidade, nunca o salão operacional");
    await comCommit(async () => {
      await a.query(`UPDATE agenda_saloes SET nome = 'S2 renomeado' WHERE id = $1::uuid`, [s2]);
      assert.deepEqual(await bloco(), { origem: "SALAO", nome: "Salão S2", endereco: "" }, "nome congelado no documento, não o cadastro atual");
      const vigente = (await rastroDaVersao(e.contrato, e.versao)).vigente!;
      assert.equal((await a.query<{ n: string }>(`SELECT snapshot->'evento'->'salao'->>'nome' n FROM contrato_versoes WHERE id = $1::uuid`, [vigente])).rows[0]!.n, "S2",
        "A: o documento vigente continua com o nome da emissão");
    }, "ROLLBACK");
    await comCommit(async () => {
      await a.query(`UPDATE agenda_escopo_config SET capacidade_tipo = 'POR_HORARIO' WHERE empresa_id = $1::uuid`, [c.empresa]);
      assert.equal(await bloco(), null, "fora de \"por salão\" não há bloco (o convite segue como hoje)");
    }, "ROLLBACK");
  } finally { await encerrarDescartavel(obs, false); }
});

const servico = () => carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
const coreImportado = () => carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts").coreNativo;
/** Executor que registra cada comando (a sequência prova "recusa antes do primeiro DML"). */
function registrando(): { tx: DbExecutor; comandos: string[] } {
  const comandos: string[] = [];
  const base = executor(a);
  return { comandos, tx: { query: (sql: string, v?: readonly unknown[]) => { comandos.push(sql.replace(/\s+/g, " ").trim()); return base.query(sql, v as unknown[]); } } as DbExecutor };
}
const DML = /^(WITH\b[\s\S]*?\)\s*)?(INSERT|UPDATE|DELETE|MERGE)\b/i;
const contagens = async (c: Cenario) => (await a.query<{ f: number; k: number; cl: string }>(
  `SELECT (SELECT count(*)::int FROM fechamentos WHERE empresa_id = $1::uuid) f,
          (SELECT count(*)::int FROM contratos k JOIN fechamentos x ON x.id = k.fechamento_id WHERE x.empresa_id = $1::uuid) k,
          (SELECT md5(string_agg(to_jsonb(cl)::text, '|' ORDER BY cl.id)) FROM clientes cl WHERE cl.empresa_id = $1::uuid) cl`, [c.empresa])).rows[0]!;

test("C''14: importação que ocupa a agenda, sem salão, com a ida entre a simulação e a confirmação → recusa antes de qualquer DML", { timeout: 300_000 }, async () => {
  await comCommit(async () => {
    const c = await cenario(a, 0);
    await travar(c);
    await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                   VALUES ($1::uuid, 'FIXO', 'POR_HORARIO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
    const ev = { data: dia(155), inicio: "14:00", fim: "18:00" };
    const imp = await importacao(a, c, ev);
    const d = decisoes(c, ev, PARCIAL());
    const s = servico();
    const sim = await s.simularIntegracao(executor(a), c.tenant as never, imp.id, d, dia(0));
    assert.ok(!sim.integrada && sim.pronto, `em POR_HORARIO a simulação fica pronta: ${JSON.stringify(sim)}`);
    await ida(c);
    // Depois da ida, a própria simulação já pede o salão (é o bloqueio que a confirmação repete).
    const depois = await s.simularIntegracao(executor(a), c.tenant as never, imp.id, d, dia(0));
    assert.ok(!depois.pronto && depois.bloqueios?.includes("Escolha o salão da festa."), JSON.stringify(depois.bloqueios));
    const antes = await contagens(c);
    const { tx, comandos } = registrando();
    let erro: unknown;
    try {
      await s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), imp.id, { decisoes: d, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), coreImportado());
    } catch (e) { erro = e; }
    const codigo = (erro as { code?: string; codigo?: string })?.code ?? (erro as { codigo?: string })?.codigo;
    // Recusa pelo bloqueio da avaliação (servico.ts:455). SALAO_EXIGIDO_NA_IMPORTACAO (:493) fica como segunda barreira, também antes de DML.
    assert.equal(codigo, "INTEGRACAO_BLOQUEADA", `recusa: ${codigo} ${erro instanceof Error ? erro.message : String(erro)}`);
    assert.equal(erro instanceof Error ? erro.message : "", "Escolha o salão da festa.");
    assert.deepEqual(comandos.filter((q) => DML.test(q)), [], "nenhum INSERT/UPDATE/DELETE antes da recusa");
    assert.deepEqual(await contagens(c), antes, "nada persistiu (festas, contratos, clientes)");
  }, "ROLLBACK");
});

test("C''15: importação que não ocupa (festa passada, quitada) em POR_SALAO → com salão bloqueia; sem salão integra com salao_id nulo", { timeout: 300_000 }, async () => {
  await comCommit(async () => {
    const c = await cenario(a, 0);
    await travar(c);
    await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                   VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
    const A = await salao(c, "Salão A", 1, null);
    const ev = { data: dia(-200), inicio: "14:00", fim: "18:00" };
    // Quitada antes da festa: a parcela a vencer do PARCIAL() bloquearia a importação de festa passada por outro motivo.
    const PAGO = () => ({ situacao: "PAGO", parcelas: [{ valorCentavos: 500000, vencimento: dia(-210), recebimento: { data: dia(-209), forma: "DINHEIRO" } }] });
    const s = servico();
    const comSalao = await importacao(a, c, ev);
    const sim = await s.simularIntegracao(executor(a), c.tenant as never, comSalao.id, decisoes(c, ev, PAGO(), null, undefined, A), dia(0));
    assert.ok(!sim.integrada && sim.bloqueios.includes("Festa passada não ocupa salão: deixe o salão em branco."), JSON.stringify(sim));
    const semSalao = await importacao(a, c, ev);
    const r = await integrar(s, coreImportado(), a, c, semSalao.id, decisoes(c, ev, PAGO()));
    await validarAgora(a);
    // "Não ocupa" como em integracao.postgres.test.ts: a reserva continua vigente, mas fica no Histórico e fora da agenda operacional.
    const f = (await a.query<{ salao: string | null; historico: boolean; na_agenda: boolean }>(
      `SELECT f.salao_id::text salao, kidmais061_historico_passado(f.id) historico,
              EXISTS (SELECT 1 FROM kidmais_ocupacoes_operacionais(f.data_evento, f.data_evento) o WHERE o.fechamento_id = f.id) na_agenda
         FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1::uuid`, [r.contratoId])).rows[0]!;
    assert.deepEqual(f, { salao: null, historico: true, na_agenda: false }, "não ocupante: nada em salao_id, no Histórico, fora da agenda");
  }, "ROLLBACK");
});

/** Escritas de salão em fechamentos vistas pela guarda dinâmica (preload) desde `desde`: "escritor:caminho:origem" de cada uma. */
type GuardaSalao = { eventos: Array<{ tipo?: string; tabela?: string; marca?: string }> };
const escritasDesde = (g: GuardaSalao, desde: number) =>
  g.eventos.slice(desde).filter((e) => e.tipo === "ESCRITA" && e.tabela === "fechamentos").map((e) => String(e.marca).split(":").slice(0, 3).join(":"));

test("controle da entrada 5: o aceite público grava o salão da V3 na pré-assinatura, com a origem ACEITE_PUBLICO", { timeout: 300_000 }, async () => {
  // Expectativa independente (P2-2 da rev. 6): o cenário sabe qual entrada chamou e confere a marca que a guarda observou.
  const g = (globalThis as { __kidmaisGuardaSalao?: GuardaSalao }).__kidmaisGuardaSalao;
  assert.ok(g, "preload da guarda dinâmica ausente: o cenário não pode conferir a origem");
  await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    await ida(c);
    // V3 emitida depois da ida e assinada pelo aceite público. O salão é gravado na pré-assinatura
    // (contrato-publico.service.ts:565); a criação da festa depois o encontra gravado e não escreve de novo.
    const aceite = await emitida(c, nativo, dia(160));
    const salaoAceite = (await schemaDe(aceite.versao)).salao;
    assert.ok(salaoAceite, "emitida depois da ida: V3 com salão");
    const i0 = g.eventos.length;
    await assinarComoCliente(aceite.contrato, aceite.cpf);
    assert.deepEqual(escritasDesde(g, i0), ["B1:FORMALIZACAO_PRE_ASSINATURA:ACEITE_PUBLICO"]);
    assert.equal((await festaDe(a, aceite.festa)).salao, salaoAceite);
  }, "ROLLBACK");
});

test("P1 (rodada 2): criação administrativa do pagamento no modelo 114, em transação nova sem trava herdada → cria; configuração antes de fechamento/contrato/versão", { timeout: 300_000 }, async () => {
  const prep = await comCommit(async () => {
    const { c, nativo } = await empresa("POR_HORARIO");
    const e = await emitida(c, nativo, dia(170), 30, "PIX_AVISTA");
    await assinarComoCliente(e.contrato, e.cpf);
    return { c, e };
  });
  const pag = carregar<typeof import("../pagamentos/services/pagamento.service.ts")>("lib/pagamentos/services/pagamento.service.ts");
  await a.query("BEGIN");
  try {
    // Como a rota (executarComPosseNoTenant): a linha da empresa sob FOR UPDATE do tenant e NENHUMA trava da configuração.
    await a.query(`SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE`, [prep.c.empresa]);
    const { tx, comandos } = registrando();
    const vigente = (await a.query<{ t: string; forma: string | null }>(`SELECT v.snapshot->'comercial'->>'valorFinalContrato' t,
      coalesce(v.snapshot->'comercial'->'condicaoPagamento'->>'forma', v.snapshot->'comercial'->>'formaPagamentoPretendida') forma
      FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id = cf.versao_vigente_id WHERE cf.contrato_id = $1`, [prep.e.contrato])).rows[0]!;
    const total = Number(vigente.t);
    // A condição da versão vigente decide meio/modalidade (à vista; o parcelado Pix exige o fluxo de sugestão, fora desta prova).
    const meio = ({ PIX_AVISTA: "PIX", CARTAO_CIELO: "CARTAO" } as Record<string, string>)[vigente.forma ?? ""];
    assert.ok(meio, `condição da vigente fora desta prova: ${vigente.forma}`);
    const contexto = { token: prep.c.token, usuarioId: prep.c.usuario, origem: "ADMIN_FINANCEIRO", requestId: randomUUID(), ip: null, userAgent: "p1-r2", executor: tx };
    const criado = await pag.criarPagamentoDoFechamento({ fechamentoId: prep.e.festa, plano: { meioPagamento: meio, modalidade: "AVISTA", parcelas: [{ valor: total, vencimento: dia(1), confirmaReserva: true }] } } as never, contexto as never) as { detalhe: { pagamento: { id: string } } };
    await validarAgora(a);
    assert.ok(criado.detalhe.pagamento.id, "pagamento criado (antes da correção: KD114 no UPDATE do fechamento)");
    const status = (await a.query<{ s: string }>(`SELECT status s FROM fechamentos WHERE id = $1::uuid`, [prep.e.festa])).rows[0]!.s;
    assert.equal(status, "AGUARDANDO_PAGAMENTO");
    const config = comandos.findIndex((q) => /pg_advisory_xact_lock_shared\(hashtextextended\('kidmais:agenda-config:/.test(q));
    const linha = comandos.findIndex((q) => /\b(fechamentos|contratos|contrato_versoes|contrato_fluxos|pagamentos)\b[\s\S]*\bFOR (NO KEY )?UPDATE\b|^(INSERT|UPDATE)\b/i.test(q));
    assert.ok(config >= 0 && config < linha, `configuração (${config}) antes da primeira trava/escrita de linha (${linha}): ${comandos[linha]}`);
  } finally { await a.query("ROLLBACK"); }
});

// ---------- C''20–22: o script real (scripts/festa-019-reconciliar.mjs, entrada 16) em processo filho ----------
// Rodada 2 (P2 do Astra): o filho roda contra um banco `kidmais_019_<n>` criado no próprio cluster descartável a partir do
// modelo 114 (com a guarda instalada), com o preload e o registro em arquivo. O legado é preparado e COMITADO nesse banco
// pelos serviços reais (só a pré-assinatura da agenda e a criação da festa são suprimidas na assinatura do legado); o filho
// enxerga esse estado e a entrada exercitada é a operacional. Registro ausente ou ilegível reprova.
const raizRepo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigirCjs = createRequire(import.meta.url);
const guardaHarness = exigirCjs("../../scripts/guarda-salao-harness.cjs") as { instalar(c: Client): Promise<void> };
const MODELO_114 = "kidmais_v1_modelo_114";

async function comBanco019<T>(corpo: (nome: string) => Promise<T>) {
  assert.equal((await a.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [MODELO_114])).rowCount, 1, "modelo 114 ausente no cluster");
  const nome = `kidmais_019_${process.pid}${Date.now() % 100_000}`;
  // A cópia do modelo pode passar dos 30 s do statement_timeout da conexão sob carga: sem prazo só nela e no DROP.
  await a.query("SET statement_timeout = 0");
  try { await a.query(`CREATE DATABASE ${nome} TEMPLATE ${MODELO_114}`); } finally { await a.query("SET statement_timeout = '30s'"); }
  const original = a;
  let copia: Client | null = null;
  try {
    copia = await conectarDescartavel({ database: nome, travar: false });
    await guardaHarness.instalar(copia);
    a = copia;
    return await corpo(nome);
  } finally {
    a = original;
    if (copia) await encerrarDescartavel(copia, false);
    await a.query("SET statement_timeout = 0");
    try { await a.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`); } finally { await a.query("SET statement_timeout = '30s'"); }
  }
}

/** Contrato legado: V emitida e assinada pelo cliente SEM a pré-assinatura da agenda e sem criar a festa (antes da 019). */
async function legadoSemFesta(c: Cenario, nativo: Nativo, data: string) {
  const e = await emitida(c, nativo, data);
  type Formalizacao = typeof import("../festas/formalizacao.ts");
  const formalizacao = carregar<Formalizacao>("lib/festas/formalizacao.ts") as Pick<Formalizacao, "garantirFestaFormalizada" | "bloquearAgendaFormalizacao">;
  const garantir = formalizacao.garantirFestaFormalizada;
  const bloquear = formalizacao.bloquearAgendaFormalizacao;
  formalizacao.garantirFestaFormalizada = (async () => ({ festaId: "", reutilizado: false })) as typeof garantir;
  formalizacao.bloquearAgendaFormalizacao = (async () => undefined) as typeof bloquear;
  try {
    await comoLegado(() => assinarComoCliente(e.contrato, e.cpf));
  } finally {
    formalizacao.garantirFestaFormalizada = garantir;
    formalizacao.bloquearAgendaFormalizacao = bloquear;
  }
  assert.equal(await festasDoContrato(e.contrato), 0, "legado: assinado sem festa");
  assert.equal((await rastroDaVersao(e.contrato, e.versao)).vigente, e.versao, "legado: versão vigente");
  return e;
}
/**
 * Preparação de legado (antes da 019) SÓ na cópia kidmais_019_<n>. A assinatura legada (e, na C''22, a remoção da assinatura
 * do cliente) roda com `session_replication_role = replica` local à transação: os gatilhos diferidos da 019 (que recusariam
 * no COMMIT um contrato assinado sem festa) e os de usuário não enfileiram eventos, e o catálogo continua intacto (gatilhos
 * habilitados, o que `validarAmbienteFesta` confere). Volta a `origin` logo depois; o script sob teste roda em outro
 * processo, com os gatilhos normais.
 */
async function preparacaoLegada<T>(corpo: () => Promise<T>) {
  assert.match(String((await a.query<{ db: string }>("SELECT current_database() db")).rows[0]!.db), /^kidmais_019_\d+$/, "só na cópia descartável");
  const r = await corpo();
  assert.equal((await a.query<{ p: string }>("SELECT current_setting('session_replication_role') p")).rows[0]!.p, "origin", "replica não vazou da preparação");
  return r;
}
async function comoLegado<T>(corpo: () => Promise<T>) {
  assert.match(String((await a.query<{ db: string }>("SELECT current_database() db")).rows[0]!.db), /^kidmais_019_\d+$/, "só na cópia descartável");
  // Os eventos já enfileirados (emissão, assinatura da Kidmais) são conferidos AGORA, no estado ainda válido; o que a
  // preparação legada faz depois não enfileira nada.
  const da019 = "festa019_contrato, festa019_fluxo, festa019_fechamento, festa019_festa";
  await a.query(`SET CONSTRAINTS ${da019} IMMEDIATE`);
  await a.query("SET LOCAL session_replication_role = replica");
  try { return await corpo(); } finally {
    await a.query("SET LOCAL session_replication_role = origin");
    await a.query(`SET CONSTRAINTS ${da019} DEFERRED`);
  }
}
const festasDoContrato = async (contrato: string) => (await a.query<{ n: number }>(`SELECT count(*)::int n FROM festas WHERE contrato_id = $1::uuid`, [contrato])).rows[0]!.n;

type EventoFilho = { tipo?: string; tabela?: string; marca?: string; desfecho?: string; todos?: string[]; producao?: boolean; motivo?: string };
/** Roda o script real no filho e devolve o registro do preload do filho (lido depois que ele termina). */
function reconciliar(nome: string, contrato: string) {
  const pasta = mkdtempSync(join(tmpdir(), "kidmais-c20-"));
  const arquivo = join(pasta, "filho.jsonl");
  const preload = resolve(raizRepo, "scripts/guarda-salao-preload.cjs").replace(/\\/g, "/");
  try {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/festa-019-reconciliar.mjs", "--database", nome, "--apply", "--authorize-write", "--contrato", contrato], {
      cwd: raizRepo, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, FESTA_ENABLED: "true", FESTA_019_RECONCILIACAO_URL: `postgresql://kidmais_descartavel@127.0.0.1:${portaDescartavel()}/${nome}`,
        NODE_OPTIONS: `--require "${preload}"`, KIDMAIS_GUARDA_SALAO_ARQUIVO: arquivo, KIDMAIS_REGISTRO_TRANSACOES_ARQUIVO: "1" },
    });
    assert.ok(existsSync(arquivo), `registro do filho ausente (status ${r.status}): ${String(r.stderr).slice(-400)}`);
    const eventos = readFileSync(arquivo, "utf8").trim().split("\n").map((l) => JSON.parse(l) as EventoFilho);
    assert.ok(eventos.some((e) => e.tipo === "PRELOAD"), "o preload não carregou no filho");
    assert.deepEqual(eventos.filter((e) => e.tipo === "KD901" || (e.tipo === "ORDEM" && e.producao)), [], "nenhuma violação da guarda no filho");
    const json = (texto: string) => { const l = texto.trim().split("\n").filter((x) => x.startsWith("{")).at(-1); return l ? JSON.parse(l) as Record<string, unknown> : null; };
    const transacoes = eventos.filter((e) => e.tipo === "TRANSACAO");
    assert.equal(transacoes.length, 1, "o script usa uma transação");
    return {
      status: r.status, aprovado: json(r.stdout), recusado: json(r.stderr), transacao: transacoes[0]!,
      escritas: eventos.filter((e) => e.tipo === "ESCRITA" && e.tabela === "fechamentos").map((e) => String(e.marca).split(":").slice(0, 3).join(":")),
    };
  } finally { rmSync(pasta, { recursive: true, force: true }); }
}
type Filho = ReturnType<typeof reconciliar>;
const DML_TODOS = /^(WITH\b[\s\S]*?\)\s*)?(INSERT|UPDATE|DELETE|MERGE)\b/i;
/** Protocolo da rev. 3 no filho: empresa (KEY SHARE) → configuração COMPARTILHADA → fechamento → contrato → fluxo. */
function conferirOrdemDoScript(f: Filho) {
  const todos = f.transacao.todos ?? [];
  const pos = (re: RegExp) => todos.findIndex((q) => re.test(q));
  const empresa = pos(/FROM empresas WHERE id = \$1::uuid FOR KEY SHARE/i);
  const config = pos(/pg_advisory_xact_lock/i);
  const fechamento = pos(/FROM fechamentos WHERE id=\$1 FOR UPDATE/i);
  const contrato = pos(/FROM contratos WHERE id=\$1 FOR UPDATE/i);
  const fluxo = pos(/FROM contrato_fluxos WHERE contrato_id=\$1 FOR UPDATE/i);
  assert.ok(empresa >= 0 && empresa < config && config < fechamento && fechamento < contrato && contrato < fluxo, `ordem do script: ${JSON.stringify({ empresa, config, fechamento, contrato, fluxo })}`);
  assert.match(todos[config]!, /pg_advisory_xact_lock_shared\(/, "configuração COMPARTILHADA (não exclusiva)");
  const primeiraDml = todos.findIndex((q) => DML_TODOS.test(q));
  if (primeiraDml >= 0) assert.ok(config < primeiraDml, "configuração antes do primeiro DML");
}

test("C''20: script real, vigente sem salão → festa com salao_id nulo (curinga), nenhuma escrita de salão; protocolo empresa → configuração → linhas", { timeout: 300_000 }, async () => {
  await comBanco019(async (nome) => {
    const prep = await preparacaoLegada(() => comCommit(async () => {
      const { c, nativo } = await empresa("POR_HORARIO");
      const e = await legadoSemFesta(c, nativo, dia(161));
      assert.notEqual((await schemaDe(e.versao)).n, 3, "vigente sem salão (emitida antes da ida)");
      const saloes = await ida(c);
      return { c, nativo, e, ...saloes };
    }));
    const f = reconciliar(nome, prep.e.contrato);
    assert.equal(f.status, 0, JSON.stringify(f.recusado));
    assert.equal(f.aprovado?.status, "APROVADO");
    assert.equal(f.transacao.desfecho, "COMMIT");
    conferirOrdemDoScript(f);
    assert.deepEqual(f.escritas, [], "sem salão: nem B1 nem B2");
    assert.equal(await festasDoContrato(prep.e.contrato), 1);
    assert.deepEqual(await festaDe(a, prep.e.festa), { salao: null, ocupa: true, convidados: 30 }, "curinga");
    assert.equal(await conflito(prep.c.empresa, prep.nativo.turno, dia(161), prep.s1), true, "curinga ocupa S1");
    assert.equal(await conflito(prep.c.empresa, prep.nativo.turno, dia(161), prep.s2), true, "curinga ocupa S2");
  });
});

test("C''21: script real, vigente V3 → B1 estrito com RECONCILIACAO_OPERACIONAL; salão indisponível → recusa sem COMMIT e sem festa", { timeout: 300_000 }, async () => {
  await comBanco019(async (nome) => {
    const prep = await preparacaoLegada(() => comCommit(async () => {
      const { c, nativo } = await empresa("POR_HORARIO");
      await ida(c);
      const livre = await legadoSemFesta(c, nativo, dia(162));
      const ocupado = await legadoSemFesta(c, nativo, dia(163));
      const salaoLivre = (await schemaDe(livre.versao)).salao;
      const salaoOcupado = (await schemaDe(ocupado.versao)).salao;
      assert.ok(salaoLivre && salaoOcupado, "V3 com salão");
      return { c, livre, ocupado, salaoLivre, salaoOcupado };
    }));
    // Ocupante do salão da V3 só na cópia descartável e em transação própria, sem disparar gatilhos (replica local): a revisão
    // inicial do legado ainda reserva esse salão, e o gatilho da agenda recusaria a festa concorrente. O script roda com os
    // gatilhos normais e enxerga o salão ocupado.
    await comCommit(() => comoLegado(() => ocupar(prep.ocupado.festa, prep.salaoOcupado!)));
    const ok = reconciliar(nome, prep.livre.contrato);
    assert.equal(ok.status, 0, JSON.stringify(ok.recusado));
    assert.equal(ok.transacao.desfecho, "COMMIT");
    conferirOrdemDoScript(ok);
    // Expectativa do cenário (entrada 16), não do helper: a mesma marca com ACEITE_PUBLICO reprovaria aqui.
    assert.deepEqual(ok.escritas, ["B1:FORMALIZACAO_POS_ASSINATURA:RECONCILIACAO_OPERACIONAL"]);
    assert.equal((await festaDe(a, prep.livre.festa)).salao, prep.salaoLivre, "salão estrito da V3 vigente");
    assert.equal(await festasDoContrato(prep.livre.contrato), 1);

    const nao = reconciliar(nome, prep.ocupado.contrato);
    assert.equal(nao.status, 1);
    assert.equal(nao.recusado?.status, "RECUSADO");
    assert.notEqual(nao.transacao.desfecho, "COMMIT", "recusa sem COMMIT");
    conferirOrdemDoScript(nao);
    assert.equal(await festasDoContrato(prep.ocupado.contrato), 0, "sem festa");
    assert.equal((await festaDe(a, prep.ocupado.festa)).salao, null, "sem salão substituto");
  });
});

test("C''22: script real, ASSINADA sem prova nativa (sem a assinatura do cliente) → recusa antes do primeiro DML, sem festa", { timeout: 300_000 }, async () => {
  await comBanco019(async (nome) => {
    const prep = await preparacaoLegada(() => comCommit(async () => {
      const { c, nativo } = await empresa("POR_HORARIO");
      await ida(c);
      return { e: await legadoSemFesta(c, nativo, dia(164)) };
    }));
    // Estado inconsistente reproduzido SÓ nesta cópia descartável, em transação própria (sem eventos diferidos da emissão): a
    // assinatura do cliente sai sem disparar gatilhos (replica local; o script sob teste nunca desliga gatilho).
    await comCommit(() => comoLegado(() => a.query(`DELETE FROM contrato_assinaturas WHERE contrato_versao_id = $1::uuid AND parte = 'CLIENTE'`, [prep.e.versao])));
    assert.equal((await rastroDaVersao(prep.e.contrato, prep.e.versao)).status, "ASSINADA");
    assert.equal((await rastroDaVersao(prep.e.contrato, prep.e.versao)).cliente, 0, "sem a assinatura do cliente");
    const f = reconciliar(nome, prep.e.contrato);
    assert.equal(f.status, 1, JSON.stringify(f.aprovado));
    assert.equal(f.recusado?.status, "RECUSADO");
    assert.notEqual(f.transacao.desfecho, "COMMIT");
    conferirOrdemDoScript(f);
    assert.deepEqual((f.transacao.todos ?? []).filter((q) => DML_TODOS.test(q)), [], "nenhum INSERT/UPDATE/DELETE antes da recusa");
    assert.deepEqual(f.escritas, []);
    assert.equal(await festasDoContrato(prep.e.contrato), 0);
  });
});
