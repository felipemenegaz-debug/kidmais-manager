import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, catalogoNoTurno, cenario, completarCliente, congelarEAssinarKidmais, decisoes, dia,
  executor, id, importacao, integrar, PARCIAL, poolNaTransacao, validarAgora, type Cenario, type Servico,
} from "../../scripts/integracao-importados-test-support.ts";
import {
  assinaturaEstruturaFesta016, assinaturaEstruturaFestaAtual, assinaturaEstruturaFestaCom104, estruturaFesta016Sql, tabelasFesta016,
} from "../festas/estrutura-016.ts";

/**
 * S-E, migration 104 (plano S-E/S-D rev. 4.1, R4-E1 e R41-1..R41-5), no PostgreSQL DESCARTÁVEL (modelo 103, sem a 104):
 * - revisões v1 de verdade (pelos serviços: importação → nova versão → editar festa), POR_SALAO com salão no destino,
 *   aplicada, cancelada e POR_HORARIO: o hash de TODAS fica idêntico depois da 104 e as aplicações/cancelamentos seguem;
 * - assinatura da estrutura da Festa: antes = a atual, depois = a da 104 (a única outra aceita por ambiente.ts);
 * - reaplicação e precheck recusam; hash_versao é imutável; rollback volta ao corpo e à assinatura anteriores;
 * - revisão NOVA em POR_SALAO nasce em hash_versao 2 com o hash da função; trocar só o salão do destino muda o hash,
 *   soma 1 à revisão e zera a aprovação; o snapshot documenta o hash final e o COMMIT passa nos validadores diferidos;
 * - com revisão v2 gravada, o rollback é recusado.
 */
let a: Client;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sql = (p: string) => readFileSync(resolve(raiz, p), "utf8");
const MIGRATION = "database/migrations/20261027_104_revisao_hash_salao.sql";
const PRECHECK = "database/checks/20261027_104_precheck.sql";
const POSTCHECK = "database/checks/20261027_104_postcheck.sql";
const DOWN = "database/rollback/20261027_104_revisao_hash_salao_down.sql";
const HORA = { inicio: "10:00", fim: "22:00" };
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "se-104" });

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}
const assinatura = async () => (await a.query<{ assinatura: string }>(estruturaFesta016Sql, [tabelasFesta016])).rows[0].assinatura;
const hashes = async () => new Map((await a.query<{ id: string; h: string; c: string }>(
  `SELECT id::text, kidmais_hash_revisao_operacional(id) h, conteudo_hash c FROM fechamento_revisoes ORDER BY id`)).rows.map((r) => [r.id, `${r.h}|${r.c}`]));

async function configurar(c: Cenario, tipo: "POR_HORARIO" | "POR_SALAO") {
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', $2, NULL, 0, $3::uuid)`, [c.empresa, tipo, c.usuario]);
}

async function modeloContrato(c: Cenario) {
  const conteudo = {
    titulo: "Contrato de Festa S-E 104",
    contratada: { nome: "Buffet S-E 104 Ltda", documento: "11.222.333/0001-81", endereco: "Rua Teste, 104", representante: "Pessoa Teste" },
    preambulo: [], clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}." }], observacoes: [], cidadeAssinatura: "Cidade Teste",
  };
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid)`,
    [c.empresa, JSON.stringify(conteudo), "a".repeat(64), c.usuario]);
}

/** Contrato histórico integrado e a preparação de revisão pelos serviços reais (como na suíte da remarcação 094). */
async function contratada(c: Cenario, data: string) {
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const ev = { data, ...HORA };
  const imp = await importacao(a, c, ev);
  const cpf = await completarCliente(a, imp.cliente);
  const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()));
  await validarAgora(a);
  const festa = (await a.query<{ id: string; cfg: string }>(
    `SELECT f.id::text, f.configuracao_agenda_id::text cfg FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1`, [r.contratoId])).rows[0];
  // Determinístico (P2-2 de 27/10): o preço do pacote precisa existir no turno que a importação escolheu.
  const chave = `${c.empresa}:${festa.cfg}`;
  if (festa.cfg !== nativos.get(c.empresa)!.turno && !precificados.has(chave)) { await catalogoNoTurno(a, c, festa.cfg); precificados.add(chave); }
  const tx = executor(a);
  const abrir = async (motivo: string) => {
    const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v;
    await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo, chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
    const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
    const revisaoEdicao = async () => (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
    const editar = async (destino: string, tema = "Circo", comercial?: Record<string, unknown>) => {
      const fonte = (await rs.fontesPreparacao(v2, tx))!;
      return operar(v2, { acao: "editar_festa", revisao: await revisaoEdicao(), motivo, fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
        dataEvento: destino, configuracaoAgendaId: festa.cfg, horarioInicio: HORA.inicio, horarioFim: HORA.fim, adicionais: fonte.adicionais,
        idadeAniversarianteEvento: 6, temaFesta: tema, buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
        observacoesEquipe: "S-E 104", ...(comercial ? { comercial } : {}) }, c.token, ctxOp(), c.empresa);
    };
    const revalidar = async () => operar(v2, { acao: "revalidar_destino", revisao: await revisaoEdicao() }, c.token, ctxOp(), c.empresa);
    const cancelar = async () => operar(v2, { acao: "cancelar_revisao", revisao: await revisaoEdicao(), motivo: "Desistência S-E" }, c.token, ctxOp(), c.empresa);
    const concluir = async () => {
      await congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, (await catalogoNativoDe(c)).tokenRepresentante);
      await assinarComoCliente(r.contratoId, cpf);
      await validarAgora(a);
    };
    const preparacao = async () => (await a.query<{ id: string; estado: string; salao: string | null; versao: number; revisao: number; hash: string; aprovada: number | null }>(
      `SELECT id::text, estado, salao_id::text salao, (to_jsonb(r)->>'hash_versao')::int versao, revisao, conteudo_hash hash, revisao_comercial_aprovada aprovada
         FROM fechamento_revisoes r WHERE contrato_versao_id = $1`, [v2])).rows[0];
    const snapshotHash = async () => (await a.query<{ h: string }>(`SELECT snapshot->'revisaoOperacional'->>'conteudoHash' h FROM contrato_versoes WHERE id = $1`, [v2])).rows[0].h;
    const substituir = async () => operar(v2, { acao: "substituir_preparacao", motivo: "Correção S-E", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
    const congelar = async () => congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, (await catalogoNativoDe(c)).tokenRepresentante);
    return { v2, editar, revalidar, cancelar, concluir, congelar, substituir, preparacao, snapshotHash };
  };
  return { festa: festa.id, contrato: r.contratoId, abrir };
}
const precificados = new Set<string>();
const nativos = new Map<string, Awaited<ReturnType<typeof catalogoNativo>>>();
const catalogoNativoDe = async (c: Cenario) => nativos.get(c.empresa)!;

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

async function empresa(tipo: "POR_HORARIO" | "POR_SALAO") {
  const c = await cenario(a, 0);
  nativos.set(c.empresa, await catalogoNativo(a, c));
  await modeloContrato(c);
  await configurar(c, tipo);
  return c;
}
const salao = (c: Cenario, nome: string, ordem: number) =>
  id(a, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, $2, $3, true) RETURNING id`, [c.empresa, nome, ordem]);

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("104: revisões v1 reais com hash idêntico; assinatura da Festa; recusas; imutabilidade; rollback e reaplicação; revisão v2 com o salão no hash", { timeout: 600_000 }, async () => {
  const semVersao = (await a.query(`SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped`)).rowCount;
  assert.equal(semVersao, 0, "modelo sem a 104");
  assert.equal(await assinatura(), assinaturaEstruturaFestaAtual, "antes da 104 = estrutura atual");

  // Revisões v1 de verdade, ANTES da 104.
  const D1 = dia(80), D2 = dia(81), D3 = dia(82);
  const v1 = await comCommit(async () => {
    const cs = await empresa("POR_SALAO");
    const S1 = await salao(cs, "Salão 1", 1), S2 = await salao(cs, "Salão 2", 2);
    // P: revisão aberta POR_SALAO com o salão do destino gravado (S1 ocupado por X em D2 → S2).
    const P = await contratada(cs, D1);
    const X = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
      SELECT $1::date, $2::time, $3::time, f.configuracao_agenda_id, f.empresa_id, f.pacote_id, f.tabela_preco_id, f.preco_pacote_id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
             'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $4::uuid FROM fechamentos f WHERE f.id = $5::uuid RETURNING fechamentos.id`, [D2, HORA.inicio, HORA.fim, S1, P.festa]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [X]);
    const rp = await P.abrir("Remarcação v1 POR_SALAO");
    await rp.editar(D2);
    // Q: aplicada; R: aberta e depois cancelada (depois da 104).
    const Q = await contratada(cs, D3);
    const rq = await Q.abrir("Revisão v1 aplicada");
    await rq.editar(D3, "Fundo do mar");
    await rq.concluir();
    // H: POR_HORARIO.
    const ch = await empresa("POR_HORARIO");
    const H = await contratada(ch, D1);
    const rh = await H.abrir("Revisão v1 POR_HORARIO");
    await rh.editar(D1, "Dinossauros");
    await validarAgora(a);
    return { rp, rq, rh, S1, S2, cs };
  });
  const p0 = await v1.rp.preparacao();
  assert.equal(p0.salao, v1.S2, "v1 com o salão do destino gravado (094)");
  assert.equal((await v1.rq.preparacao()).estado, "APLICADA");
  const ambiente = carregar<typeof import("../festas/ambiente.ts")>("lib/festas/ambiente.ts");
  await ambiente.validarAmbienteFesta(executor(a));
  const antes = await hashes();
  assert.ok(antes.size >= 3);
  for (const [k, v] of antes) { const [h, c] = v.split("|"); assert.equal(h, c, `revisão ${k}: hash gravado = função (antes)`); }

  // Aplicação da 104 (o arquivo traz BEGIN/COMMIT) e o postcheck.
  await a.query(sql(PRECHECK));
  await a.query(sql(MIGRATION));
  await a.query(sql(POSTCHECK));
  assert.deepEqual(await hashes(), antes, "hash de TODAS as revisões idêntico depois da 104");
  assert.equal((await a.query(`SELECT count(*)::int n FROM fechamento_revisoes WHERE hash_versao <> 1`)).rows[0].n, 0);
  const depois = await assinatura();
  console.log(`assinatura da estrutura da Festa depois da 104: ${depois}`);
  assert.notEqual(depois, assinaturaEstruturaFestaAtual);
  assert.notEqual(depois, assinaturaEstruturaFesta016);
  assert.equal(depois, assinaturaEstruturaFestaCom104, "depois da 104 = assinatura registrada em estrutura-016.ts");
  await ambiente.validarAmbienteFesta(executor(a));
  // Corpo mutado com o mesmo nome: o consumidor real recusa (só os dois estados conhecidos).
  await a.query("BEGIN");
  try {
    const corpo = (await a.query<{ s: string }>(`SELECT prosrc s FROM pg_proc WHERE oid = to_regprocedure('public.kidmais_hash_revisao_operacional(uuid)')`)).rows[0].s;
    await a.query(`CREATE OR REPLACE FUNCTION kidmais_hash_revisao_operacional(rid uuid) RETURNS text LANGUAGE sql STABLE AS $f$${corpo} $f$`);
    await recusa(ambiente.validarAmbienteFesta(executor(a)), /instalação não validada/);
  } finally { await a.query("ROLLBACK"); }
  await ambiente.validarAmbienteFesta(executor(a));
  // P3 do Astra (27/10): o postcheck confere a EXPRESSÃO da restrição e o gatilho sem WHEN/argumentos, não só os nomes.
  const recriarCk = (ck: string) => `ALTER TABLE fechamento_revisoes DROP CONSTRAINT fechamento_revisoes_hash_versao_ck;
    ALTER TABLE fechamento_revisoes ADD CONSTRAINT fechamento_revisoes_hash_versao_ck ${ck}`;
  const recriarGatilho = (corpo: string) => `DROP TRIGGER kidmais104_hash_versao_imutavel ON fechamento_revisoes;
    CREATE TRIGGER kidmais104_hash_versao_imutavel BEFORE UPDATE ON fechamento_revisoes FOR EACH ROW ${corpo}`;
  for (const [rotulo, ddl] of [
    ["CHECK ampliado", recriarCk("CHECK (hash_versao IN (1, 2, 3))")],
    ["CHECK sempre verdadeiro", recriarCk("CHECK (hash_versao IS NOT NULL OR true)")],
    ["CHECK não validado", recriarCk("CHECK (hash_versao IN (1, 2)) NOT VALID")],
    ["gatilho com WHEN", recriarGatilho("WHEN (false) EXECUTE FUNCTION kidmais104_hash_versao_imutavel()")],
    ["gatilho com argumento", recriarGatilho("EXECUTE FUNCTION kidmais104_hash_versao_imutavel('x')")],
  ] as const) {
    await a.query("BEGIN");
    try {
      await a.query(ddl);
      await recusa(a.query(sql(POSTCHECK)), /104 postcheck: coluna, restrição ou gatilho/);
    } catch (erro) { throw new Error(`mutante "${rotulo}": ${erro instanceof Error ? erro.message : String(erro)}`); }
    finally { await a.query("ROLLBACK"); }
  }
  await a.query(sql(POSTCHECK));
  // Recusas: reaplicação e precheck; imutabilidade.
  await recusa(a.query(sql(MIGRATION)), /104: precheck falhou \(já aplicada ou parcial\)/);
  await a.query("ROLLBACK").catch(() => undefined);
  await recusa(a.query(sql(PRECHECK)), /104 precheck: já aplicada ou parcial/);
  await recusa(a.query(`UPDATE fechamento_revisoes SET hash_versao = 2 WHERE id = $1::uuid`, [p0.id]), /não muda depois de criada/);

  // Rollback sem revisão v2: volta ao corpo e à assinatura anteriores, hashes idênticos; depois reaplica.
  await a.query(sql(DOWN));
  assert.equal(await assinatura(), assinaturaEstruturaFestaAtual, "rollback devolve a estrutura atual");
  assert.deepEqual(await hashes(), antes);
  await a.query(sql(MIGRATION));
  await a.query(sql(POSTCHECK));
  assert.equal(await assinatura(), assinaturaEstruturaFestaCom104);

  // v1 depois da 104: a aberta POR_HORARIO é aplicada e a POR_SALAO é cancelada, com os validadores no COMMIT.
  await comCommit(async () => { await v1.rh.concluir(); });
  assert.equal((await v1.rh.preparacao()).estado, "APLICADA");
  await comCommit(async () => { await v1.rp.cancelar(); await validarAgora(a); });
  assert.equal((await v1.rp.preparacao()).estado, "CANCELADA");
  assert.equal((await v1.rp.preparacao()).hash, p0.hash, "v1 cancelada com o mesmo hash");

  // Revisão NOVA em POR_SALAO depois da 104: nasce v2, hash da função na criação (revisão 1).
  const D4 = dia(84), D5 = dia(85);
  const v2 = await comCommit(async () => {
    const N = await contratada(v1.cs, D4);
    const rn = await N.abrir("Revisão v2");
    const criada = await rn.preparacao();
    assert.equal(criada.versao, 2, "POR_SALAO depois da 104 nasce em hash_versao 2");
    // A festa ocupa a agenda: a criação já escolhe o salão do destino (+1). Hash do INSERT errado daria +1 a mais (3).
    assert.ok(criada.salao, "salão do destino escolhido na criação");
    assert.equal(criada.revisao, 2, "hash do INSERT = função; só a escolha do salão somou 1");
    // Remarcação para D5: o salão do destino é escolhido (S1) e o hash final inclui o salão.
    await rn.editar(D5, "Espacial");
    const editada = await rn.preparacao();
    assert.equal(editada.salao, v1.S1);
    assert.equal(editada.hash, (await a.query<{ h: string }>(`SELECT kidmais_hash_revisao_operacional($1::uuid) h`, [editada.id])).rows[0].h);
    assert.equal(await rn.snapshotHash(), editada.hash, "o snapshot documenta o hash final");
    await validarAgora(a);
    return { rn, editada };
  });
  // Trocar SÓ o salão do destino: S1 deixa de ser elegível (inativo); a revalidação manual escolhe S2 → hash novo, revisão + 1.
  await comCommit(async () => {
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [v1.S1]);
    const r = await v2.rn.revalidar() as { revalidado: boolean; revisao: number };
    const trocada = await v2.rn.preparacao();
    assert.equal(trocada.salao, v1.S2, "destino passou a S2");
    assert.notEqual(trocada.hash, v2.editada.hash, "trocar só o salão muda o hash (v2)");
    assert.equal(trocada.revisao, v2.editada.revisao + 1);
    assert.equal(trocada.aprovada, null, "aprovação zerada");
    assert.equal(r.revisao, trocada.revisao, "a revalidação manual devolve o número relido");
    assert.equal(await v2.rn.snapshotHash(), trocada.hash, "o documento em elaboração foi recomposto com o hash novo");
    await validarAgora(a);
  });
  // Assinatura e aplicação da revisão v2: a festa vai para D5 no salão S2, com os validadores diferidos no COMMIT.
  await comCommit(async () => { await v2.rn.concluir(); });
  const aplicada = await v2.rn.preparacao();
  assert.equal(aplicada.estado, "APLICADA");
  const festaN = (await a.query<{ d: string; s: string }>(`SELECT f.data_evento::text d, f.salao_id::text s FROM fechamento_revisoes r JOIN fechamentos f ON f.id = r.fechamento_id WHERE r.id = $1::uuid`, [aplicada.id])).rows[0];
  assert.deepEqual(festaN, { d: D5, s: v1.S2 }, "festa aplicada no destino e no salão da revisão v2");
  // Com revisão v2 gravada, o rollback é recusado e nada muda.
  await recusa(a.query(sql(DOWN)), /104 rollback: há revisão com hash_versao 2/);
  await a.query("ROLLBACK").catch(() => undefined);
  assert.equal(await assinatura(), assinaturaEstruturaFestaCom104);
});

test("104: edição comercial + troca de salão juntas, cópia da revisão congelada e revalidação tolerante a conflito (pagamento)", { timeout: 600_000 }, async () => {
  const instalada = (await a.query(`SELECT 1 FROM pg_attribute WHERE attrelid = 'public.fechamento_revisoes'::regclass AND attname = 'hash_versao' AND NOT attisdropped`)).rowCount;
  if (!instalada) await a.query(sql(MIGRATION));
  const rs = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
  const rr = carregar<typeof import("../fechamentos/repositories/revisao.repository.ts")>("lib/fechamentos/repositories/revisao.repository.ts");
  const D6 = dia(90), D7 = dia(91);
  const r = await comCommit(async () => {
    const cs = await empresa("POR_SALAO");
    const S1 = await salao(cs, "Salão A", 1), S2 = await salao(cs, "Salão B", 2);
    const N = await contratada(cs, D6);
    const rn = await N.abrir("Comercial + salão");
    assert.equal((await rn.preparacao()).salao, S1);
    // S1 deixa de servir: a mesma edição muda data, comercial e o salão do destino (S2).
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [S1]);
    await rn.editar(D7, "Comercial", { confirmarAprovacao: true, forma: "PIX_AVISTA", baseNegociada: null, condicaoPix: null });
    const p = await rn.preparacao();
    assert.equal(p.salao, S2);
    assert.equal(p.aprovada, p.revisao, "a aprovação é da revisão final (depois da troca de salão)");
    const ap = (await a.query<{ h: string; n: number }>(`SELECT a.fechamento_revisao_hash h, a.fechamento_revisao_numero n FROM aprovacoes_negociacao a JOIN fechamento_revisoes r ON r.aprovacao_negociacao_id = a.id WHERE r.id = $1::uuid`, [p.id])).rows[0];
    assert.deepEqual(ap, { h: p.hash, n: p.revisao }, "aprovação aponta o hash e o número finais");
    assert.equal(await rn.snapshotHash(), p.hash);
    await validarAgora(a);
    return { cs, S1, S2, N, rn, p };
  });
  // Cópia (substituir a preparação congelada): o snapshot da versão nova documenta a revisão relida.
  const copia = await comCommit(async () => {
    await r.rn.congelar();
    await a.query(`UPDATE agenda_saloes SET ativo = true WHERE id = $1::uuid`, [r.S1]);
    await r.rn.substituir();
    const v3 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.N.contrato])).rows[0].id;
    const nova = (await rr.buscarRevisaoDaVersao(v3, executor(a)))!;
    assert.equal((nova as unknown as { hash_versao: number }).hash_versao, 2);
    assert.equal(nova.operacao.dataEvento, D7, "operação copiada");
    const doc = (await a.query<{ h: string }>(`SELECT snapshot->'revisaoOperacional'->>'conteudoHash' h FROM contrato_versoes WHERE id = $1`, [v3])).rows[0].h;
    assert.equal(doc, nova.conteudo_hash, "snapshot da cópia = hash da revisão relida");
    await validarAgora(a);
    return { v3, nova };
  });
  // Caminho do pagamento (naoFalharPorConflito): sem salão livre devolve livre=false com a revisão RELIDA; com salão, livre.
  const ctx = { usuarioId: null, requestId: randomUUID() };
  await a.query("BEGIN");
  try {
    await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = ANY($1::uuid[])`, [[r.S1, r.S2]]);
    const atual = (await rr.buscarRevisaoDaVersao(copia.v3, executor(a)))!;
    const res = await rs.revalidarAgendaRevisao(executor(a), atual, ctx, { naoFalharPorConflito: true });
    assert.equal(res.livre, false);
    const banco = (await a.query<{ h: string; n: number; s: string | null }>(`SELECT conteudo_hash h, revisao n, salao_id::text s FROM fechamento_revisoes WHERE id = $1::uuid`, [atual.id])).rows[0];
    assert.equal(banco.s, null, "sem salão elegível o destino fica sem salão");
    assert.equal(res.revisao.conteudo_hash, banco.h, "o retorno tolerante já reflete a escrita");
    assert.equal(res.revisao.revisao, banco.n);
    assert.notEqual(banco.h, atual.conteudo_hash);
  } finally { await a.query("ROLLBACK"); }
  await a.query("BEGIN");
  try {
    const atual = (await rr.buscarRevisaoDaVersao(copia.v3, executor(a)))!;
    const res = await rs.revalidarAgendaRevisao(executor(a), atual, ctx, { naoFalharPorConflito: true });
    assert.equal(res.livre, true);
    assert.equal(res.revisao.conteudo_hash, (await a.query<{ h: string }>(`SELECT conteudo_hash h FROM fechamento_revisoes WHERE id = $1::uuid`, [atual.id])).rows[0].h);
  } finally { await a.query("ROLLBACK"); }
});
