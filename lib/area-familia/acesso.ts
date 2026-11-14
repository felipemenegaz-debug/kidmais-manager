import { randomBytes, randomInt } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { hashProvaIdentidadeToken, mascararTelefoneIdentidade } from "../identidade/services/identity.service.ts";
import { registrarEnvioOtp, registrarTentativaInvalida } from "../identidade/repositories/identidade.repository.ts";
import type { IdentityOtpSender } from "../identidade/services/models.ts";
import {
  CODIGO_EMPRESA_AREA, documentoCanonico, FORMATO_TOKEN_AREA, gerarTokenArea, hashCodigoArea, hashDocumentoPessoa, hashesIguais,
  hashTokenArea,
} from "./tokens.ts";

/**
 * Entrada na área "Minha festa" (123). Toda recusa da prova é a MESMA (`{ ok: false }`): link inválido, vencido ou
 * revogado, documento errado, pessoa removida, festa de outra empresa, contrato cancelado, festa invalidada ou área
 * fechada. Nada de CPF, token, código ou telefone em log.
 *
 * As funções recebem a conexão/transação: a rota abre a transação (withTransaction) e as suítes usam a do teste.
 */
export const CODIGO_TTL_MS = 10 * 60 * 1000;
export const MAX_TENTATIVAS_CODIGO = 5;
/** Códigos por pessoa: no máximo 3 por hora e 8 por dia. */
export const CODIGOS_POR_HORA = 3;
export const CODIGOS_POR_DIA = 8;
/** Erros por pessoa em 24 h, somados entre códigos (pedir um código novo não zera). */
export const ERROS_POR_DIA = 10;

/** A área fecha no fim do dia data_evento + 30 (America/Sao_Paulo): início do dia data_evento + 31. */
export const SQL_FECHAMENTO_AREA = `(((fe.data_evento + 31)::timestamp) AT TIME ZONE 'America/Sao_Paulo')`;

/**
 * Predicado de acesso da pessoa `p` (com f, c, fe): pessoa ativa, festa válida, contrato não cancelado, contratante ainda
 * é o cliente da festa e a área ainda aberta.
 */
export const SQL_ACESSO_ABERTO = `p.removido_em IS NULL AND f.invalidada_em IS NULL AND c.status <> 'CANCELADO'
  AND (p.papel <> 'CONTRATANTE' OR p.cliente_id = fe.cliente_id)
  AND clock_timestamp() < ${SQL_FECHAMENTO_AREA}`;

export const SQL_JUNCAO_FESTA = `JOIN festas f ON f.id = p.festa_id
  JOIN contratos c ON c.id = f.contrato_id
  JOIN fechamentos fe ON fe.id = c.fechamento_id
  JOIN clientes cl ON cl.id = fe.cliente_id`;

export type RecusaArea = { ok: false; motivo: "RECUSADO" | "LIMITE" | "CODIGO_INCORRETO" };
const RECUSADO: RecusaArea = { ok: false, motivo: "RECUSADO" };

export type DependenciasArea = {
  pepper: string;
  enviarOtp: IdentityOtpSender;
  gerarCodigo?: () => string;
};

export async function empresaDaArea(conexao: DbExecutor, codigo: string): Promise<string | null> {
  if (!CODIGO_EMPRESA_AREA.test(codigo)) return null;
  const { rows } = await conexao.query<{ id: string }>(
    "SELECT id::text AS id FROM empresas WHERE codigo = $1 AND status = 'ATIVA'", [codigo]);
  return rows.length === 1 ? rows[0].id : null;
}

/** Documento só com letras e dígitos, em maiúsculas (CNPJ alfanumérico). */
export function normalizarDocumento(valor: string | null | undefined) {
  return documentoCanonico(valor);
}

function documentoConfere(informado: string, cadastro: { tipo: string | null; cpf: string | null; cnpj: string | null }, pepper: string) {
  const esperado = normalizarDocumento(cadastro.tipo === "PJ" ? cadastro.cnpj : cadastro.cpf);
  if (!esperado || !informado) return false;
  // Comparação em tempo constante, pelos HMAC (mesmo tamanho) da forma canônica, que mantém as letras do CNPJ (AF-R2).
  return hashesIguais(hashDocumentoPessoa(informado, pepper), hashDocumentoPessoa(esperado, pepper));
}

type LinhaLink = {
  pessoa_id: string;
  papel: "CONTRATANTE" | "SEGUNDO_RESPONSAVEL";
  cliente_id: string;
  tipo_pessoa: string | null;
  cpf: string | null;
  cnpj: string | null;
  whatsapp_cliente: string | null;
  whatsapp_pessoa: string | null;
  documento_hash: string | null;
};

export type InicioArea = { ok: true; validacaoId: string; destinoMascarado: string; expiraEm: string };

/**
 * Passo 1: link + documento. Confere tudo, aplica os limites da pessoa, encerra códigos pendentes dela e manda um código
 * novo só para o WhatsApp da própria pessoa (contratante: o do cadastro atual; segundo: o dele).
 */
export async function iniciarEntrada(
  tx: DbExecutor,
  deps: DependenciasArea,
  input: { empresaCodigo: string; token: string; documento?: string | null },
): Promise<InicioArea | RecusaArea> {
  if (!FORMATO_TOKEN_AREA.test(input.token)) return RECUSADO;
  const empresaId = await empresaDaArea(tx, input.empresaCodigo);
  if (!empresaId) return RECUSADO;
  const { rows } = await tx.query<LinhaLink>(
    `SELECT p.id::text AS pessoa_id, p.papel, fe.cliente_id::text AS cliente_id, cl.tipo_pessoa, cl.cpf, cl.cnpj,
            cl.whatsapp AS whatsapp_cliente, p.whatsapp AS whatsapp_pessoa, p.documento_hash
       FROM festa_links_area l
       JOIN festa_pessoas p ON p.id = l.pessoa_id
       ${SQL_JUNCAO_FESTA}
      WHERE l.token_hash = $1 AND l.empresa_id = $2::uuid AND l.revogado_em IS NULL AND l.expira_em > clock_timestamp()
        AND ${SQL_ACESSO_ABERTO}
      FOR UPDATE OF p FOR SHARE OF cl`,
    [hashTokenArea(input.token), empresaId],
  );
  const linha = rows[0];
  if (!linha) return RECUSADO;

  const documento = normalizarDocumento(input.documento);
  if (linha.papel === "CONTRATANTE") {
    if (!documentoConfere(documento, { tipo: linha.tipo_pessoa, cpf: linha.cpf, cnpj: linha.cnpj }, deps.pepper)) return RECUSADO;
  } else if (linha.documento_hash) {
    if (!documento || !hashesIguais(hashDocumentoPessoa(documento, deps.pepper), linha.documento_hash.trim())) return RECUSADO;
  }

  const uso = (await tx.query<{ hora: number; dia: number; erros: number }>(
    `SELECT count(*) FILTER (WHERE criado_em > clock_timestamp() - interval '1 hour')::int AS hora,
            count(*)::int AS dia, coalesce(sum(tentativas), 0)::int AS erros
       FROM validacoes_identidade_cliente
      WHERE festa_pessoa_id = $1::uuid AND criado_em > clock_timestamp() - interval '24 hours'`,
    [linha.pessoa_id],
  )).rows[0];
  if (uso.hora >= CODIGOS_POR_HORA || uso.dia >= CODIGOS_POR_DIA || uso.erros >= ERROS_POR_DIA) return { ok: false, motivo: "LIMITE" };

  const destino = linha.papel === "CONTRATANTE" ? linha.whatsapp_cliente : linha.whatsapp_pessoa;
  if (!destino) return RECUSADO;

  await tx.query(
    "UPDATE validacoes_identidade_cliente SET status = 'CANCELADA' WHERE festa_pessoa_id = $1::uuid AND status = 'PENDENTE'",
    [linha.pessoa_id],
  );
  const codigo = (deps.gerarCodigo ?? (() => randomInt(0, 1_000_000).toString().padStart(6, "0")))();
  const expiraEm = new Date(Date.now() + CODIGO_TTL_MS).toISOString();
  // Emissão trava o cadastro do contratante (FOR SHARE OF cl) e a pessoa (FOR UPDATE OF p) até o COMMIT: uma troca de
  // contato concorrente espera e, ao entrar, cancela este código (gatilhos da 123).
  const codigoHash = hashCodigoArea(codigo, deps.pepper, { clienteId: linha.cliente_id, destino, codigoExpiraEm: expiraEm });
  const criada = (await tx.query<{ id: string }>(
    `INSERT INTO validacoes_identidade_cliente (cliente_id, finalidade, festa_pessoa_id, canal, status, codigo_hash, codigo_expira_em, max_tentativas, max_envios)
     VALUES ($1::uuid, 'AREA_FAMILIA', $2::uuid, 'WHATSAPP', 'PENDENTE', $3, $4::timestamptz, $5, 1)
     RETURNING id::text AS id`,
    [linha.cliente_id, linha.pessoa_id, codigoHash, expiraEm, MAX_TENTATIVAS_CODIGO],
  )).rows[0];

  await deps.enviarOtp({ validacaoId: criada.id, canal: "WHATSAPP", destino, codigo, expiraEm });
  await registrarEnvioOtp(criada.id, tx);
  return { ok: true, validacaoId: criada.id, destinoMascarado: mascararTelefoneIdentidade(destino), expiraEm };
}

type LinhaValidacao = {
  id: string;
  status: string;
  cliente_id: string;
  canal: "WHATSAPP" | "SMS" | "EMAIL" | null;
  codigo_hash: string | null;
  codigo_expira_em: Date | string | null;
  vencido: boolean;
  pessoa_id: string;
  festa_id: string;
  empresa_id: string;
  acesso: boolean;
  erros: number;
  destino: string | null;
};

export type EntradaArea = { ok: true; token: string; sessaoId: string; expiraEm: Date; lembrar: boolean };

/**
 * Passo 2: código. Na MESMA transação: sessão nova (prazo calculado no banco, nunca depois do fechamento da área) e a
 * validação PENDENTE → CONSUMIDA apontando para ela (sem prova solta reaproveitável). Código errado conta tentativa e
 * a rota faz COMMIT dessa contagem.
 */
export async function confirmarEntrada(
  tx: DbExecutor,
  deps: Pick<DependenciasArea, "pepper">,
  input: { empresaCodigo: string; validacaoId: string; codigo: string; lembrar: boolean; aparelho: string | null },
): Promise<EntradaArea | RecusaArea> {
  if (!/^\d{6}$/.test(input.codigo)) return { ok: false, motivo: "CODIGO_INCORRETO" };
  const empresaId = await empresaDaArea(tx, input.empresaCodigo);
  if (!empresaId) return RECUSADO;
  const { rows } = await tx.query<LinhaValidacao>(
    `SELECT v.id::text AS id, v.status, v.cliente_id::text AS cliente_id, v.canal, v.codigo_hash, v.codigo_expira_em,
            v.codigo_expira_em <= clock_timestamp() AS vencido,
            p.id::text AS pessoa_id, p.festa_id::text AS festa_id, p.empresa_id::text AS empresa_id,
            CASE WHEN p.papel = 'CONTRATANTE' THEN cl.whatsapp ELSE p.whatsapp END AS destino,
            (${SQL_ACESSO_ABERTO} AND EXISTS (SELECT 1 FROM festa_links_area l WHERE l.pessoa_id = p.id AND l.revogado_em IS NULL
               AND l.expira_em > clock_timestamp())) AS acesso,
            (SELECT coalesce(sum(o.tentativas), 0)::int FROM validacoes_identidade_cliente o
              WHERE o.festa_pessoa_id = p.id AND o.criado_em > clock_timestamp() - interval '24 hours') AS erros
       FROM validacoes_identidade_cliente v
       JOIN festa_pessoas p ON p.id = v.festa_pessoa_id
       ${SQL_JUNCAO_FESTA}
      WHERE v.id = $1::uuid AND v.finalidade = 'AREA_FAMILIA' AND p.empresa_id = $2::uuid
      FOR UPDATE OF v`,
    [input.validacaoId, empresaId],
  );
  const v = rows[0];
  if (!v || v.status !== "PENDENTE" || v.vencido || !v.acesso || !v.codigo_hash || !v.codigo_expira_em || !v.canal || !v.destino) return RECUSADO;
  if (v.erros >= ERROS_POR_DIA) return { ok: false, motivo: "LIMITE" };

  // O código só confere com o WhatsApp ATUAL da pessoa: enviado a um número que mudou depois, não abre sessão (AF-R1).
  // A troca de contato também cancela a validação pendente (gatilhos da 123) e, se vier agora, espera o FOR UPDATE OF v
  // desta transação e derruba a sessão criada aqui.
  const esperado = hashCodigoArea(input.codigo, deps.pepper, {
    clienteId: v.cliente_id, destino: v.destino, codigoExpiraEm: new Date(v.codigo_expira_em).toISOString(),
  });
  if (!hashesIguais(esperado, v.codigo_hash)) {
    await registrarTentativaInvalida(v.id, tx);
    return { ok: false, motivo: "CODIGO_INCORRETO" };
  }

  const token = gerarTokenArea();
  const sessao = (await tx.query<{ id: string; expira_em: Date }>(
    `INSERT INTO area_familia_sessoes (pessoa_id, festa_id, empresa_id, validacao_id, token_hash, lembrar, expira_em, aparelho)
     SELECT p.id, p.festa_id, p.empresa_id, $2::uuid, $3, $4::boolean,
            LEAST(now() + CASE WHEN $4::boolean THEN interval '30 days' ELSE interval '12 hours' END, ${SQL_FECHAMENTO_AREA}), $5
       FROM festa_pessoas p ${SQL_JUNCAO_FESTA}
      WHERE p.id = $1::uuid
     RETURNING id::text AS id, expira_em`,
    [v.pessoa_id, v.id, hashTokenArea(token), input.lembrar, input.aparelho],
  )).rows[0];
  const consumida = await tx.query(
    `UPDATE validacoes_identidade_cliente
        SET status = 'CONSUMIDA', confirmado_em = now(), token_prova_hash = $2, prova_expira_em = now() + interval '1 second',
            consumido_em = now(), consumido_por_area_sessao_id = $3::uuid, codigo_hash = NULL
      WHERE id = $1::uuid AND status = 'PENDENTE'`,
    [v.id, hashProvaIdentidadeToken(randomBytes(32).toString("base64url")), sessao.id],
  );
  if (consumida.rowCount !== 1) throw new Error("AREA_FAMILIA_CONSUMO_CONCORRENTE");
  await tx.query(
    `INSERT INTO area_familia_eventos (festa_id, empresa_id, pessoa_id, autor_pessoa_id, tipo) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, 'ENTRADA')`,
    [v.festa_id, v.empresa_id, v.pessoa_id],
  );
  return { ok: true, token, sessaoId: sessao.id, expiraEm: new Date(sessao.expira_em), lembrar: input.lembrar };
}

export type SessaoArea = {
  sessaoId: string;
  pessoaId: string;
  festaId: string;
  empresaId: string;
  papel: "CONTRATANTE" | "SEGUNDO_RESPONSAVEL";
  primeiroNome: string;
};

/**
 * Sessão do cookie: ativa, da empresa do endereço e com o acesso ainda aberto. Prazo vencido só recusa (não há motivo
 * PRAZO). Marca o uso no máximo a cada 5 minutos.
 */
export async function lerSessao(conexao: DbExecutor, empresaCodigo: string, token: string | null | undefined): Promise<SessaoArea | null> {
  if (!token || !FORMATO_TOKEN_AREA.test(token) || !CODIGO_EMPRESA_AREA.test(empresaCodigo)) return null;
  const { rows } = await conexao.query<{
    id: string; pessoa_id: string; festa_id: string; empresa_id: string; papel: SessaoArea["papel"]; nome: string | null; tocar: boolean;
  }>(
    `SELECT s.id::text AS id, p.id::text AS pessoa_id, p.festa_id::text AS festa_id, p.empresa_id::text AS empresa_id, p.papel,
            CASE WHEN p.papel = 'CONTRATANTE' THEN coalesce(cl.representante_nome, cl.nome_completo) ELSE p.nome END AS nome,
            s.ultimo_uso_em < clock_timestamp() - interval '5 minutes' AS tocar
       FROM area_familia_sessoes s
       JOIN empresas e ON e.id = s.empresa_id AND e.codigo = $2 AND e.status = 'ATIVA'
       JOIN festa_pessoas p ON p.id = s.pessoa_id
       ${SQL_JUNCAO_FESTA}
      WHERE s.token_hash = $1 AND s.revogada_em IS NULL AND s.expira_em > clock_timestamp() AND ${SQL_ACESSO_ABERTO}`,
    [hashTokenArea(token), empresaCodigo],
  );
  const s = rows[0];
  if (!s) return null;
  if (s.tocar) {
    await conexao.query("UPDATE area_familia_sessoes SET ultimo_uso_em = clock_timestamp() WHERE id = $1::uuid AND revogada_em IS NULL", [s.id]);
  }
  return {
    sessaoId: s.id, pessoaId: s.pessoa_id, festaId: s.festa_id, empresaId: s.empresa_id, papel: s.papel,
    primeiroNome: (s.nome ?? "").trim().split(/\s+/)[0] ?? "",
  };
}

/** Sair deste aparelho. */
export async function sair(tx: DbExecutor, sessao: SessaoArea) {
  const r = await tx.query(
    "UPDATE area_familia_sessoes SET revogada_em = clock_timestamp(), motivo_revogacao = 'SAIR' WHERE id = $1::uuid AND revogada_em IS NULL",
    [sessao.sessaoId],
  );
  if (r.rowCount === 1) {
    await tx.query(
      `INSERT INTO area_familia_eventos (festa_id, empresa_id, pessoa_id, autor_pessoa_id, tipo) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, 'SAIR')`,
      [sessao.festaId, sessao.empresaId, sessao.pessoaId],
    );
  }
}

/** Sair de todos os aparelhos DESTA pessoa (o outro responsável continua conectado). */
export async function sairDeTodos(tx: DbExecutor, sessao: SessaoArea) {
  await tx.query("SELECT kidmais_123_derrubar_sessoes($1::uuid, $2::uuid, 'SAIR_DE_TODOS')", [sessao.festaId, sessao.pessoaId]);
  await tx.query(
    `INSERT INTO area_familia_eventos (festa_id, empresa_id, pessoa_id, autor_pessoa_id, tipo) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, 'SAIR_DE_TODOS')`,
    [sessao.festaId, sessao.empresaId, sessao.pessoaId],
  );
}
