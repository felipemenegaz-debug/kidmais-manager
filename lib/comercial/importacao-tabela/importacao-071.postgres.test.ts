import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../../db/contracts.ts";
import { salvarAdicionalEmEtapas, type EmTransacao } from "../adicionais-admin.ts";
import { gravarFaixasPacote } from "../pacote-precos.ts";
import { definirDisponibilidadePacoteAdmin } from "../pacotes-admin.ts";
import { conectarDescartavel, encerrarDescartavel } from "../postgres-descartavel.ts";
import { calcularResumoComercial } from "../services/pricing.service.ts";
import { buscarCategoriaHorarioAplicavel } from "../repositories/comercial.repository.ts";
import type { LeituraTabela } from "./esquema.ts";
import { gravarLeitura, lerImportacao, publicarImportacao, registrarImportacao, salvarRevisao } from "./servico.ts";

/**
 * 071 no PostgreSQL DESCARTÁVEL (modelo 063 + 070 + 071 aplicadas aqui): importação da tabela de preços com leitura
 * simulada (nenhum provedor), revisão, publicação numa única tabela sucessora, revisão de pacote já usado e cotação.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");

let client: Client;
let tx: DbExecutor;
const sufixo = randomBytes(3).toString("hex").toUpperCase();
let empresa: string;
let premium: string;
let essencial: string;
let pocket: string;
let ctx: { empresaId: string; usuarioId: string; requestId: string };

async function emTransacaoBruta<T>(trabalho: () => Promise<T>): Promise<T> {
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
const emTransacao: EmTransacao = (trabalho) => emTransacaoBruta(() => trabalho(tx));

async function correntes() {
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM tabelas_preco WHERE empresa_id = $1::uuid AND publicada_em IS NOT NULL AND substituida_em IS NULL
       AND vigencia_inicio <= CURRENT_DATE AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)`, [empresa]);
  return r.rows.map((l) => l.id);
}

async function pacote(codigo: string, nome: string, min: number, max: number | null) {
  return (await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
     VALUES ($1::uuid, $2, $3, 710, true, true, $4, $5) RETURNING id::text AS id`, [empresa, codigo, nome, min, max])).rows[0].id;
}

const l = (ate: number | null, valor: number, de: number | null = null, rotulo: string | null = null) => ({ de, ate, valor, rotulo });
const LEITURA: LeituraTabela = {
  pacotes: [
    { nome: "Festa Premium", pagina: 4, descricao: "Tudo da Completa + crepe de chocolate.", selo: null, duracao: "3h30", convidadosMin: null, convidadosMax: null, inclusos: [],
      cobranca: "FAIXAS", grades: [
        { horario: "PROMOCIONAL", linhas: [l(50, 10390), l(60, 11190), l(150, 18390)] },
        { horario: "NOBRE", linhas: [l(50, 10890), l(60, 11690), l(150, 18890)] },
      ], valorPorConvidado: null, aPartirDe: 10390 },
    { nome: "Festa Essencial", pagina: 4, descricao: "Salgadinhos, minipizza e docinhos.", selo: null, duracao: null, convidadosMin: null, convidadosMax: null, inclusos: [],
      cobranca: "FAIXAS", grades: [{ horario: "UNICO", linhas: [l(50, 8490), l(150, 15490)] }], valorPorConvidado: null, aPartirDe: null },
    { nome: "Kidmais Pocket", pagina: 2, descricao: null, selo: null, duracao: null, convidadosMin: 20, convidadosMax: null, inclusos: [],
      cobranca: "POR_CONVIDADO", grades: [], valorPorConvidado: 190, aPartirDe: null },
  ],
  adicionais: [
    { nome: "Bombom", pagina: 5, grupo: "EXTRA", cobranca: "UNIDADE", linhas: [l(null, 8)] },
    { nome: "Mesa de café", pagina: 5, grupo: "MESA", cobranca: "VALOR_FECHADO", linhas: [l(50, 590, null, "Pequena"), l(100, 790, 60, "Média"), l(150, 990, 110, "Grande")] },
    { nome: "Adicional de pizza Scienza", pagina: 6, grupo: "BUFFET", cobranca: "VALOR_FECHADO", linhas: [l(20, 990), l(30, 1390)] },
  ],
  comuns: [], horarios: [], informacoes: [], naoImportavel: [],
};

test.before(async () => {
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await client.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("070 e 071: aplicam com checks; 071 repetida é recusada", async () => {
  for (const f of ["database/checks/20261007_070_precheck.sql", "database/migrations/20261007_070_adicionais_do_buffet.sql", "database/checks/20261007_070_postcheck.sql",
    "database/checks/20261007_071_precheck.sql", "database/migrations/20261007_071_importacoes_comerciais.sql", "database/checks/20261007_071_postcheck.sql"]) {
    await client.query(arquivo(f));
  }
  await assert.rejects(client.query(arquivo("database/migrations/20261007_071_importacoes_comerciais.sql")), /071 já aplicada/);
  await client.query("ROLLBACK").catch(() => undefined);
});

test("fixtures: empresa com Essencial já usada e precificada, Premium sem preço, Pocket, Bombom a R$ 4 e Mesa de café", async () => {
  empresa = (await client.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa 071', 'PROVISIONAMENTO') RETURNING id::text AS id`, [`e071${sufixo}`.toLowerCase()])).rows[0].id;
  ctx = { empresaId: empresa, usuarioId: randomUUID(), requestId: randomUUID() };
  premium = await pacote(`PREMIUM_${sufixo}`, "Festa Premium", 50, null);
  essencial = await pacote(`ESSENCIAL_${sufixo}`, "Festa Essencial", 50, 150);
  pocket = await pacote(`POCKET_${sufixo}`, "Kidmais Pocket", 20, null);
  await emTransacaoBruta(() => gravarFaixasPacote(tx, empresa, essencial, [{ convidadosMin: 50, convidadosMax: 150, valor: "8000.00" }], { minimo: 50, maximo: 150 }, { ...ctx, motivo: "PACOTE_EDITADO" }));
  const [tabela] = await correntes();
  const preco = (await client.query<{ id: string }>(`SELECT id::text AS id FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid`, [tabela, essencial])).rows[0].id;
  const agenda = (await client.query<{ id: string }>("SELECT id::text AS id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1")).rows[0].id;
  await client.query(
    `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, desconto_percentual, valor_desconto_pacote,
       valor_pacote_aplicado, valor_adicionais, valor_tabela, status, origem_fechamento)
     VALUES (CURRENT_DATE, TIME '10:00', TIME '14:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 60, 60, 8000, 0, 0, 8000, 0, 8000, 'RASCUNHO', 'ATENDIMENTO_KIDMAIS')`,
    [agenda, empresa, essencial, tabela, preco]);
  await salvarAdicionalEmEtapas(emTransacao, ctx, { nome: "Bombom", categoria: "EXTRA", unidadeCobranca: "UNIDADE", ativo: true, preco: "4.00" });
  await salvarAdicionalEmEtapas(emTransacao, ctx, { nome: "Mesa de café", categoria: "MESA", unidadeCobranca: "PACOTE", ativo: true });
});

let importacaoId: string;

test("leitura simulada vira revisão casada com o cadastro; PDF guardado e imutável", async () => {
  const bytes = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  importacaoId = await emTransacaoBruta(() => registrarImportacao(tx, ctx, { contentType: "application/pdf", nomeSeguro: "tabela.pdf", tamanhoBytes: bytes.length, sha256, bytes }));
  const imp = await emTransacaoBruta(() => gravarLeitura(tx, ctx, importacaoId, { ok: true, leitura: LEITURA, modelo: "fake", provedor: "FAKE" }));
  assert.equal(imp.situacao, "RASCUNHO");
  assert.deepEqual(imp.revisao!.pacotes.map((p) => p.pacoteId), [premium, essencial, pocket]);
  assert.deepEqual(imp.revisao!.adicionais.map((a) => a.destino.tipo), ["EXISTENTE", "EXISTENTE", "NOVO"]);
  await assert.rejects(client.query(`UPDATE importacoes_comerciais SET arquivo_sha256 = $2 WHERE id = $1::uuid`, [importacaoId, "0".repeat(64)]), /imutáveis/);
});

test("publicação: bloqueada sem confirmar; depois uma única sucessora com promocional/nobre, por convidado e faixas", async () => {
  const antes = await correntes();
  let imp = await emTransacaoBruta(() => lerImportacao(tx, empresa, importacaoId));
  await assert.rejects(publicarImportacao(emTransacao, ctx, importacaoId, imp.versao), /Confirme/);
  const revisao = {
    ...imp.revisao!,
    pacotes: imp.revisao!.pacotes.map((p) => ({ ...p, confirmado: true, aplicarDescricao: p.pacoteId === essencial || p.pacoteId === premium })),
    adicionais: imp.revisao!.adicionais.map((a) => ({ ...a, confirmado: true })),
  };
  imp = await emTransacaoBruta(() => salvarRevisao(tx, ctx, importacaoId, imp.versao, revisao));
  await assert.rejects(emTransacaoBruta(() => salvarRevisao(tx, ctx, importacaoId, imp.versao - 1, revisao)), /outra tela/);
  const resultado = await publicarImportacao(emTransacao, ctx, importacaoId, imp.versao);
  assert.ok(resultado.passos.every((p) => p.ok), JSON.stringify(resultado.passos));

  const agora = await correntes();
  assert.equal(agora.length, 1);
  assert.notEqual(agora[0], antes[0]);
  assert.deepEqual((await client.query(`SELECT codigo FROM kidmais_047_lacunas_escopo($1::uuid)`, [resultado.tabelaId])).rows, []);
  const linhas = await client.query<{ pacote_id: string; categoria_horario: string; tipo_calculo: string; convidados_min: number; convidados_max: number | null; valor: string }>(
    `SELECT pacote_id::text AS pacote_id, categoria_horario, tipo_calculo, convidados_min, convidados_max, valor::text AS valor
       FROM precos_pacote WHERE tabela_preco_id = $1::uuid ORDER BY pacote_id, categoria_horario, convidados_min`, [resultado.tabelaId]);
  const premiumLinhas = linhas.rows.filter((x) => x.pacote_id === premium);
  assert.deepEqual(premiumLinhas.map((x) => [x.categoria_horario, x.convidados_min, x.convidados_max, x.valor]), [
    ["NOBRE", 50, 50, "10890.00"], ["NOBRE", 51, 60, "11690.00"], ["NOBRE", 61, 150, "18890.00"],
    ["PADRAO", 50, 50, "10390.00"], ["PADRAO", 51, 60, "11190.00"], ["PADRAO", 61, 150, "18390.00"],
  ]);
  assert.deepEqual(linhas.rows.filter((x) => x.pacote_id === pocket).map((x) => [x.tipo_calculo, x.convidados_min, x.valor]), [["POR_CONVIDADO", 20, "190.00"]]);

  const adicionais = await client.query<{ nome: string; convidados_min: number; convidados_max: number | null; valor: string; observacoes: string | null }>(
    `SELECT a.nome, pa.convidados_min, pa.convidados_max, pa.valor::text AS valor, pa.observacoes
       FROM precos_adicional pa JOIN adicionais a ON a.id = pa.adicional_id
      WHERE pa.tabela_preco_id = $1::uuid AND a.empresa_id = $2::uuid ORDER BY a.nome, pa.convidados_min`, [resultado.tabelaId, empresa]);
  assert.deepEqual(adicionais.rows.map((x) => [x.nome, x.convidados_min, x.convidados_max, x.valor, x.observacoes]), [
    ["Adicional de pizza Scienza", 1, 20, "990.00", null], ["Adicional de pizza Scienza", 21, 30, "1390.00", null],
    ["Bombom", 1, null, "8.00", null],
    ["Mesa de café", 1, 50, "590.00", "Pequena"], ["Mesa de café", 51, 100, "790.00", "Média"], ["Mesa de café", 101, 150, "990.00", "Grande"],
  ]);

  // Essencial já usada: descrição em revisão nova (vigente), com preço preservado; Premium editado direto.
  const vigentes = await client.query<{ id: string; codigo: string; descricao: string | null; convidados_maximos: number | null }>(
    `SELECT id::text AS id, codigo, descricao, convidados_maximos FROM pacotes WHERE empresa_id = $1::uuid AND vigente ORDER BY codigo`, [empresa]);
  const essencialVigente = vigentes.rows.find((x) => x.codigo === `ESSENCIAL_${sufixo}`)!;
  assert.notEqual(essencialVigente.id, essencial, "revisão do pacote usado");
  assert.equal(essencialVigente.descricao, "Salgadinhos, minipizza e docinhos.");
  assert.equal(vigentes.rows.find((x) => x.id === premium)!.descricao, "Tudo da Completa + crepe de chocolate.");
  assert.equal(vigentes.rows.find((x) => x.id === premium)!.convidados_maximos, 150);
  assert.equal((await correntes()).length, 1);

  const final = await emTransacaoBruta(() => lerImportacao(tx, empresa, importacaoId));
  assert.equal(final.situacao, "PUBLICADA");
  await assert.rejects(publicarImportacao(emTransacao, ctx, importacaoId, final.versao), /publicada ou descartada/);
  await assert.rejects(client.query(`UPDATE importacoes_comerciais SET revisao = NULL WHERE id = $1::uuid`, [importacaoId]), /já encerrada/);
});

test("cotação: o cálculo do envio usa a grade do horário (promocional ou nobre) e a faixa de 55 convidados", async () => {
  const agenda = (await client.query<{ id: string }>("SELECT id::text AS id FROM configuracao_agenda WHERE ativo ORDER BY codigo LIMIT 1")).rows[0].id;
  const todos = { disponibilidade: [1, 2, 3, 4, 5, 6, 7].map((dia) => ({ dia, horarioId: agenda })) };
  for (const id of [premium, pocket]) await emTransacaoBruta(() => definirDisponibilidadePacoteAdmin(tx, id, todos, { ...ctx, motivo: "Teste" }));
  const data = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const categoria = await buscarCategoriaHorarioAplicavel(data, agenda, tx);
  const resumo = await calcularResumoComercial({ data, configuracaoAgendaId: agenda, pacoteId: premium, convidados: 55, adicionais: [], empresaEsperada: empresa }, tx);
  const esperado = categoria?.categoriaHorario === "NOBRE" ? 11690 : 11190;
  assert.equal(resumo.pacote.valorTabelaBase, esperado, `categoria ${JSON.stringify(categoria)}`);
  const pocketResumo = await calcularResumoComercial({ data, configuracaoAgendaId: agenda, pacoteId: pocket, convidados: 15, adicionais: [], empresaEsperada: empresa }, tx);
  assert.equal(pocketResumo.pacote.valorTabelaBase, 190 * 20, "mínimo faturável de 20 convidados");
});
