import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { gerarPdfContratoOficial } from "../documento/oficial/pdf.ts";
import type { ConteudoModelo } from "./conteudo.ts";
import { SNAPSHOT_EXEMPLO } from "./exemplo.ts";
import { renderizarModeloEmpresa } from "./renderizar.ts";
import {
  gravarLeituraContrato, lerImportacaoContrato, modeloContratoAtivo, painelModeloContrato, publicarModeloContrato, registrarImportacaoContrato, salvarRevisaoContrato,
} from "./servico.ts";

/**
 * 072 no PostgreSQL DESCARTÁVEL (modelo 063 + 070 + 071 + 072 aplicadas aqui): contrato da loja lido (simulado, sem
 * provedor), revisado e publicado como modelo da empresa; versões, imutabilidade, recusa de modelo incompleto e
 * auditoria. O documento sai no padrão da empresa a partir do modelo ATIVO.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");

let client: Client;
let tx: DbExecutor;
let empresa: string;
let outra: string;
const usuario = randomUUID();
const ctx = () => ({ empresaId: empresa, usuarioId: usuario, requestId: randomUUID() });

const MODELO: ConteudoModelo = {
  titulo: "Contrato de Festa",
  contratada: { nome: "Buffet Alegria Ltda", documento: "12.345.678/0001-90", endereco: "Goiânia/GO", representante: "João Souza" },
  preambulo: [],
  clausulas: [
    { titulo: "Objeto", texto: "Festa em {{festa.data}} para {{contratante.nome}}, CPF {{contratante.cpf}}." },
    { titulo: "Valor", texto: "Total de {{valor.total}}." },
  ],
  observacoes: [],
  cidadeAssinatura: "Goiânia/GO",
};

async function emTransacao<T>(trabalho: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try { const r = await trabalho(); await client.query("COMMIT"); return r; } catch (e) { await client.query("ROLLBACK"); throw e; }
}

async function rascunho(conteudo: ConteudoModelo) {
  const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${randomBytes(4).toString("hex")}\n%%EOF`));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = await emTransacao(() => registrarImportacaoContrato(tx, ctx(), { contentType: "application/pdf", nomeSeguro: "contrato.pdf", tamanhoBytes: bytes.length, sha256, bytes }));
  return emTransacao(() => gravarLeituraContrato(tx, ctx(), id, { ok: true, modelo: "fake", provedor: "FAKE", leitura: { conteudo, avisos: ["Horário de montagem sem campo."] } }));
}

test.before(async () => {
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await client.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("070, 071 e 072 aplicam com checks; 072 repetida é recusada; sem modelo a empresa segue como antes", async () => {
  for (const f of ["070_precheck", "070_adicionais_do_buffet", "070_postcheck", "071_precheck", "071_importacoes_comerciais", "071_postcheck", "072_precheck", "072_modelos_contrato_empresa", "072_postcheck"]) {
    const pasta = /check/.test(f) ? "checks" : "migrations";
    await client.query(arquivo(`database/${pasta}/20261007_${f}.sql`));
  }
  await assert.rejects(client.query(arquivo("database/migrations/20261007_072_modelos_contrato_empresa.sql")), /072 já aplicada/);
  await client.query("ROLLBACK").catch(() => undefined);
  const suf = randomBytes(3).toString("hex");
  empresa = (await client.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet 072', 'PROVISIONAMENTO') RETURNING id::text AS id`, [`b072${suf}`])).rows[0].id;
  outra = (await client.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Outra 072', 'PROVISIONAMENTO') RETURNING id::text AS id`, [`o072${suf}`])).rows[0].id;
  assert.equal(await modeloContratoAtivo(tx, empresa), null);
});

test("rascunho lido → revisão com versão → publicação v1 com aprovação e auditoria; documento no padrão da empresa", async () => {
  const r = await rascunho(MODELO);
  assert.deepEqual(r.revisao?.avisos, ["Horário de montagem sem campo."]);
  await assert.rejects(emTransacao(() => lerImportacaoContrato(tx, outra, r.id)), /não encontrada/);
  const salvo = await emTransacao(() => salvarRevisaoContrato(tx, ctx(), r.id, r.versao, { conteudo: { ...MODELO, titulo: "Contrato de Festa Infantil" }, avisos: [] }));
  await assert.rejects(emTransacao(() => salvarRevisaoContrato(tx, ctx(), r.id, r.versao, { conteudo: MODELO, avisos: [] })), /outra tela/);
  await assert.rejects(emTransacao(() => publicarModeloContrato(tx, ctx(), r.id, r.versao, { revisadoPorPessoa: true })), /mudou/);
  const pub = await emTransacao(() => publicarModeloContrato(tx, ctx(), r.id, salvo.versao, { revisadoPorPessoa: true }));
  assert.equal(pub.versao, 1);
  const ativo = await modeloContratoAtivo(tx, empresa);
  assert.equal(ativo?.versao, 1);
  assert.equal(ativo?.conteudo.titulo, "Contrato de Festa Infantil");
  const aud = await client.query(`SELECT acao FROM auditoria WHERE entidade_id = $1::uuid`, [pub.modeloId]);
  assert.deepEqual(aud.rows.map((x) => x.acao), ["MODELO_CONTRATO_PUBLICADO"]);
  const doc = renderizarModeloEmpresa(ativo!, { snapshot: SNAPSHOT_EXEMPLO, numeroVersao: 1, snapshotHash: "b".repeat(64) });
  assert.match(doc.clausulas[0].texto, /Maria da Silva \(exemplo\), CPF 123\.456\.789-09/);
  assert.ok(gerarPdfContratoOficial(doc, { logo: false }).length > 1000);
  assert.equal(await modeloContratoAtivo(tx, outra), null, "outra empresa segue sem modelo");
});

test("v2 substitui v1; publicado é imutável e não se apaga; incompleto não publica", async () => {
  const r2 = await rascunho({ ...MODELO, titulo: "Contrato v2" });
  const pub2 = await emTransacao(() => publicarModeloContrato(tx, ctx(), r2.id, r2.versao, { revisadoPorPessoa: true }));
  assert.equal(pub2.versao, 2);
  const versoes = await client.query<{ versao: number; situacao: string }>(`SELECT versao, situacao FROM modelos_contrato_empresa WHERE empresa_id = $1::uuid ORDER BY versao`, [empresa]);
  assert.deepEqual(versoes.rows.map((v) => `${v.versao}:${v.situacao}`), ["1:SUBSTITUIDO", "2:ATIVO"]);
  await assert.rejects(client.query(`UPDATE modelos_contrato_empresa SET conteudo = '{}'::jsonb WHERE id = $1::uuid`, [pub2.modeloId]), /imutável/);
  await assert.rejects(client.query(`DELETE FROM modelos_contrato_empresa WHERE id = $1::uuid`, [pub2.modeloId]), /não é apagado/);
  await assert.rejects(emTransacao(() => publicarModeloContrato(tx, ctx(), r2.id, r2.versao + 1, { revisadoPorPessoa: true })), /publicada ou descartada/);
  const incompleto = await rascunho({ ...MODELO, clausulas: [{ titulo: null, texto: "Sem dados da festa." }] });
  await assert.rejects(emTransacao(() => publicarModeloContrato(tx, ctx(), incompleto.id, incompleto.versao, { revisadoPorPessoa: true })), /precisa usar \{\{contratante\.nome\}\}/);
  const painel = await painelModeloContrato(tx, empresa);
  assert.equal(painel.ativo?.versao, 2);
  assert.equal(painel.rascunhos.length, 1);
});

test("rollback da 072 é recusado com modelo publicado", async () => {
  await assert.rejects(client.query(arquivo("database/rollback/20261007_072_modelos_contrato_empresa_down.sql")), /072 rollback recusado/);
  await client.query("ROLLBACK").catch(() => undefined);
});
