import { createHash } from "node:crypto";
import type { DbExecutor } from "../../db/contracts.ts";
import type { ArquivoValidado } from "../../importacao-contrato/arquivo.ts";
import { PacoteAdminError } from "../../comercial/pacotes-admin.ts";
import { gerarPdfContratoOficial } from "../documento/oficial/pdf.ts";
import { conteudoModeloSchema, problemasDoConteudo, type ConteudoModelo } from "./conteudo.ts";
import { SNAPSHOT_EXEMPLO } from "./exemplo.ts";
import type { LeituraContrato } from "./leitura.ts";
import { renderizarModeloEmpresa } from "./renderizar.ts";

/**
 * Modelo de contrato da empresa (072), a partir do contrato em PDF da loja (importação 071, tipo MODELO_CONTRATO).
 * Rascunho → revisão humana (texto e campos) → prévia em PDF com dados fictícios → publicação com aprovação
 * registrada. Publicar cria uma versão nova ATIVA e marca a anterior SUBSTITUIDA; contratos já gerados não mudam
 * (o PDF de cada versão contratual fica guardado). Tudo no Tenant Context do chamador.
 */
type Contexto = { empresaId: string; usuarioId: string; requestId: string };

export class ModeloContratoError extends PacoteAdminError {}

function recusar(codigo: string, mensagem: string, status: number): never {
  throw new ModeloContratoError(codigo, mensagem, status);
}

export type ResultadoLeituraContrato = { ok: true; leitura: LeituraContrato; modelo: string; provedor: string } | { ok: false; aviso: string };
export type RevisaoModelo = { conteudo: ConteudoModelo; avisos: string[] };

export async function migration072Aplicada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.modelos_contrato_empresa') IS NOT NULL AS ok`);
  return Boolean(r.rows[0]?.ok);
}

async function exigir072(tx: DbExecutor) {
  if (!(await migration072Aplicada(tx))) recusar("MIGRACAO_PENDENTE", "A atualização do banco para modelos de contrato (071 e 072) ainda não foi aplicada.", 503);
}

export type ModeloAtivo = { id: string; versao: number; conteudo: ConteudoModelo; aprovadoEm: string };

/** Modelo ATIVO da empresa, ou null (sem 072 também é null: a empresa segue como antes). */
export async function modeloContratoAtivo(tx: DbExecutor, empresaId: string): Promise<ModeloAtivo | null> {
  if (!(await migration072Aplicada(tx))) return null;
  const r = await tx.query<{ id: string; versao: number; conteudo: ConteudoModelo; aprovado_em: Date }>(
    `SELECT id::text AS id, versao, conteudo, aprovado_em FROM modelos_contrato_empresa WHERE empresa_id = $1::uuid AND situacao = 'ATIVO'`,
    [empresaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  const conteudo = conteudoModeloSchema.parse(l.conteudo);
  return { id: l.id, versao: Number(l.versao), conteudo, aprovadoEm: new Date(l.aprovado_em).toISOString() };
}

type LinhaImp = { id: string; situacao: string; arquivo_nome: string; versao: number; modelo: string | null; avisos: string[]; revisao: RevisaoModelo | null; criado_em: Date; publicado_em: Date | null; resultado: Record<string, unknown> | null };
const COLUNAS = `id::text AS id, situacao, arquivo_nome, versao, modelo, avisos, revisao, criado_em, publicado_em, resultado`;

function resumo(l: LinhaImp) {
  return {
    id: l.id, situacao: l.situacao, arquivoNome: l.arquivo_nome, versao: Number(l.versao), modelo: l.modelo, avisos: l.avisos ?? [],
    revisao: l.revisao, resultado: l.resultado, criadoEm: new Date(l.criado_em).toISOString(), publicadoEm: l.publicado_em ? new Date(l.publicado_em).toISOString() : null,
  };
}

export async function registrarImportacaoContrato(tx: DbExecutor, ctx: Contexto, arquivo: ArquivoValidado) {
  await exigir072(tx);
  if (arquivo.contentType !== "application/pdf") recusar("ARQUIVO_INVALIDO", "Envie o contrato em PDF.", 415);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO importacoes_comerciais (empresa_id, tipo, arquivo_nome, arquivo_sha256, arquivo_bytes, criado_por)
     VALUES ($1::uuid, 'MODELO_CONTRATO', $2, $3, $4, $5::uuid) RETURNING id::text AS id`,
    [ctx.empresaId, arquivo.nomeSeguro.slice(0, 200), arquivo.sha256, Buffer.from(arquivo.bytes), ctx.usuarioId],
  );
  return r.rows[0].id;
}

export async function arquivoDaImportacaoContrato(tx: DbExecutor, empresaId: string, id: string): Promise<ArquivoValidado> {
  const r = await tx.query<{ arquivo_nome: string; arquivo_bytes: Buffer; arquivo_sha256: string; situacao: string }>(
    `SELECT arquivo_nome, arquivo_bytes, arquivo_sha256, situacao FROM importacoes_comerciais
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = 'MODELO_CONTRATO'`,
    [id, empresaId],
  );
  const l = r.rows[0] ?? recusar("NAO_ENCONTRADO", "Importação não encontrada nesta empresa.", 404);
  if (l.situacao !== "RASCUNHO") recusar("IMPORTACAO_ENCERRADA", "Esta importação já foi publicada ou descartada.", 409);
  const bytes = new Uint8Array(l.arquivo_bytes);
  return { contentType: "application/pdf", nomeSeguro: l.arquivo_nome, tamanhoBytes: bytes.length, sha256: l.arquivo_sha256, bytes };
}

export async function gravarLeituraContrato(tx: DbExecutor, ctx: Contexto, id: string, resultado: ResultadoLeituraContrato) {
  const revisao: RevisaoModelo | null = resultado.ok ? { conteudo: resultado.leitura.conteudo, avisos: resultado.leitura.avisos } : null;
  const r = await tx.query<LinhaImp>(
    `UPDATE importacoes_comerciais
        SET leitura = $3::jsonb, revisao = $4::jsonb, metodo = $5, provedor = $6, modelo = $7, avisos = $8::jsonb, versao = versao + 1
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = 'MODELO_CONTRATO' AND situacao = 'RASCUNHO'
      RETURNING ${COLUNAS}`,
    [id, ctx.empresaId, resultado.ok ? JSON.stringify(resultado.leitura) : null, revisao ? JSON.stringify(revisao) : null,
      resultado.ok ? "VISAO" : null, resultado.ok ? resultado.provedor : null, resultado.ok ? resultado.modelo : null,
      JSON.stringify(resultado.ok ? [] : [resultado.aviso])],
  );
  return resumo(r.rows[0] ?? recusar("NAO_ENCONTRADO", "Importação não encontrada nesta empresa.", 404));
}

export async function lerImportacaoContrato(tx: DbExecutor, empresaId: string, id: string) {
  await exigir072(tx);
  const r = await tx.query<LinhaImp>(`SELECT ${COLUNAS} FROM importacoes_comerciais WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = 'MODELO_CONTRATO'`, [id, empresaId]);
  return resumo(r.rows[0] ?? recusar("NAO_ENCONTRADO", "Importação não encontrada nesta empresa.", 404));
}

/** Painel: modelo ativo, versões anteriores e rascunhos em revisão. */
export async function painelModeloContrato(tx: DbExecutor, empresaId: string) {
  if (!(await migration072Aplicada(tx))) return { migracaoPendente: true, ativo: null, versoes: [], rascunhos: [] };
  const ativo = await modeloContratoAtivo(tx, empresaId);
  const versoes = await tx.query<{ versao: number; situacao: string; aprovado_em: Date }>(
    `SELECT versao, situacao, aprovado_em FROM modelos_contrato_empresa WHERE empresa_id = $1::uuid ORDER BY versao DESC LIMIT 20`, [empresaId]);
  const rascunhos = await tx.query<LinhaImp>(
    `SELECT ${COLUNAS} FROM importacoes_comerciais WHERE empresa_id = $1::uuid AND tipo = 'MODELO_CONTRATO' AND situacao = 'RASCUNHO' ORDER BY criado_em DESC LIMIT 10`,
    [empresaId]);
  return {
    migracaoPendente: false,
    ativo,
    versoes: versoes.rows.map((v) => ({ versao: Number(v.versao), situacao: v.situacao, aprovadoEm: new Date(v.aprovado_em).toISOString() })),
    rascunhos: rascunhos.rows.map((l) => ({ ...resumo(l), revisao: null })),
  };
}

export async function salvarRevisaoContrato(tx: DbExecutor, ctx: Contexto, id: string, versao: number, revisao: RevisaoModelo) {
  await exigir072(tx);
  const conteudo = conteudoModeloSchema.parse(revisao.conteudo);
  const r = await tx.query<LinhaImp>(
    `UPDATE importacoes_comerciais SET revisao = $4::jsonb, versao = versao + 1
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = 'MODELO_CONTRATO' AND versao = $3 AND situacao = 'RASCUNHO'
      RETURNING ${COLUNAS}`,
    [id, ctx.empresaId, versao, JSON.stringify({ conteudo, avisos: revisao.avisos })],
  );
  if (!r.rows[0]) {
    await lerImportacaoContrato(tx, ctx.empresaId, id);
    recusar("VERSAO_DESATUALIZADA", "Este rascunho foi alterado em outra tela. Recarregue antes de salvar.", 409);
  }
  return resumo(r.rows[0]);
}

/** PDF de prévia com dados fictícios, no mesmo gerador do contrato real. Não grava nada. */
export function previaModeloContrato(conteudo: ConteudoModelo) {
  const valido = conteudoModeloSchema.parse(conteudo);
  const problemas = problemasDoConteudo(valido);
  if (problemas.some((p) => p.includes("não existe"))) recusar("CAMPO_DESCONHECIDO", problemas.join(" "), 409);
  const documento = renderizarModeloEmpresa(
    { id: "00000000-0000-4000-8000-000000000000", versao: 1, conteudo: valido },
    { snapshot: SNAPSHOT_EXEMPLO, numeroVersao: 1, snapshotHash: "0".repeat(64), geradoEm: new Date().toISOString() },
  );
  documento.avisoHomologacao = "PRÉVIA COM DADOS FICTÍCIOS — sem valor contratual.";
  return gerarPdfContratoOficial(documento, { logo: false });
}

export async function descartarImportacaoContrato(tx: DbExecutor, ctx: Contexto, id: string) {
  await exigir072(tx);
  const r = await tx.query(
    `UPDATE importacoes_comerciais SET situacao = 'DESCARTADA', descartado_em = clock_timestamp()
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = 'MODELO_CONTRATO' AND situacao = 'RASCUNHO' RETURNING id`,
    [id, ctx.empresaId],
  );
  if (!r.rowCount) recusar("IMPORTACAO_ENCERRADA", "Esta importação já foi publicada ou descartada.", 409);
}

/**
 * Publica o rascunho como nova versão ATIVA. Exige: versão da revisão atual, nenhum problema no conteúdo e a
 * confirmação explícita de quem gere a empresa ("revisei o texto jurídico"). Tudo numa transação.
 */
export async function publicarModeloContrato(tx: DbExecutor, ctx: Contexto, id: string, versao: number, aprovacao: { revisadoPorPessoa: true }) {
  await exigir072(tx);
  if (aprovacao.revisadoPorPessoa !== true) recusar("APROVACAO_OBRIGATORIA", "Confirme que revisou o texto do contrato antes de publicar.", 409);
  const imp = await tx.query<{ revisao: RevisaoModelo | null; versao: number; situacao: string }>(
    `SELECT revisao, versao, situacao FROM importacoes_comerciais WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = 'MODELO_CONTRATO' FOR UPDATE`,
    [id, ctx.empresaId],
  );
  const l = imp.rows[0] ?? recusar("NAO_ENCONTRADO", "Importação não encontrada nesta empresa.", 404);
  if (l.situacao !== "RASCUNHO") recusar("IMPORTACAO_ENCERRADA", "Esta importação já foi publicada ou descartada.", 409);
  if (Number(l.versao) !== versao) recusar("VERSAO_DESATUALIZADA", "O rascunho mudou desde que você abriu. Recarregue antes de publicar.", 409);
  if (!l.revisao) recusar("SEM_LEITURA", "Este rascunho ainda não tem texto lido do PDF.", 409);
  const conteudo = conteudoModeloSchema.parse(l.revisao.conteudo);
  const problemas = problemasDoConteudo(conteudo);
  if (problemas.length) recusar("MODELO_INCOMPLETO", problemas.slice(0, 4).join(" "), 409);
  // Prova que o modelo renderiza com um snapshot completo antes de publicar.
  previaModeloContrato(conteudo);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('kidmais-072-modelo-contrato'), hashtext($1))`, [ctx.empresaId]);
  const anterior = await tx.query<{ id: string; versao: number }>(
    `SELECT id::text AS id, versao FROM modelos_contrato_empresa WHERE empresa_id = $1::uuid ORDER BY versao DESC LIMIT 1`, [ctx.empresaId]);
  const proxima = Number(anterior.rows[0]?.versao ?? 0) + 1;
  await tx.query(`UPDATE modelos_contrato_empresa SET situacao = 'SUBSTITUIDO', substituido_em = clock_timestamp() WHERE empresa_id = $1::uuid AND situacao = 'ATIVO'`, [ctx.empresaId]);
  const json = JSON.stringify(conteudo);
  const novo = await tx.query<{ id: string }>(
    `INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, importacao_id, aprovado_por)
     VALUES ($1::uuid, $2, $3::jsonb, $4, $5::uuid, $6::uuid) RETURNING id::text AS id`,
    [ctx.empresaId, proxima, json, createHash("sha256").update(json).digest("hex"), id, ctx.usuarioId],
  );
  await tx.query(
    `UPDATE importacoes_comerciais SET situacao = 'PUBLICADA', publicado_em = clock_timestamp(), publicado_por = $3::uuid, resultado = $4::jsonb
      WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, ctx.empresaId, ctx.usuarioId, JSON.stringify({ modeloId: novo.rows[0].id, versao: proxima })],
  );
  await tx.query(
    `INSERT INTO auditoria (ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_antes, dados_depois, justificativa, origem, request_id)
     VALUES ('USUARIO', $1::uuid, 'MODELO_CONTRATO_PUBLICADO', 'MODELO_CONTRATO', $2::uuid, $3::jsonb, $4::jsonb, 'Modelo de contrato da empresa revisado e aprovado', 'COMERCIAL', $5::uuid)`,
    [ctx.usuarioId, novo.rows[0].id, JSON.stringify({ empresaId: ctx.empresaId, versaoAnterior: anterior.rows[0]?.versao ?? null }),
      JSON.stringify({ empresaId: ctx.empresaId, versao: proxima, importacaoId: id }), ctx.requestId],
  );
  return { modeloId: novo.rows[0].id, versao: proxima };
}
