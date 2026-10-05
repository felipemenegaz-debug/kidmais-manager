import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { hashToken } from "../autenticacao/senha.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";

/**
 * E1 — Festa com Tenant Context no PostgreSQL REAL (serviço de produção, schema atual). Roda numa transação
 * externa nunca confirmada (as transações do serviço viram SAVEPOINTs): a Festa exige contrato assinado, e as
 * guardas DIFERIDAS de formalização (019) não são o objeto aqui. Concorrência de revogação usa o mesmo
 * provarTenant já provado em conexões reais no gates-c2.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
const extensoes = exigir.extensions as unknown as Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_texto, caminho: string) => `require(${JSON.stringify(resolve(root, caminho))})`);
  module._compile(output, filename);
};

const cod = () => `e1${randomBytes(3).toString("hex")}`;
const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;

async function empresa(db: Client) {
  const e = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa E1', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}

type Vinculo = { empresa: string; papel?: string; capacidades?: string[] };
/** Identidade global + uma membership por empresa (papel e capacidades DAQUELA membership) + sessão. */
async function usuario(db: Client, vinculos: Vinculo[], papelGlobal = "REPRESENTANTE_AUTORIZADO") {
  const email = `${cod()}@example.test`;
  const u = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Usuário E1', $2, $3, true) RETURNING id`,
    [email, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`, papelGlobal]);
  const memberships: Record<string, string> = {};
  for (const v of vinculos) {
    const m = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [v.empresa, u, v.papel ?? papelGlobal]);
    await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    for (const c of v.capacidades ?? []) {
      await db.query(`INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'Fixture 056')`, [v.empresa, m, c, u]);
    }
    memberships[v.empresa] = m;
  }
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`, [u, hashToken(token), hashToken(randomBytes(32).toString("base64url"))]);
  return { id: u, token, email, memberships, sessao: { usuario_id: u, papel: papelGlobal } };
}

/** Contrato ASSINADO com versão vigente e a Festa dele, na empresa dada. */
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

const TODAS = ["FESTA_CONSULTAR", "FESTA_CRIAR", "FESTA_OPERAR", "FESTA_CORRIGIR", "FESTA_CONFIGURAR_AREAS"];

test("E1/056 real: identidade global, membership por empresa, papel e capacidade de A nunca valem em B, Festa e áreas no tenant", { timeout: 120_000 }, async (t) => {
  const anterior = process.env.FESTA_ENABLED;
  process.env.FESTA_ENABLED = "true";
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    await db.query("BEGIN");
    const A = await empresa(db);
    const B = await empresa(db);
    const gestaoA = await usuario(db, [{ empresa: A, capacidades: TODAS }]);
    const gestaoB = await usuario(db, [{ empresa: B, capacidades: TODAS }]);
    const membroA = await usuario(db, [{ empresa: A, papel: "ADMINISTRATIVO" }], "ADMINISTRATIVO");
    const soB = await usuario(db, [{ empresa: B, papel: "ADMINISTRATIVO" }], "ADMINISTRATIVO");
    // Compartilhado: Equipe em A (sem capacidade), Gestão em B (com capacidades em B).
    const comp = await usuario(db, [{ empresa: A, papel: "ADMINISTRATIVO" }, { empresa: B, papel: "REPRESENTANTE_AUTORIZADO", capacidades: TODAS }]);
    const fA = await festa(db, A, gestaoA.id);
    const fB = await festa(db, B, gestaoB.id);
    const troca: Record<string, string> = { BEGIN: "SAVEPOINT operacao", COMMIT: "RELEASE SAVEPOINT operacao", ROLLBACK: "ROLLBACK TO SAVEPOINT operacao" };
    (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = {
      query: (sql: string, v?: unknown[]) => db.query(sql, v),
      connect: async () => ({ query: (sql: string, v?: unknown[]) => db.query(troca[sql] ?? sql, v), release() {} }),
    };
    const svc = exigir(resolve(root, "lib/festas/service.ts")) as Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>>;
    const contas = exigir(resolve(root, "lib/autenticacao/usuarios.ts")) as Record<string, (...a: unknown[]) => Promise<Record<string, unknown>>>;
    const { provarTenant } = exigir(resolve(root, "lib/saas/provar-tenant.ts")) as { provarTenant: (tx: unknown, s: unknown, e?: string | null) => Promise<{ empresaComprovada: string; papelAtual: string }> };
    const ctxDe = (u: { token: string }, empresaSolicitada: string | null = null) => ({ token: u.token, requestId: randomUUID(), userAgent: null, empresaSolicitada });
    const status = (e: unknown) => (e as { status?: number; httpStatus?: number }).status ?? (e as { httpStatus?: number }).httpStatus;
    const q = async <R>(sql: string, v: unknown[] = []) => (await db.query(sql, v)).rows as R[];
    // 063: sessão de quem tem mais de uma empresa opera na empresa SELECIONADA (seletor "Empresa ativa"); antes da
    // 063 a seleção não existe e o empresaId pedido escolhe entre as memberships (regra legada).
    const selecionar = async (u: { token: string }, empresaId: string) => {
      const instalada = (await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sessoes_administrativas' AND column_name='empresa_ativa_id'")).rows.length > 0;
      if (instalada) await db.query("UPDATE sessoes_administrativas SET empresa_ativa_id = $2::uuid WHERE token_hash = $1", [hashToken(u.token), empresaId]);
    };
    const tenantOk = async (u: { sessao: unknown }, e: string) => { await db.query("SAVEPOINT prova"); try { return await provarTenant(db, u.sessao, e); } finally { await db.query("ROLLBACK TO SAVEPOINT prova"); } };

    await t.test("identidade global: o mesmo e-mail em A e B é UMA identidade com DUAS memberships; conta nova nasce administrável", async () => {
      const antes = (await q<{ n: number }>("SELECT count(*)::int AS n FROM usuarios_administrativos"))[0].n;
      const ligado = await contas.criarUsuarioAdministrativo(gestaoA.sessao, { acao: "criar", nome: "Outro nome", email: soB.email.toUpperCase(), nivel: "EQUIPE", senha: "nao-muda-1", confirmacao: "nao-muda-1" }, randomUUID(), undefined, A);
      // F2: a resposta é só a membership desta empresa — sem id, nome ou situação da identidade global.
      const chavesF2 = ["associado", "email", "membershipId", "nivelSistema", "papel", "reutilizado", "statusMembership"];
      assert.deepEqual(Object.keys(ligado).sort(), chavesF2);
      assert.ok(!JSON.stringify(ligado).includes(soB.id) && !JSON.stringify(ligado).includes("Usuário E1") && !JSON.stringify(ligado).includes(B));
      assert.equal((await q<{ n: number }>("SELECT count(*)::int AS n FROM usuarios_administrativos"))[0].n, antes, "nenhuma identidade duplicada");
      assert.deepEqual((await q<{ empresa_id: string; status: string }>("SELECT empresa_id::text, status FROM memberships WHERE usuario_id = $1::uuid ORDER BY empresa_id", [soB.id])).map((r) => r.empresa_id).sort(), [A, B].sort());
      assert.equal((await q<{ nome: string }>("SELECT nome FROM usuarios_administrativos WHERE id = $1::uuid", [soB.id]))[0].nome, "Usuário E1", "identidade intacta");
      const emailNovo = `${cod()}@example.test`;
      const novo = await contas.criarUsuarioAdministrativo(gestaoA.sessao, { acao: "criar", nome: "Nova pessoa", email: emailNovo, nivel: "EQUIPE", senha: "senha-longa-1", confirmacao: "senha-longa-1" }, randomUUID(), undefined, A);
      assert.deepEqual(Object.keys(novo).sort(), chavesF2, "mesmo formato para e-mail novo e existente");
      const novoId = (await q<{ id: string }>("SELECT id FROM usuarios_administrativos WHERE email = $1", [emailNovo]))[0].id;
      const vinc = await q<{ empresa_id: string; status: string; papel: string }>("SELECT empresa_id::text, status, papel FROM memberships WHERE usuario_id = $1::uuid", [novoId]);
      assert.deepEqual(vinc, [{ empresa_id: A, status: "ATIVA", papel: "ADMINISTRATIVO" }], "membership certa, na empresa criadora");
      const caps = await q<{ capacidade: string; empresa_id: string }>("SELECT capacidade, empresa_id::text FROM festa_membership_capacidades WHERE membership_id = $1::uuid AND revogado_em IS NULL ORDER BY capacidade", [novo.membershipId]);
      assert.deepEqual(caps.map((c) => c.capacidade), ["FESTA_CONSULTAR", "FESTA_OPERAR"]);
      assert.ok(caps.every((c) => c.empresa_id === A));
      await contas.alterarPapelNaEmpresa(gestaoA.sessao, { acao: "papel", usuarioId: novoId, nivel: "GESTAO" }, randomUUID(), undefined, A);
      assert.equal((await q<{ papel: string }>("SELECT papel FROM memberships WHERE usuario_id = $1::uuid", [novoId]))[0].papel, "REPRESENTANTE_AUTORIZADO", "administrável na hora");
      assert.equal((await q<{ papel: string }>("SELECT papel FROM usuarios_administrativos WHERE id = $1::uuid", [novoId]))[0].papel, "ADMINISTRATIVO", "promover na empresa não toca o papel global");
    });

    await t.test("F1: Gestão criada por A tem identidade global neutra (sem plataforma), opera em A pela membership e nada vale em B", async () => {
      const { temAutoridadeDePlataforma } = exigir(resolve(root, "lib/autenticacao/plataforma.ts")) as { temAutoridadeDePlataforma: (s: { papel: string }) => boolean };
      const email = `${cod()}@example.test`;
      await contas.criarUsuarioAdministrativo(gestaoA.sessao, { acao: "criar", nome: "Gestão nova", email, nivel: "GESTAO", senha: "senha-longa-1", confirmacao: "senha-longa-1" }, randomUUID(), undefined, A);
      const ident = (await q<{ id: string; papel: string; ativo: boolean }>("SELECT id, papel, ativo FROM usuarios_administrativos WHERE email = $1", [email]))[0];
      assert.equal(ident.papel, "ADMINISTRATIVO", "papel global neutro");
      assert.equal(temAutoridadeDePlataforma({ papel: ident.papel }), false, "sem autoridade de plataforma (tabela PDF / WhatsApp)");
      assert.deepEqual(await q("SELECT empresa_id::text, status, papel FROM memberships WHERE usuario_id = $1::uuid", [ident.id]), [{ empresa_id: A, status: "ATIVA", papel: "REPRESENTANTE_AUTORIZADO" }]);
      const sessaoNova = { usuario_id: ident.id, papel: ident.papel };
      assert.equal((await tenantOk({ sessao: sessaoNova }, A)).papelAtual, "REPRESENTANTE_AUTORIZADO", "opera em A como Gestão pela membership");
      const lista = await contas.listarUsuariosAdministrativos(sessaoNova, A) as unknown as { usuarios: Array<{ email: string }> };
      assert.ok(lista.usuarios.some((u) => u.email === email), "administra A");
      await assert.rejects(() => tenantOk({ sessao: sessaoNova }, B), "nada em B");
      assert.equal((await q<{ n: number }>("SELECT count(*)::int AS n FROM usuarios_administrativos WHERE id = $1::uuid AND papel = 'REPRESENTANTE_AUTORIZADO'", [ident.id]))[0].n, 0);
    });

    await t.test("F2: identidade inativa recebe a mesma resposta; continua inativa e sem acesso; a empresa não vê a situação global", async () => {
      const email = `${cod()}@example.test`;
      const inativa = (await q<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa inativa', $2, 'ADMINISTRATIVO', false) RETURNING id", [email, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]))[0].id;
      const r = await contas.criarUsuarioAdministrativo(gestaoA.sessao, { acao: "criar", nome: "Qualquer", email, nivel: "EQUIPE", senha: "senha-longa-1", confirmacao: "senha-longa-1" }, randomUUID(), undefined, A);
      assert.deepEqual(Object.keys(r).sort(), ["associado", "email", "membershipId", "nivelSistema", "papel", "reutilizado", "statusMembership"]);
      assert.equal(r.reutilizado, false);
      assert.ok(!JSON.stringify(r).includes(inativa) && !JSON.stringify(r).includes("Pessoa inativa"));
      assert.equal((await q<{ ativo: boolean; nome: string }>("SELECT ativo, nome FROM usuarios_administrativos WHERE id = $1::uuid", [inativa]))[0].ativo, false, "identidade continua inativa");
      await assert.rejects(() => tenantOk({ sessao: { usuario_id: inativa, papel: "ADMINISTRATIVO" } }, A), "sem acesso");
      const lista = await contas.listarUsuariosAdministrativos(gestaoA.sessao, A) as unknown as { usuarios: Array<Record<string, unknown>> };
      const linha = lista.usuarios.find((u) => u.email === email)!;
      assert.equal(linha.ativo, true, "situação = a da membership desta empresa");
      assert.ok(!("identidade_ativa" in linha));
      // Nem a tela de Festa distingue: a pessoa aparece nos perfis como qualquer membro ativo desta empresa.
      const perfis = await svc.consultarPerfis(ctxDe(gestaoA, A)) as unknown as { usuarios: Array<{ id: string }> };
      assert.ok(perfis.usuarios.some((u) => u.id === inativa), "perfis de Festa não revelam a situação global");
    });

    await t.test("listagem: A vê membro A e o compartilhado (papel de A); nunca quem é só de B", async () => {
      const lista = await contas.listarUsuariosAdministrativos(gestaoA.sessao, A) as unknown as { usuarios: Array<{ id: string; email: string; papel: string }> };
      const ids = lista.usuarios.map((u) => u.id);
      assert.ok(ids.includes(membroA.id) && ids.includes(comp.id));
      assert.ok(!ids.includes(gestaoB.id), "conta só de B não aparece");
      assert.equal(lista.usuarios.find((u) => u.id === comp.id)!.papel, "ADMINISTRATIVO", "papel NESTA empresa");
      // Equipe em A não administra A, mesmo sendo Gestão em B e na identidade.
      await assert.rejects(contas.listarUsuariosAdministrativos(comp.sessao, A), (e: unknown) => status(e) === 403);
      const deB = await contas.listarUsuariosAdministrativos(comp.sessao, B) as unknown as { usuarios: Array<{ id: string }> };
      assert.ok(!deB.usuarios.some((u) => u.id === membroA.id), "B não vê membro de A");
    });

    await t.test("papel: alterar em A não muda B nem a identidade; capacidade concedida em A funciona em A e não em B", async () => {
      await contas.alterarPapelNaEmpresa(gestaoA.sessao, { acao: "papel", usuarioId: comp.id, nivel: "GESTAO" }, randomUUID(), undefined, A);
      await contas.alterarPapelNaEmpresa(gestaoA.sessao, { acao: "papel", usuarioId: comp.id, nivel: "EQUIPE" }, randomUUID(), undefined, A);
      assert.equal((await tenantOk(comp, A)).papelAtual, "ADMINISTRATIVO");
      assert.equal((await tenantOk(comp, B)).papelAtual, "REPRESENTANTE_AUTORIZADO", "B intacta");
      assert.equal((await q<{ papel: string }>("SELECT papel FROM usuarios_administrativos WHERE id = $1::uuid", [comp.id]))[0].papel, "REPRESENTANTE_AUTORIZADO", "identidade intacta");
      // Capacidade: membroA recebe FESTA_CONSULTAR em A ⇒ consulta A; o compartilhado só tem capacidade em B ⇒ não consulta A.
      await svc.administrarCapacidade({ usuarioId: membroA.id, capacidade: "FESTA_CONSULTAR", conceder: true, motivo: "Equipe de A" }, ctxDe(gestaoA));
      const lista = await svc.consultarFestas(ctxDe(membroA)) as { festas: Array<{ id: string }> };
      assert.deepEqual(lista.festas.map((x) => x.id), [fA.festa]);
      await selecionar(comp, A);
      await assert.rejects(svc.consultarFestas(ctxDe(comp, A)), (e: unknown) => status(e) === 403 && /FESTA_CONSULTAR/.test((e as Error).message), "capacidade de B não vale em A");
      await selecionar(comp, B);
      const deB = await svc.consultarFestas(ctxDe(comp, B)) as { festas: Array<{ id: string }> };
      assert.deepEqual(deB.festas.map((x) => x.id), [fB.festa], "em B vale a capacidade de B e só a Festa de B");
    });

    await t.test("Festa: A não lê, não comanda, não cancela, não atribui responsável e não administra recurso de B", async () => {
      const ctx = ctxDe(gestaoA);
      const obs = (versao: string, revisao: number, extra: Record<string, unknown> = {}) => ({ acao: "observacao", chave: randomUUID(), revisao, versaoId: versao, descricao: "Nota", ...extra });
      const eventosB = async () => (await q<{ n: number }>("SELECT count(*)::int AS n FROM festa_eventos WHERE festa_id = $1::uuid", [fB.festa]))[0].n;
      await assert.rejects(svc.consultarFestas(ctx, fB.festa), (e: unknown) => status(e) === 404);
      await assert.rejects(svc.comandarFesta(fB.festa, obs(fB.versao, 1), ctx), (e: unknown) => status(e) === 404);
      await assert.rejects(svc.comandarFesta(fB.festa, { acao: "cancelar_contratacao", chave: randomUUID(), revisao: 1, versaoId: fB.versao, motivo: "Tentativa cruzada" }, ctx), (e: unknown) => status(e) === 404);
      assert.equal(await eventosB(), 0);
      const r = await svc.comandarFesta(fA.festa, obs(fA.versao, 1), ctx);
      assert.equal(r.festaRevisao, 2);
      const tarefa = (resp: string | null, area: string | null) => ({ acao: "tarefa", chave: randomUUID(), revisao: 2, versaoId: fA.versao, titulo: "Balões", descricao: "", prioridade: "NORMAL", estado: "PENDENTE", areaId: area, responsavelId: resp, prazo: null });
      await assert.rejects(svc.comandarFesta(fA.festa, tarefa(gestaoB.id, null), ctx), /Responsável inativo ou inexistente/);
      // A barreira no banco (056) também recusa responsável/área de outra empresa, mesmo por SQL direto.
      await db.query("SAVEPOINT direto");
      await assert.rejects(db.query(`INSERT INTO festa_tarefas (festa_id, titulo, prioridade, responsavel_id, versao_contratual_id, criado_por) VALUES ($1::uuid, 'X', 'NORMAL', $2::uuid, $3::uuid, $4::uuid)`, [fA.festa, gestaoB.id, fA.versao, gestaoA.id]), /056: responsável sem vínculo ativo/);
      await db.query("ROLLBACK TO SAVEPOINT direto");
      // Capacidades/perfis: B não administra membro de A.
      await assert.rejects(svc.administrarCapacidade({ usuarioId: membroA.id, capacidade: "FESTA_OPERAR", conceder: true, motivo: "Cruzado" }, ctxDe(gestaoB)), /Usuário inativo ou inexistente/);
    });

    await t.test("áreas: área de A não é lida nem alterada por B; unidade de outra empresa recusada; banco recusa área cruzada em tarefa", async () => {
      const areaA = await svc.administrarArea({ nome: "Salão principal", ativo: true, motivo: "Área de A" }, ctxDe(gestaoA));
      const areaB = await svc.administrarArea({ nome: "Salão principal", ativo: true, motivo: "Mesmo nome em B" }, ctxDe(gestaoB));
      assert.equal(areaA.empresa_id, A);
      assert.equal(areaB.empresa_id, B, "nome igual em empresas diferentes é permitido");
      const vistaB = await svc.consultarFestas(ctxDe(gestaoB)) as { areas: Array<{ id: string }> };
      assert.ok(!vistaB.areas.some((a) => a.id === areaA.id), "B não lê a área de A");
      await assert.rejects(svc.administrarArea({ id: areaA.id, nome: "Invasão", ativo: false, motivo: "Tentativa cruzada" }, ctxDe(gestaoB)), (e: unknown) => status(e) === 404);
      assert.equal((await q<{ nome: string }>("SELECT nome FROM festa_areas WHERE id = $1::uuid", [areaA.id]))[0].nome, "Salão principal");
      const unidadeB = await id(db, `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade B', 'SUSPENSO') RETURNING id`, [B, `u-${randomBytes(3).toString("hex")}`]);
      await assert.rejects(svc.administrarArea({ nome: "Área baby", ativo: true, estabelecimentoId: unidadeB, motivo: "Unidade alheia" }, ctxDe(gestaoA)), (e: unknown) => status(e) === 404);
      const unidadeA = await id(db, `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade A', 'SUSPENSO') RETURNING id`, [A, `u-${randomBytes(3).toString("hex")}`]);
      const baby = await svc.administrarArea({ nome: "Área baby", ativo: true, estabelecimentoId: unidadeA, motivo: "Unidade de A" }, ctxDe(gestaoA));
      assert.equal(baby.estabelecimento_id, unidadeA);
      await db.query("SAVEPOINT direto");
      await assert.rejects(db.query("UPDATE festa_areas SET empresa_id = $2::uuid WHERE id = $1::uuid", [areaA.id, B]), /056: empresa e estabelecimento da área não mudam/);
      await db.query("ROLLBACK TO SAVEPOINT direto");
      await db.query("SAVEPOINT direto");
      await assert.rejects(db.query(`INSERT INTO festa_tarefas (festa_id, titulo, prioridade, area_id, versao_contratual_id, criado_por) VALUES ($1::uuid, 'X', 'NORMAL', $2::uuid, $3::uuid, $4::uuid)`, [fA.festa, areaB.id, fA.versao, gestaoA.id]), /056: área de outra empresa/);
      await db.query("ROLLBACK TO SAVEPOINT direto");
    });

    await t.test("remover o compartilhado de A: acesso a A bloqueado, B mantido, identidade ativa; tenant não desativa identidade global", async () => {
      await contas.removerDaEmpresa(gestaoA.sessao, { acao: "remover", usuarioId: comp.id, confirmar: true }, randomUUID(), undefined, A);
      await assert.rejects(tenantOk(comp, A), (e: unknown) => (e as { code?: string }).code === "TENANT_NAO_COMPROVADO");
      assert.equal((await tenantOk(comp, B)).empresaComprovada, B, "B permanece");
      assert.equal((await q<{ ativo: boolean }>("SELECT ativo FROM usuarios_administrativos WHERE id = $1::uuid", [comp.id]))[0].ativo, true);
      const sessoes = (await q<{ n: number }>("SELECT count(*)::int AS n FROM sessoes_administrativas WHERE usuario_id = $1::uuid AND revogado_em IS NULL", [comp.id]))[0].n;
      assert.equal(sessoes, 1, "sessão global preservada");
      const deB = await svc.consultarFestas(ctxDe(comp, B)) as { festas: Array<{ id: string }> };
      assert.deepEqual(deB.festas.map((x) => x.id), [fB.festa], "capacidades de B intactas");
      // A rota de tenant não expõe desativação global.
      const rota = readFileSync(resolve(root, "app/api/admin/configuracoes/usuarios/route.ts"), "utf8");
      assert.doesNotMatch(rota, /desativarUsuarioAdministrativo/);
    });
  } finally {
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    if (anterior == null) delete process.env.FESTA_ENABLED; else process.env.FESTA_ENABLED = anterior;
    await encerrarDescartavel(client);
  }
});
