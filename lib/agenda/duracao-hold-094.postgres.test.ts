import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import { carregar, cenario, decisoes, dia, id, importacao, integrar, type Cenario, type Evento, type Servico, comSalaoEscolhido } from "../../scripts/integracao-importados-test-support.ts";
import { consultarDisponibilidadeData, duracaoDoPacoteDaEmpresa, revalidarHorarioSelecionado } from "../disponibilidade/services/availability.service.ts";

/**
 * Gate antes de staging (conferência do delta 7, 22/10/2026), no PostgreSQL DESCARTÁVEL com o inventário até a 094:
 * - rollback da 094 de verdade (estado limpo) e reaplicação; recusas adversariais (sobreposição, salão só na revisão);
 * - consultas reais de duração do pacote (helper, pacote mais curto, revalidação no horário livre, duração inválida);
 * - hold real da remarcação sob a regra da 094 (capacidade por horário; a própria festa não conta duas vezes);
 * - concorrência real: duas conexões confirmando o mesmo horário ao mesmo tempo.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
let a: Client;
let tx: DbExecutor;
const D = dia(60);
type Revisao = typeof import("../fechamentos/repositories/revisao.repository.ts");

const executor = (db: Client): DbExecutor => ({
  async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await db.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; },
});

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

async function horario(c: Cenario, codigo: string, inicio: string, fim: string, capacidade = 1, livre = false) {
  return id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade, horario_livre) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, $5, $6) RETURNING id`, [codigo, inicio, fim, c.empresa, capacidade, livre]);
}

async function configurar(c: Cenario, modo: "FIXO" | "LIVRE", tipo: "POR_HORARIO" | "POR_SALAO" = "POR_HORARIO") {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, $2, $3, NULL, 0, $4::uuid)`, [c.empresa, modo, tipo, c.usuario]);
}

/** Festa gravada e confirmada numa transação (na conexão indicada): os gatilhos conferem a agenda. */
async function confirmada(db: Client, c: Cenario, cfg: string, inicio: string, fim: string, data = D, aninhada = false) {
  await db.query(aninhada ? "SAVEPOINT festa" : "BEGIN");
  try {
    const f = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
        SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
      [data, inicio, fim, cfg, c.empresa, c.pacote]);
    await db.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    await db.query(aninhada ? "RELEASE SAVEPOINT festa" : "COMMIT");
    return f;
  } catch (error) {
    await db.query(aninhada ? "ROLLBACK TO SAVEPOINT festa" : "ROLLBACK");
    throw error;
  }
}

/**
 * Festa integrada pelo caminho real (importação conferida → contrato assinado, festa confirmada) e a remarcação em
 * preparação (versão 2 + revisão operacional), como a suíte 062. Chamar DENTRO da transação do teste.
 */
async function integradaComRevisao(c: Cenario, ev: Evento) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const impId = (await importacao(a, c, ev)).id;
  const r = await integrar(s, coreNativo, a, c, impId, await comSalaoEscolhido(s, a, c, impId, decisoes(c, ev, { situacao: "NAO_CONFERIDO" })));
  const reserva = (await a.query(`SELECT f.id, f.configuracao_agenda_id cfg, v.id versao, v.snapshot, v.snapshot_hash FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id
      JOIN contrato_versoes v ON v.contrato_id = k.id WHERE k.id = $1`, [r.contratoId])).rows[0];
  const v2 = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, motivo_nova_versao)
      VALUES ($1::uuid, 2, 'ATIVA', $2::jsonb, $3, 'Remarcação 094') RETURNING id`, [r.contratoId, JSON.stringify(reserva.snapshot), reserva.snapshot_hash]);
  await a.query(`UPDATE contrato_fluxos SET versao_em_preparacao_id = $2::uuid WHERE contrato_id = $1::uuid`, [r.contratoId, v2]);
  const { criarRevisaoOperacionalRegistro } = carregar<Revisao>("lib/fechamentos/repositories/revisao.repository.ts");
  const revisao = randomUUID();
  await criarRevisaoOperacionalRegistro(tx, { id: revisao, fechamentoId: reserva.id, contratoId: r.contratoId, versaoId: v2, baseId: reserva.versao,
    baseHash: reserva.snapshot_hash, motivo: "Remarcação", chave: randomUUID(), usuarioId: c.usuario });
  return { festa: reserva.id as string, cfg: reserva.cfg as string, revisao };
}

const hold = (revisao: string) => a.query(`UPDATE fechamento_revisoes SET hold_destino_adquirido_em = clock_timestamp() WHERE id = $1::uuid`, [revisao]);
const instalada = async () => (await a.query<{ ok: boolean }>(
  `SELECT to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NOT NULL AS ok`)).rows[0].ok;

test.before(async () => {
  // Como a suíte 062: módulo Festa e integração de importados ligados só neste processo de teste.
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
  tx = executor(a);
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("rollback da 094 no estado limpo: volta à 062 (manifesto válido), sem a coluna de salão; reaplicação devolve a 094", async () => {
  assert.equal(await instalada(), true);
  await a.query(arquivo("database/rollback/20261022_094_agenda_capacidade_down.sql"));
  assert.equal(await instalada(), false);
  const colunas = await a.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'salao_id' AND table_name IN ('fechamentos', 'fechamento_revisoes')`);
  assert.equal(colunas.rowCount, 0);
  assert.equal((await a.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0].valida, true, "manifesto da Festa com o conjunto 062");
  await recusa(a.query(arquivo("database/rollback/20261022_094_agenda_capacidade_down.sql")), /a 094 não está aplicada/);
  await a.query("ROLLBACK").catch(() => undefined);
  await a.query(arquivo("database/checks/20261022_094_precheck.sql"));
  await a.query(arquivo("database/migrations/20261022_094_agenda_capacidade.sql"));
  await a.query(arquivo("database/checks/20261022_094_postcheck.sql"));
  assert.equal(await instalada(), true);
  assert.equal((await a.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0].valida, true, "manifesto da Festa com o conjunto 094");
});

test("durações reais: pacote, pacote mais curto no horário livre, revalidação pela duração do pacote e duração inválida", async () => {
  const c = await cenario(a, 0);
  const escopo = { empresaId: c.empresa, estabelecimentoId: null };
  const codigo = async (pacote: string) => (await a.query<{ codigo: string }>(`SELECT codigo FROM pacotes WHERE id = $1::uuid`, [pacote])).rows[0].codigo;
  const novoPacote = async (duracao: number | null, ativo = true) => {
    const p = await id(a, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, duracao_minutos)
                           VALUES ($1::uuid, $2, 'Pacote', 2, $3, true, $4) RETURNING id`, [c.empresa, `P${randomUUID().slice(0, 8).toUpperCase()}`, ativo, duracao]);
    return { id: p, codigo: await codigo(p) };
  };
  await a.query(`UPDATE pacotes SET duracao_minutos = 240 WHERE id = $1::uuid`, [c.pacote]);
  const quatro = await codigo(c.pacote);
  const tres = await novoPacote(180);
  const invalido = await novoPacote(1440);
  await novoPacote(60, false); // inativo: fora do mais curto
  const semDuracao = await novoPacote(null);
  assert.equal(await duracaoDoPacoteDaEmpresa(tx, c.empresa, quatro), 240);
  assert.equal(await duracaoDoPacoteDaEmpresa(tx, c.empresa, tres.codigo), 180);
  assert.equal(await duracaoDoPacoteDaEmpresa(tx, c.empresa, semDuracao.codigo), null);
  await assert.rejects(duracaoDoPacoteDaEmpresa(tx, c.empresa, invalido.codigo), (e: { code?: string }) => e.code === "PACOTE_DURACAO_INVALIDA");

  const livre = await horario(c, `LIVRE${randomUUID().slice(0, 6)}`, "00:00", "23:59", 1, true);
  await configurar(c, "LIVRE");
  const [periodo] = (await consultarDisponibilidadeData(D, tx, undefined, escopo)).periodos;
  assert.equal(periodo.configuracaoId, livre);
  assert.deepEqual(periodo.horarios.find((h) => h.inicio === "15:00"), { inicio: "15:00", fim: "18:00", ajusteMinutos: 900, status: "DISPONIVEL" }, "pacote ativo mais curto (180), sem o inativo nem o inválido");
  const [informado] = (await consultarDisponibilidadeData(D, tx, undefined, escopo, { duracaoMinutos: 300 })).periodos;
  assert.equal(informado.horarios.find((h) => h.inicio === "15:00")?.fim, "20:00");

  const pedido = (inicio: string, fim: string, pacoteCodigo: string) => ({ data: D, configuracaoId: livre, inicio, fim, ajusteMinutos: Number(inicio.slice(0, 2)) * 60, pacoteCodigo });
  await recusa(revalidarHorarioSelecionado(pedido("15:00", "18:00", quatro), tx, escopo), /não está mais disponível/);
  assert.equal((await revalidarHorarioSelecionado(pedido("15:00", "19:00", quatro), tx, escopo)).candidato.fim, "19:00");
  assert.equal((await revalidarHorarioSelecionado(pedido("15:00", "18:00", tres.codigo), tx, escopo)).candidato.fim, "18:00");
  assert.equal((await revalidarHorarioSelecionado(pedido("15:00", "17:00", semDuracao.codigo), tx, escopo)).candidato.fim, "17:00", "sem duração: a do intervalo");
  await assert.rejects(revalidarHorarioSelecionado(pedido("15:00", "19:00", invalido.codigo), tx, escopo), (e: { code?: string }) => e.code === "PACOTE_DURACAO_INVALIDA");
});

test("hold real da remarcação sob a 094: capacidade cheia recusa; com vaga aceita; a própria festa não conta duas vezes", async () => {
  // A conferência de agenda da revisão é um gatilho ADIADO (fr_agenda_validar_trg, no COMMIT): aqui ela roda na hora
  // (SET CONSTRAINTS … IMMEDIATE) dentro de um savepoint, e o ROLLBACK final desfaz o cenário inteiro.
  const holdAgora = async (revisao: string) => { await hold(revisao); await a.query("SET CONSTRAINTS fr_agenda_validar_trg IMMEDIATE"); };
  const desfazer = async () => { await a.query("ROLLBACK TO SAVEPOINT h"); await a.query("SET CONSTRAINTS fr_agenda_validar_trg DEFERRED"); };
  await a.query("BEGIN");
  try {
    const c = await cenario(a, 0);
    await configurar(c, "FIXO");
    const tarde = await horario(c, `TARDE${randomUUID().slice(0, 6)}`, "15:00", "19:00", 1);
    const D2 = dia(62);
    // Ocupante (preparo do cenário) na tarde; a festa importada (09h–13h) cai no mesmo horário configurado da empresa.
    const ocupante = await confirmada(a, c, tarde, "15:00", "19:00", D2, true);
    const { festa, cfg, revisao } = await integradaComRevisao(c, { data: D2, inicio: "09:00", fim: "13:00" });
    assert.equal(cfg, tarde);
    const destino = (inicio: string, fim: string) => a.query(`UPDATE fechamento_revisoes SET configuracao_agenda_id = $2::uuid, horario_inicio = $3::time, horario_fim = $4::time WHERE id = $1::uuid`, [revisao, tarde, inicio, fim]);
    // 1. Destino 15h–19h com a ocupante e capacidade 1: o hold é recusado pela regra da 094.
    await destino("15:00", "19:00");
    await a.query("SAVEPOINT h");
    await recusa(holdAgora(revisao), /Conflito de agenda da revisão/);
    await desfazer();
    // 2. Com vaga (capacidade 2), o mesmo destino é aceito; a festa passa a ocupar origem e destino (hold).
    await a.query("SAVEPOINT h");
    await a.query(`UPDATE configuracao_agenda SET capacidade = 2 WHERE id = $1::uuid`, [tarde]);
    await holdAgora(revisao);
    const ocupacoes = await a.query<{ fechamento_id: string }>(`SELECT fechamento_id FROM kidmais094_ocupacoes($1::date, $1::date) WHERE configuracao_agenda_id = $2::uuid AND horario_inicio = '15:00'`, [D2, tarde]);
    assert.deepEqual(new Set(ocupacoes.rows.map((o) => o.fechamento_id)), new Set([ocupante, festa]));
    await desfazer();
    // 3. Destino 10h–14h, sobreposto só à própria origem (09h–13h), capacidade 1: a festa não conta duas vezes.
    await destino("10:00", "14:00");
    await a.query("SAVEPOINT h");
    await holdAgora(revisao);
    await desfazer();
  } finally {
    await a.query("ROLLBACK");
  }
});

test("concorrência real: duas conexões confirmam o mesmo horário (capacidade 1) ao mesmo tempo — exatamente uma vence", async () => {
  const c = await cenario(a, 0);
  await configurar(c, "FIXO");
  const cfg = await horario(c, `CORRIDA${randomUUID().slice(0, 6)}`, "15:00", "19:00", 1);
  const b = await conectarDescartavel({ travar: false });
  const d = await conectarDescartavel({ travar: false });
  try {
    const r = await Promise.allSettled([confirmada(b, c, cfg, "15:00", "19:00"), confirmada(d, c, cfg, "15:00", "19:00")]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(r.map((x) => x.status)));
    const motivo = (r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason as Error;
    assert.match(motivo.message, /Conflito|indisponível/);
    // Capacidade 2: as duas vencem juntas; a terceira, não.
    const cfg2 = await horario(c, `CORRIDA2${randomUUID().slice(0, 6)}`, "09:00", "13:00", 2);
    const r2 = await Promise.allSettled([confirmada(b, c, cfg2, "09:00", "13:00"), confirmada(d, c, cfg2, "09:00", "13:00")]);
    assert.equal(r2.filter((x) => x.status === "fulfilled").length, 2, JSON.stringify(r2.map((x) => x.status === "rejected" ? String(x.reason) : "ok")));
    await recusa(confirmada(a, c, cfg2, "09:00", "13:00"), /Conflito/);
    assert.equal((await a.query(`SELECT count(*)::int n FROM fechamentos WHERE configuracao_agenda_id = ANY($1::uuid[]) AND status = 'CONFIRMADO'`, [[cfg, cfg2]])).rows[0].n, 3);
  } finally {
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(d, false);
  }
});

test("rollback adversarial: festas sobrepostas válidas pela capacidade e salão só na revisão recusam; nada muda", async () => {
  // Estado vindo dos testes anteriores: festas sobrepostas no mesmo recurso (capacidade 2) já confirmadas.
  await recusa(a.query(arquivo("database/rollback/20261022_094_agenda_capacidade_down.sql")), /festas simultâneas no mesmo recurso/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.equal(await instalada(), true);
  // Salão gravado só numa revisão (festa sem salão): também recusa — a remoção apagaria a escolha. A recusa do down é
  // conferida dentro da transação do cenário (o arquivo do down abre o próprio BEGIN: vira aviso e segue na mesma).
  const down = arquivo("database/rollback/20261022_094_agenda_capacidade_down.sql").replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
  await a.query("BEGIN");
  try {
    const c = await cenario(a, 0);
    const salao = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, 'Salão A', 1, true) RETURNING id`, [c.empresa]);
    const { festa, revisao } = await integradaComRevisao(c, { data: dia(63), inicio: "09:00", fim: "13:00" });
    await a.query(`UPDATE fechamento_revisoes SET salao_id = $2::uuid WHERE id = $1::uuid`, [revisao, salao]);
    assert.equal((await a.query(`SELECT count(*)::int n FROM fechamentos WHERE id = $1::uuid AND salao_id IS NOT NULL`, [festa])).rows[0].n, 0);
    await a.query("SAVEPOINT d");
    await recusa(a.query(down), /há festas com salão/);
    await a.query("ROLLBACK TO SAVEPOINT d");
  } finally {
    await a.query("ROLLBACK");
  }
  assert.equal(await instalada(), true);
  assert.equal((await a.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0].valida, true);
});
