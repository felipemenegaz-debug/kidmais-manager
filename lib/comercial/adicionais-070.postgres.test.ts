import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { excluirAdicionalAdmin, lerAdicionaisAdmin, salvarAdicionalEmEtapas } from "./adicionais-admin.ts";
import { observacoesDasEscolhas } from "./adicionais-escolhas.ts";
import { adicionaisDoPacoteNoTenant } from "./adicionais-tenant.ts";
import { gravarFaixasPacote } from "./pacote-precos.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";

/**
 * 070 no PostgreSQL DESCARTÁVEL (modelo 063 + 070 aplicada aqui): item e categoria do buffet vendidos como adicional
 * da empresa, preço pela sucessão publicada, oferta só nos pacotes marcados, escolhas da categoria, isolamento entre
 * empresas e rollback recusado com dados.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");

let client: Client;
let tx: DbExecutor;
const sufixo = randomBytes(3).toString("hex");
const ctx = (empresaId: string) => ({ empresaId, usuarioId: randomUUID(), requestId: randomUUID() });

async function empresa(nome: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`,
    [`e70${nome}${sufixo}`.toLowerCase(), `Empresa 070 ${nome}`],
  );
  return r.rows[0].id;
}

async function pacote(empresaId: string, codigo: string) {
  const r = await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
     VALUES ($1::uuid, $2, $3, 700, true, true, 20, 30) RETURNING id::text AS id`,
    [empresaId, codigo, `Pacote ${codigo}`],
  );
  return r.rows[0].id;
}

async function correntes(empresaId: string) {
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM tabelas_preco
      WHERE empresa_id = $1::uuid AND publicada_em IS NOT NULL AND substituida_em IS NULL
        AND vigencia_inicio <= CURRENT_DATE AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)`,
    [empresaId],
  );
  return r.rows.map((l) => l.id);
}

/** Como a rota: cada gravação numa transação (a trava da 048 é conferida no COMMIT). */
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

const salvar = (_tx: DbExecutor, c: Parameters<typeof salvarAdicionalEmEtapas>[1], e: Parameters<typeof salvarAdicionalEmEtapas>[2]) =>
  salvarAdicionalEmEtapas((trabalho) => emTransacao(() => trabalho(tx)), c, e);

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

let A: string;
let B: string;
let pacoteA: string;
let pacoteB: string;
let categoria: string;
let coxinha: string;
let kibe: string;
let esfihaInativa: string;
let semCategoria: string;

test.before(async () => {
  client = await conectarDescartavel();
  tx = {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const r = await client.query(text, values as unknown[]);
      return { rows: r.rows as Row[], rowCount: r.rowCount };
    },
  };
});

test.after(async () => {
  if (client) await encerrarDescartavel(client);
});

test("070: precheck, migration e postcheck; segunda aplicação é recusada", async () => {
  await client.query(arquivo("database/checks/20261007_070_precheck.sql"));
  await client.query(arquivo("database/migrations/20261007_070_adicionais_do_buffet.sql"));
  await client.query(arquivo("database/checks/20261007_070_postcheck.sql"));
  await recusa(client.query(arquivo("database/migrations/20261007_070_adicionais_do_buffet.sql")), /070 já aplicada/);
  await client.query("ROLLBACK").catch(() => undefined);
});

test("fixtures: duas empresas, pacotes com preço publicado e uma categoria do buffet", async () => {
  A = await empresa("A");
  B = await empresa("B");
  pacoteA = await pacote(A, `P70A${sufixo}`.toUpperCase());
  pacoteB = await pacote(B, `P70B${sufixo}`.toUpperCase());
  const faixas = [{ convidadosMin: 20, convidadosMax: 30, valor: "1000.00" }];
  await emTransacao(() => gravarFaixasPacote(tx, A, pacoteA, faixas, { minimo: 20, maximo: 30 }, { ...ctx(A), motivo: "PACOTE_EDITADO" }));
  await emTransacao(() => gravarFaixasPacote(tx, B, pacoteB, faixas, { minimo: 20, maximo: 30 }, { ...ctx(B), motivo: "PACOTE_EDITADO" }));
  assert.equal((await correntes(A)).length, 1);
  const cat = await client.query<{ id: string }>(
    `INSERT INTO buffet_categorias (codigo, nome, ativo) VALUES ($1, 'Salgados 070', true) RETURNING id::text AS id`,
    [`SALG70_${sufixo}`.toUpperCase()],
  );
  categoria = cat.rows[0].id;
  const item = async (nome: string, ativo: boolean, cat: string | null) => (await client.query<{ id: string }>(
    `INSERT INTO buffet_itens (categoria_id, codigo, nome, ativo, arquivado_em)
     VALUES ($1::uuid, $2, $3, $4, CASE WHEN $4 THEN NULL ELSE now() END) RETURNING id::text AS id`,
    [cat, `${nome.toUpperCase()}_70_${sufixo}`.toUpperCase(), nome, ativo],
  )).rows[0].id;
  coxinha = await item("Coxinha", true, categoria);
  kibe = await item("Kibe", true, categoria);
  esfihaInativa = await item("Esfiha", false, categoria);
  semCategoria = await item("Brigadeiro", true, null);
});

test("categoria vira um adicional único: preço numa nova tabela publicada, oferecido só no pacote marcado", async () => {
  const antes = await correntes(A);
  const { id } = await salvar(tx, ctx(A), {
    origem: { tipo: "CATEGORIA", id: categoria }, nome: "Cento de salgados extra", categoria: "BUFFET",
    unidadeCobranca: "CENTO", ativo: true, escolhasMax: 2, preco: "120.00", pacotes: { [pacoteA]: "EXTRA" },
  });
  const depois = await correntes(A);
  assert.equal(depois.length, 1, "uma tabela corrente");
  assert.notEqual(depois[0], antes[0], "sucessora publicada");
  const preco = await client.query(`SELECT valor::text AS valor FROM precos_adicional WHERE tabela_preco_id = $1::uuid AND adicional_id = $2::uuid`, [depois[0], id]);
  assert.deepEqual(preco.rows, [{ valor: "120.00" }]);
  const pacoteAinda = await client.query(`SELECT count(*)::int AS n FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid`, [depois[0], pacoteA]);
  assert.equal(pacoteAinda.rows[0].n, 1, "o preço do pacote foi copiado para a sucessora");

  const leitura = await lerAdicionaisAdmin(tx, A);
  assert.equal(leitura.migracaoPendente, false);
  assert.equal(leitura.tabelaCorrente, true);
  const adicional = leitura.adicionais.find((a) => a.id === id)!;
  assert.deepEqual({ origem: adicional.origem, preco: adicional.preco, escolhasMax: adicional.escolhasMax, pacotes: adicional.pacotes },
    { origem: { tipo: "CATEGORIA", id: categoria }, preco: "120.00", escolhasMax: 2, pacotes: { [pacoteA]: "EXTRA" } });

  const codigoPacote = (await client.query(`SELECT codigo FROM pacotes WHERE id = $1::uuid`, [pacoteA])).rows[0].codigo;
  const oferecidos = await adicionaisDoPacoteNoTenant(tx, { empresaId: A, pacoteCodigo: codigoPacote, data: new Date().toISOString().slice(0, 10), convidados: 25 });
  assert.equal(oferecidos.length, 1);
  assert.equal(oferecidos[0].preco, 120);
  assert.deepEqual(oferecidos[0].escolhas, { max: 2, itens: [{ id: coxinha, nome: "Coxinha" }, { id: kibe, nome: "Kibe" }] }, "só itens ativos");

  // Salvar de novo a mesma origem atualiza (não duplica); preço igual não cria tabela nova.
  const deNovo = await salvar(tx, ctx(A), {
    origem: { tipo: "CATEGORIA", id: categoria }, nome: "Cento de salgados", categoria: "BUFFET",
    unidadeCobranca: "CENTO", ativo: true, escolhasMax: 3, preco: "120.00",
  });
  assert.equal(deNovo.id, id);
  assert.deepEqual(await correntes(A), depois);
  const n = await client.query(`SELECT count(*)::int AS n FROM adicionais WHERE empresa_id = $1::uuid AND origem_buffet_categoria_id = $2::uuid`, [A, categoria]);
  assert.equal(n.rows[0].n, 1);
});

test("escolhas: congeladas por nome; item inativo, de outra categoria, acima do máximo ou em adicional sem categoria é recusado", async () => {
  const adicional = (await client.query<{ id: string; codigo: string; nome: string }>(
    `SELECT id::text AS id, codigo, nome FROM adicionais WHERE empresa_id = $1::uuid AND origem_buffet_categoria_id = $2::uuid`, [A, categoria])).rows[0];
  const precificado = [{ adicionalId: adicional.id, codigo: adicional.codigo, nome: adicional.nome }];
  const ok = await observacoesDasEscolhas(tx, precificado, [{ codigo: adicional.codigo, escolhas: [kibe, coxinha] }]);
  assert.equal(ok.get(adicional.id), "Escolhas: Kibe, Coxinha");
  assert.equal((await observacoesDasEscolhas(tx, precificado, [{ codigo: adicional.codigo }])).get(adicional.id), "Escolhas: a definir com a equipe");
  await recusa(observacoesDasEscolhas(tx, precificado, [{ codigo: adicional.codigo, escolhas: [esfihaInativa] }]), /não está disponível/);
  await recusa(observacoesDasEscolhas(tx, precificado, [{ codigo: adicional.codigo, escolhas: [semCategoria] }]), /não está disponível/);
  await recusa(observacoesDasEscolhas(tx, precificado, [{ codigo: adicional.codigo, escolhas: [coxinha, kibe, randomUUID(), randomUUID()] }]), /no máximo 3/);

  const item = await salvar(tx, ctx(A), {
    origem: { tipo: "ITEM", id: semCategoria }, nome: "Brigadeiro extra", categoria: "BUFFET", unidadeCobranca: "UNIDADE", ativo: true,
  });
  const linha = (await client.query(`SELECT codigo, escolhas_max FROM adicionais WHERE id = $1::uuid`, [item.id])).rows[0];
  assert.equal(linha.codigo, `BRIGADEIRO_70_${sufixo}`.toUpperCase(), "mesmo código do item do buffet");
  assert.equal(linha.escolhas_max, null);
  await recusa(observacoesDasEscolhas(tx, [{ adicionalId: item.id, codigo: linha.codigo, nome: "Brigadeiro extra" }], [{ codigo: linha.codigo, escolhas: [coxinha] }]), /não aceita escolhas/);
});

test("outro adicional sem origem; preço nulo tira da oferta; empresa B não vê nem edita os de A", async () => {
  const { id } = await salvar(tx, ctx(A), {
    nome: "Mesa de café 070", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true, preco: "350", pacotes: { [pacoteA]: "EXTRA" },
  });
  assert.match((await client.query(`SELECT codigo FROM adicionais WHERE id = $1::uuid`, [id])).rows[0].codigo, /^MESA_DE_CAFE_070_[0-9A-F]{6}$/);
  await salvar(tx, ctx(A), { id, nome: "Mesa de café 070", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true, preco: null });
  const leitura = await lerAdicionaisAdmin(tx, A);
  assert.equal(leitura.adicionais.find((a) => a.id === id)!.preco, null);

  assert.equal((await lerAdicionaisAdmin(tx, B)).adicionais.length, 0);
  await recusa(salvar(tx, ctx(B), { id, nome: "Invasão", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true }), /não encontrado nesta empresa/);
  await recusa(salvar(tx, ctx(B), { id: randomUUID(), nome: "x", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true, pacotes: { [pacoteA]: "EXTRA" } }), /não encontrado/);
  const outra = await salvar(tx, ctx(B), { nome: "Extra B", categoria: "EXTRA", unidadeCobranca: "PACOTE", ativo: true });
  await recusa(salvar(tx, ctx(B), { id: outra.id, nome: "Extra B", categoria: "EXTRA", unidadeCobranca: "PACOTE", ativo: true, pacotes: { [pacoteA]: "EXTRA" } }), /Pacote não encontrado nesta empresa/);
});

test("sem tabela publicada o preço é recusado com orientação; categoria de adicional inválida também", async () => {
  const C = await empresa("C");
  await recusa(salvar(tx, ctx(C), { nome: "Sem tabela", categoria: "EXTRA", unidadeCobranca: "PACOTE", ativo: true, preco: "10.00" }), /Publique a tabela de preços/);
  await recusa(salvar(tx, ctx(C), { nome: "Categoria ruim", categoria: "NAO_EXISTE", unidadeCobranca: "PACOTE", ativo: true }), /Categoria do adicional inválida/);
});

test("rollback da 070 é recusado enquanto houver adicional criado a partir do buffet", async () => {
  await recusa(client.query(arquivo("database/rollback/20261007_070_adicionais_do_buffet_down.sql")), /070 rollback recusado/);
  await client.query("ROLLBACK").catch(() => undefined);
});

/** Pacote passa a ser "utilizado": um fechamento em rascunho com o preço corrente (como em staging/produção). */
async function marcarUsado(empresaId: string, pacoteId: string) {
  const [tabelaId] = await correntes(empresaId);
  const preco = await client.query<{ id: string; valor: string }>(
    `SELECT id::text AS id, valor::text AS valor FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid AND ativo LIMIT 1`,
    [tabelaId, pacoteId],
  );
  const agenda = await client.query<{ id: string }>("SELECT id::text AS id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1");
  await client.query(
    `INSERT INTO fechamentos (
       data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
       empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
       valor_pacote_base, desconto_percentual, valor_desconto_pacote, valor_pacote_aplicado,
       valor_adicionais, valor_tabela, status, origem_fechamento
     ) VALUES (CURRENT_DATE, TIME '10:00', TIME '14:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               'PADRAO', 'PADRAO', 20, 20, $6, 0, 0, $6, 0, $6, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS')`,
    [agenda.rows[0].id, empresaId, pacoteId, tabelaId, preco.rows[0].id, preco.rows[0].valor],
  );
}

test("pacotes já usados: preço + dois pacotes num salvamento viram etapas; revisões vigentes recebem o adicional", async () => {
  const outro = await pacote(A, `P70U${sufixo}`.toUpperCase());
  await emTransacao(() => gravarFaixasPacote(tx, A, outro, [{ convidadosMin: 20, convidadosMax: 30, valor: "900.00" }], { minimo: 20, maximo: 30 }, { ...ctx(A), motivo: "PACOTE_EDITADO" }));
  await marcarUsado(A, pacoteA);
  await marcarUsado(A, outro);
  const { id } = await salvar(tx, ctx(A), {
    nome: "Arco de balões 070", categoria: "DECORACAO", unidadeCobranca: "PACOTE", ativo: true, preco: "250.00",
    pacotes: { [pacoteA]: "EXTRA", [outro]: "EXTRA" },
  });
  assert.equal((await correntes(A)).length, 1, "uma tabela corrente depois de três sucessoras em etapas");
  const vinculos = await client.query<{ revisao_anterior_id: string | null; modalidade: string }>(
    `SELECT p.revisao_anterior_id::text AS revisao_anterior_id, pa.modalidade
       FROM pacote_adicionais pa JOIN pacotes p ON p.id = pa.pacote_id
      WHERE pa.adicional_id = $1::uuid AND pa.ativo AND p.vigente`,
    [id],
  );
  assert.equal(vinculos.rows.length, 2, "os dois pacotes vigentes (revisões) oferecem o adicional");
  assert.ok(vinculos.rows.every((v) => v.modalidade === "EXTRA" && v.revisao_anterior_id !== null), "revisões dos pacotes usados");
  const leitura = await lerAdicionaisAdmin(tx, A);
  assert.equal(leitura.adicionais.find((a) => a.id === id)!.preco, "250.00");
  assert.equal(Object.values(leitura.adicionais.find((a) => a.id === id)!.pacotes).filter((m) => m === "EXTRA").length, 2);
});

test("excluir: sem histórico apaga; com preço publicado arquiva (some do fechamento); outra empresa não exclui", async () => {
  const semUso = await salvar(tx, ctx(A), { nome: "Exclusão sem uso 070", categoria: "DECORACAO", unidadeCobranca: "PACOTE", ativo: true, preco: null, pacotes: {} });
  await recusa(emTransacao(() => excluirAdicionalAdmin(tx, ctx(B), semUso.id)), /não encontrado/);
  const apagado = await emTransacao(() => excluirAdicionalAdmin(tx, ctx(A), semUso.id));
  assert.deepEqual(apagado, { resultado: "EXCLUIDO", festas: 0, pacotes: 0 });
  assert.equal((await client.query("SELECT 1 FROM adicionais WHERE id = $1::uuid", [semUso.id])).rowCount, 0);

  // pacoteA ganhou revisão no caso anterior: usa a revisão vigente do mesmo código.
  const codigoPacote = (await client.query<{ codigo: string }>("SELECT codigo FROM pacotes WHERE id = $1::uuid", [pacoteA])).rows[0].codigo;
  const vigente = (await client.query<{ id: string }>("SELECT id::text AS id FROM pacotes WHERE empresa_id = $1::uuid AND codigo = $2 AND vigente", [A, codigoPacote])).rows[0].id;
  const oferecidos = () => adicionaisDoPacoteNoTenant(tx, { empresaId: A, pacoteCodigo: codigoPacote, data: new Date().toISOString().slice(0, 10), convidados: 25 });
  const comPreco = await salvar(tx, ctx(A), { nome: "Exclusão com preço 070", categoria: "DECORACAO", unidadeCobranca: "PACOTE", ativo: true, preco: "120.00", pacotes: { [vigente]: "EXTRA" } });
  assert.ok((await oferecidos()).some((a) => a.nome === "Exclusão com preço 070"), "oferecido antes");
  const arquivado = await emTransacao(() => excluirAdicionalAdmin(tx, ctx(A), comPreco.id));
  assert.equal(arquivado.resultado, "ARQUIVADO");
  assert.equal(arquivado.pacotes, 1);
  const linha = await client.query<{ ativo: boolean }>("SELECT ativo FROM adicionais WHERE id = $1::uuid", [comPreco.id]);
  assert.equal(linha.rows[0].ativo, false, "continua no banco, inativo");
  assert.ok(!(await oferecidos()).some((a) => a.nome === "Exclusão com preço 070"), "some do fechamento");
  const auditoria = await client.query<{ acao: string }>("SELECT acao FROM auditoria WHERE entidade_id IN ($1::uuid, $2::uuid) AND acao LIKE 'ADICIONAL_%' ORDER BY criado_em", [semUso.id, comPreco.id]);
  assert.deepEqual(auditoria.rows.map((r) => r.acao).filter((a) => a !== "ADICIONAL_EDITADO" && a !== "ADICIONAL_CRIADO"), ["ADICIONAL_EXCLUIDO", "ADICIONAL_ARQUIVADO"]);
});
