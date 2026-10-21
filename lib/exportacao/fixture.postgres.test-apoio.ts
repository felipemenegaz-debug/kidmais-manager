import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";
import type { Transacao } from "./servico.ts";
import { lerZip } from "./zip.ts";
import type { Manifesto } from "./pacote.ts";

/**
 * Apoio das suítes PostgreSQL da exportação (exportacao.postgres.test.ts e exportacao-adversarial.postgres.test.ts):
 * fixture sintético por empresa, transações das fases e leitura do pacote. Não é suíte (não termina em .test.ts).
 * O fixture de Festa é cópia de lib/convites/autorizacoes-088.postgres.test.ts, com Marketing (tarefa) e convite de
 * acesso acrescentados para que as mutações de filtro do revisor nessas tabelas morram.
 */
export const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
export const cod = () => `ex${randomBytes(3).toString("hex")}`;
export const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
export const RETRATO = "lib/exportacao/colunas-esperadas.json";

export function transacaoDo(c: Client): Transacao {
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
export function transacaoAninhada(c: Client): Transacao {
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
export function lerCsv(texto: string): string[][] {
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

export type Fixture = { empresa: string; gestao: string; equipe: string; marca: string; segredos: string[]; pdf: Buffer; documento: string };

export async function montarEmpresa(db: Client, letra: string): Promise<Fixture> {
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
  // Marketing: regra → execução → tarefa (a tabela de tarefas só tem dono pela empresa).
  const regra = await id(db, `INSERT INTO marketing_automacao_regras (empresa_id, tipo, acao, espera_dias, criado_por, atualizado_por) VALUES ($1::uuid, 'POS_FESTA', 'TAREFA_INTERNA', 1, $2::uuid, $2::uuid) RETURNING id`, [empresa, gestao]);
  const execucao = await id(db, `INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, chave_idempotencia, agendada_para, max_tentativas)
    VALUES ($1::uuid, $2::uuid, 1, 'TAREFA_INTERNA', 'CLIENTE', $3::uuid, $3::uuid, $4, now(), 3) RETURNING id`, [empresa, regra, cliente, `exec-${randomBytes(6).toString("hex")}`]);
  await db.query(`INSERT INTO marketing_tarefas (empresa_id, execucao_id, cliente_id, titulo, vencimento) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2026-11-10')`, [empresa, execucao, cliente, `Tarefa ${marca}`]);
  // Convite de acesso (token só em hash, que não sai no pacote).
  const tokenAcesso = randomBytes(32).toString("hex");
  await db.query(`INSERT INTO convites_acesso (empresa_id, email, nome_sugerido, papel, token_hash, expira_em, criado_por) VALUES ($1::uuid, $2, $3, 'ADMINISTRATIVO', $4, now() + interval '1 day', $5::uuid)`,
    [empresa, `convite-${cod()}@example.test`, `Convidado ${marca}`, tokenAcesso, gestao]);
  return { empresa, gestao, equipe, marca, segredos: [SENHA_FALSA, publicoToken, tokenFamilia, tokenProva, tokenAcesso], pdf, documento };
}

export const sessaoDe = (usuario: string, extra: Record<string, unknown> = {}) => ({ usuario_id: usuario, papel: "REPRESENTANTE_AUTORIZADO", ...extra });

/**
 * Consome um pacote como a rota faz: lê o ZIP do arquivo temporário, confere o hash auditado, chama limpar() e confere
 * que a pasta temporária sumiu (e que a vaga de exportação foi liberada). Devolve o resultado com os bytes do ZIP.
 */
export async function lido<T extends { zipCaminho: string; zipSha256: string; dir: string; limpar: () => Promise<void> }>(p: Promise<T>): Promise<T & { zip: Buffer }> {
  const r = await p;
  const zip = readFileSync(r.zipCaminho);
  assert.equal(sha(zip), r.zipSha256, "hash do ZIP = o auditado");
  await r.limpar();
  assert.equal(existsSync(r.dir), false, "pasta temporária apagada");
  return { ...r, zip };
}

export function abrir(r: { zip: Buffer; manifestoSha256: string }) {
  const arquivos = lerZip(r.zip);
  const bruto = arquivos.get("MANIFESTO.json");
  assert.ok(bruto, "MANIFESTO.json presente");
  assert.equal(sha(bruto), r.manifestoSha256, "hash do MANIFESTO = o devolvido (cabeçalho e auditoria)");
  return { arquivos, manifesto: JSON.parse(bruto.toString("utf8")) as Manifesto };
}
