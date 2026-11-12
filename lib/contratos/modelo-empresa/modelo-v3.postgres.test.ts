import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import type { DbExecutor } from "../../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import type { ConteudoModelo } from "./conteudo.ts";
import { aplicarContratada, conferidaDe, contratadaEfetiva } from "./contratada.ts";
import { SNAPSHOT_EXEMPLO } from "./exemplo.ts";
import { renderizarModeloEmpresa } from "./renderizar.ts";
import {
  descartarImportacaoContrato, gravarLeituraContrato, lerImportacaoContrato, modeloContratoAtivo, publicarModeloContrato, registrarImportacaoContrato, salvarRevisaoContrato,
} from "./servico.ts";

/**
 * Plano "revisão do modelo de contrato v3" (rev. 10) no PostgreSQL DESCARTÁVEL: contratada efetiva do perfil APLICADO
 * da empresa comprovada (duas empresas, sem cruzar), CONTRATADA_MUDOU quando o perfil muda entre a prévia e a
 * publicação, hash do conteúdo FINAL, auditoria com origem/sha/regra, rollback, modelo legado ativo, envioId gravado
 * com a versão, concorrência do Salvar e publicação depois de descartar.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const arquivo = (p: string) => readFileSync(resolve(root, p), "utf8");

let client: Client;
let tx: DbExecutor;
const usuario = randomUUID();
const empresas: Record<"A" | "B" | "L", string> = { A: "", B: "", L: "" };
const ctx = (empresaId: string) => ({ empresaId, usuarioId: usuario, requestId: randomUUID() });
const executor = (c: Client): DbExecutor => ({ async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await c.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } });

const D1: ConteudoModelo = {
  titulo: "Contrato de Festa",
  contratada: { nome: "Buffet do Modelo", documento: "12.345.678/0001-95", endereco: "Rua do Modelo, 1", representante: "Ana Souza" },
  preambulo: [],
  clausulas: [
    { titulo: "Objeto", texto: "Festa {{festa.pacote}} em {{festa.data}}, das {{festa.inicio}} às {{festa.fim}}, {{festa.convidados}} convidados." },
    { titulo: "Valor", texto: "Total de {{valor.total}}, {{pagamento.condicao}}." },
  ],
  observacoes: [],
  cidadeAssinatura: "Goiânia/GO",
};

async function emTransacao<T>(trabalho: () => Promise<T>, c: Client = client): Promise<T> {
  await c.query("BEGIN");
  try { const r = await trabalho(); await c.query("COMMIT"); return r; } catch (e) { await c.query("ROLLBACK"); throw e; }
}

async function rascunho(empresaId: string, conteudo: ConteudoModelo) {
  const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n${randomBytes(4).toString("hex")}\n%%EOF`));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = await emTransacao(() => registrarImportacaoContrato(tx, ctx(empresaId), { contentType: "application/pdf", nomeSeguro: "contrato.pdf", tamanhoBytes: bytes.length, sha256, bytes }));
  return emTransacao(() => gravarLeituraContrato(tx, ctx(empresaId), id, { ok: true, modelo: "fake", provedor: "FAKE", leitura: { conteudo, avisos: [] } }));
}
const vista = async (empresaId: string, conteudo: ConteudoModelo = D1) => conferidaDe(await emTransacao(() => contratadaEfetiva(tx, empresaId, conteudo)))!;

async function empresaComPerfil(marca: string, perfil: Record<string, unknown> | null) {
  const codigo = `v3${marca.toLowerCase()}${randomBytes(3).toString("hex")}`;
  // 063: empresa nova nasce em PROVISIONAMENTO; o perfil só resolve com a empresa ATIVA.
  const id = (await client.query<{ id: string }>(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [codigo, `Buffet ${marca}`])).rows[0].id;
  await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
  if (perfil) {
    const cols = Object.keys(perfil);
    await client.query(
      `INSERT INTO perfil_empresas (id, codigo, ${cols.join(", ")}) VALUES ($1::uuid, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")})`,
      [id, codigo, ...Object.values(perfil)],
    );
  }
  return id;
}
const SEDE = { sede_cep: "74000000", sede_logradouro: "Rua A", sede_numero: "10", sede_sem_numero: false, sede_bairro: "Centro", sede_cidade: "Goiânia", sede_uf: "GO", versao: 3 };

test.before(async () => {
  client = await conectarDescartavel();
  tx = executor(client);
  if (!(await client.query<{ ok: boolean }>(`SELECT to_regclass('public.modelos_contrato_empresa') IS NOT NULL AS ok`)).rows[0].ok) {
    for (const f of ["070_precheck", "070_adicionais_do_buffet", "070_postcheck", "071_precheck", "071_importacoes_comerciais", "071_postcheck", "072_precheck", "072_modelos_contrato_empresa", "072_postcheck"]) {
      await client.query(arquivo(`database/${/check/.test(f) ? "checks" : "migrations"}/20261007_${f}.sql`));
    }
  }
  empresas.A = await empresaComPerfil("A", { razao_social: "Buffet A Festas Ltda", cnpj: "11222333000181", ...SEDE });
  empresas.B = await empresaComPerfil("B", { razao_social: "Buffet B Eventos Ltda", cnpj: "45723174000110", ...SEDE, sede_logradouro: "Avenida B", sede_cidade: "Anápolis" });
  empresas.L = await empresaComPerfil("L", null);
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("duas empresas: cada uma recebe só o próprio perfil aplicado; sem perfil → bloco do modelo", async () => {
  const a = await emTransacao(() => contratadaEfetiva(tx, empresas.A, D1));
  const b = await emTransacao(() => contratadaEfetiva(tx, empresas.B, D1));
  assert.equal(a.estado, "PERFIL");
  assert.equal(a.valores?.nome, "Buffet A Festas Ltda");
  assert.equal(a.valores?.endereco, "Rua A, 10, Centro, Goiânia/GO, CEP 74000-000");
  assert.equal(b.valores?.nome, "Buffet B Eventos Ltda");
  assert.match(b.valores!.endereco, /Avenida B.*Anápolis/);
  assert.doesNotMatch(JSON.stringify(b), /Buffet A/);
  assert.equal((await emTransacao(() => contratadaEfetiva(tx, empresas.L, D1))).estado, "MODELO_SEM_PERFIL");
});

test("só o cadastro APLICADO da sede: rascunho do perfil divergente e salão com outro endereço não entram (revisão Astra)", async () => {
  const sufixo = randomBytes(3).toString("hex");
  const autor = (await client.query<{ id: string }>(
    `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Ana v3', $2, 'ADMINISTRATIVO', true) RETURNING id::text AS id`,
    [`anav3${sufixo}@exemplo.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`],
  )).rows[0].id;
  // Salão em outro endereço (mesmo_endereco_sede = false).
  const unidade = (await client.query<{ id: string }>(
    `INSERT INTO perfil_unidades (empresa_id, codigo, nome, mesmo_endereco_sede, cep, logradouro, numero, bairro, cidade, uf)
     VALUES ($1::uuid, $2, 'Salão Jardim', false, '75000000', 'Rua do Salão', '99', 'Jundiaí', 'Anápolis', 'GO') RETURNING id::text AS id`,
    [empresas.A, `SAL${sufixo}`],
  )).rows[0].id;
  // Rascunho do perfil com outra razão social e outro endereço da sede (não aplicado).
  await client.query(
    `INSERT INTO perfil_empresa_revisoes (empresa_id, unidade_id, numero, estado, versao_base, edicao, conteudo, autor_id)
     VALUES ($1::uuid, $2::uuid, 1, 'RASCUNHO', 3, 1, $3::jsonb, $4::uuid)`,
    [empresas.A, unidade, JSON.stringify({ razaoSocial: "Rascunho NÃO APLICADO Ltda", sede: { logradouro: "Rua do Rascunho" } }), autor],
  );
  const c = await emTransacao(() => contratadaEfetiva(tx, empresas.A, D1));
  assert.equal(c.estado, "PERFIL");
  assert.equal(c.valores?.nome, "Buffet A Festas Ltda");
  assert.equal(c.valores?.endereco, "Rua A, 10, Centro, Goiânia/GO, CEP 74000-000", "endereço da SEDE");
  assert.doesNotMatch(JSON.stringify(c), /Rascunho|Salão|Rua do Salão|Anápolis/);
  // Completude avaliada só pela sede: sede incompleta não é completada com o endereço do salão.
  await client.query(`UPDATE perfil_empresas SET sede_bairro = NULL WHERE id = $1::uuid`, [empresas.A]);
  try {
    const inc = await emTransacao(() => contratadaEfetiva(tx, empresas.A, D1));
    assert.equal(inc.estado, "MODELO_INCOMPLETO");
    assert.deepEqual(inc.faltando, ["bairro da sede"]);
  } finally {
    await client.query(`UPDATE perfil_empresas SET sede_bairro = 'Centro' WHERE id = $1::uuid`, [empresas.A]);
  }
});

test("publicação: conteúdo FINAL com a contratada do perfil e a origem; hash do final; auditoria com origem, sha e regra", async () => {
  const r = await rascunho(empresas.A, D1);
  const conferida = await vista(empresas.A);
  const pub = await emTransacao(() => publicarModeloContrato(tx, ctx(empresas.A), r.id, r.versao, { revisadoPorPessoa: true }, conferida));
  const linha = (await client.query<{ conteudo: ConteudoModelo; conteudo_sha256: string }>(`SELECT conteudo, conteudo_sha256 FROM modelos_contrato_empresa WHERE id = $1::uuid`, [pub.modeloId])).rows[0];
  assert.equal(linha.conteudo.contratada.nome, "Buffet A Festas Ltda");
  assert.equal(linha.conteudo.contratada.representante, "Ana Souza", "representante do modelo");
  assert.deepEqual(linha.conteudo.contratadaOrigem, { origem: "PERFIL", perfilVersao: 3 });
  const esperado = aplicarContratada(D1, await emTransacao(() => contratadaEfetiva(tx, empresas.A, D1)));
  assert.equal(linha.conteudo_sha256, createHash("sha256").update(JSON.stringify(esperado)).digest("hex"));
  const aud = (await client.query<{ dados_depois: Record<string, unknown> }>(`SELECT dados_depois FROM auditoria WHERE entidade_id = $1::uuid AND acao = 'MODELO_CONTRATO_PUBLICADO'`, [pub.modeloId])).rows[0];
  assert.deepEqual(aud.dados_depois.contratada, { origem: "PERFIL", perfilVersao: 3 });
  assert.equal(aud.dados_depois.conteudoSha256, linha.conteudo_sha256);
  assert.equal(aud.dados_depois.obrigatorios, 7);
  assert.equal(aud.dados_depois.regraObrigatorios, "D1-20261028");
  const ativo = await modeloContratoAtivo(tx, empresas.A);
  const doc = renderizarModeloEmpresa(ativo!, { snapshot: SNAPSHOT_EXEMPLO, numeroVersao: 1, snapshotHash: "c".repeat(64), geradoEm: "2026-10-28T12:00:00Z" });
  assert.match(doc.contratada[0], /Buffet A Festas Ltda, inscrita sob o nº 11\.222\.333\/0001-81/);
  assert.match(doc.contratante[0], /Maria da Silva \(exemplo\), CPF 123\.456\.789-09/, "bloco fixo sem nome/CPF nas cláusulas");
});

test("CONTRATADA_MUDOU: perfil aplicado entre a prévia e a publicação → 409 e nada gravado; mudar o perfil não altera o publicado", async () => {
  const antes = await modeloContratoAtivo(tx, empresas.A);
  const r = await rascunho(empresas.A, { ...D1, titulo: "Contrato v2" });
  const conferida = await vista(empresas.A);
  await client.query(`UPDATE perfil_empresas SET sede_bairro = 'Setor Oeste', versao = versao + 1 WHERE id = $1::uuid`, [empresas.A]);
  await assert.rejects(emTransacao(() => publicarModeloContrato(tx, ctx(empresas.A), r.id, r.versao, { revisadoPorPessoa: true }, conferida)), /Os dados da empresa mudaram desde a prévia/);
  const depois = await modeloContratoAtivo(tx, empresas.A);
  assert.deepEqual(depois, antes, "publicado intacto");
  assert.equal((await emTransacao(() => lerImportacaoContrato(tx, empresas.A, r.id))).situacao, "RASCUNHO");
  const nova = await vista(empresas.A);
  assert.equal(nova.perfilVersao, 4);
  const pub = await emTransacao(() => publicarModeloContrato(tx, ctx(empresas.A), r.id, r.versao, { revisadoPorPessoa: true }, nova));
  assert.equal(pub.versao, 2);
});

test("rollback: falha depois do INSERT (auditoria) não deixa versão nova nem importação publicada", async () => {
  await client.query(`CREATE OR REPLACE FUNCTION pg_temp.falhar_auditoria() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.acao = 'MODELO_CONTRATO_PUBLICADO' AND current_setting('kidmais.teste_falhar', true) = '1' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $$`);
  await client.query(`CREATE TRIGGER v3_falhar_auditoria BEFORE INSERT ON auditoria FOR EACH ROW EXECUTE FUNCTION pg_temp.falhar_auditoria()`);
  try {
    const r = await rascunho(empresas.B, D1);
    const conferida = await vista(empresas.B);
    await assert.rejects(emTransacao(async () => {
      await client.query(`SET LOCAL kidmais.teste_falhar = '1'`);
      return publicarModeloContrato(tx, ctx(empresas.B), r.id, r.versao, { revisadoPorPessoa: true }, conferida);
    }), /falha simulada/);
    assert.equal((await client.query(`SELECT 1 FROM modelos_contrato_empresa WHERE empresa_id = $1::uuid`, [empresas.B])).rowCount, 0);
    assert.equal((await emTransacao(() => lerImportacaoContrato(tx, empresas.B, r.id))).situacao, "RASCUNHO");
  } finally {
    await client.query(`DROP TRIGGER IF EXISTS v3_falhar_auditoria ON auditoria`);
  }
});

test("modelo ATIVO legado (regra antiga, sem contratadaOrigem) continua carregando e gerando contrato", async () => {
  const legado: ConteudoModelo = { ...D1, clausulas: [{ titulo: null, texto: "Festa em {{festa.data}} para {{contratante.nome}}, CPF {{contratante.cpf}}, total {{valor.total}}." }] };
  const r = await rascunho(empresas.L, legado);
  const json = JSON.stringify(legado);
  await client.query(
    `INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, importacao_id, aprovado_por) VALUES ($1::uuid, 1, $2::jsonb, $3, $4::uuid, $5::uuid)`,
    [empresas.L, json, createHash("sha256").update(json).digest("hex"), r.id, usuario],
  );
  const ativo = await modeloContratoAtivo(tx, empresas.L);
  assert.equal(ativo?.conteudo.contratadaOrigem, undefined);
  const doc = renderizarModeloEmpresa(ativo!, { snapshot: SNAPSHOT_EXEMPLO, numeroVersao: 1, snapshotHash: "d".repeat(64), geradoEm: "2026-10-28T12:00:00Z" });
  assert.match(doc.clausulas[0].texto, /Festa em 24\/10\/2026 para Maria da Silva \(exemplo\)/);
  assert.equal(doc.contratada[0], "CONTRATADA: Buffet do Modelo, inscrita sob o nº 12.345.678/0001-95, com sede em Rua do Modelo, 1.");
});

test("Salvar: envioId gravado com a versão e devolvido no GET; sem envioId (cliente antigo) segue; concorrentes da mesma versão → uma 200, outra 409", async () => {
  const r = await rascunho(empresas.B, D1);
  const envioId = randomUUID();
  const s1 = await emTransacao(() => salvarRevisaoContrato(tx, ctx(empresas.B), r.id, r.versao, { conteudo: { ...D1, titulo: "  Com espaços  " }, avisos: [], envioId }));
  assert.equal(s1.versao, r.versao + 1);
  const lido = await emTransacao(() => lerImportacaoContrato(tx, empresas.B, r.id));
  assert.equal(lido.revisao?.envioId, envioId);
  assert.equal(lido.revisao?.conteudo.titulo, "Com espaços", ".trim() do servidor; o envioId reconcilia mesmo assim");
  const s2 = await emTransacao(() => salvarRevisaoContrato(tx, ctx(empresas.B), r.id, s1.versao, { conteudo: D1, avisos: [] }));
  assert.equal((await emTransacao(() => lerImportacaoContrato(tx, empresas.B, r.id))).revisao?.envioId, undefined);

  // Segunda conexão sem a trava de teste (a primeira já a segura): só assim as duas gravações concorrem de verdade.
  const outro = await conectarDescartavel({ travar: false });
  try {
    const tx2 = executor(outro);
    await client.query("BEGIN");
    await salvarRevisaoContrato(tx, ctx(empresas.B), r.id, s2.versao, { conteudo: D1, avisos: [], envioId: randomUUID() });
    const concorrente = emTransacao(() => salvarRevisaoContrato(tx2, ctx(empresas.B), r.id, s2.versao, { conteudo: D1, avisos: [], envioId: randomUUID() }), outro);
    await new Promise((ok) => setTimeout(ok, 200));
    await client.query("COMMIT");
    await assert.rejects(concorrente, /alterado em outra tela/);
  } finally {
    await encerrarDescartavel(outro);
  }
});

test("descartar: PATCH e publicação depois são recusados; o conteúdo continua no banco; versão desatualizada → 409", async () => {
  const r = await rascunho(empresas.B, D1);
  const conferida = await vista(empresas.B);
  await assert.rejects(emTransacao(() => publicarModeloContrato(tx, ctx(empresas.B), r.id, r.versao - 1 || 99, { revisadoPorPessoa: true }, conferida)), /mudou/);
  await emTransacao(() => descartarImportacaoContrato(tx, ctx(empresas.B), r.id));
  await assert.rejects(emTransacao(() => salvarRevisaoContrato(tx, ctx(empresas.B), r.id, r.versao, { conteudo: D1, avisos: [] })), /alterado em outra tela|publicada ou descartada/);
  await assert.rejects(emTransacao(() => publicarModeloContrato(tx, ctx(empresas.B), r.id, r.versao, { revisadoPorPessoa: true }, conferida)), /publicada ou descartada/);
  const linha = (await client.query<{ situacao: string; revisao: { conteudo: ConteudoModelo } }>(`SELECT situacao, revisao FROM importacoes_comerciais WHERE id = $1::uuid`, [r.id])).rows[0];
  assert.equal(linha.situacao, "DESCARTADA");
  assert.equal(linha.revisao.conteudo.titulo, D1.titulo, "sem exclusão física");
});
