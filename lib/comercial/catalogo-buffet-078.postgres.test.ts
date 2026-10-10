import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import { salvarAdicionalEmEtapas } from "./adicionais-admin.ts";
import { adicionaisDoPacoteNoTenant } from "./adicionais-tenant.ts";
import { criarCategoriaBuffet, criarItemBuffet, editarCategoriaBuffet, excluirCategoriaBuffet, lerCatalogoBuffet } from "./catalogo-buffet.ts";
import { gravarFaixasPacote } from "./pacote-precos.ts";
import { definirCategoriasPacoteAdmin, definirDisponibilidadePacoteAdmin, definirItensEspecificosPacoteAdmin } from "./pacotes-admin.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { calcularResumoComercial } from "./services/pricing.service.ts";

/**
 * 078 no PostgreSQL DESCARTÁVEL (modelo 063 + 070 + 078 aplicadas aqui), com dados criados ANTES da 078:
 *  - o catálogo atual vira da Kidmais sem mudar nada (ids, códigos, nomes, composição dos pacotes dela);
 *  - outra empresa que já usava categorias/itens recebe cópia só do que usa e os vínculos dela passam para a cópia;
 *  - as cópias mantêm os códigos (categorias e itens sem categoria, via pacote e via adicional): a unicidade passa a ser
 *    por empresa ANTES das cópias;
 *  - empresa sem uso não recebe nada; pedido e escolha de buffet já gravados continuam idênticos;
 *  - depois: duas empresas com a MESMA categoria (SALGADOS) e itens diferentes — leitura, escrita, composição,
 *    adicional do buffet, escolha no pedido e cotação nunca cruzam empresas (serviço e gatilho do banco).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");
const M070 = "database/migrations/20261007_070_adicionais_do_buffet.sql";
const M078 = "database/migrations/20261010_078_catalogo_buffet_por_empresa.sql";

let client: Client;
let tx: DbExecutor;
const sufixo = randomBytes(3).toString("hex");
const ctx = (empresaId: string) => ({ empresaId, usuarioId: randomUUID(), requestId: randomUUID(), motivo: "PACOTE_EDITADO" });
const { resolverEscolhasBuffet } = carregarModulo("lib/fechamentos/services/escolhas-buffet.service.ts", {}, new Map()) as {
  resolverEscolhasBuffet: (tx: DbExecutor, pacoteId: string, escolhas: Record<string, string[]>, status?: string) => Promise<unknown>;
};

async function emTransacao<T>(trabalho: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const r = await trabalho();
    await client.query("COMMIT");
    return r;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}
async function empresa(nome: string) {
  return (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`,
    [`e78${nome}${sufixo}`.toLowerCase(), `Empresa 078 ${nome}`],
  )).rows[0].id;
}
async function pacote(empresaId: string, codigo: string) {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
     VALUES ($1::uuid, $2, $3, 780, true, true, 20, 30) RETURNING id::text AS id`,
    [empresaId, codigo, `Pacote ${codigo}`],
  )).rows[0].id;
  await emTransacao(() => gravarFaixasPacote(tx, empresaId, id, [{ convidadosMin: 20, convidadosMax: 30, valor: "1000.00" }], { minimo: 20, maximo: 30 }, ctx(empresaId)));
  return id;
}
/** Impressão das linhas (ordenadas) de uma tabela: prova que a 078 não tocou em nada dela. */
async function impressao(tabela: string) {
  const r = await client.query(`SELECT to_jsonb(t) AS linha FROM ${tabela} t`);
  return createHash("sha256").update(r.rows.map((l) => JSON.stringify(l.linha)).sort().join("\n")).digest("hex");
}
const TABELAS_HISTORICO = ["fechamentos", "fechamento_buffet_snapshots", "fechamento_buffet_escolhas", "fechamento_pacote_snapshots",
  "fechamento_pacote_composicao", "fechamento_pacote_itens_especificos"];

let kidmais: string;
let OUTRA: string;
let NOVA: string;
let pacoteOutra: string;
let salgadosGlobal: string;
let docesGlobal: string;
let coxinhaGlobal: string;
let kibeGlobal: string;
let brigadeiroGlobal: string;
let soltoGlobal: string;
let soltoAdicionalGlobal: string;
let adicionalOutra: string;
let adicionalSoltoOutra: string;
let escolhaAntes: { categoria_id: string; item_id: string; item_nome_aplicado: string };
const antes: Record<string, unknown> = {};

test.before(async () => {
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("antes da 078: 070 aplicada; catálogo global da 022 em uso pela Kidmais e por OUTRA (pacote, item solto, adicional e pedido)", async () => {
  await client.query(arquivo(M070));
  kidmais = (await client.query<{ id: string }>(`SELECT id::text AS id FROM empresas WHERE codigo = 'kidmais'`)).rows[0].id;
  const id = async (sql: string, p: unknown[] = []) => (await client.query<{ id: string }>(sql, p)).rows[0].id;
  salgadosGlobal = await id(`SELECT id::text AS id FROM buffet_categorias WHERE codigo = 'SALGADOS'`);
  docesGlobal = await id(`SELECT id::text AS id FROM buffet_categorias WHERE codigo = 'DOCES'`);
  coxinhaGlobal = await id(`SELECT id::text AS id FROM buffet_itens WHERE categoria_id = $1::uuid ORDER BY ordem_exibicao, nome LIMIT 1`, [salgadosGlobal]);
  kibeGlobal = await id(`SELECT id::text AS id FROM buffet_itens WHERE categoria_id = $1::uuid ORDER BY ordem_exibicao, nome OFFSET 1 LIMIT 1`, [salgadosGlobal]);
  brigadeiroGlobal = await id(`SELECT id::text AS id FROM buffet_itens WHERE categoria_id = $1::uuid ORDER BY ordem_exibicao, nome LIMIT 1`, [docesGlobal]);
  soltoGlobal = await id(`INSERT INTO buffet_itens (categoria_id, codigo, nome) VALUES (NULL, $1, 'Taxa de rolha 078') RETURNING id::text AS id`, [`ROLHA_078_${sufixo}`.toUpperCase()]);
  // Segundo item sem categoria, usado por OUTRA só como origem de adicional (o código também é copiado).
  soltoAdicionalGlobal = await id(`INSERT INTO buffet_itens (categoria_id, codigo, nome) VALUES (NULL, $1, 'Gelo 078') RETURNING id::text AS id`, [`GELO_078_${sufixo}`.toUpperCase()]);

  OUTRA = await empresa("Outra");
  NOVA = await empresa("Nova");
  pacoteOutra = await pacote(OUTRA, `P78OUT${sufixo}`.toUpperCase());
  await client.query(`INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, modo_itens, escolhas_min, escolhas_max) VALUES ($1::uuid, $2::uuid, 'SELECIONADOS', 0, 2)`, [pacoteOutra, salgadosGlobal]);
  await client.query(`INSERT INTO pacote_buffet_itens (pacote_id, categoria_id, item_id) VALUES ($1::uuid, $2::uuid, $3::uuid), ($1::uuid, $2::uuid, $4::uuid)`, [pacoteOutra, salgadosGlobal, coxinhaGlobal, kibeGlobal]);
  await client.query(`INSERT INTO pacote_itens_especificos (pacote_id, item_id) VALUES ($1::uuid, $2::uuid)`, [pacoteOutra, soltoGlobal]);
  adicionalOutra = (await salvarAdicionalEmEtapas((t) => emTransacao(() => t(tx)), ctx(OUTRA),
    { origem: { tipo: "ITEM", id: brigadeiroGlobal }, nome: "Brigadeiro extra", categoria: "BUFFET", unidadeCobranca: "CENTO", ativo: true, preco: "90.00" })).id;
  adicionalSoltoOutra = (await salvarAdicionalEmEtapas((t) => emTransacao(() => t(tx)), ctx(OUTRA),
    { origem: { tipo: "ITEM", id: soltoAdicionalGlobal }, nome: "Gelo extra", categoria: "BUFFET", unidadeCobranca: "UNIDADE", ativo: true, preco: "15.00" })).id;

  // Pedido de OUTRA, já gravado, com escolha de buffet apontando para o catálogo global.
  const agenda = (await client.query<{ id: string }>("SELECT id::text AS id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1")).rows[0].id;
  const preco = (await client.query<{ id: string; tabela: string; valor: string }>(
    `SELECT pp.id::text AS id, pp.tabela_preco_id::text AS tabela, pp.valor::text AS valor FROM precos_pacote pp WHERE pp.pacote_id = $1::uuid AND pp.ativo LIMIT 1`, [pacoteOutra])).rows[0];
  const fechamento = await id(
    `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, desconto_percentual, valor_desconto_pacote,
       valor_pacote_aplicado, valor_adicionais, valor_tabela, status, origem_fechamento)
     VALUES (CURRENT_DATE + 40, TIME '10:00', TIME '14:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, $6, 0, 0, $6, 0, $6,
             'RASCUNHO', 'ATENDIMENTO_KIDMAIS') RETURNING id::text AS id`,
    [agenda, OUTRA, pacoteOutra, preco.tabela, preco.id, preco.valor]);
  const snapshot = await id(`INSERT INTO fechamento_buffet_snapshots (fechamento_id) VALUES ($1::uuid) RETURNING id::text AS id`, [fechamento]);
  await client.query(
    `INSERT INTO fechamento_buffet_escolhas (snapshot_id, categoria_id, item_id, categoria_nome_aplicado, item_nome_aplicado, ordem_aplicada)
     SELECT $1::uuid, c.id, i.id, c.nome, i.nome, 1 FROM buffet_categorias c JOIN buffet_itens i ON i.categoria_id = c.id WHERE i.id = $2::uuid`,
    [snapshot, coxinhaGlobal]);

  antes.catalogo = (await client.query(`SELECT id::text, codigo, nome, ordem_exibicao, ativo FROM buffet_categorias WHERE codigo NOT LIKE '%078%' ORDER BY id`)).rows;
  antes.itens = (await client.query(`SELECT id::text, categoria_id::text, codigo, nome, ativo FROM buffet_itens ORDER BY id`)).rows;
  antes.composicaoKidmais = (await client.query(
    `SELECT r.pacote_id::text, r.categoria_id::text, r.modo_itens, r.escolhas_min, r.escolhas_max, r.ativo FROM pacote_buffet_categorias r
       JOIN pacotes p ON p.id = r.pacote_id WHERE p.empresa_id = $1::uuid ORDER BY 1, 2`, [kidmais])).rows;
  for (const t of TABELAS_HISTORICO) antes[t] = await impressao(t);
  escolhaAntes = (await client.query(`SELECT categoria_id::text, item_id::text, item_nome_aplicado FROM fechamento_buffet_escolhas WHERE snapshot_id = $1::uuid`, [snapshot])).rows[0];
});

test("078: precheck lista só OUTRA; migration e postcheck; segunda aplicação recusada", async () => {
  const pre = await client.query(arquivo("database/checks/20261010_078_precheck.sql")) as unknown as Array<{ rows: Array<Record<string, unknown>> }>;
  const copias = pre.flatMap((r) => r.rows ?? []).filter((l) => "empresa_que_recebe_copia" in l).map((l) => l.empresa_que_recebe_copia);
  assert.ok(copias.includes(`e78outra${sufixo}`.toLowerCase()), "OUTRA aparece na lista");
  assert.ok(!copias.includes(`e78nova${sufixo}`.toLowerCase()), "NOVA (sem uso) não aparece");
  await client.query(arquivo(M078));
  await client.query(arquivo("database/checks/20261010_078_postcheck.sql"));
  await recusa(client.query(arquivo(M078)), /078 já aplicada/);
  await client.query("ROLLBACK").catch(() => undefined);
});

test("Kidmais: cardápio, ids e composição idênticos, agora com empresa_id da Kidmais", async () => {
  const depois = (await client.query(`SELECT id::text, codigo, nome, ordem_exibicao, ativo FROM buffet_categorias WHERE empresa_id = $1::uuid ORDER BY id`, [kidmais])).rows;
  assert.deepEqual(depois, antes.catalogo);
  const itens = (await client.query(`SELECT id::text, categoria_id::text, codigo, nome, ativo FROM buffet_itens WHERE empresa_id = $1::uuid ORDER BY id`, [kidmais])).rows;
  assert.deepEqual(itens, antes.itens, "inclusive o item solto criado antes da 078");
  const composicao = (await client.query(
    `SELECT r.pacote_id::text, r.categoria_id::text, r.modo_itens, r.escolhas_min, r.escolhas_max, r.ativo FROM pacote_buffet_categorias r
       JOIN pacotes p ON p.id = r.pacote_id WHERE p.empresa_id = $1::uuid ORDER BY 1, 2`, [kidmais])).rows;
  assert.deepEqual(composicao, antes.composicaoKidmais);
});

test("OUTRA: cópia só do que usava; vínculos (pacote, itens selecionados, item solto, adicional) passam para a cópia", async () => {
  const cats = (await client.query<{ id: string; codigo: string }>(`SELECT id::text, codigo FROM buffet_categorias WHERE empresa_id = $1::uuid ORDER BY codigo`, [OUTRA])).rows;
  assert.deepEqual(cats.map((c) => c.codigo), ["DOCES", "SALGADOS"], "SALGADOS (pacote) e DOCES (origem do adicional); nada mais");
  assert.ok(cats.every((c) => c.id !== salgadosGlobal && c.id !== docesGlobal));
  const copiaSalgados = cats.find((c) => c.codigo === "SALGADOS")!.id;
  const nItens = async (cat: string) => (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM buffet_itens WHERE categoria_id = $1::uuid`, [cat])).rows[0].n;
  assert.equal(await nItens(copiaSalgados), await nItens(salgadosGlobal), "todos os itens da categoria copiada");
  const vinculo = (await client.query(`SELECT categoria_id::text, modo_itens, escolhas_max FROM pacote_buffet_categorias WHERE pacote_id = $1::uuid`, [pacoteOutra])).rows;
  assert.deepEqual(vinculo, [{ categoria_id: copiaSalgados, modo_itens: "SELECIONADOS", escolhas_max: 2 }]);
  const selecionados = (await client.query<{ codigo: string; empresa: string }>(
    `SELECT i.codigo, i.empresa_id::text AS empresa FROM pacote_buffet_itens x JOIN buffet_itens i ON i.id = x.item_id WHERE x.pacote_id = $1::uuid ORDER BY 1`, [pacoteOutra])).rows;
  const codigosOriginais = (await client.query<{ codigo: string }>(`SELECT codigo FROM buffet_itens WHERE id = ANY($1::uuid[]) ORDER BY 1`, [[coxinhaGlobal, kibeGlobal]])).rows.map((r) => r.codigo);
  assert.deepEqual(selecionados.map((s) => s.codigo), codigosOriginais);
  assert.ok(selecionados.every((s) => s.empresa === OUTRA));
  const solto = (await client.query<{ empresa: string; nome: string }>(`SELECT i.empresa_id::text AS empresa, i.nome FROM pacote_itens_especificos x JOIN buffet_itens i ON i.id = x.item_id WHERE x.pacote_id = $1::uuid`, [pacoteOutra])).rows;
  assert.deepEqual(solto, [{ empresa: OUTRA, nome: "Taxa de rolha 078" }]);
  const origem = (await client.query<{ empresa: string }>(`SELECT i.empresa_id::text AS empresa FROM adicionais a JOIN buffet_itens i ON i.id = a.origem_buffet_item_id WHERE a.id = $1::uuid`, [adicionalOutra])).rows[0];
  assert.equal(origem.empresa, OUTRA);
  assert.equal((await client.query(`SELECT 1 FROM buffet_categorias WHERE empresa_id = $1::uuid`, [NOVA])).rowCount, 0, "empresa sem uso não recebe o catálogo da Kidmais");
});

test("OUTRA: cópias com os MESMOS códigos do catálogo antigo (categorias e itens sem categoria), que a unicidade global recusaria", async () => {
  // Categoria: o mesmo código existe agora na Kidmais e em OUTRA.
  const porCodigo = (await client.query<{ codigo: string; empresas: string[] }>(
    `SELECT codigo, array_agg(empresa_id::text ORDER BY empresa_id::text) AS empresas FROM buffet_categorias
      WHERE codigo IN ('SALGADOS', 'DOCES') GROUP BY codigo ORDER BY codigo`)).rows;
  const ambas = [kidmais, OUTRA].sort();
  assert.deepEqual(porCodigo, [{ codigo: "DOCES", empresas: ambas }, { codigo: "SALGADOS", empresas: ambas }]);
  // Itens das categorias copiadas: mesmo conjunto de códigos.
  const codigosItens = async (cat: string) => (await client.query<{ codigo: string }>(`SELECT codigo FROM buffet_itens WHERE categoria_id = $1::uuid ORDER BY codigo`, [cat])).rows.map((r) => r.codigo);
  const copiaDoces = (await client.query<{ id: string }>(`SELECT id::text AS id FROM buffet_categorias WHERE empresa_id = $1::uuid AND codigo = 'DOCES'`, [OUTRA])).rows[0].id;
  assert.deepEqual(await codigosItens(copiaDoces), await codigosItens(docesGlobal));
  // Itens SEM categoria: os dois (pacote e origem de adicional) com o código original, sem categoria, na Kidmais e em OUTRA.
  for (const [original, viaAdicional] of [[soltoGlobal, null], [soltoAdicionalGlobal, adicionalSoltoOutra]] as const) {
    const o = (await client.query<{ codigo: string; nome: string; empresa: string }>(
      `SELECT codigo, nome, empresa_id::text AS empresa FROM buffet_itens WHERE id = $1::uuid`, [original])).rows[0];
    assert.equal(o.empresa, kidmais, "original continua na Kidmais");
    const copias = (await client.query<{ id: string; nome: string; categoria: string | null }>(
      `SELECT id::text, nome, categoria_id::text AS categoria FROM buffet_itens WHERE empresa_id = $1::uuid AND codigo = $2`, [OUTRA, o.codigo])).rows;
    assert.equal(copias.length, 1, o.codigo);
    assert.deepEqual({ nome: copias[0].nome, categoria: copias[0].categoria }, { nome: o.nome, categoria: null });
    assert.notEqual(copias[0].id, original);
    if (viaAdicional) {
      const a = (await client.query<{ origem: string }>(`SELECT origem_buffet_item_id::text AS origem FROM adicionais WHERE id = $1::uuid`, [viaAdicional])).rows[0];
      assert.equal(a.origem, copias[0].id, "adicional passa para a cópia sem categoria");
    }
  }
  // A unicidade continua valendo dentro da empresa (sem categoria) — agora por empresa.
  const rolha = `ROLHA_078_${sufixo}`.toUpperCase();
  await recusa(client.query(`INSERT INTO buffet_itens (empresa_id, categoria_id, codigo, nome) VALUES ($1::uuid, NULL, $2, 'Repetido')`, [OUTRA, rolha]), /buffet_itens_empresa_codigo_sem_categoria_uk|duplicate key|duplicada/);
  await recusa(client.query(`INSERT INTO buffet_categorias (empresa_id, codigo, nome) VALUES ($1::uuid, 'SALGADOS', 'Repetida')`, [OUTRA]), /buffet_categorias_empresa_codigo_uk|duplicate key|duplicada/);
});

test("pedidos e fotografias: nenhuma linha alterada; a escolha antiga continua apontando para o item original", async () => {
  for (const t of TABELAS_HISTORICO) assert.equal(await impressao(t), antes[t], t);
  const agora = (await client.query(`SELECT categoria_id::text, item_id::text, item_nome_aplicado FROM fechamento_buffet_escolhas WHERE item_id = $1::uuid`, [coxinhaGlobal])).rows[0];
  assert.deepEqual(agora, escolhaAntes);
});

let X: string; let Y: string; let pacoteX: string; let pacoteY: string;
let salgadosX: string; let salgadosY: string; let coxinhaX: string; let empadaY: string;

test("duas empresas, MESMA categoria (SALGADOS) e itens diferentes: leitura só da própria empresa", async () => {
  X = await empresa("X"); Y = await empresa("Y");
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = ANY($1::uuid[])`, [[X, Y]]);
  salgadosX = await emTransacao(() => criarCategoriaBuffet(tx, X, "Salgados", true, "SALGADOS"));
  salgadosY = await emTransacao(() => criarCategoriaBuffet(tx, Y, "Salgados", true, "SALGADOS"));
  assert.notEqual(salgadosX, salgadosY);
  await recusa(emTransacao(() => criarCategoriaBuffet(tx, X, "Salgados 2", true, "SALGADOS")), /já tem uma categoria com este código/);
  coxinhaX = await emTransacao(() => criarItemBuffet(tx, X, "Coxinha X", salgadosX));
  empadaY = await emTransacao(() => criarItemBuffet(tx, Y, "Empada Y", salgadosY));
  const lx = await lerCatalogoBuffet(tx, X);
  const ly = await lerCatalogoBuffet(tx, Y);
  assert.deepEqual(lx.itens.map((i) => i.nome), ["Coxinha X"]);
  assert.deepEqual(ly.itens.map((i) => i.nome), ["Empada Y"]);
  assert.ok(!lx.categorias.some((c) => c.id === salgadosY) && !ly.categorias.some((c) => c.id === salgadosX));
  assert.ok(!lx.itens.some((i) => /Coxinha com|Kibe/.test(i.nome)), "nada do cardápio da Kidmais");
});

test("escrita: Y não edita, exclui nem usa categoria/item de X (serviço = 404/recusa; banco = gatilho)", async () => {
  await recusa(emTransacao(() => editarCategoriaBuffet(tx, Y, salgadosX, "Invasão", true)), /Categoria não encontrada/);
  await recusa(emTransacao(() => excluirCategoriaBuffet(tx, Y, salgadosX)), /Categoria não encontrada/);
  await recusa(emTransacao(() => criarItemBuffet(tx, Y, "Intruso", salgadosX)), /Escolha uma categoria cadastrada/);
  assert.equal((await client.query(`SELECT nome FROM buffet_categorias WHERE id = $1::uuid`, [salgadosX])).rows[0].nome, "Salgados");
  pacoteX = await pacote(X, `P78X${sufixo}`.toUpperCase());
  pacoteY = await pacote(Y, `P78Y${sufixo}`.toUpperCase());
  await recusa(emTransacao(() => definirCategoriasPacoteAdmin(tx, pacoteY, [{ categoriaId: salgadosX, escolhas: 1 }], ctx(Y))), /categorias do buffet já cadastradas|desta empresa/);
  await recusa(emTransacao(() => definirItensEspecificosPacoteAdmin(tx, pacoteY, [coxinhaX], Y)), /itens do buffet já cadastrados/);
  await recusa(emTransacao(() => definirItensEspecificosPacoteAdmin(tx, pacoteX, [coxinhaX], Y)), /Pacote não encontrado nesta empresa/);
  // Mesmo burlando o serviço, o banco recusa (gatilhos da 078).
  await recusa(client.query(`INSERT INTO pacote_buffet_categorias (pacote_id, categoria_id, escolhas_max) VALUES ($1::uuid, $2::uuid, 1)`, [pacoteY, salgadosX]), /cruza empresas/);
  await recusa(client.query(`INSERT INTO pacote_itens_especificos (pacote_id, item_id) VALUES ($1::uuid, $2::uuid)`, [pacoteY, coxinhaX]), /cruza empresas/);
  await recusa(client.query(`INSERT INTO buffet_itens (empresa_id, categoria_id, codigo, nome) VALUES ($1::uuid, $2::uuid, 'INTRUSO_078', 'Intruso')`, [Y, salgadosX]), /cruza empresas/);
  await recusa(client.query(`UPDATE buffet_categorias SET empresa_id = $1::uuid WHERE id = $2::uuid`, [Y, salgadosX]), /não muda/);
  await recusa(client.query(`UPDATE pacote_buffet_categorias SET categoria_id = $1::uuid WHERE pacote_id = ANY(SELECT id FROM pacotes WHERE empresa_id = $2::uuid)`, [salgadosY, kidmais]), /cruza empresas/);
  // Cada uma com o próprio catálogo.
  await emTransacao(() => definirCategoriasPacoteAdmin(tx, pacoteX, [{ categoriaId: salgadosX, escolhas: 1 }], ctx(X)));
  await emTransacao(() => definirCategoriasPacoteAdmin(tx, pacoteY, [{ categoriaId: salgadosY, escolhas: 1 }], ctx(Y)));
});

test("pedido: a escolha só aceita item do catálogo da empresa do pacote, mesmo com o mesmo código de categoria", async () => {
  await recusa(resolverEscolhasBuffet(tx, pacoteY, { SALGADOS: [coxinhaX] }, "DEFINIDO"), /indisponível para este pacote/);
  const ok = await resolverEscolhasBuffet(tx, pacoteY, { SALGADOS: [empadaY] }, "DEFINIDO") as { campos: { buffetSalgados: string } };
  assert.equal(ok.campos.buffetSalgados, "Empada Y");
});

test("adicional do buffet e cotação: origem de outra empresa é recusada; a cotação de Y não enxerga o adicional de X", async () => {
  await recusa(salvarAdicionalEmEtapas((t) => emTransacao(() => t(tx)), ctx(Y),
    { origem: { tipo: "ITEM", id: coxinhaX }, nome: "Coxinha extra", categoria: "BUFFET", unidadeCobranca: "CENTO", ativo: true, preco: "80.00" }), /Item do buffet não encontrado/);
  await recusa(client.query(`UPDATE adicionais SET origem_buffet_item_id = $1::uuid WHERE id = $2::uuid`, [coxinhaX, adicionalOutra]), /cruza empresas/);
  const adicionalX = await salvarAdicionalEmEtapas((t) => emTransacao(() => t(tx)), ctx(X),
    { origem: { tipo: "ITEM", id: coxinhaX }, nome: "Coxinha extra", categoria: "BUFFET", unidadeCobranca: "CENTO", ativo: true, preco: "80.00", pacotes: { [pacoteX]: "EXTRA" } });
  const codigoX = (await client.query<{ codigo: string }>(`SELECT codigo FROM adicionais WHERE id = $1::uuid`, [adicionalX.id])).rows[0].codigo;
  const agenda = (await client.query<{ id: string }>("SELECT id::text AS id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1")).rows[0].id;
  const todos = { disponibilidade: [1, 2, 3, 4, 5, 6, 7].map((dia) => ({ dia, horarioId: agenda })) };
  for (const [e, p] of [[X, pacoteX], [Y, pacoteY]]) await emTransacao(() => definirDisponibilidadePacoteAdmin(tx, p, todos, ctx(e)));
  const data = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const codigoPacote = async (p: string) => (await client.query<{ codigo: string }>(`SELECT codigo FROM pacotes WHERE id = $1::uuid`, [p])).rows[0].codigo;
  const ofertaX = await adicionaisDoPacoteNoTenant(tx, { empresaId: X, pacoteCodigo: await codigoPacote(pacoteX), data, convidados: 25 });
  const ofertaY = await adicionaisDoPacoteNoTenant(tx, { empresaId: Y, pacoteCodigo: await codigoPacote(pacoteY), data, convidados: 25 });
  assert.ok(ofertaX.some((a) => a.nome === "Coxinha extra"));
  assert.ok(!ofertaY.some((a) => a.nome === "Coxinha extra"));
  const resumoX = await calcularResumoComercial({ data, configuracaoAgendaId: agenda, pacoteId: pacoteX, convidados: 25, adicionais: [{ codigo: codigoX, quantidade: 1 }], empresaEsperada: X }, tx);
  assert.equal(resumoX.valorAdicionais, 80);
  await recusa(calcularResumoComercial({ data, configuracaoAgendaId: agenda, pacoteId: pacoteY, convidados: 25, adicionais: [{ codigo: codigoX, quantidade: 1 }], empresaEsperada: Y }, tx),
    /não existem|não estão disponíveis/);
});
