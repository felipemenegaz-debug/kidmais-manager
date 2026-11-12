import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cenario, executor, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import {
  abrirImportacao, atualizarImportacao, importacaoPorAbertura, importacaoPorDocumento, LIMITE_ABERTURAS, lerImportacao, listarParaRevisao, registrarAbertura, reimportacaoInstalada,
  substituirImportacaoCancelada, travarDocumento,
} from "./repositorio-importacao.ts";

/**
 * Lote L1 (plano rev. 5.1) no PostgreSQL DESCARTÁVEL, pelo repositório real (sem migration nova):
 * - lista "aguardando revisão": dois grupos, ordem e cursor estáveis, isolamento por empresa, somente leitura;
 * - identidades de abertura: limite de 200 (A0..A199 aceitas, A200 recusada, A0 recuperável), repetição sem gravação,
 *   importação encerrada não muda (guarda 055d), outra empresa não vê nem grava;
 * - toda escrita em `dados` preserva a lista atual de aberturas (revisar/cliente/preparar/descartar/Import Engine, 064);
 * - concorrência: `retomar` espera o `abrir` em voo na trava do documento e acha a identidade registrada por ele.
 * Os testes de lista e de identidade terminam em ROLLBACK; o de concorrência usa dados próprios confirmados.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
const ab = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

test.before(async () => { if (opt()) a = await conectarDescartavel(); });
test.after(async () => { if (a) await encerrarDescartavel(a); });

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  try { await corpo(); } finally { await a.query("ROLLBACK"); }
}

type Campo = { id: string; valor: string | null; normalizado?: string | null };
const resultado = (campos: Campo[]) => ({ secoes: [{ id: "s", campos }] });
const camposDe = (contratante: string | null, data: string | null) => [
  { id: "contratante.nome", valor: contratante },
  { id: "evento.data", valor: data ? `${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)}` : null, normalizado: data },
];

/** Documento com original (nome) e extração (resultado); `enviadoEm` controla o desempate. */
async function documento(db: Client, c: Cenario, o: { nome?: string; campos: Campo[]; enviadoEm: string }) {
  const doc = await id(db, `INSERT INTO ia_documentos (empresa_id, tipo, status, enviado_por, enviado_em) VALUES ($1::uuid, 'CONTRATO_HISTORICO', 'RECEBIDO', $2::uuid, $3::timestamptz) RETURNING id`, [c.empresa, c.usuario, o.enviadoEm]);
  const pdf = Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n%%EOF\n`);
  const original = await id(db, `INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
     VALUES ($1::uuid, $2::uuid, 1, $3, 'application/pdf', $4, encode(sha256($5), 'hex'), $5, $6::uuid) RETURNING id`, [doc, c.empresa, o.nome ?? "contrato.pdf", pdf.length, pdf, c.usuario]);
  const extracao = await id(db, `INSERT INTO ia_extracoes (documento_id, empresa_id, original_id, metodo, schema_versao, status, resultado, correlation_id, iniciado_em, concluido_em)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'DETERMINISTICO', 1, 'SUCESSO', $4::jsonb, 'l1', now(), now()) RETURNING id`, [doc, c.empresa, original, JSON.stringify(resultado(o.campos))]);
  return { doc, extracao, campos: o.campos };
}
async function revisao(db: Client, c: Cenario, d: { doc: string; extracao: string; campos: Campo[] }, extra: Record<string, unknown> = {}) {
  return id(db, `INSERT INTO ia_importacoes (documento_id, empresa_id, extracao_id, status, versao, dados, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, 'EM_REVISAO', 1, $4::jsonb, $5::uuid) RETURNING id`,
    [d.doc, c.empresa, d.extracao, JSON.stringify({ extracao: resultado(d.campos), revisados: [], decisaoCliente: null, ...extra }), c.usuario]);
}
const assinatura = async (db: Client) => (await db.query<{ h: string }>(
  `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM (
     SELECT i::text AS t FROM ia_importacoes i UNION ALL SELECT d::text FROM ia_documentos d UNION ALL SELECT e::text FROM ia_extracoes e) x`)).rows[0].h;

test("L1 listar: grupos REVISAO e LIDO, ordem por festa/envio/documento, cursor sem repetição, empresa isolada, nada gravado", { skip: !opt(), timeout: 120_000 }, async () => {
  await emTx(async () => {
    const db = executor(a);
    const A = await cenario(a); const B = await cenario(a);
    const t = (m: number) => `2026-11-03T12:${String(m).padStart(2, "0")}:00.123456Z`;
    const lido1201 = await documento(a, A, { nome: "lido 123.456.789-09.pdf", campos: camposDe("Bia", "2026-12-01"), enviadoEm: t(5) });
    const rev1210 = await documento(a, A, { campos: camposDe("Ana", "2026-12-10"), enviadoEm: t(1) });
    const rev1210b = await documento(a, A, { campos: camposDe("Caio", "2026-12-10"), enviadoEm: t(2) });
    const revSemData = await documento(a, A, { campos: camposDe("Duda", null), enviadoEm: t(0) });
    const revDataRuim = await documento(a, A, { campos: [{ id: "contratante.nome", valor: "Eva" }, { id: "evento.data", valor: "31/02", normalizado: "31/02/2026" }], enviadoEm: t(3) });
    const vazio = await documento(a, A, { campos: [{ id: "contratante.nome", valor: "   " }], enviadoEm: t(4) });
    const descartado = await documento(a, A, { campos: camposDe("Fábio", "2026-11-20"), enviadoEm: t(6) });
    const importado = await documento(a, A, { campos: camposDe("Gil", "2026-11-21"), enviadoEm: t(7) });
    const deB = await documento(a, B, { campos: camposDe("Outra", "2026-11-01"), enviadoEm: t(8) });
    const lidoB = await documento(a, B, { campos: camposDe("Outra lida", "2026-11-02"), enviadoEm: t(9) });
    const ids = { r1: await revisao(a, A, rev1210), r2: await revisao(a, A, rev1210b), r3: await revisao(a, A, revSemData), r4: await revisao(a, A, revDataRuim) };
    const desc = await revisao(a, A, descartado);
    await a.query(`UPDATE ia_importacoes SET status = 'DESCARTADA', versao = 2 WHERE id = $1::uuid`, [desc]);
    const imp = await revisao(a, A, importado);
    await a.query(`UPDATE ia_importacoes SET status = 'IMPORTADA', versao = 2, cliente_id = $2::uuid, resultado = '{}'::jsonb WHERE id = $1::uuid`,
      [imp, await id(a, `INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp) VALUES ('Gil', $1::uuid, '11999990000', '11999990000') RETURNING id`, [A.empresa])]);
    await revisao(a, B, deB);
    void vazio; void lidoB;

    const antes = await assinatura(a);
    const pagina = await listarParaRevisao(db, A.empresa, { limite: 50, cursor: null });
    const esperado = [
      ["LIDO", lido1201.doc, null, "2026-12-01", "Bia"],
      ["REVISAO", rev1210.doc, ids.r1, "2026-12-10", "Ana"],
      ["REVISAO", rev1210b.doc, ids.r2, "2026-12-10", "Caio"],
      // Sem data válida: por último, pelo envio.
      ["REVISAO", revSemData.doc, ids.r3, null, "Duda"],
      ["REVISAO", revDataRuim.doc, ids.r4, null, "Eva"],
    ];
    assert.deepEqual(pagina.linhas.map((l) => [l.grupo, l.documentoId, l.importacaoId, l.dataFesta, l.contratante]), esperado);
    assert.equal(pagina.proximo, null);
    assert.equal(pagina.linhas[0].arquivo, "lido 123.456.789-09.pdf", "a linha bruta sai do repositório; a sanitização é do DTO");
    assert.match(pagina.linhas[0].enviadoEm, /^2026-11-03T12:05:00\.123456Z$/);
    assert.deepEqual(pagina.linhas.map((l) => l.versao), [null, 1, 1, 1, 1]);
    // Cursor: páginas de 1 percorrem a mesma ordem, sem repetição nem salto, inclusive no empate de data e no grupo sem data.
    const vistos: string[] = [];
    let cursor = null as Awaited<ReturnType<typeof listarParaRevisao>>["proximo"];
    for (let k = 0; k < 10; k++) {
      const p = await listarParaRevisao(db, A.empresa, { limite: 1, cursor });
      vistos.push(...p.linhas.map((l) => l.documentoId));
      cursor = p.proximo;
      if (!cursor) break;
    }
    assert.deepEqual(vistos, esperado.map((e) => e[1]));
    // Empresa B só vê a própria revisão e o próprio lido; A não aparece.
    const deBLista = await listarParaRevisao(db, B.empresa, { limite: 50, cursor: null });
    assert.deepEqual(deBLista.linhas.map((l) => [l.grupo, l.contratante]), [["REVISAO", "Outra"], ["LIDO", "Outra lida"]]);
    // Cursor de A usado por B não vaza nada de A.
    const cruzado = await listarParaRevisao(db, B.empresa, { limite: 50, cursor: { k: "0000-00-00", t: "2000-01-01T00:00:00.000000Z", id: rev1210.doc } });
    assert.ok(cruzado.linhas.every((l) => l.contratante?.startsWith("Outra")));
    assert.equal(await assinatura(a), antes, "listar não grava");
  });
});

test("L1 identidades: A0..A199 aceitas, A200 recusada sem gravar, A0 recuperável, 50 repetições sem gravar, encerrada não muda, outra empresa não vê", { skip: !opt(), timeout: 180_000 }, async () => {
  await emTx(async () => {
    const db = executor(a);
    const A = await cenario(a); const B = await cenario(a);
    const d = await documento(a, A, { campos: camposDe("Ana", "2026-12-10"), enviadoEm: "2026-11-03T12:00:00Z" });
    const imp = await revisao(a, A, d);
    for (let k = 0; k < LIMITE_ABERTURAS; k++) {
      const r = await registrarAbertura(db, A.empresa, imp, ab(k));
      assert.equal(r.tipo, "REGISTRADA", `A${k}`);
      if (r.tipo === "REGISTRADA") assert.equal(r.importacao.versao, k + 2, "registrar sobe a versão (055d)");
    }
    const versao = (await lerImportacao(db, A.empresa, imp, false))!.versao;
    assert.deepEqual(await registrarAbertura(db, A.empresa, imp, ab(LIMITE_ABERTURAS)), { tipo: "LIMITE" });
    assert.equal((await lerImportacao(db, A.empresa, imp, false))!.versao, versao, "A200 não gravou");
    assert.equal((await importacaoPorAbertura(db, A.empresa, d.doc, ab(LIMITE_ABERTURAS))), null);
    for (let k = 0; k < 50; k++) {
      assert.deepEqual(await registrarAbertura(db, A.empresa, imp, ab(0)), { tipo: "JA_REGISTRADA" });
      assert.equal((await importacaoPorAbertura(db, A.empresa, d.doc, ab(0)))?.id, imp);
    }
    assert.equal((await lerImportacao(db, A.empresa, imp, false))!.versao, versao, "50 repetições sem gravar");
    const lista = (await a.query<{ n: number; distintos: number }>(`SELECT jsonb_array_length(dados->'aberturas') n, (SELECT count(DISTINCT x) FROM jsonb_array_elements_text(dados->'aberturas') x)::int distintos FROM ia_importacoes WHERE id = $1::uuid`, [imp])).rows[0];
    assert.deepEqual(lista, { n: 200, distintos: 200 });
    // Outra empresa: não trava, não acha, não grava (mesmo com o id certo).
    assert.equal(await travarDocumento(db, B.empresa, d.doc), false);
    assert.equal(await importacaoPorAbertura(db, B.empresa, d.doc, ab(0)), null);
    await assert.rejects(registrarAbertura(db, B.empresa, imp, ab(999)), /IMPORTACAO_CONFLITO/);
    assert.equal(await travarDocumento(db, A.empresa, d.doc), true);
    // Encerrada (IMPORTADA): nada grava; a guarda 055d recusaria qualquer UPDATE.
    const d2 = await documento(a, A, { campos: camposDe("Bia", null), enviadoEm: "2026-11-03T12:01:00Z" });
    const imp2 = await revisao(a, A, d2, { aberturas: [ab(1)] });
    await a.query(`UPDATE ia_importacoes SET status = 'IMPORTADA', versao = 2, cliente_id = $2::uuid, resultado = '{}'::jsonb WHERE id = $1::uuid`,
      [imp2, await id(a, `INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp) VALUES ('Bia', $1::uuid, '11999990000', '11999990000') RETURNING id`, [A.empresa])]);
    assert.deepEqual(await registrarAbertura(db, A.empresa, imp2, ab(2)), { tipo: "ENCERRADA" });
    assert.deepEqual(await registrarAbertura(db, A.empresa, imp2, ab(1)), { tipo: "JA_REGISTRADA" });
    assert.equal((await importacaoPorAbertura(db, A.empresa, d2.doc, ab(1)))?.status, "IMPORTADA");
    // Descartada + nova ativa com a mesma identidade herdada: a ativa vem primeiro.
    const d3 = await documento(a, A, { campos: camposDe("Caio", null), enviadoEm: "2026-11-03T12:02:00Z" });
    const velha = await revisao(a, A, d3, { aberturas: [ab(5)] });
    await a.query(`UPDATE ia_importacoes SET status = 'DESCARTADA', versao = 2 WHERE id = $1::uuid`, [velha]);
    const nova = await revisao(a, A, d3, { aberturas: [ab(5)] });
    assert.equal((await importacaoPorAbertura(db, A.empresa, d3.doc, ab(5)))?.id, nova);
  });
});

test("L1 toda escrita em dados preserva as aberturas atuais: revisar/cliente/preparar/descartar, Import Engine e 064", { skip: !opt(), timeout: 120_000 }, async (ctx) => {
  await emTx(async () => {
    const db = executor(a);
    const A = await cenario(a);
    const d = await documento(a, A, { campos: camposDe("Ana", "2026-12-10"), enviadoEm: "2026-11-03T12:00:00Z" });
    const imp = await revisao(a, A, d, { aberturas: [ab(1)] });
    const aberturas = async () => (await a.query<{ x: unknown }>(`SELECT dados->'aberturas' x FROM ia_importacoes WHERE id = $1::uuid`, [imp])).rows[0].x;
    // Cada "tela" lê, a identidade A2 chega entre a leitura e a escrita (versão relida) e a escrita manda dados sem/com lista forjada.
    for (const forjar of [undefined, [], [ab(66)], "lixo"]) {
      const lida = (await lerImportacao(db, A.empresa, imp, true))!;
      const extra = randomUUID();
      const r = await registrarAbertura(db, A.empresa, imp, extra);
      assert.equal(r.tipo, "REGISTRADA");
      const atual = (await lerImportacao(db, A.empresa, imp, true))!;
      const dados = { ...(lida.dados as Record<string, unknown>), revisados: [{ campoId: "contratante.nome", valor: `x${extra}` }] } as Record<string, unknown>;
      if (forjar === undefined) delete dados.aberturas; else dados.aberturas = forjar;
      assert.equal(await atualizarImportacao(db, A.empresa, { ...atual, dados, versao: atual.versao + 1 }, atual.versao), true);
      const lista = await aberturas() as string[];
      assert.ok(lista.includes(ab(1)) && lista.includes(extra) && !lista.includes(ab(66)), JSON.stringify(lista));
    }
    // Versão velha (aba antiga): compare-and-set recusa sem gravar.
    const atual = (await lerImportacao(db, A.empresa, imp, true))!;
    assert.equal(await atualizarImportacao(db, A.empresa, { ...atual, dados: {}, versao: atual.versao + 1 }, atual.versao - 1), false);
    const n = (await aberturas() as string[]).length;
    // Import Engine: a conclusão (IMPORTADA) também passa por atualizarImportacao e mantém a lista.
    const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp) VALUES ('Ana', $1::uuid, '11999990000', '11999990000') RETURNING id`, [A.empresa]);
    assert.equal(await atualizarImportacao(db, A.empresa, { ...atual, status: "IMPORTADA", clienteId: cliente, resultado: { clienteId: cliente } as never, dados: { extracao: atual.dados.extracao }, versao: atual.versao + 1 }, atual.versao), true);
    assert.equal((await aberturas() as string[]).length, n);
    // 064 sem contrato cancelado ⇒ false, nada muda.
    const importada = (await lerImportacao(db, A.empresa, imp, false))!;
    assert.equal(await substituirImportacaoCancelada(db, A.empresa, importada, A.usuario), false);
    assert.equal((await aberturas() as string[]).length, n);
    // r2: 064 ESCREVENDO de fato. Só o predicado "contrato cancelado?" é trocado dentro desta transação (ROLLBACK no
    // fim); a guarda 064 da tabela e o UPDATE real do repositório rodam como em produção.
    if (!(await reimportacaoInstalada(db))) { ctx.diagnostic("064 ausente neste modelo: escrita da 064 não se aplica"); return; }
    await a.query(`CREATE OR REPLACE FUNCTION kidmais064_contrato_cancelado(importacao uuid) RETURNS boolean
      LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT importacao = '${imp}'::uuid $$`);
    assert.equal(await substituirImportacaoCancelada(db, A.empresa, importada, A.usuario), true, "064 escreveu");
    const depois = (await lerImportacao(db, A.empresa, imp, false))!;
    assert.equal(depois.status, "DESCARTADA");
    assert.equal(depois.versao, importada.versao + 1);
    assert.ok((depois.dados as { substituicao?: unknown }).substituicao, "resultado anterior em dados.substituicao");
    assert.equal((await aberturas() as string[]).length, n, "064 preserva as aberturas");
    assert.equal((await importacaoPorAbertura(db, A.empresa, d.doc, ab(1)))?.id, imp, "identidade continua achando a substituída");
    ctx.diagnostic("064 instalada: escrita real exercitada");
  });
});

test("L1 concorrência: retomar espera o abrir em voo na trava do documento e acha a identidade; duas identidades em paralelo não se perdem", { skip: !opt(), timeout: 120_000 }, async () => {
  const b = await conectarDescartavel({ travar: false });
  try {
    // Dados próprios confirmados (cluster descartável): as duas conexões precisam enxergá-los.
    const A = await cenario(a);
    const d = await documento(a, A, { campos: camposDe("Ana", "2026-12-10"), enviadoEm: "2026-11-03T12:00:00Z" });
    const imp = await revisao(a, A, d);
    const dbA = executor(a); const dbB = executor(b);

    await a.query("BEGIN");
    assert.equal(await travarDocumento(dbA, A.empresa, d.doc), true);
    await b.query("BEGIN");
    let liberado = false;
    const espera = travarDocumento(dbB, A.empresa, d.doc).then((ok) => { liberado = true; return ok; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(liberado, false, "retomar fica na trava enquanto o abrir não termina");
    assert.equal((await registrarAbertura(dbA, A.empresa, imp, ab(1))).tipo, "REGISTRADA");
    await a.query("COMMIT");
    assert.equal(await espera, true);
    assert.equal((await importacaoPorAbertura(dbB, A.empresa, d.doc, ab(1)))?.id, imp, "retomar acha a identidade gravada pelo abrir");
    await b.query("COMMIT");

    // Duas identidades em paralelo (sem a trava do documento): a trava de linha do UPDATE serializa e nenhuma se perde.
    await a.query("BEGIN"); await b.query("BEGIN");
    assert.equal((await registrarAbertura(dbA, A.empresa, imp, ab(2))).tipo, "REGISTRADA");
    const segunda = registrarAbertura(dbB, A.empresa, imp, ab(3));
    await new Promise((r) => setTimeout(r, 200));
    await a.query("COMMIT");
    assert.equal((await segunda).tipo, "REGISTRADA");
    await b.query("COMMIT");
    const lista = (await a.query<{ x: string[] }>(`SELECT dados->'aberturas' x FROM ia_importacoes WHERE id = $1::uuid`, [imp])).rows[0].x;
    assert.deepEqual(lista, [ab(1), ab(2), ab(3)]);
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    await b.end();
  }
});

test("r2 P2-1 concorrência: abrir trava a importação achada; o descarte de outra aba espera, preserva a identidade e retomar acha a descartada sem criar", { skip: !opt(), timeout: 120_000 }, async () => {
  const b = await conectarDescartavel({ travar: false });
  try {
    const A = await cenario(a);
    const d = await documento(a, A, { campos: camposDe("Rui", "2026-12-11"), enviadoEm: "2026-11-03T13:00:00Z" });
    const imp = await revisao(a, A, d);
    const dbA = executor(a); const dbB = executor(b);
    const total = async () => (await a.query<{ n: number }>(`SELECT count(*)::int n FROM ia_importacoes WHERE documento_id = $1::uuid`, [d.doc])).rows[0].n;

    // A (abrir do lote): trava do documento, busca a ativa e TRAVA a linha (como revisao.ts faz desde a r2).
    await a.query("BEGIN");
    assert.equal(await travarDocumento(dbA, A.empresa, d.doc), true);
    const achada = await abrirImportacao(dbA, { empresaId: A.empresa, documentoId: d.doc, extracaoId: d.extracao, usuarioId: A.usuario, dados: {} });
    assert.equal(achada.id, imp);
    const travada = (await lerImportacao(dbA, A.empresa, imp, true))!;
    assert.equal(travada.status, "EM_REVISAO");
    // B (descartar de outra aba): lê com FOR UPDATE como a rota faz ⇒ espera.
    await b.query("BEGIN");
    let liberado = false;
    const descarte = (async () => {
      const atual = (await lerImportacao(dbB, A.empresa, imp, true))!;
      liberado = true;
      return atualizarImportacao(dbB, A.empresa, { ...atual, status: "DESCARTADA", versao: atual.versao + 1, dados: { ...(atual.dados as object), aberturas: [] } }, atual.versao);
    })();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(liberado, false, "o descarte espera a trava do abrir");
    assert.equal((await registrarAbertura(dbA, A.empresa, imp, ab(41))).tipo, "REGISTRADA");
    await a.query("COMMIT");
    assert.equal(await descarte, true, "o descarte segue com a versão relida depois do abrir");
    await b.query("COMMIT");
    const final = (await lerImportacao(dbA, A.empresa, imp, false))!;
    assert.equal(final.status, "DESCARTADA");
    assert.deepEqual((final.dados as { aberturas?: string[] }).aberturas, [ab(41)], "o descarte preservou a identidade");
    // retomar: acha pela identidade (DESCARTADA), sem criar. Total continua 1.
    assert.equal((await importacaoPorAbertura(dbA, A.empresa, d.doc, ab(41)))?.id, imp);
    assert.equal(await total(), 1);
    // Identidade que nunca gravou, só com histórico encerrado: o servidor recusa (RECUPERACAO_AMBIGUA) pelo que este
    // repositório devolve — a importação do documento existe e não está aberta.
    assert.equal(await importacaoPorAbertura(dbA, A.empresa, d.doc, ab(42)), null);
    assert.equal((await importacaoPorDocumento(dbA, A.empresa, d.doc))?.status, "DESCARTADA");
    assert.equal(await total(), 1);
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    await b.end();
  }
});
