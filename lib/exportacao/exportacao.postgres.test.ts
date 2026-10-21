import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";
import { exportarPacoteCompleto, type Transacao } from "./servico.ts";
import { provarTenantParaExportacao, empresasSuspensasExportaveis } from "./guarda.ts";
import { ENTIDADES, FORA_DO_ESCOPO, SEGREDO } from "./entidades.ts";
import { lerZip } from "./zip.ts";
import type { Manifesto } from "./pacote.ts";

/**
 * Exportação verificável no PostgreSQL descartável, modelo 088 (inventário inteiro até a 088). Só pelo
 * check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL; dados sintéticos de DUAS empresas, gravados de verdade (o banco
 * de trabalho é recriado do modelo antes da suíte). Prova:
 *   1. completude: toda tabela do schema está no inventário ou em FORA_DO_ESCOPO; colunas exportadas = retrato;
 *   2. pacote: ZIP legível, SHA-256 de cada arquivo = manifesto = SHA256SUMS, linhas do CSV = manifesto = contagem
 *      independente (JOINs escritos à parte), PDFs idênticos aos do banco;
 *   3. isolamento: nenhuma marca, id ou segredo da empresa B no pacote da A (e vice-versa);
 *   4. guarda: Equipe, outra empresa, desativada, vínculo suspenso e sessão em outra empresa recusados; suspensa
 *      exportável só pela Gestão; troca de vínculo ou de situação no meio = nada entregue, nada auditado;
 *   5. auditoria só com contagens e hashes; limites recusam o pacote inteiro.
 * O fixture de Festa é cópia de lib/convites/autorizacoes-088.postgres.test.ts.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const cod = () => `ex${randomBytes(3).toString("hex")}`;
const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const RETRATO = "lib/exportacao/colunas-esperadas.json";

function transacaoDo(c: Client): Transacao {
  return async (work) => {
    await c.query("BEGIN");
    try {
      const r = await work(c as unknown as DbExecutor);
      await c.query("COMMIT");
      return r;
    } catch (erro) {
      await c.query("ROLLBACK");
      throw erro;
    }
  };
}

/**
 * Transações das três fases como SAVEPOINTs dentro de uma transação externa que nunca é confirmada (mesmo recurso de
 * lib/festas/tenant-festa.postgres.test.ts): o fixture de contrato não precisa passar pelas validações adiadas do
 * COMMIT. Dentro de um SAVEPOINT o PostgreSQL não aceita SET TRANSACTION; o isolamento REPEATABLE READ READ ONLY da
 * fase de leitura é provado à parte, com transações reais, no primeiro teste.
 */
function transacaoAninhada(c: Client): Transacao {
  const tx = { query: (sql: string, v?: readonly unknown[]) => (sql.startsWith("SET TRANSACTION") ? Promise.resolve({ rows: [], rowCount: 0 }) : c.query(sql, v as unknown[])) } as unknown as DbExecutor;
  return async (work) => {
    await c.query("SAVEPOINT fase");
    try {
      const r = await work(tx);
      await c.query("RELEASE SAVEPOINT fase");
      return r;
    } catch (erro) {
      await c.query("ROLLBACK TO SAVEPOINT fase");
      throw erro;
    }
  };
}

/** CSV ; com aspas (RFC 4180) e BOM: linhas de células. */
function lerCsv(texto: string): string[][] {
  const t = texto.replace(/^﻿/, "");
  const linhas: string[][] = [];
  let linha: string[] = [], cel = "", aspas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (aspas) {
      if (ch === '"' && t[i + 1] === '"') { cel += '"'; i++; } else if (ch === '"') aspas = false; else cel += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === ";") { linha.push(cel); cel = ""; }
    else if (ch === "\r" && t[i + 1] === "\n") { linha.push(cel); linhas.push(linha); linha = []; cel = ""; i++; }
    else cel += ch;
  }
  if (cel !== "" || linha.length) { linha.push(cel); linhas.push(linha); }
  return linhas;
}

type Fixture = { empresa: string; gestao: string; equipe: string; marca: string; segredos: string[]; pdf: Buffer; documento: string };

async function montarEmpresa(db: Client, letra: string): Promise<Fixture> {
  const marca = `MARCA-${letra}-${randomBytes(4).toString("hex")}`;
  const empresa = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod(), `Buffet ${marca}`]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresa]);
  const pessoa = async (papel: string, nome: string) => {
    const u = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'ADMINISTRATIVO', true) RETURNING id`,
      [`${cod()}@example.test`, `${nome} ${marca}`, SENHA_FALSA]);
    const m = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), $3) RETURNING id`, [empresa, u, papel]);
    await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    return u;
  };
  const gestao = await pessoa("REPRESENTANTE_AUTORIZADO", "Gestão");
  const equipe = await pessoa("ADMINISTRATIVO", "Equipe");

  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, $3, 1, true, true) RETURNING id`, [empresa, cod().toUpperCase(), `Pacote ${marca}`]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela', '2026-01-01', false, $2::uuid) RETURNING id`, [cod(), empresa]);
  const preco = await id(db, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
  const agenda = await id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ($1, 'Agenda', '10:00', '18:00', 9, $2::uuid) RETURNING id`, [cod(), empresa]);
  const cliente = await id(db, `INSERT INTO clientes (nome_completo, empresa_id, observacoes) VALUES ($1, $2::uuid, '+55 observação') RETURNING id`, [`Cliente ${marca}`, empresa]);
  await db.query(`INSERT INTO clientes (nome_completo, empresa_id) VALUES ($1, $2::uuid)`, [`=HYPERLINK("x") ${marca}`, empresa]);
  await db.query(`INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, $2)`, [cliente, `Aniversariante ${marca}`]);
  await db.query(`INSERT INTO responsaveis_adicionais (cliente_id, nome) VALUES ($1::uuid, $2)`, [cliente, `Responsável; "${marca}"\nsegunda linha`]);
  const fechamento = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
    VALUES ('2026-09-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
    [agenda, empresa, pacote, tabela, preco, cliente]);
  const contrato = await id(db, `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`, [fechamento]);
  const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2026-09-01", convidados: 20, pacote: { codigo: "E1", nome: marca } }, contratacao: { buffet: {}, adicionais: [] } };
  const hash = hashSnapshotContrato(snapshot);
  const pdf = Buffer.from(`%PDF-1.4\n% contrato ${marca} ${randomUUID()}\n%%EOF\n`);
  const pdfHash = sha(pdf);
  const versao = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
     VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`, [contrato, JSON.stringify(snapshot), hash, pdfHash]);
  const documento = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
     VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_E1', 1, $3, $4, $5, $6::uuid) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf, gestao]);
  const comprovante = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf)
     VALUES ($1::uuid, 'COMPROVANTE_ASSINATURA', 1, $2, 'COMPROVANTE_E1', 1, $3, $4, $5) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf]);
  await db.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
     VALUES ($1::uuid, $2::uuid, 'INICIAL', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, contrato, gestao, documento]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, $4::uuid, 'SENHA', now(), $5::jsonb, $6, $7, 'SESSAO_REAUTENTICADA', 'INTERNAL', now(), $8::uuid, $9::uuid, $10::uuid)`,
    [versao, documento, gestao, randomUUID(), JSON.stringify({ usuarioId: gestao, papel: "REPRESENTANTE_AUTORIZADO", nome: "Gestão", cargo: null }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  const tokenProva = randomBytes(32).toString("hex");
  const validacao = await id(db, `INSERT INTO validacoes_identidade_cliente (cliente_id, canal, status, confirmado_em, token_prova_hash, prova_expira_em) VALUES ($1::uuid, 'EMAIL', 'CONFIRMADA', now(), $2, now() + interval '10 minutes') RETURNING id`, [cliente, tokenProva]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, validacao_identidade_id, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'CLIENTE', $2::uuid, $3::uuid, $4::jsonb, $5, $6, 'OTP', 'INTERNAL', now(), $7::uuid, $8::uuid, $9::uuid)`,
    [versao, documento, validacao, JSON.stringify({ schemaVersao: 1, clienteId: cliente, nome: `Cliente ${marca}` }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
  const festa = await id(db, `INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id`,
    [contrato, versao, randomUUID(), sha(marca), gestao]);
  await db.query(`INSERT INTO festa_tarefas (festa_id, titulo, prioridade, versao_contratual_id, criado_por) VALUES ($1::uuid, $2, 'NORMAL', $3::uuid, $4::uuid)`, [festa, `Tarefa ${marca}`, versao, gestao]);
  const pagamento = await id(db, `INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, 100) RETURNING id`, [versao]);
  const plano = await id(db, `INSERT INTO pagamento_planos (pagamento_id, numero_versao, meio_pagamento, modalidade, quantidade_parcelas) VALUES ($1::uuid, 1, 'PIX', 'PARCELADO', 2) RETURNING id`, [pagamento]);
  await db.query(`INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento) VALUES ($1::uuid, 1, 50, '2026-08-01'), ($1::uuid, 2, 50, '2026-08-20')`, [plano]);
  const publicoToken = randomBytes(32).toString("base64url");
  const convite = await id(db, `INSERT INTO convites (empresa_id, festa_id, cliente_id, estabelecimento_id, publico_token, rascunho, versao_contrato_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4, '{}'::jsonb, $5::uuid) RETURNING id`, [empresa, festa, cliente, publicoToken, versao]);
  const tokenFamilia = randomBytes(32).toString("hex");
  await db.query(`INSERT INTO convite_familias (id, convite_id, empresa_id, nome, adultos_previstos, criancas_previstas, token_hash) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 2, 1, $5)`,
    [randomUUID(), convite, empresa, `Família ${marca}`, tokenFamilia]);
  await db.query(`INSERT INTO convite_respostas (convite_id, chave, nome, presenca, adultos, criancas) VALUES ($1::uuid, $2::uuid, $3, true, 2, 1)`, [convite, randomUUID(), `Convidado ${marca}`]);
  const categoria = await id(db, `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', $2) RETURNING id`, [empresa, `Categoria ${marca}`]);
  await db.query(`INSERT INTO financeiro_contas_pagar (empresa_id, categoria_id, descricao, valor, vencimento) VALUES ($1::uuid, $2::uuid, $3, 123.45, '2026-11-01')`, [empresa, categoria, `Conta ${marca}`]);
  await db.query(`INSERT INTO bloqueios_agenda (data, motivo, empresa_id, dia_inteiro) VALUES ('2026-12-24', $1, $2::uuid, true)`, [`Bloqueio ${marca}`, empresa]);
  await db.query(`INSERT INTO marketing_contatos (empresa_id, canal_atendimento, nome, chave_idempotencia, vinculo_cliente, telefone) VALUES ($1::uuid, 'WHATSAPP', $2, $3, 'SEM_CLIENTE', '11999990000')`,
    [empresa, `Lead ${marca}`, randomBytes(12).toString("hex")]);
  const conversa = await id(db, `INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1::uuid, 'staging', '5511999990000') RETURNING id`, [empresa]);
  await db.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, estado, versao_conversa, externa_id, texto) VALUES ($1::uuid, $2::uuid, 'staging', 'ENTRADA', 'PROCESSADA', 1, $3, $4)`,
    [conversa, empresa, `wamid.${randomUUID()}`, `Mensagem ${marca}`]);
  return { empresa, gestao, equipe, marca, segredos: [SENHA_FALSA, publicoToken, tokenFamilia, tokenProva], pdf, documento };
}

const sessaoDe = (usuario: string, extra: Record<string, unknown> = {}) => ({ usuario_id: usuario, papel: "REPRESENTANTE_AUTORIZADO", ...extra });

function abrir(r: { zip: Buffer; manifestoSha256: string }) {
  const arquivos = lerZip(r.zip);
  const bruto = arquivos.get("MANIFESTO.json");
  assert.ok(bruto, "MANIFESTO.json presente");
  assert.equal(sha(bruto), r.manifestoSha256, "hash do MANIFESTO = o devolvido (cabeçalho e auditoria)");
  return { arquivos, manifesto: JSON.parse(bruto.toString("utf8")) as Manifesto };
}

test("exportação: completude do inventário e retrato das colunas no schema 088", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const tabelas = (await c.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
    const noInventario = new Set(ENTIDADES.map((e) => e.tabela));
    const semDecisao = tabelas.filter((t) => !noInventario.has(t) && !Object.hasOwn(FORA_DO_ESCOPO, t));
    assert.deepEqual(semDecisao, [], "tabela nova precisa entrar no inventário ou em FORA_DO_ESCOPO com motivo");
    for (const e of ENTIDADES) assert.ok(tabelas.includes(e.tabela), `${e.tabela} existe no schema 088`);

    // Pacote de uma empresa vazia: o manifesto traz as colunas efetivamente exportadas de cada tabela.
    await c.query("BEGIN");
    const vazia = await id(c, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Vazia', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
    await c.query("COMMIT");
    const { gerarPacote } = await import("./pacote.ts");
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const p = await gerarPacote(c as unknown as DbExecutor, vazia);
    await c.query("COMMIT");
    const colunas = Object.fromEntries(p.manifesto.arquivos.filter((a) => a.tipo === "csv").map((a) => [a.tabela as string, a.colunas as string[]]));
    for (const lista of Object.values(colunas)) for (const col of lista) assert.doesNotMatch(col.replace(/__(bytes|sha256|arquivo)$/, ""), SEGREDO, `coluna de segredo exportada: ${col}`);
    if (process.env.KIDMAIS_EXPORTACAO_ATUALIZAR_RETRATO === "1") writeFileSync(RETRATO, `${JSON.stringify(colunas, null, 2)}\n`);
    assert.deepEqual(colunas, JSON.parse(readFileSync(RETRATO, "utf8")), "colunas exportadas mudaram: revise segredos e atualize o retrato");
    assert.deepEqual(p.manifesto.entidadesAusentes, []);

    // Fluxo real das três fases com transações de verdade (SET TRANSACTION como primeiro comando da leitura): uma
    // empresa só com a Gestão. A fase de leitura é READ ONLY: qualquer escrita nela falharia.
    const transacao = transacaoDo(c);
    const gestao = await transacao(async () => {
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [vazia]);
      const u = await id(c, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Vazia', $2, 'ADMINISTRATIVO', true) RETURNING id`, [`${cod()}@example.test`, SENHA_FALSA]);
      const m = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [vazia, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return u;
    });
    const real = await exportarPacoteCompleto(sessaoDe(gestao), vazia, { requestId: randomUUID() }, { transacao });
    const { manifesto } = abrir(real);
    assert.equal(manifesto.empresa.id, vazia);
    assert.equal(manifesto.totais.linhas, 3, "empresa, usuário e vínculo");
    assert.equal(Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS' AND entidade_id = $1::uuid`, [vazia])).rows[0].n), 1);
    // Escrita na fase de leitura é recusada pelo próprio PostgreSQL.
    await c.query("BEGIN");
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await assert.rejects(c.query(`UPDATE empresas SET nome = nome WHERE id = $1::uuid`, [vazia]), /read-only/);
    await c.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("exportação: pacote verificável, contagens independentes, PDFs, isolamento A×B, sem segredos e auditoria", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A"), B = await montarEmpresa(c, "B");
    const auditoriasAntes = Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n);
    const rA = await exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, { requestId: randomUUID() }, { transacao });
    const rB = await exportarPacoteCompleto(sessaoDe(B.gestao), null, { requestId: randomUUID() }, { transacao });
    assert.equal(rA.suspensa, false);

    for (const [r, eu, outra] of [[rA, A, B], [rB, B, A]] as const) {
      const { arquivos, manifesto } = abrir(r);
      assert.equal(manifesto.formato, "kidmais-exportacao");
      assert.equal(manifesto.versaoFormato, 1);
      assert.equal(manifesto.empresa.id, eu.empresa);
      // Cada arquivo do manifesto: presente, mesmo tamanho, mesmo SHA-256; CSV com as linhas declaradas.
      const listados = new Set(["MANIFESTO.json", "SHA256SUMS.txt"]);
      for (const a of manifesto.arquivos) {
        const b = arquivos.get(a.caminho);
        assert.ok(b, `${a.caminho} no ZIP`);
        listados.add(a.caminho);
        assert.equal(b.length, a.bytes, a.caminho);
        assert.equal(sha(b), a.sha256, a.caminho);
        if (a.tipo === "csv") {
          const linhas = lerCsv(b.toString("utf8"));
          assert.equal(b.subarray(0, 3).toString("hex"), "efbbbf", "BOM UTF-8");
          assert.deepEqual(linhas[0], a.colunas);
          assert.equal(linhas.length - 1, a.linhas, `${a.caminho}: linhas`);
        }
      }
      assert.deepEqual([...arquivos.keys()].sort(), [...listados].sort(), "nada no ZIP fora do manifesto");
      // SHA256SUMS.txt: formato do sha256sum, cobre tudo (inclusive o MANIFESTO) e confere.
      const somas = arquivos.get("SHA256SUMS.txt")!.toString("utf8").trim().split("\n").map((l) => l.split("  "));
      assert.equal(somas.length, manifesto.arquivos.length + 1);
      for (const [h, caminho] of somas) assert.equal(sha(arquivos.get(caminho)!), h, caminho);

      // Contagens independentes (JOINs escritos à parte do inventário).
      const linhasDe = (arquivo: string) => manifesto.arquivos.find((a) => a.entidade === arquivo)?.linhas;
      const conta = async (sql: string) => Number((await c.query(sql, [eu.empresa])).rows[0].n);
      const esperadas: Record<string, string> = {
        "clientes/clientes": `SELECT count(*) AS n FROM clientes WHERE empresa_id = $1`,
        "clientes/aniversariantes": `SELECT count(*) AS n FROM aniversariantes a JOIN clientes c ON c.id = a.cliente_id WHERE c.empresa_id = $1`,
        "clientes/responsaveis_adicionais": `SELECT count(*) AS n FROM responsaveis_adicionais r JOIN clientes c ON c.id = r.cliente_id WHERE c.empresa_id = $1`,
        "contratos/contratos": `SELECT count(*) AS n FROM contratos ct JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "contratos/contrato_versoes": `SELECT count(*) AS n FROM contrato_versoes v JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "contratos/contrato_documentos": `SELECT count(*) AS n FROM contrato_documentos d JOIN contrato_versoes v ON v.id = d.contrato_versao_id JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "contratos/contrato_assinaturas": `SELECT count(*) AS n FROM contrato_assinaturas s JOIN contrato_versoes v ON v.id = s.contrato_versao_id JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "festas/festas": `SELECT count(*) AS n FROM festas fe JOIN contratos ct ON ct.id = fe.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "festas/tarefas": `SELECT count(*) AS n FROM festa_tarefas x JOIN festas fe ON fe.id = x.festa_id JOIN contratos ct ON ct.id = fe.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "financeiro/parcelas": `SELECT count(*) AS n FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id JOIN pagamentos p ON p.id = pl.pagamento_id JOIN contrato_versoes v ON v.id = p.contrato_versao_id JOIN contratos ct ON ct.id = v.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id WHERE f.empresa_id = $1`,
        "financeiro/contas_pagar": `SELECT count(*) AS n FROM financeiro_contas_pagar WHERE empresa_id = $1`,
        "agenda/bloqueios": `SELECT count(*) AS n FROM bloqueios_agenda WHERE empresa_id = $1`,
        "convites/convites": `SELECT count(*) AS n FROM convites WHERE empresa_id = $1`,
        "convites/familias": `SELECT count(*) AS n FROM convite_familias WHERE empresa_id = $1`,
        "convites/respostas": `SELECT count(*) AS n FROM convite_respostas r JOIN convites cn ON cn.id = r.convite_id WHERE cn.empresa_id = $1`,
        "marketing/contatos": `SELECT count(*) AS n FROM marketing_contatos WHERE empresa_id = $1`,
        "whatsapp/mensagens": `SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id = $1`,
        "empresa/vinculos": `SELECT count(*) AS n FROM memberships WHERE empresa_id = $1`,
        "empresa/usuarios": `SELECT count(DISTINCT usuario_id) AS n FROM memberships WHERE empresa_id = $1`,
      };
      for (const [arquivo, sql] of Object.entries(esperadas)) {
        const n = await conta(sql);
        assert.ok(n > 0, `${arquivo}: fixture com dados`);
        assert.equal(linhasDe(arquivo), n, `${arquivo}: manifesto × contagem independente`);
      }
      assert.equal(linhasDe("clientes/clientes"), 2);
      assert.equal(linhasDe("financeiro/parcelas"), 2);

      // PDF do contrato: o arquivo do pacote é byte a byte o do banco, e o CSV aponta para ele.
      const caminhoPdf = `arquivos/contratos/${eu.documento}.pdf`;
      assert.ok(arquivos.get(caminhoPdf)?.equals(eu.pdf), "PDF idêntico");
      assert.equal(manifesto.totais.pdfs, 2, "contrato e comprovante");
      const docs = lerCsv(arquivos.get("dados/contratos/contrato_documentos.csv")!.toString("utf8"));
      const linhaDoc = docs.find((l) => l[docs[0].indexOf("id")] === eu.documento)!;
      assert.equal(linhaDoc[docs[0].indexOf("conteudo_pdf__arquivo")], caminhoPdf);
      assert.equal(linhaDoc[docs[0].indexOf("conteudo_pdf__sha256")], sha(eu.pdf));
      assert.ok(!docs[0].includes("conteudo_pdf"), "bytes do PDF não vão para o CSV");

      // Isolamento e segredos: nada da outra empresa e nenhum segredo, em nenhum arquivo.
      const tudo = [...arquivos.values()].map((b) => b.toString("utf8")).join("\n");
      assert.ok(tudo.includes(eu.marca), "a própria marca está no pacote");
      assert.ok(!tudo.includes(outra.marca), "marca da outra empresa vazou");
      assert.ok(!tudo.includes(outra.empresa), "id da outra empresa vazou");
      for (const s of [...eu.segredos, ...outra.segredos]) assert.ok(!tudo.includes(s), "segredo no pacote");
      // Nomes de coluna de segredo só aparecem no MANIFESTO, na lista de colunas excluídas (com o motivo), nunca nos dados.
      const dados = [...arquivos].filter(([k]) => k.startsWith("dados/")).map(([, b]) => b.toString("utf8")).join(" ");
      for (const nome of ["senha_hash", "publico_token", "token_prova_hash", "codigo_hash", "editor_hash", "token_hash"]) assert.ok(!dados.includes(nome), nome);
      const excluidas = manifesto.arquivos.flatMap((a) => (a.colunasExcluidas ?? []).map((x) => `${a.tabela}.${x.coluna}`));
      for (const x of ["usuarios_administrativos.senha_hash", "convites.publico_token", "validacoes_identidade_cliente.token_prova_hash", "convite_familias.token_hash"]) assert.ok(excluidas.includes(x), x);
      // Fórmula neutralizada no texto; número negativo/valor preservado; quebra de linha e ; entre aspas.
      const clientes = arquivos.get("dados/clientes/clientes.csv")!.toString("utf8");
      assert.ok(clientes.includes(`"'=HYPERLINK(""x"") ${eu.marca}"`), "fórmula neutralizada");
      assert.ok(clientes.includes("'+55 observação"), "texto iniciado por + neutralizado");
      const contas = lerCsv(arquivos.get("dados/financeiro/contas_pagar.csv")!.toString("utf8"));
      assert.equal(contas[1][contas[0].indexOf("valor")], "123.45");
    }
    // Ids disjuntos entre os pacotes (todas as colunas id).
    const ids = (r: typeof rA) => {
      const s = new Set<string>();
      for (const [caminho, b] of lerZip(r.zip)) {
        if (!caminho.endsWith(".csv")) continue;
        const l = lerCsv(b.toString("utf8"));
        const i = l[0].indexOf("id");
        if (i >= 0) for (const linha of l.slice(1)) s.add(`${caminho}:${linha[i]}`);
      }
      return s;
    };
    const idsA = ids(rA), idsB = ids(rB);
    assert.ok(idsA.size > 10);
    for (const x of idsA) assert.ok(!idsB.has(x), `id repetido entre empresas: ${x}`);

    // Auditoria: uma por exportação, só contagens e hashes.
    const aud = (await c.query<{ usuario_id: string; entidade_id: string; dados_depois: Record<string, unknown>; ip: string | null; user_agent: string | null }>(
      `SELECT usuario_id::text, entidade_id::text, dados_depois, ip::text, user_agent FROM auditoria WHERE acao = 'EXPORTACAO_DADOS' ORDER BY criado_em, id`)).rows;
    assert.equal(aud.length, auditoriasAntes + 2);
    const ultimaA = aud.find((a) => a.entidade_id === A.empresa)!;
    assert.equal(ultimaA.usuario_id, A.gestao);
    assert.equal(ultimaA.ip, null); assert.equal(ultimaA.user_agent, null);
    assert.equal(ultimaA.dados_depois.manifestoSha256, rA.manifestoSha256);
    assert.equal(ultimaA.dados_depois.zipSha256, rA.zipSha256);
    assert.deepEqual(Object.keys(ultimaA.dados_depois).sort(), ["arquivos", "bytes", "empresaId", "empresaSuspensa", "entidadesAusentes", "formato", "geradoEm", "linhas", "manifestoSha256", "pdfs", "resultado", "tipo", "versaoFormato", "zipSha256"]);
    assert.ok(!JSON.stringify(aud).includes(A.marca), "auditoria sem conteúdo");

    // Limites: o pacote inteiro é recusado (nada parcial, nada auditado).
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, limites: { linhasPorArquivo: 1, bytesTotal: 1e9, tempoMs: 60_000 } }), /EXPORTACAO_GRANDE_DEMAIS|limite/);
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, limites: { linhasPorArquivo: 1000, bytesTotal: 2000, tempoMs: 60_000 } }), /limite/);
    let tique = 0;
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao, relogio: () => (tique += 200_000) }), /tempo limite/);
    assert.equal(Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n), auditoriasAntes + 2);
  } finally {
    await encerrarDescartavel(c);
  }
});

test("exportação: guarda — Gestão, Equipe, outra empresa, suspensa, desativada, sessão e mudanças no meio", { timeout: 300_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const transacao = transacaoAninhada(c);
  const prova = (sessao: Parameters<typeof provarTenantParaExportacao>[1], empresa: string | null) => transacao((tx) => provarTenantParaExportacao(tx, sessao, empresa));
  const auditorias = async () => Number((await c.query(`SELECT count(*) AS n FROM auditoria WHERE acao = 'EXPORTACAO_DADOS'`)).rows[0].n);
  try {
    await c.query("BEGIN");
    const A = await montarEmpresa(c, "A"), B = await montarEmpresa(c, "B");
    // Ativa: Gestão sim; Equipe não; Gestão de B não leva A.
    assert.equal((await prova(sessaoDe(A.gestao), A.empresa)).suspensa, false);
    await assert.rejects(prova(sessaoDe(A.equipe), A.empresa), /PAPEL_NAO_AUTORIZADO|Gestão/);
    await assert.rejects(prova(sessaoDe(B.gestao), A.empresa), /não comprova/);
    await assert.rejects(prova(sessaoDe(A.gestao), "nao-e-uuid"), /não comprova/);
    // Sessão real selecionada em A: B pedida por parâmetro é recusada.
    const sessaoA = await transacao(async () => id(c, `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, now(), now(), now() + interval '8 hours', $4::uuid) RETURNING id`, [A.gestao, sha(randomUUID()), sha(randomUUID()), A.empresa]));
    const comSessao = sessaoDe(A.gestao, { id: sessaoA, empresa_ativa_id: A.empresa });
    assert.equal((await prova(comSessao, null)).empresaComprovada, A.empresa);

    // Mudança no meio (entre a leitura e a auditoria): vínculo suspenso → nada entregue, nada auditado.
    const antes = await auditorias();
    const comMudanca = (sql: string, params: unknown[]): Transacao => { let n = 0; return async (work) => { if (++n === 3) await c.query(sql, params); return transacao(work); }; };
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao: comMudanca(`UPDATE memberships SET status = 'SUSPENSA' WHERE usuario_id = $1::uuid`, [A.gestao]) }), /não comprova/);
    assert.equal(await auditorias(), antes);
    await transacao(async () => c.query(`UPDATE memberships SET status = 'ATIVA' WHERE usuario_id = $1::uuid`, [A.gestao]));

    // Empresa ativa que é suspensa no meio: a prova final muda de natureza → recusada.
    await assert.rejects(exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao: comMudanca(`UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1::uuid`, [A.empresa]) }), /não comprova/);
    assert.equal(await auditorias(), antes);
    // A suspensão revogou a sessão selecionada em A (063): ela não serve mais para nada.
    await assert.rejects(prova(comSessao, A.empresa), /não comprova/);
    await assert.rejects(prova(sessaoDe(A.gestao, { id: sessaoA, empresa_ativa_id: B.empresa }), A.empresa), /não comprova/);

    // Suspensa: só com a empresa pedida explicitamente, só Gestão com vínculo ativo; o resto do sistema continua fechado.
    await assert.rejects(prova(sessaoDe(A.gestao), null), /não comprova/);
    const suspensa = await prova(sessaoDe(A.gestao), A.empresa);
    assert.equal(suspensa.suspensa, true);
    assert.equal(suspensa.empresaComprovada, A.empresa);
    await assert.rejects(prova(sessaoDe(A.equipe), A.empresa), /PAPEL_NAO_AUTORIZADO|Gestão/);
    await assert.rejects(prova(sessaoDe(B.gestao), A.empresa), /não comprova/);
    const { provarTenant } = await import("../saas/provar-tenant.ts");
    await assert.rejects(transacao((tx) => provarTenant(tx, sessaoDe(A.gestao), A.empresa)), /não comprova/, "provarTenant continua recusando a suspensa");
    assert.deepEqual(await empresasSuspensasExportaveis(c as unknown as DbExecutor, A.gestao), [{ id: A.empresa, nome: `Buffet ${A.marca}` }]);
    assert.deepEqual(await empresasSuspensasExportaveis(c as unknown as DbExecutor, A.equipe), []);
    const r = await exportarPacoteCompleto(sessaoDe(A.gestao), A.empresa, {}, { transacao });
    assert.equal(r.suspensa, true);
    const { manifesto } = abrir(r);
    assert.equal(manifesto.empresa.situacao, "SUSPENSA");
    assert.equal((await c.query(`SELECT dados_depois->>'empresaSuspensa' AS s FROM auditoria WHERE acao = 'EXPORTACAO_DADOS' ORDER BY criado_em DESC, id DESC LIMIT 1`)).rows[0].s, "true");
    // Vínculo da Gestão suspenso: recusa.
    await transacao(async () => c.query(`UPDATE memberships SET status = 'SUSPENSA' WHERE usuario_id = $1::uuid`, [A.gestao]));
    await assert.rejects(prova(sessaoDe(A.gestao), A.empresa), /não comprova/);
    await transacao(async () => c.query(`UPDATE memberships SET status = 'ATIVA' WHERE usuario_id = $1::uuid`, [A.gestao]));
    // Desativada: fim da exceção.
    await transacao(async () => c.query(`UPDATE empresas SET status = 'DESATIVADA' WHERE id = $1::uuid`, [A.empresa]));
    await assert.rejects(prova(sessaoDe(A.gestao), A.empresa), /não comprova/);
    assert.deepEqual(await empresasSuspensasExportaveis(c as unknown as DbExecutor, A.gestao), []);
    // B segue intacta e exportável.
    assert.equal((await exportarPacoteCompleto(sessaoDe(B.gestao), B.empresa, {}, { transacao })).suspensa, false);
  } finally {
    await encerrarDescartavel(c);
  }
});
