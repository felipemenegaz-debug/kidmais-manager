import type { DbExecutor } from "../db/contracts.ts";
import { isUniqueViolation } from "../db/errors.ts";
import { mascararTelefoneIdentidade } from "../identidade/services/identity.service.ts";
import { SQL_FECHAMENTO_AREA } from "./acesso.ts";
import { acoesInstaladas, textoLivre } from "./acoes.ts";
import { caminhoArea, gerarTokenArea, hashDocumentoPessoa, hashTokenArea } from "./tokens.ts";

/**
 * Painel do buffet para a área "Minha festa" (123). Toda função recebe a transação do tenant comprovado
 * (withTenantTransaction) e confere que a festa é da empresa pelo mesmo caminho do banco (kidmais_123_empresa_da_festa).
 * Festa de outra empresa ou inexistente: 404 igual. O link só aparece uma vez (o banco guarda o SHA-256).
 */
export class AreaFamiliaError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number) {
    super(message);
    this.name = "AreaFamiliaError";
  }
}

const NAO_ENCONTRADA = () => new AreaFamiliaError("FESTA_NAO_ENCONTRADA", "Festa não encontrada.", 404);
const FECHADA = () => new AreaFamiliaError("AREA_INDISPONIVEL", "A área desta festa não está disponível (contrato cancelado, festa invalidada ou mais de 30 dias depois da festa).", 409);

type Ctx = { empresaId: string; usuarioId: string };

type FestaArea = { festaId: string; empresaId: string; clienteId: string; codigoEmpresa: string; aberta: boolean; fechaEm: string };

async function festaDaEmpresa(tx: DbExecutor, ctx: Ctx, festaId: string, travar = false): Promise<FestaArea> {
  if (!/^[0-9a-f-]{36}$/i.test(festaId)) throw NAO_ENCONTRADA();
  const { rows } = await tx.query<{ festa_id: string; cliente_id: string; codigo: string | null; aberta: boolean; fecha_em: Date }>(
    `SELECT f.id::text AS festa_id, fe.cliente_id::text AS cliente_id, e.codigo,
            (f.invalidada_em IS NULL AND c.status <> 'CANCELADO' AND clock_timestamp() < ${SQL_FECHAMENTO_AREA}) AS aberta,
            ${SQL_FECHAMENTO_AREA} AS fecha_em
       FROM festas f
       JOIN contratos c ON c.id = f.contrato_id
       JOIN fechamentos fe ON fe.id = c.fechamento_id
       JOIN empresas e ON e.id = $2::uuid
      WHERE f.id = $1::uuid AND kidmais_123_empresa_da_festa(f.id) = $2::uuid
      ${travar ? "FOR UPDATE OF f" : ""}`,
    [festaId, ctx.empresaId],
  );
  const r = rows[0];
  if (!r) throw NAO_ENCONTRADA();
  if (!r.codigo) throw new AreaFamiliaError("EMPRESA_SEM_ENDERECO", "Defina o endereço público do buffet antes de enviar o link.", 409);
  return { festaId: r.festa_id, empresaId: ctx.empresaId, clienteId: r.cliente_id, codigoEmpresa: r.codigo, aberta: r.aberta, fechaEm: new Date(r.fecha_em).toISOString() };
}

async function evento(tx: DbExecutor, f: FestaArea, ctx: Ctx, tipo: string, pessoaId: string | null, motivo: string | null = null) {
  await tx.query(
    `INSERT INTO area_familia_eventos (festa_id, empresa_id, pessoa_id, autor_usuario_id, tipo, motivo) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
    [f.festaId, f.empresaId, pessoaId, ctx.usuarioId, tipo, motivo],
  );
}

async function contratante(tx: DbExecutor, f: FestaArea, ctx: Ctx): Promise<string> {
  const atual = await tx.query<{ id: string }>(
    "SELECT id::text AS id FROM festa_pessoas WHERE festa_id = $1::uuid AND papel = 'CONTRATANTE' AND removido_em IS NULL",
    [f.festaId],
  );
  if (atual.rows[0]) return atual.rows[0].id;
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO festa_pessoas (festa_id, empresa_id, papel, cliente_id, criado_por_usuario_id)
     VALUES ($1::uuid, $2::uuid, 'CONTRATANTE', $3::uuid, $4::uuid) RETURNING id::text AS id`,
    [f.festaId, f.empresaId, f.clienteId, ctx.usuarioId],
  );
  return criada.rows[0].id;
}

async function segundo(tx: DbExecutor, festaId: string): Promise<{ id: string; whatsapp: string } | null> {
  const r = await tx.query<{ id: string; whatsapp: string }>(
    "SELECT id::text AS id, whatsapp FROM festa_pessoas WHERE festa_id = $1::uuid AND papel = 'SEGUNDO_RESPONSAVEL' AND removido_em IS NULL",
    [festaId],
  );
  return r.rows[0] ?? null;
}

export type PapelArea = "CONTRATANTE" | "SEGUNDO_RESPONSAVEL";

export type ResumoAreaFamilia = {
  aberta: boolean;
  fechaEm: string;
  pessoas: Array<{ id: string; papel: PapelArea; nome: string; whatsappMascarado: string | null; linkAtivoAte: string | null }>;
  aparelhos: Array<{ id: string; papel: PapelArea; aparelho: string | null; entrouEm: string; ultimoUsoEm: string; lembrar: boolean }>;
  /** F3 (125). Sem a 125: { disponivel: false } e listas vazias. */
  acoes: ResumoAcoesPainel;
};

export type ResumoAcoesPainel = {
  disponivel: boolean;
  avisoFixo: string | null;
  /** Segundo responsável convidado pela família (e não pelo buffet). */
  segundoPelaFamilia: boolean;
  avisos: Array<{ id: string; parcela: number; saldoCentavos: number; observacao: string | null; criadoEm: string; papel: PapelArea }>;
  pendencias: Array<{
    id: string; descricao: string; estado: string; prazo: string | null;
    familia: { visivel: boolean; texto: string; feitaEm: string | null; feitaPor: PapelArea | null; devolvidaEm: string | null } | null;
  }>;
};

const ACOES_INDISPONIVEIS = () => new AreaFamiliaError("ACOES_INDISPONIVEIS", "As ações da área ainda não estão instaladas (migration 125).", 503);

async function resumoAcoes(tx: DbExecutor, f: FestaArea): Promise<ResumoAcoesPainel> {
  if (!(await acoesInstaladas(tx))) return { disponivel: false, avisoFixo: null, segundoPelaFamilia: false, avisos: [], pendencias: [] };
  const avisoFixo = (await tx.query<{ texto: string | null }>(
    "SELECT texto FROM area_familia_aviso_empresa WHERE empresa_id = $1::uuid", [f.empresaId])).rows[0]?.texto ?? null;
  const segundoPelaFamilia = (await tx.query(
    `SELECT 1 FROM festa_pessoas WHERE festa_id = $1::uuid AND papel = 'SEGUNDO_RESPONSAVEL' AND removido_em IS NULL
        AND criado_por_pessoa_id IS NOT NULL`, [f.festaId])).rowCount === 1;
  const avisos = (await tx.query<{ id: string; parcela: number; saldo: string; observacao: string | null; criado_em: Date; papel: PapelArea }>(
    `SELECT a.id::text AS id, a.parcela_numero AS parcela, a.saldo_centavos::text AS saldo, a.observacao, a.criado_em, p.papel
       FROM area_familia_avisos_pagamento a JOIN festa_pessoas p ON p.id = a.pessoa_id
      WHERE a.festa_id = $1::uuid AND a.empresa_id = $2::uuid AND a.estado = 'PENDENTE' ORDER BY a.criado_em`,
    [f.festaId, f.empresaId],
  )).rows;
  const pendencias = (await tx.query<{
    id: string; descricao: string; estado: string; prazo: string | null; visivel: boolean | null; texto: string | null;
    feito_em: Date | null; feito_papel: PapelArea | null; devolvido_em: Date | null;
  }>(
    `SELECT p.id::text AS id, p.descricao, p.estado, to_char(p.prazo AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS prazo,
            pf.visivel, pf.texto, pf.feito_em, fp.papel AS feito_papel, pf.devolvido_em
       FROM festa_pendencias p
       LEFT JOIN festa_pendencias_familia pf ON pf.pendencia_id = p.id AND pf.festa_id = p.festa_id
       LEFT JOIN festa_pessoas fp ON fp.id = pf.feito_por_pessoa_id
      WHERE p.festa_id = $1::uuid AND p.natureza = 'CLIENTE'
      ORDER BY (p.estado IN ('ABERTA', 'EM_TRATAMENTO')) DESC, p.prazo NULLS LAST, p.criado_em`,
    [f.festaId],
  )).rows;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    disponivel: true, avisoFixo, segundoPelaFamilia,
    avisos: avisos.map((a) => ({ id: a.id, parcela: a.parcela, saldoCentavos: Number(a.saldo), observacao: a.observacao, criadoEm: new Date(a.criado_em).toISOString(), papel: a.papel })),
    pendencias: pendencias.map((p) => ({
      id: p.id, descricao: p.descricao, estado: p.estado, prazo: p.prazo,
      familia: p.texto === null ? null : { visivel: p.visivel === true, texto: p.texto, feitaEm: iso(p.feito_em), feitaPor: p.feito_papel, devolvidaEm: iso(p.devolvido_em) },
    })),
  };
}

/** O que o painel mostra: pessoas, até quando vale o link de cada uma e os aparelhos conectados. Sem token nem CPF. */
export async function resumoAreaFamilia(tx: DbExecutor, ctx: Ctx, festaId: string): Promise<ResumoAreaFamilia> {
  const f = await festaDaEmpresa(tx, ctx, festaId);
  const cliente = (await tx.query<{ nome: string; whatsapp: string | null }>(
    "SELECT coalesce(nome_completo, razao_social, '') AS nome, whatsapp FROM clientes WHERE id = $1::uuid", [f.clienteId])).rows[0];
  const pessoas = (await tx.query<{ id: string; papel: PapelArea; nome: string | null; whatsapp: string | null; link_ate: Date | null }>(
    `SELECT p.id::text AS id, p.papel, p.nome, p.whatsapp,
            (SELECT l.expira_em FROM festa_links_area l WHERE l.pessoa_id = p.id AND l.revogado_em IS NULL AND l.expira_em > clock_timestamp()) AS link_ate
       FROM festa_pessoas p WHERE p.festa_id = $1::uuid AND p.removido_em IS NULL ORDER BY p.papel, p.criado_em`,
    [f.festaId],
  )).rows;
  const doContratante = pessoas.find((p) => p.papel === "CONTRATANTE");
  const lista: ResumoAreaFamilia["pessoas"] = [{
    id: doContratante?.id ?? "", papel: "CONTRATANTE", nome: cliente?.nome ?? "",
    whatsappMascarado: cliente?.whatsapp ? mascararTelefoneIdentidade(cliente.whatsapp) : null,
    linkAtivoAte: doContratante?.link_ate ? new Date(doContratante.link_ate).toISOString() : null,
  }];
  for (const p of pessoas.filter((x) => x.papel === "SEGUNDO_RESPONSAVEL")) {
    lista.push({ id: p.id, papel: p.papel, nome: p.nome ?? "", whatsappMascarado: p.whatsapp ? mascararTelefoneIdentidade(p.whatsapp) : null,
      linkAtivoAte: p.link_ate ? new Date(p.link_ate).toISOString() : null });
  }
  const aparelhos = (await tx.query<{ id: string; papel: PapelArea; aparelho: string | null; criado_em: Date; ultimo_uso_em: Date; lembrar: boolean }>(
    `SELECT s.id::text AS id, p.papel, s.aparelho, s.criado_em, s.ultimo_uso_em, s.lembrar
       FROM area_familia_sessoes s JOIN festa_pessoas p ON p.id = s.pessoa_id
      WHERE s.festa_id = $1::uuid AND s.revogada_em IS NULL AND s.expira_em > clock_timestamp()
      ORDER BY s.ultimo_uso_em DESC LIMIT 50`,
    [f.festaId],
  )).rows;
  return {
    aberta: f.aberta, fechaEm: f.fechaEm, pessoas: lista,
    aparelhos: aparelhos.map((a) => ({ id: a.id, papel: a.papel, aparelho: a.aparelho, entrouEm: new Date(a.criado_em).toISOString(),
      ultimoUsoEm: new Date(a.ultimo_uso_em).toISOString(), lembrar: a.lembrar })),
    acoes: await resumoAcoes(tx, f),
  };
}

/**
 * Link novo para a pessoa (o anterior dela cai com NOVO_LINK). Vale até o fechamento da área (no máximo 400 dias).
 * Devolve o caminho com o token no fragmento (#): o fragmento não vai ao servidor nem aos logs de acesso.
 */
export async function gerarLinkArea(tx: DbExecutor, ctx: Ctx, festaId: string, papel: PapelArea) {
  const f = await festaDaEmpresa(tx, ctx, festaId, true);
  if (!f.aberta) throw FECHADA();
  let pessoaId: string;
  if (papel === "CONTRATANTE") pessoaId = await contratante(tx, f, ctx);
  else {
    const s = await segundo(tx, f.festaId);
    if (!s) throw new AreaFamiliaError("SEGUNDO_AUSENTE", "Cadastre o segundo responsável antes de enviar o link.", 409);
    pessoaId = s.id;
  }
  await tx.query("SELECT kidmais_123_revogar_links($1::uuid, $2::uuid, 'NOVO_LINK')", [f.festaId, pessoaId]);
  const token = gerarTokenArea();
  const link = (await tx.query<{ expira_em: Date }>(
    `INSERT INTO festa_links_area (pessoa_id, festa_id, empresa_id, token_hash, expira_em, criado_por_usuario_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, LEAST($5::timestamptz, now() + interval '400 days'), $6::uuid) RETURNING expira_em`,
    [pessoaId, f.festaId, f.empresaId, hashTokenArea(token), f.fechaEm, ctx.usuarioId],
  )).rows[0];
  await evento(tx, f, ctx, "LINK_GERADO", pessoaId);
  return { caminho: `${caminhoArea(f.codigoEmpresa)}#${token}`, expiraEm: new Date(link.expira_em).toISOString() };
}

/** Derruba todos os aparelhos da festa (as duas pessoas). Os links continuam valendo. */
export async function desconectarTodos(tx: DbExecutor, ctx: Ctx, festaId: string) {
  const f = await festaDaEmpresa(tx, ctx, festaId, true);
  const n = (await tx.query<{ n: number }>("SELECT kidmais_123_derrubar_sessoes($1::uuid, NULL, 'BUFFET_DESCONECTOU') AS n", [f.festaId])).rows[0].n;
  await evento(tx, f, ctx, "BUFFET_DESCONECTOU", null);
  return { desconectados: n };
}

export type NovoSegundo = { nome: string; whatsapp: string; email?: string | null; documento?: string | null };

/** WhatsApp só com dígitos, 10 a 13 (com ou sem DDI). */
export function normalizarWhatsapp(valor: string) {
  const d = valor.replace(/\D/g, "");
  return /^[0-9]{10,13}$/.test(d) ? d : null;
}

/** Segundo responsável cadastrado pelo buffet: vê tudo, mas não convida nem remove ninguém. Um por festa. */
export async function cadastrarSegundo(tx: DbExecutor, ctx: Ctx, festaId: string, input: NovoSegundo, pepper: string) {
  const f = await festaDaEmpresa(tx, ctx, festaId, true);
  if (!f.aberta) throw FECHADA();
  const whatsapp = normalizarWhatsapp(input.whatsapp);
  if (!whatsapp) throw new AreaFamiliaError("DADOS_INVALIDOS", "WhatsApp inválido.", 400);
  const documento = (input.documento ?? "").replace(/\D/g, "");
  if (documento && documento.length !== 11) throw new AreaFamiliaError("DADOS_INVALIDOS", "CPF inválido.", 400);
  const email = input.email?.trim().toLowerCase() || null;
  try {
    const criada = (await tx.query<{ id: string }>(
      `INSERT INTO festa_pessoas (festa_id, empresa_id, papel, nome, whatsapp, email, documento_hash, criado_por_usuario_id)
       VALUES ($1::uuid, $2::uuid, 'SEGUNDO_RESPONSAVEL', $3, $4, $5, $6, $7::uuid) RETURNING id::text AS id`,
      [f.festaId, f.empresaId, input.nome.trim(), whatsapp, email, documento ? hashDocumentoPessoa(documento, pepper) : null, ctx.usuarioId],
    )).rows[0];
    await evento(tx, f, ctx, "PESSOA_CADASTRADA", criada.id);
    return { id: criada.id };
  } catch (error) {
    if (isUniqueViolation(error)) throw new AreaFamiliaError("SEGUNDO_JA_CADASTRADO", "Esta festa já tem um segundo responsável. Remova o atual antes.", 409);
    throw error;
  }
}

/** Remove o segundo responsável: o banco derruba os aparelhos e o link dele (PESSOA_REMOVIDA). */
export async function removerSegundo(tx: DbExecutor, ctx: Ctx, festaId: string, pessoaId: string) {
  const f = await festaDaEmpresa(tx, ctx, festaId, true);
  const r = await tx.query(
    `UPDATE festa_pessoas SET removido_em = clock_timestamp(), removido_por_usuario_id = $3::uuid
      WHERE id = $1::uuid AND festa_id = $2::uuid AND papel = 'SEGUNDO_RESPONSAVEL' AND removido_em IS NULL`,
    [pessoaId, f.festaId, ctx.usuarioId],
  );
  if (r.rowCount !== 1) throw new AreaFamiliaError("PESSOA_NAO_ENCONTRADA", "Pessoa não encontrada.", 404);
  await evento(tx, f, ctx, "PESSOA_REMOVIDA", pessoaId);
  return { removida: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// F3 (125): ações do buffet sobre o que a família fez ou vê. Sem a 125: 503 (ACOES_INDISPONIVEIS), nada gravado.
// ---------------------------------------------------------------------------------------------------------------------

/** "Já paguei" conferido (a baixa continua no financeiro, à parte) ou descartado. Só aviso pendente desta festa. */
export async function tratarAvisoPagamento(tx: DbExecutor, ctx: Ctx, festaId: string, avisoId: string, decisao: "CONFERIDO" | "DESCARTADO") {
  const f = await festaDaEmpresa(tx, ctx, festaId, true);
  if (!(await acoesInstaladas(tx))) throw ACOES_INDISPONIVEIS();
  const r = (await tx.query<{ pessoa_id: string; parcela_numero: number }>(
    `UPDATE area_familia_avisos_pagamento SET estado = $4, tratado_em = clock_timestamp(), tratado_por_usuario_id = $5::uuid
      WHERE id = $1::uuid AND festa_id = $2::uuid AND empresa_id = $3::uuid AND estado = 'PENDENTE'
      RETURNING pessoa_id::text AS pessoa_id, parcela_numero`,
    [avisoId, f.festaId, f.empresaId, decisao, ctx.usuarioId],
  )).rows[0];
  if (!r) throw new AreaFamiliaError("AVISO_NAO_ENCONTRADO", "Aviso não encontrado ou já tratado.", 404);
  await evento(tx, f, ctx, "AVISO_PAGAMENTO_TRATADO", r.pessoa_id, decisao);
  return { tratado: decisao };
}

/**
 * Mostra (ou esconde) uma pendência CLIENTE para a família, com um texto PARA A FAMÍLIA (a descrição interna nunca vai
 * para a área). Esconder não apaga: guarda o texto e o histórico do "feito".
 */
export async function configurarPendenciaFamilia(tx: DbExecutor, ctx: Ctx, festaId: string, pendenciaId: string, input: { visivel: boolean; texto: string }) {
  const f = await festaDaEmpresa(tx, ctx, festaId, true);
  if (!(await acoesInstaladas(tx))) throw ACOES_INDISPONIVEIS();
  const texto = textoLivre(input.texto, 280);
  if (!texto) throw new AreaFamiliaError("DADOS_INVALIDOS", "Escreva o texto que a família vai ver (até 280 caracteres).", 400);
  const pendencia = (await tx.query<{ natureza: string }>(
    "SELECT natureza FROM festa_pendencias WHERE id = $1::uuid AND festa_id = $2::uuid", [pendenciaId, f.festaId])).rows[0];
  if (!pendencia) throw new AreaFamiliaError("PENDENCIA_NAO_ENCONTRADA", "Pendência não encontrada.", 404);
  if (pendencia.natureza !== "CLIENTE") throw new AreaFamiliaError("PENDENCIA_OPERACIONAL", "Só pendência do cliente aparece para a família.", 409);
  await tx.query(
    `INSERT INTO festa_pendencias_familia (pendencia_id, festa_id, empresa_id, visivel, texto, atualizado_por_usuario_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)
     ON CONFLICT (pendencia_id) DO UPDATE SET visivel = EXCLUDED.visivel, texto = EXCLUDED.texto,
       atualizado_por_usuario_id = EXCLUDED.atualizado_por_usuario_id`,
    [pendenciaId, f.festaId, f.empresaId, input.visivel, texto, ctx.usuarioId],
  );
  await evento(tx, f, ctx, "PENDENCIA_VISIBILIDADE", null, input.visivel ? "VISIVEL" : "OCULTA");
  return { visivel: input.visivel };
}

/** Devolve um "feito" da família (ex.: faltou algo). A família volta a ver o item em aberto, marcado como devolvido. */
export async function devolverPendenciaFamilia(tx: DbExecutor, ctx: Ctx, festaId: string, pendenciaId: string) {
  const f = await festaDaEmpresa(tx, ctx, festaId, true);
  if (!(await acoesInstaladas(tx))) throw ACOES_INDISPONIVEIS();
  const r = (await tx.query<{ pessoa_id: string }>(
    `SELECT feito_por_pessoa_id::text AS pessoa_id FROM festa_pendencias_familia
      WHERE pendencia_id = $1::uuid AND festa_id = $2::uuid AND empresa_id = $3::uuid AND feito_em IS NOT NULL FOR UPDATE`,
    [pendenciaId, f.festaId, f.empresaId],
  )).rows[0];
  if (r) {
    await tx.query(
      `UPDATE festa_pendencias_familia SET devolvido_em = clock_timestamp(), devolvido_por_usuario_id = $2::uuid,
              feito_em = NULL, feito_por_pessoa_id = NULL
        WHERE pendencia_id = $1::uuid`,
      [pendenciaId, ctx.usuarioId],
    );
  }
  if (!r) throw new AreaFamiliaError("PENDENCIA_NAO_FEITA", "Esta pendência não está marcada como feita.", 409);
  await evento(tx, f, ctx, "PENDENCIA_DEVOLVIDA", r.pessoa_id);
  return { devolvida: true };
}

/** Aviso fixo do buffet (um por empresa) mostrado no Início de todas as festas. Vazio = sem aviso. */
export async function salvarAvisoFixo(tx: DbExecutor, ctx: Ctx, festaId: string, texto: string | null) {
  const f = await festaDaEmpresa(tx, ctx, festaId);
  if (!(await acoesInstaladas(tx))) throw ACOES_INDISPONIVEIS();
  const limpo = textoLivre(texto, 500);
  if (limpo === false) throw new AreaFamiliaError("DADOS_INVALIDOS", "O aviso tem no máximo 500 caracteres.", 400);
  await tx.query(
    `INSERT INTO area_familia_aviso_empresa (empresa_id, texto, atualizado_por_usuario_id) VALUES ($1::uuid, $2, $3::uuid)
     ON CONFLICT (empresa_id) DO UPDATE SET texto = EXCLUDED.texto, atualizado_por_usuario_id = EXCLUDED.atualizado_por_usuario_id`,
    [f.empresaId, limpo, ctx.usuarioId],
  );
  await evento(tx, f, ctx, "AVISO_FIXO", null, limpo ? "DEFINIDO" : "REMOVIDO");
  return { avisoFixo: limpo };
}
