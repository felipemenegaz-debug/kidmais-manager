import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";

/**
 * OBS-2 da revisão de f9d8a63 — Convites (084) e WhatsApp (083) com o Marketing (085/086) presente, no modelo 086
 * (cadeia 083 → 084 → 085 → 086). Só pelo check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL; dados sintéticos; tudo
 * numa transação externa desfeita (os downs rodam sem BEGIN/COMMIT próprios, como na suíte migration-085-086).
 *   1. catálogo: o postcheck 084 passa com 085/086; os downs 086 → 085 não mudam convite_geracoes nem whatsapp_conexoes;
 *      o down 084 depois deles volta convite_geracoes ao formato da 079 (resolução preservada) sem tocar o WhatsApp;
 *   2. dados: geração de convite com etapas (084) aceita e combinações inválidas recusadas com o Marketing presente; o
 *      gatilho da 086 em clientes (troca de telefone) não altera o convite; com dados, o down 085 e o down 084 recusam
 *      sem perda parcial (contato, geração e catálogo intactos depois de cada recusa).
 * O fixture de Festa é cópia literal de lib/festas/tenant-festa.postgres.test.ts (linhas 62–101 em f9d8a63), provado
 * naquela suíte nos modelos atual/061–063; neste modelo ainda NÃO foi executado.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const POST084 = ler("database/checks/20261018_084_postcheck.sql");
const DOWN084 = ler("database/rollback/20261018_084_convite_geracao_pendencias_down.sql");
const DOWN085 = ler("database/rollback/20261018_085_marketing_base_down.sql");
const DOWN086 = ler("database/rollback/20261018_086_marketing_automacoes_down.sql");
const COLUNAS_084 = ["enviado_em", "etapas_registradas", "falha_classe", "falha_detalhes", "falha_diagnostico", "recebido_em", "resultado_pendente"];

const cod = () => `oc${randomBytes(3).toString("hex")}`;
const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

type Catalogo = { convites_constraints: Record<string, string>; convites_colunas: string[]; convites_indices: string[]; convites_gatilhos: string[];
  whatsapp_constraints: Record<string, string>; whatsapp_colunas: string[] };
const SQL_CATALOGO = `SELECT
  (SELECT jsonb_object_agg(conname, pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.convite_geracoes'::regclass) AS convites_constraints,
  (SELECT jsonb_agg(column_name::text ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='convite_geracoes') AS convites_colunas,
  (SELECT jsonb_agg(indexname::text ORDER BY indexname) FROM pg_indexes WHERE schemaname='public' AND tablename='convite_geracoes') AS convites_indices,
  (SELECT coalesce(jsonb_agg(tgname::text ORDER BY tgname), '[]'::jsonb) FROM pg_trigger WHERE tgrelid IN ('public.convites'::regclass,'public.convite_geracoes'::regclass) AND NOT tgisinternal) AS convites_gatilhos,
  (SELECT jsonb_object_agg(conname, pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.whatsapp_conexoes'::regclass) AS whatsapp_constraints,
  (SELECT jsonb_agg(column_name::text ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_conexoes') AS whatsapp_colunas`;
const catalogo = async (c: Client) => (await c.query<Catalogo>(SQL_CATALOGO)).rows[0];
const tabelasMarketing = async (c: Client) =>
  (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'marketing\\_%'`)).rows[0].n;

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}

async function empresa(db: Client) {
  const e = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa composição', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}

/** Contrato ASSINADO com versão vigente e a Festa dele — cópia literal de lib/festas/tenant-festa.postgres.test.ts:62-101 (blob 1719e7e54170 em f9d8a63). */
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
  // Formalização 019 completa (o que kidmais019_formalizacao exige na criação da Festa): documento revisado,
  // edição CONCLUIDA, assinaturas KIDMAIS e CLIENTE sobre o mesmo PDF e o mesmo snapshot.
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
  return { festa: f, versao };
}

test("catálogo: 084 intacta com 085/086; downs 086 → 085 não tocam Convites/WhatsApp; 084 depois volta ao formato 079", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    assert.equal(await tabelasMarketing(c), 19, "modelo 086: 11 tabelas da 085 + 8 da 086");
    await c.query(POST084);
    const s0 = await catalogo(c);
    for (const col of COLUNAS_084) assert.ok(s0.convites_colunas.includes(col), "084 presente: " + col);
    assert.match(s0.convites_constraints.convite_geracoes_estado_check, /NAO_ENVIADA/);
    await c.query("BEGIN");
    await c.query(semTransacaoExplicita(DOWN086));
    assert.deepEqual(await catalogo(c), s0, "down 086 não muda Convites nem WhatsApp");
    await c.query(semTransacaoExplicita(DOWN085));
    assert.deepEqual(await catalogo(c), s0, "down 085 não muda Convites nem WhatsApp");
    assert.equal(await tabelasMarketing(c), 0);
    await c.query(semTransacaoExplicita(DOWN084));
    const s3 = await catalogo(c);
    for (const col of COLUNAS_084) assert.ok(!s3.convites_colunas.includes(col), "084 removida: " + col);
    assert.doesNotMatch(s3.convites_constraints.convite_geracoes_estado_check, /NAO_ENVIADA/);
    assert.match(s3.convites_constraints.convite_geracoes_estado_check, /RESOLVIDA_SEM_COBRANCA/);
    assert.equal(s3.convites_constraints.convite_geracoes_etapas_consistentes, undefined);
    assert.equal(s3.convites_constraints.convite_geracoes_resolucao_consistente, s0.convites_constraints.convite_geracoes_resolucao_consistente, "079 preservada");
    assert.ok(!s3.convites_indices.includes("convite_geracoes_em_aberto"));
    assert.deepEqual(s3.convites_gatilhos, s0.convites_gatilhos);
    assert.deepEqual([s3.whatsapp_constraints, s3.whatsapp_colunas], [s0.whatsapp_constraints, s0.whatsapp_colunas], "WhatsApp intacto");
    await c.query("ROLLBACK");
    assert.deepEqual(await catalogo(c), s0, "tudo desfeito");
    assert.equal(await tabelasMarketing(c), 19);
  } finally {
    await encerrarDescartavel(c);
  }
});

test("dados: geração de convite (084) com o Marketing presente; gatilho de clientes; downs recusam com dados, sem perda parcial", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const s0 = await catalogo(c);
    await c.query("BEGIN");
    const A = await empresa(c);
    const criador = await id(c, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Usuário composição', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${cod()}@example.test`, SENHA_FALSA]);
    const { festa: F, versao } = await festa(c, A, criador);
    const { cliente } = (await c.query<{ cliente: string }>(`SELECT fe.cliente_id::text AS cliente FROM festas f JOIN contratos ct ON ct.id = f.contrato_id
      JOIN fechamentos fe ON fe.id = ct.fechamento_id WHERE f.id = $1::uuid`, [F])).rows[0];
    const convite = await id(c, `INSERT INTO convites (empresa_id, festa_id, cliente_id, estabelecimento_id, publico_token, rascunho, versao_contrato_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4, '{}'::jsonb, $5::uuid) RETURNING id`, [A, F, cliente, randomBytes(32).toString("base64url"), versao]);
    const geracao = randomUUID();
    const inserirGeracao = `INSERT INTO convite_geracoes (id, convite_id, empresa_id, ator, payload_hash, modelo, estado, etapas_registradas, enviado_em, recebido_em, falha_classe)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'teste-composicao', $4, 'modelo-sintetico', $5, $6, $7::timestamptz, $8::timestamptz, $9)`;
    const hashPayload = createHash("sha256").update("composicao").digest("hex");
    // Combinações que a 084 recusa, com o Marketing presente.
    await recusa(c, inserirGeracao, [randomUUID(), convite, A, hashPayload, "NAO_ENVIADA", true, null, null, null], /convite_geracoes_etapas_consistentes/);
    await recusa(c, inserirGeracao, [randomUUID(), convite, A, hashPayload, "INCERTA", true, null, new Date().toISOString(), null], /convite_geracoes_etapas_consistentes/);
    await recusa(c, inserirGeracao, [randomUUID(), convite, A, hashPayload, "INCERTA", false, new Date().toISOString(), null, null], /convite_geracoes_etapas_consistentes/);
    // Geração válida do código novo: enviada, sem resposta, INCERTA.
    await c.query(inserirGeracao, [geracao, convite, A, hashPayload, "INCERTA", true, new Date().toISOString(), null, null]);
    const linhaGeracao = async () => (await c.query(`SELECT estado, etapas_registradas, enviado_em IS NOT NULL AS enviado, falha_classe FROM convite_geracoes WHERE id = $1::uuid`, [geracao])).rows[0];
    const antes = await linhaGeracao();
    assert.deepEqual(antes, { estado: "INCERTA", etapas_registradas: true, enviado: true, falha_classe: null });
    // Dado do Marketing para o mesmo cliente; a troca de telefone dispara o gatilho da 086 em clientes.
    const contato = await id(c, `INSERT INTO marketing_contatos (empresa_id, cliente_id, canal_atendimento, nome, telefone, chave_idempotencia, vinculo_cliente)
      VALUES ($1::uuid, $2::uuid, 'FORMULARIO_SITE', 'Contato composição', '5511988880099', $3, 'NOVO') RETURNING id::text AS id`, [A, cliente, `chave-composicao-${cod()}`]);
    await c.query(`UPDATE clientes SET telefone = '5511977770099' WHERE id = $1::uuid`, [cliente]);
    assert.deepEqual(await linhaGeracao(), antes, "gatilho do Marketing em clientes não toca a geração do convite");
    // Downs com dados: cada recusa desfaz o próprio savepoint e nada se perde.
    const intacto = async (rotulo: string) => {
      assert.deepEqual(await linhaGeracao(), antes, rotulo + ": geração preservada");
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM marketing_contatos WHERE id = $1::uuid`, [contato])).rows[0].n, 1, rotulo + ": contato preservado");
      assert.deepEqual(await catalogo(c), s0, rotulo + ": catálogo de Convites/WhatsApp intacto");
    };
    await c.query("SAVEPOINT downs");
    await c.query(semTransacaoExplicita(DOWN086));
    await assert.rejects(c.query(semTransacaoExplicita(DOWN085)), /085: há contatos, atribuições, versões publicadas ou eventos; rollback recusado/);
    await c.query("ROLLBACK TO SAVEPOINT downs");
    assert.equal(await tabelasMarketing(c), 19, "a recusa da 085 desfaz também o down 086 do mesmo savepoint");
    await intacto("down 085 recusado");
    await c.query("SAVEPOINT down084");
    await assert.rejects(c.query(semTransacaoExplicita(DOWN084)), /084 rollback recusado/);
    await c.query("ROLLBACK TO SAVEPOINT down084");
    await intacto("down 084 recusado");
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});
