import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { catalogoNativo, catalogoNoTurno, cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { normalizarWebp } from "../imagens/normalizar-webp.ts";
import { adicionarFoto, confirmarDeclaracao, salvarApresentacao, type CamposInformados } from "./salao-apresentacao.ts";
import { fotoPublica, listarSaloesPublicos, SalaoPublicoIndisponivel } from "./salao-publico.ts";
import { escolherSalaoParaEmissao } from "./salao-festa.ts";
import { adquirirLockConfirmacaoAgenda } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { carregarComBanco, executor, porTransacao } from "../marketing/harness-postgres.ts";
import * as cotacaoPublicaReal from "../comercial/cotacao-publica.ts";
import * as escopoReal from "../disponibilidade/escopo.ts";

/**
 * S-D no PostgreSQL DESCARTÁVEL (modelo 104 = staging; a 106 é aplicada aqui). Plano S-E/S-D rev. 4.1 (D7, R-T, R3-T, R4-T):
 *   * 106: precheck → migration → postcheck/integridade; reaplicação recusada; rollback recusado com valor e aceito sem;
 *     mutante que só troca VOLATILE por STABLE reprova o postcheck;
 *   * gatilhos: preferência de outra empresa/unidade recusada; escopo de salão referenciado (inclusive festa cancelada)
 *     recusado; N2 nas duas ordens com duas conexões e espera observada (pg_blocking_pids);
 *   * leitura pública: 2 prontos (50 e 120 com mínimo 60) — recomendado, não comporta, abaixo do mínimo, ocupado; flag
 *     desligada, um só pronto e outra empresa = não publicado; foto de salão que deixou de estar pronto = não publicado;
 *   * POST real: preferido livre grava; não comporta, ocupado ou de outro pacote = 409 sem escrita; ocupação concorrente
 *     (segunda conexão segura a trava da data e ocupa o salão) = 409 depois da espera;
 *   * emissão: usa o preferido; preferido que não serve = PREFERIDO_NAO_SERVE (nunca outro); escolha da equipe vence.
 */
let a: Client;
let tx: DbExecutor;
const LIGADO = { SALOES_PUBLICOS: "true" };
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: crypto.randomUUID() });
const arquivo = (p: string) => readFileSync(p, "utf8");

async function emTransacao<T>(fn: () => Promise<T>, db: Client = a): Promise<T> {
  await db.query("BEGIN");
  try { const r = await fn(); await db.query("COMMIT"); return r; } catch (e) { await db.query("ROLLBACK"); throw e; }
}
async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}
async function imagem() {
  const cor = { r: randomBytes(1)[0]!, g: randomBytes(1)[0]!, b: randomBytes(1)[0]! };
  return normalizarWebp(await sharp({ create: { width: 40, height: 30, channels: 3, background: cor } }).png().toBuffer());
}

/** Salão PRONTO pelos serviços reais da 102: campos, 6 fotos com legenda, mês das fotos e declaração. */
async function salaoPronto(c: Cenario, nome: string, capacidade: number, minimo: number | null, ordem: number) {
  const s = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, $2, $3, $4) RETURNING id`, [c.empresa, nome, capacidade, ordem]);
  const v0 = (await a.query<{ v: number }>(`SELECT conteudo_versao AS v FROM agenda_saloes WHERE id = $1`, [s])).rows[0]!.v;
  const campos: CamposInformados = { convidadosMinimo: minimo, convidadosSentados: null, areaM2: 100, idadeMin: 3, idadeMax: 10, frase: `Salão ${nome}`,
    outraFestaSimultanea: true, exclusivos: ["ENTRADA"], fotosReferencia: "2026-09" };
  let r = await emTransacao(() => salvarApresentacao(tx, ctx(c), s, v0, campos, []));
  for (let i = 0; i < 6; i++) r = await emTransacao(async () => adicionarFoto(tx, ctx(c), s, r.conteudoVersao, await imagem(), `Ambiente ${i + 1}`));
  await emTransacao(() => confirmarDeclaracao(tx, ctx(c), s, r.conteudoVersao));
  return s;
}

/** Buffet POR_SALAO com horário 15–19, dois salões prontos (Pequeno 50; Grande 120, mínimo 60) e catálogo cotável. */
async function buffet() {
  const c = await cenario(a, 0);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_SALAO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
  const tarde = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ('TARDE_SD', 'Tarde', '15:00', '19:00', 0, 30, 1, $1::uuid, 1) RETURNING id`, [c.empresa]);
  const pequeno = await salaoPronto(c, "Pequeno", 50, null, 1);
  const grande = await salaoPronto(c, "Grande", 120, 60, 2);
  await catalogoNativo(a, c);
  await catalogoNoTurno(a, c, tarde);
  return { c, tarde, pequeno, grande };
}

/** Festa confirmada no salão (ocupação), numa transação. */
async function ocupar(c: Cenario, data: string, cfg: string, salao: string, db: Client = a) {
  await db.query("BEGIN");
  try {
    const f = await id(db as Client, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
        SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 80, 80, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
      [data, cfg, c.empresa, c.pacote, salao]);
    await db.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    await db.query("COMMIT");
    return f;
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}

const escopo = (c: Cenario) => ({ empresaId: c.empresa, estabelecimentoId: null });
const consulta = (data: string, cfg: string, convidados: number) => ({ data, configuracaoId: cfg, inicio: "15:00", fim: "19:00", convidados });

/**
 * Roda `fn` numa transação com gatilhos ANTERIORES de fechamentos desligados e SEMPRE desfaz: a 062 (unidade não
 * agendável) e a 054 (empresa imutável/coerente com o pacote) recusam antes; desligadas, quem recusa é a 106.
 */
const G062 = ["fechamentos_062_unidade_trg"];
const G054 = ["fechamentos_054_empresa_imutavel_trg", "fechamentos_054_empresa_coerente_trg"];
async function semGatilhos<T>(cl: Client, gatilhos: string[], fn: () => Promise<T>): Promise<T> {
  await cl.query("BEGIN");
  try {
    for (const g of gatilhos) await cl.query(`ALTER TABLE fechamentos DISABLE TRIGGER ${g}`);
    return await fn();
  } finally { await cl.query("ROLLBACK"); }
}
const sem062 = <T>(cl: Client, fn: () => Promise<T>) => semGatilhos(cl, G062, fn);
async function gatilhosReligados(cl: Client, momento: string) {
  const r = await cl.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.fechamentos'::regclass
    AND tgname = ANY($1::text[]) AND tgenabled = 'O'`, [[...G062, ...G054]]);
  assert.equal(r.rows[0]!.n, 3, `062 e 054 religadas (ROLLBACK) ${momento}`);
}

async function esperarBloqueio(observador: Client, pid: number) {
  for (let i = 0; i < 200; i++) {
    const r = await observador.query<{ b: boolean }>("SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS b", [pid]);
    if (r.rows[0]!.b) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  assert.fail(`a conexão ${pid} não ficou bloqueada`);
}
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (base.every((d) => d === base[0])) base[8] = (base[0]! + 1) % 10;
  const dv = (n: number[]) => { const soma = n.reduce((t, d, i) => t + d * (n.length + 1 - i), 0) % 11; return soma < 2 ? 0 : 11 - soma; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join("");
}
const pid = async (cl: Client) => (await cl.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]!.p;

test.before(async () => {
  a = await conectarDescartavel();
  tx = executor(a);
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("106: precheck, migration, postcheck e integridade; reaplicação recusada; rollback condicionado; mutante STABLE reprova", async () => {
  await a.query(arquivo("database/checks/20261027_106_precheck.sql"));
  await a.query(arquivo("database/migrations/20261027_106_salao_preferido.sql"));
  await a.query(arquivo("database/checks/20261027_106_postcheck.sql"));
  await a.query(arquivo("database/checks/20261027_106_integridade.sql"));
  await recusa(a.query(arquivo("database/migrations/20261027_106_salao_preferido.sql")), /106: precheck falhou/);
  await a.query("ROLLBACK").catch(() => undefined);
  await recusa(a.query(arquivo("database/checks/20261027_106_precheck.sql")), /106 precheck/);
  // Rollback recusado com valor gravado; aceito sem; reaplica.
  const { c, tarde, grande } = await buffet();
  const f = await ocupar(c, dia(150), tarde, grande);
  await a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, grande]);
  await recusa(a.query(arquivo("database/rollback/20261027_106_salao_preferido_down.sql")), /106 rollback: há festa com salão de preferência/);
  await a.query("ROLLBACK").catch(() => undefined);
  await a.query(`UPDATE fechamentos SET salao_preferido_id = NULL WHERE id = $1::uuid`, [f]);
  await a.query(arquivo("database/rollback/20261027_106_salao_preferido_down.sql"));
  await a.query(arquivo("database/checks/20261027_106_precheck.sql"));
  await a.query(arquivo("database/migrations/20261027_106_salao_preferido.sql"));
  await a.query(arquivo("database/checks/20261027_106_postcheck.sql"));
  // Mutante: só a volatilidade muda (mesmo prosrc) → postcheck e integridade reprovam.
  await a.query(`ALTER FUNCTION public.kidmais106_salao_preferido_escopo() STABLE`);
  await recusa(a.query(arquivo("database/checks/20261027_106_postcheck.sql")), /106 postcheck/);
  await recusa(a.query(arquivo("database/checks/20261027_106_integridade.sql")), /106 postcheck/);
  await a.query(`ALTER FUNCTION public.kidmais106_salao_preferido_escopo() VOLATILE`);
  await a.query(arquivo("database/checks/20261027_106_postcheck.sql"));
});

test("106: preferência de outra empresa/unidade recusada; escopo de salão referenciado (até por festa cancelada) recusado", async () => {
  const { c, tarde, grande } = await buffet();
  const outra = await buffet();
  const f = await ocupar(c, dia(151), tarde, grande);
  await recusa(a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, outra.grande]), /fechamentos_106_salao_preferido_fk|106: salão de preferência/);
  const unidade = await id(a, `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade SD', 'SUSPENSO') RETURNING id`, [c.empresa, `u-${randomBytes(3).toString("hex")}`]);
  const naUnidade = await id(a, `INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, capacidade_convidados) VALUES ($1::uuid, $2::uuid, 'Da unidade', 100) RETURNING id`, [c.empresa, unidade]);
  await recusa(a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, naUnidade]), /106: salão de preferência de outra empresa ou unidade/);
  await a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, grande]);
  // Mudança de escopo do PRÓPRIO fechamento com preferência: unidade diferente da do salão e outra empresa são recusadas.
  // (a 062 recusaria primeiro a unidade não agendável; sem ela, quem recusa é a 106)
  await recusa(a.query(`UPDATE fechamentos SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [f, unidade]), /062: unidade não elegível|106: salão de preferência/);
  await recusa(sem062(a, () => a.query(`UPDATE fechamentos SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [f, unidade])), /106: salão de preferência de outra empresa ou unidade/);
  await gatilhosReligados(a, "depois da prova da 062");
  await recusa(a.query(`UPDATE fechamentos SET empresa_id = $2::uuid WHERE id = $1::uuid`, [f, outra.c.empresa]), /054: /);
  await recusa(semGatilhos(a, G054, () => a.query(`UPDATE fechamentos SET empresa_id = $2::uuid WHERE id = $1::uuid`, [f, outra.c.empresa])), /106: salão de preferência de outra empresa ou unidade/);
  await gatilhosReligados(a, "depois da prova da 054");
  // INSERT já com a preferência: salão de outra unidade recusado; salão do mesmo escopo aceito.
  const inserir = (salao: string) => id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_preferido_id)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 80, 80, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [dia(153), tarde, c.empresa, c.pacote, salao]);
  await recusa(inserir(naUnidade), /106: salão de preferência de outra empresa ou unidade/);
  await recusa(inserir(outra.grande), /fechamentos_106_salao_preferido_fk|106: salão de preferência/);
  const inserida = await inserir(grande);
  assert.equal((await a.query(`SELECT salao_preferido_id::text AS s FROM fechamentos WHERE id = $1::uuid`, [inserida])).rows[0]!.s, grande);
  await a.query(`DELETE FROM fechamentos WHERE id = $1::uuid`, [inserida]);
  // Festa cancelada continua referência: o cancelamento é verificado antes de exigir a recusa.
  await a.query(`UPDATE fechamentos SET status = 'CANCELADO' WHERE id = $1::uuid`, [f]);
  assert.equal((await a.query(`SELECT status FROM fechamentos WHERE id = $1::uuid`, [f])).rows[0]!.status, "CANCELADO");
  await recusa(a.query(`UPDATE agenda_saloes SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [grande, unidade]), /106: salão escolhido por cliente não muda/);
});

test("106 (N2): preferência × mudança de escopo do salão, nas duas ordens, com espera observada", async () => {
  const { c, tarde, pequeno, grande } = await buffet();
  const unidade = await id(a, `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade N2', 'SUSPENSO') RETURNING id`, [c.empresa, `u-${randomBytes(3).toString("hex")}`]);
  const f = await ocupar(c, dia(152), tarde, grande);
  const b = await conectarDescartavel({ travar: false });
  const [pidA, pidB] = [await pid(a), await pid(b)];
  try {
    // Preferência primeiro: o UPDATE de escopo espera o FOR SHARE e, depois do COMMIT, vê a referência e recusa.
    await a.query("BEGIN");
    await a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, pequeno]);
    const escopoDepois = b.query(`UPDATE agenda_saloes SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [pequeno, unidade]).then(() => "ok", (e: Error) => e.message);
    const cedo = await Promise.race([escopoDepois, new Promise((r) => setTimeout(() => r("esperando"), 1500))]);
    assert.equal(cedo, "esperando", `a mudança de escopo não esperou a preferência: ${cedo}`);
    await esperarBloqueio(a, pidB);
    await a.query("COMMIT");
    assert.match(await escopoDepois, /106: salão escolhido por cliente não muda/);
    // Escopo primeiro: a preferência espera a linha do salão e, depois do COMMIT, lê a unidade nova e recusa.
    const outroSalao = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados) VALUES ($1::uuid, 'Livre N2', 100) RETURNING id`, [c.empresa]);
    await b.query("BEGIN");
    await b.query(`UPDATE agenda_saloes SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [outroSalao, unidade]);
    const preferenciaDepois = a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, outroSalao]).then(() => "ok", (e: Error) => e.message);
    await esperarBloqueio(b, pidA);
    await b.query("COMMIT");
    assert.match(await preferenciaDepois, /106: salão de preferência de outra empresa ou unidade/);
    // INSERT com preferência enquanto o salão muda de unidade: o INSERT espera e, depois do COMMIT, recusa.
    const terceiro = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados) VALUES ($1::uuid, 'Livre N2 b', 100) RETURNING id`, [c.empresa]);
    await b.query("BEGIN");
    await b.query(`UPDATE agenda_saloes SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [terceiro, unidade]);
    const insertDepois = a.query(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_preferido_id)
        SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 80, 80, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1`,
      [dia(154), tarde, c.empresa, c.pacote, terceiro]).then(() => "ok", (e: Error) => e.message);
    await esperarBloqueio(b, pidA);
    await b.query("COMMIT");
    assert.match(await insertDepois, /106: salão de preferência de outra empresa ou unidade/);
    // Fechamento muda de unidade × salão preferido: a mudança do fechamento confere o salão e recusa a unidade diferente.
    await a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, grande]);
    await b.query("BEGIN");
    await b.query(`SELECT 1 FROM agenda_saloes WHERE id = $1::uuid FOR UPDATE`, [grande]);
    const escopoFechamento = sem062(a, () => a.query(`UPDATE fechamentos SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [f, unidade])).then(() => "ok", (e: Error) => e.message);
    await esperarBloqueio(b, pidA);
    await b.query("COMMIT");
    assert.match(await escopoFechamento, /106: salão de preferência de outra empresa ou unidade/, "o fechamento lê o salão FOR SHARE e espera");
    await gatilhosReligados(b, "depois da prova concorrente");
  } finally {
    await b.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(b, false);
  }
});

test("S-D: leitura pública — recomendado, não comporta, abaixo do mínimo, ocupado; portões; foto de salão que deixou de estar pronto", async () => {
  const { c, tarde, pequeno, grande } = await buffet();
  const data = dia(160);
  const r80 = await listarSaloesPublicos(tx, escopo(c), consulta(data, tarde, 80), LIGADO);
  assert.deepEqual(r80.saloes.map((s) => [s.nome, s.situacao]), [["Pequeno", "nao_comporta"], ["Grande", "livre"]]);
  assert.deepEqual(r80.recomendado, { id: grande, motivo: "indicado para 80 · cabe até 120" });
  const r40 = await listarSaloesPublicos(tx, escopo(c), consulta(data, tarde, 40), LIGADO);
  assert.deepEqual(r40.saloes.map((s) => s.situacao), ["livre", "abaixo_do_minimo"]);
  assert.equal(r40.recomendado?.id, pequeno);
  await ocupar(c, data, tarde, grande);
  const ocupado = await listarSaloesPublicos(tx, escopo(c), consulta(data, tarde, 80), LIGADO);
  assert.deepEqual(ocupado.saloes.map((s) => s.situacao), ["nao_comporta", "ocupado"], "estrutural vence ocupado no Pequeno");
  assert.equal(ocupado.recomendado, null);
  const texto = JSON.stringify(ocupado);
  for (const proibido of ["conteudo_versao", "declaracao", "fechamento"]) assert.equal(texto.includes(proibido), false, proibido);
  // Portões.
  await assert.rejects(listarSaloesPublicos(tx, escopo(c), consulta(data, tarde, 80), {}), SalaoPublicoIndisponivel, "flag desligada");
  const outra = await cenario(a, 0);
  await assert.rejects(listarSaloesPublicos(tx, escopo(outra), consulta(data, tarde, 80), LIGADO), SalaoPublicoIndisponivel, "outra empresa");
  const foto = (await a.query<{ id: string }>(`SELECT id::text FROM agenda_salao_fotos WHERE salao_id = $1 AND removida_em IS NULL LIMIT 1`, [grande])).rows[0]!.id;
  assert.ok((await fotoPublica(tx, escopo(c), grande, foto, LIGADO)).sha256);
  await assert.rejects(fotoPublica(tx, escopo(outra), grande, foto, LIGADO), SalaoPublicoIndisponivel, "foto pelo escopo de outra empresa");
  // O Grande deixa de estar pronto (conteúdo novo sem declaração): 2 → 1 pronto, tudo despublica.
  const v = (await a.query<{ v: number }>(`SELECT conteudo_versao AS v FROM agenda_saloes WHERE id = $1`, [grande])).rows[0]!.v;
  await emTransacao(() => salvarApresentacao(tx, ctx(c), grande, v, { convidadosMinimo: 60, convidadosSentados: null, areaM2: 120, idadeMin: 3, idadeMax: 10,
    frase: "Mudou", outraFestaSimultanea: true, exclusivos: [], fotosReferencia: "2026-09" }, []));
  await assert.rejects(fotoPublica(tx, escopo(c), grande, foto, LIGADO), SalaoPublicoIndisponivel, "foto de salão não pronto");
  await assert.rejects(listarSaloesPublicos(tx, escopo(c), consulta(data, tarde, 40), LIGADO), SalaoPublicoIndisponivel, "um só pronto: a etapa some");
});

test("S-D: POST real — preferido livre grava; não comporta, ocupado ou de outro pacote = 409 sem escrita; ocupação concorrente = 409", async () => {
  const { c, tarde, pequeno, grande } = await buffet();
  // Um terceiro salão pronto que comporta 80: com o Grande ocupado o HORÁRIO segue disponível (a revalidação da S-C passa)
  // e a recusa vem da preferência (SALAO_INDISPONIVEL). Sem ele, a S-C já recusaria antes (SEM_SALAO_PARA_CONVIDADOS).
  const medio = await salaoPronto(c, "Médio", 100, null, 3);
  const anterior = process.env.SALOES_PUBLICOS;
  process.env.SALOES_PUBLICOS = "true";
  const extras = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "http/limite-publico": { limitarPublico: async () => null },
    "comercial/cotacao-publica": { ...cotacaoPublicaReal, codigoEmpresaDoPedido: () => "buffet-sd",
      escopoCotacaoPublica: async () => ({ empresaId: c.empresa, estabelecimentoId: null, porCodigo: true }) },
    "disponibilidade/escopo": { ...escopoReal, escopoDaEmpresa: async () => ({ estabelecimentoId: null }) },
    "db/postgres": { db: () => executor(a), withTransaction: porTransacao(a) },
  };
  const rota = carregarComBanco("app/api/fechamentos/route.ts", a, () => null, extras, new Map()) as unknown as {
    POST: (r: unknown) => Promise<{ status: number; body: Record<string, unknown> }> };
  const enviar = (data: string, convidados: number, salaoPreferido: string) => rota.POST({ url: "http://localhost/api/fechamentos", nextUrl: new URL("http://localhost/api/fechamentos"),
    headers: new Headers(), json: async () => ({
      pacote: "completa", dataFesta: data, configuracaoId: tarde, ajusteHorario: "0", horarioInicio: "15:00", horarioFim: "19:00",
      identidadeTipo: "NOVO_CLIENTE", statusDisponibilidade: "disponivel", convidadosPagantes: convidados, buffetDefinicao: "depois", adicionaisSelecionados: [],
      valorCombinado: "100,00", formaPagamento: "pix_avista", nomeCliente: "Cliente Sintético SD", cpf: cpfValido(), email: `sd-${randomBytes(3).toString("hex")}@buffet.test`,
      whatsapp: "11988880002", telefone: "1133330002", cep: "70000000", logradouro: "Rua Sintética", numero: "1", bairro: "Centro", cidade: "Brasília", uf: "DF",
      nomeAniversariante: "Aniversariante SD", idadeAniversariante: 6, salaoPreferido,
    }) });
  const contagem = async () => Number((await a.query<{ n: string }>(`SELECT count(*)::text AS n FROM fechamentos WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0]!.n);
  try {
    const d1 = dia(170);
    const ok = await enviar(d1, 80, grande);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual((await a.query(`SELECT salao_preferido_id::text AS p, salao_id FROM fechamentos WHERE empresa_id = $1::uuid AND data_evento = $2::date`, [c.empresa, d1])).rows,
      [{ p: grande, salao_id: null }], "preferência gravada, sem ocupar a agenda");
    const antes = await contagem();
    const naoComporta = await enviar(dia(171), 80, pequeno);
    assert.deepEqual([naoComporta.status, naoComporta.body.codigo], [409, "SALAO_INDISPONIVEL"]);
    const d3 = dia(172);
    await ocupar(c, d3, tarde, grande);
    const depoisDaOcupacao = await contagem();
    const ocupado = await enviar(d3, 80, grande);
    assert.deepEqual([ocupado.status, ocupado.body.codigo], [409, "SALAO_INDISPONIVEL"], "ocupado: nunca troca pelo Pequeno");
    assert.equal(await contagem(), depoisDaOcupacao, "nada gravado nas recusas");
    assert.equal(depoisDaOcupacao, antes + 1, "só a ocupação de teste entrou");
    // Pacote do Pequeno e do Médio (o horário segue servível pelo Médio): o Grande não é do pacote.
    await a.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`, [c.pacote, pequeno, medio]);
    const outroPacote = await enviar(dia(173), 80, grande);
    assert.deepEqual([outroPacote.status, outroPacote.body.codigo], [409, "SALAO_INDISPONIVEL"]);
    await a.query(`DELETE FROM pacote_saloes WHERE pacote_id = $1::uuid`, [c.pacote]);
    // Concorrência: a segunda conexão segura a trava da data e ocupa o Grande; o envio espera e recusa.
    const d5 = dia(174);
    const b = await conectarDescartavel({ travar: false });
    const pidRota = await pid(a);
    try {
      await b.query("BEGIN");
      await adquirirLockConfirmacaoAgenda(d5, executor(b));
      const corrida = enviar(d5, 80, grande);
      await esperarBloqueio(b, pidRota);
      const f = await id(b, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
            categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
          SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 80, 80, 100, 100, 100,
                 'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $5::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
        [d5, tarde, c.empresa, c.pacote, grande]);
      await b.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
      await b.query("COMMIT");
      const r = await corrida;
      assert.deepEqual([r.status, r.body.codigo], [409, "SALAO_INDISPONIVEL"], "ocupado entre a consulta e o envio");
    } finally {
      await b.query("ROLLBACK").catch(() => undefined);
      await encerrarDescartavel(b, false);
    }
  } finally {
    if (anterior === undefined) delete process.env.SALOES_PUBLICOS; else process.env.SALOES_PUBLICOS = anterior;
  }
});

test("S-D: emissão usa o preferido; preferido que não serve = PREFERIDO_NAO_SERVE; a escolha da equipe vence", async () => {
  const { c, tarde, pequeno, grande } = await buffet();
  const novaFesta = async (data: string, convidados: number) => id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id,
        tabela_preco_id, preco_pacote_id, categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela,
        origem_fechamento, cliente_id, status)
      SELECT $1::date, '15:00', '19:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', $5, $5, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`, [data, tarde, c.empresa, c.pacote, convidados]);
  const d = dia(180);
  const f = await novaFesta(d, 40);
  await a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [f, pequeno]);
  assert.deepEqual(await escolherSalaoParaEmissao(tx, f), { porSalao: true, salao: { id: pequeno, nome: "Pequeno" } }, "o automático daria o mesmo; aqui é o preferido");
  const g = await novaFesta(d, 80);
  await a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [g, grande]);
  assert.deepEqual(await escolherSalaoParaEmissao(tx, g), { porSalao: true, salao: { id: grande, nome: "Grande" } });
  await ocupar(c, d, tarde, grande);
  assert.deepEqual(await escolherSalaoParaEmissao(tx, g), { porSalao: true, salao: null, motivo: "PREFERIDO_NAO_SERVE" }, "nunca troca em silêncio");
  // A equipe escolhe outro de forma explícita (salao_id) — essa escolha vem antes da preferência.
  const h = await novaFesta(dia(181), 40);
  await a.query(`UPDATE fechamentos SET salao_preferido_id = $2::uuid WHERE id = $1::uuid`, [h, grande]);
  assert.equal((await escolherSalaoParaEmissao(tx, h) as { motivo?: string }).motivo, "PREFERIDO_NAO_SERVE", "40 está abaixo do mínimo do Grande");
  await a.query(`UPDATE fechamentos SET salao_id = $2::uuid WHERE id = $1::uuid`, [h, pequeno]);
  assert.deepEqual(await escolherSalaoParaEmissao(tx, h), { porSalao: true, salao: { id: pequeno, nome: "Pequeno" } }, "escolha da equipe vence");
});
