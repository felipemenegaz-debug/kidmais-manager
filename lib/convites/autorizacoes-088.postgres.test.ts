import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";
import { AUTORIZACAO_AINDA_VIGENTE, autorizacaoVigente, hashTextoIA, registrarAutorizacao, resumoAutorizacao, revogarAutorizacao } from "./consentimento.ts";
import { VERSAO_TEXTOS_IA } from "./consentimento-textos.ts";

/**
 * 088 — autorização específica do responsável legal para Convites com IA, no PostgreSQL descartável sobre o modelo
 * 086 (cadeia completa até a 086, sem a 087 de outro trabalho local). Só pelo check:v1:postgres com
 * KIDMAIS_POSTGRES_DESCARTAVEL; dados sintéticos.
 *   1. precheck, aplicação, postcheck e reaplicação recusada;
 *   2. dados (transação desfeita): registro pelo serviço real, isolamento por empresa (chave composta, gatilho e
 *      consultas filtradas), constraints, uma vigente por convite, substituição, imutabilidade, revogação, marcador
 *      do envio condicionado à autorização, rollback recusado com dados;
 *   3. rollback sem dados (desfeito no fim).
 * O fixture de Festa é cópia de lib/marketing/composicao-convites-085-086.postgres.test.ts (que copia
 * lib/festas/tenant-festa.postgres.test.ts), com vínculo (membership) do usuário acrescentado.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261021_088_convite_ia_autorizacoes.sql");
const PRE = ler("database/checks/20261021_088_precheck.sql");
const POST = ler("database/checks/20261021_088_postcheck.sql");
const DOWN = ler("database/rollback/20261021_088_convite_ia_autorizacoes_down.sql");

const cod = () => `ia${randomBytes(3).toString("hex")}`;
const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}
async function recusaFn(c: Client, fn: () => Promise<unknown>, motivo: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(fn(), motivo);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}

async function empresa(db: Client) {
  const e = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa 088', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}
async function usuario(db: Client, empresaId: string) {
  const u = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Usuário 088', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${cod()}@example.test`, SENHA_FALSA]);
  const m = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresaId, u]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return u;
}

/** Contrato ASSINADO com versão vigente e a Festa dele (cópia do fixture da composição 085/086). */
async function festa(db: Client, empresaId: string, criador: string) {
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa E1', 1, true, true) RETURNING id`, [empresaId, cod().toUpperCase()]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela E1', '2026-01-01', false, $2::uuid) RETURNING id`, [cod(), empresaId]);
  const preco = await id(db, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
  const agenda = await id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda E1', '10:00', '18:00', 9) RETURNING id`, [cod()]);
  const cliente = await id(db, `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente E1', $1::uuid) RETURNING id`, [empresaId]);
  const fechamento = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
    VALUES ('2026-09-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
    [agenda, empresaId, pacote, tabela, preco, cliente]);
  const contrato = await id(db, `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`, [fechamento]);
  const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2026-09-01", convidados: 20, pacote: { codigo: "E1", nome: "Festa E1" } }, contratacao: { buffet: {}, adicionais: [] } };
  const hash = hashSnapshotContrato(snapshot);
  const pdf = Buffer.from(`%PDF-1.4
% E1 contrato ${randomUUID()}
%%EOF
`);
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  const versao = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
     VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`, [contrato, JSON.stringify(snapshot), hash, pdfHash]);
  const doc = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
     VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_E1', 1, $3, $4, $5, $6::uuid) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf, criador]);
  const comprovante = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf)
     VALUES ($1::uuid, 'COMPROVANTE_ASSINATURA', 1, $2, 'COMPROVANTE_E1', 1, $3, $4, $5) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf]);
  await db.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
     VALUES ($1::uuid, $2::uuid, 'INICIAL', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, contrato, criador, doc]);
  const validacao = await id(db, `INSERT INTO validacoes_identidade_cliente (cliente_id, canal, status, confirmado_em, token_prova_hash, prova_expira_em) VALUES ($1::uuid, 'EMAIL', 'CONFIRMADA', now(), $2, now() + interval '10 minutes') RETURNING id`, [cliente, randomBytes(32).toString("hex")]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, $4::uuid, 'SENHA', now(), $5::jsonb, $6, $7, 'SESSAO_REAUTENTICADA', 'INTERNAL', now(), $8::uuid, $9::uuid, $10::uuid)`,
    [versao, doc, criador, randomUUID(), JSON.stringify({ usuarioId: criador, papel: "REPRESENTANTE_AUTORIZADO", nome: "Usuário E1", cargo: null }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, validacao_identidade_id, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'CLIENTE', $2::uuid, $3::uuid, $4::jsonb, $5, $6, 'OTP', 'INTERNAL', now(), $7::uuid, $8::uuid, $9::uuid)`,
    [versao, doc, validacao, JSON.stringify({ schemaVersao: 1, clienteId: cliente, nome: "Cliente E1" }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
  const f = await id(db, `INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id`,
    [contrato, versao, randomUUID(), createHash("sha256").update("e1").digest("hex"), criador]);
  const convite = await id(db, `INSERT INTO convites (empresa_id, festa_id, cliente_id, estabelecimento_id, publico_token, rascunho, versao_contrato_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4, '{}'::jsonb, $5::uuid) RETURNING id`, [empresaId, f, cliente, randomBytes(32).toString("base64url"), versao]);
  return { id: convite, empresa_id: empresaId, festa_id: f, cliente_id: cliente };
}

const INSERIR = `INSERT INTO convite_ia_autorizacoes (empresa_id, convite_id, festa_id, provedor, texto_versao, texto_hash, operador_tipo, operador_usuario_id,
  operador_cliente_id, responsavel_nome, responsavel_vinculo, meio, declaracao_responsavel, foto_autorizada)
  VALUES ($1::uuid, $2::uuid, $3::uuid, 'openai', $4, $5, $6, $7::uuid, $8::uuid, 'Responsável Sintético', 'MAE', $9, $10, false)`;

test("088: precheck, aplicação, postcheck e reaplicação recusada", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    await c.query(PRE);
    await c.query(UP);
    await c.query(POST);
    await assert.rejects(c.query(UP), /088: precheck falhou/); await c.query("ROLLBACK").catch(() => {});
    await assert.rejects(c.query(PRE), /088 precheck: aplicação anterior ou parcial/);
    await c.query(POST);
  } finally {
    await encerrarDescartavel(c);
  }
});

test("088: registro, isolamento por empresa, constraints, imutabilidade, revogação, marcador do envio e rollback recusado com dados", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    await c.query(POST);
    await c.query("BEGIN");
    const A = await empresa(c), B = await empresa(c);
    const uA = await usuario(c, A), uB = await usuario(c, B);
    const cA = await festa(c, A, uA), cB = await festa(c, B, uB);
    const nova = (extra: Record<string, unknown> = {}) => ({ versao: VERSAO_TEXTOS_IA, provedor: "openai", textoHash: hashTextoIA("openai", "BUFFET", true),
      responsavelNome: "  Joana   Responsável  ", vinculo: "MAE" as const, meio: "WHATSAPP" as const, declaracao: true as const, foto: true, ...extra });

    // Registro pelo serviço real (empresa A, funcionário A): todos os campos do registro.
    const r1 = await registrarAutorizacao(c, cA, { tipo: "BUFFET", usuarioId: uA }, `USUARIO:${uA}`, "openai", nova());
    const linha = (await c.query(`SELECT empresa_id::text, convite_id::text, festa_id::text, finalidade, provedor, texto_versao, texto_hash, operador_tipo,
      operador_usuario_id::text, operador_cliente_id, responsavel_nome, responsavel_vinculo, meio, declaracao_responsavel, foto_autorizada, criado_em IS NOT NULL AS tem_data, revogada_em
      FROM convite_ia_autorizacoes WHERE id = $1::uuid`, [r1.id])).rows[0];
    assert.deepEqual(linha, { empresa_id: A, convite_id: cA.id, festa_id: cA.festa_id, finalidade: "CONVITE_IA", provedor: "openai", texto_versao: VERSAO_TEXTOS_IA,
      texto_hash: hashTextoIA("openai", "BUFFET", true), operador_tipo: "BUFFET", operador_usuario_id: uA, operador_cliente_id: null, responsavel_nome: "Joana Responsável",
      responsavel_vinculo: "MAE", meio: "WHATSAPP", declaracao_responsavel: true, foto_autorizada: true, tem_data: true, revogada_em: null });
    assert.equal((await autorizacaoVigente(c, cA, "openai"))?.id, r1.id);
    assert.equal(await autorizacaoVigente(c, cA, "gemini"), null, "outro provedor não vale");
    // Isolamento: o mesmo convite visto pela empresa B não existe; B não revoga a autorização de A.
    assert.equal(await autorizacaoVigente(c, { id: cA.id, empresa_id: B }, "openai"), null);
    assert.deepEqual(await resumoAutorizacao(c, { id: cA.id, empresa_id: B }, "openai"), { vigente: null, precisaRenovar: false });
    assert.equal(await revogarAutorizacao(c, { id: cA.id, empresa_id: B }, `USUARIO:${uB}`), null);
    assert.equal((await autorizacaoVigente(c, cA, "openai"))?.id, r1.id);
    // Banco recusa vínculos cruzados mesmo em inserts manuais.
    await recusa(c, INSERIR, [B, cA.id, cA.festa_id, VERSAO_TEXTOS_IA, "a".repeat(64), "BUFFET", uB, null, "PRESENCIAL", true], /não correspondem/);
    // Mesmo sem o gatilho (ex.: desabilitado por engano), a chave composta (convite_id, empresa_id) recusa.
    await c.query("SAVEPOINT sem_gatilho");
    await c.query("ALTER TABLE convite_ia_autorizacoes DISABLE TRIGGER convite_ia_autorizacao_validar");
    await assert.rejects(c.query(INSERIR, [B, cA.id, cA.festa_id, VERSAO_TEXTOS_IA, "a".repeat(64), "BUFFET", uB, null, "PRESENCIAL", true]), /foreign key|violates/);
    await c.query("ROLLBACK TO SAVEPOINT sem_gatilho");
    assert.equal((await c.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'convite_ia_autorizacao_validar'`)).rows[0].tgenabled, "O");
    await recusa(c, INSERIR, [A, cA.id, cB.festa_id, VERSAO_TEXTOS_IA, "a".repeat(64), "BUFFET", uA, null, "PRESENCIAL", true], /não correspondem/);
    await recusaFn(c, () => registrarAutorizacao(c, cA, { tipo: "BUFFET", usuarioId: uB }, `USUARIO:${uB}`, "openai", nova()), /sem vínculo ativo/);
    await recusaFn(c, () => registrarAutorizacao(c, cA, { tipo: "CLIENTE", clienteId: cB.cliente_id }, `CLIENTE:${cB.cliente_id}`, "openai",
      nova({ meio: undefined, textoHash: hashTextoIA("openai", "CLIENTE", true) })), /cliente não é o do convite/);
    // Constraints: meio coerente com quem opera, declaração obrigatória, provedor fechado; uma não revogada por convite.
    await recusa(c, INSERIR, [A, cA.id, cA.festa_id, VERSAO_TEXTOS_IA, "a".repeat(64), "BUFFET", uA, null, "PROPRIO_RESPONSAVEL", true], /convite_ia_autorizacoes_operador/);
    await recusa(c, INSERIR, [A, cA.id, cA.festa_id, VERSAO_TEXTOS_IA, "a".repeat(64), "BUFFET", uA, null, "PRESENCIAL", false], /declaracao_responsavel_check/);
    await recusa(c, INSERIR.replace("'openai'", "'deepseek'"), [A, cA.id, cA.festa_id, VERSAO_TEXTOS_IA, "a".repeat(64), "BUFFET", uA, null, "PRESENCIAL", true], /provedor_check/);
    await recusa(c, INSERIR, [A, cA.id, cA.festa_id, VERSAO_TEXTOS_IA, "a".repeat(64), "BUFFET", uA, null, "PRESENCIAL", true], /convite_ia_autorizacao_vigente/);
    // Imutável: só a revogação muda, uma vez.
    await recusa(c, `UPDATE convite_ia_autorizacoes SET responsavel_nome = 'Outro' WHERE id = $1::uuid`, [r1.id], /registro imutável/);
    await recusa(c, `UPDATE convite_ia_autorizacoes SET foto_autorizada = false WHERE id = $1::uuid`, [r1.id], /registro imutável/);

    // Marcador do envio (SQL real do serviço): só grava com a autorização da reserva ainda não revogada.
    const marcador = `UPDATE convite_geracoes SET enviado_em=clock_timestamp() WHERE id=$1 AND estado='RESERVADA' AND etapas_registradas AND enviado_em IS NULL
      AND ${AUTORIZACAO_AINDA_VIGENTE} RETURNING id`;
    const geracao = async () => { const g = randomUUID(); await c.query(`INSERT INTO convite_geracoes (id, convite_id, empresa_id, ator, payload_hash, modelo, etapas_registradas)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'teste-088', $4, 'modelo-sintetico', true)`, [g, cA.id, A, "b".repeat(64)]); return g; };
    const g1 = await geracao();
    // Autorização de outra empresa/convite não serve como prova.
    const rB = await registrarAutorizacao(c, cB, { tipo: "BUFFET", usuarioId: uB }, `USUARIO:${uB}`, "openai", nova());
    assert.equal((await c.query(marcador, [g1, rB.id])).rowCount, 0);
    assert.equal((await c.query(marcador, [g1, r1.id])).rowCount, 1);
    await c.query(`UPDATE convite_geracoes SET estado='INCERTA' WHERE id=$1::uuid`, [g1]); // libera o índice de uma RESERVADA por festa

    // Substituição pelo responsável no link (CLIENTE): a anterior vira SUBSTITUIDA; segue uma só não revogada.
    const r2 = await registrarAutorizacao(c, cA, { tipo: "CLIENTE", clienteId: cA.cliente_id }, `CLIENTE:${cA.cliente_id}`, "openai",
      nova({ meio: undefined, foto: false, textoHash: hashTextoIA("openai", "CLIENTE", false) }));
    assert.equal(r2.substituiu, r1.id);
    assert.deepEqual((await c.query(`SELECT id::text, revogacao_motivo, revogada_por, meio, operador_tipo FROM convite_ia_autorizacoes WHERE convite_id = $1::uuid ORDER BY criado_em, revogada_em NULLS LAST`, [cA.id])).rows,
      [{ id: r1.id, revogacao_motivo: "SUBSTITUIDA", revogada_por: `CLIENTE:${cA.cliente_id}`, meio: "WHATSAPP", operador_tipo: "BUFFET" },
        { id: r2.id, revogacao_motivo: null, revogada_por: null, meio: "PROPRIO_RESPONSAVEL", operador_tipo: "CLIENTE" }]);
    await recusa(c, `UPDATE convite_ia_autorizacoes SET revogada_em = now(), revogada_por = 'USUARIO:x', revogacao_motivo = 'REVOGADA' WHERE id = $1::uuid`, [r1.id], /registro imutável/);
    const resumo = await resumoAutorizacao(c, cA, "openai");
    assert.equal(resumo.vigente?.foto, false); assert.equal(resumo.vigente?.operador, "CLIENTE"); assert.ok(!JSON.stringify(resumo).includes("Joana"));

    // Revogação para usos futuros: o marcador do envio não grava mais.
    assert.equal(await revogarAutorizacao(c, cA, `USUARIO:${uA}`), r2.id);
    assert.equal(await autorizacaoVigente(c, cA, "openai"), null);
    assert.equal(await revogarAutorizacao(c, cA, `USUARIO:${uA}`), null, "revogar de novo não muda nada");
    const g2 = await geracao();
    assert.equal((await c.query(marcador, [g2, r2.id])).rowCount, 0);
    assert.equal((await c.query(`SELECT enviado_em FROM convite_geracoes WHERE id = $1::uuid`, [g2])).rows[0].enviado_em, null);

    // Rollback com dados: recusado, nada perdido.
    await c.query("SAVEPOINT down");
    await assert.rejects(c.query(semTransacaoExplicita(DOWN)), /088 rollback recusado: há autorizações registradas/);
    await c.query("ROLLBACK TO SAVEPOINT down");
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM convite_ia_autorizacoes WHERE convite_id IN ($1::uuid, $2::uuid)`, [cA.id, cB.id])).rows[0].n, 3);
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("088: rollback sem dados remove tabela e gatilho; desfeito, o schema volta e o postcheck passa", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM convite_ia_autorizacoes`)).rows[0].n, 0);
    await c.query("BEGIN");
    await c.query(semTransacaoExplicita(DOWN));
    assert.deepEqual((await c.query(`SELECT to_regclass('public.convite_ia_autorizacoes') IS NULL AS sem_tabela, to_regprocedure('public.convite_ia_autorizacao_validar()') IS NULL AS sem_funcao`)).rows[0],
      { sem_tabela: true, sem_funcao: true });
    await c.query(PRE); // depois do down, a 088 pode ser reaplicada
    await c.query("ROLLBACK");
    await c.query(POST);
  } finally {
    await encerrarDescartavel(c);
  }
});
