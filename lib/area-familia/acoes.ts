import type { DbExecutor } from "../db/contracts.ts";
import { isUniqueViolation } from "../db/errors.ts";
import { listarRecebiveisDoContrato } from "../financeiro/servico.ts";
import { mascararTelefoneIdentidade } from "../identidade/services/identity.service.ts";
import { lerSessao, SQL_FECHAMENTO_AREA, type SessaoArea } from "./acesso.ts";
import { textoLivre } from "./formato.ts";
import { contratoDaSessao, estadoDaParcela } from "./leitura.ts";

export { textoLivre };
import { caminhoArea, gerarTokenArea, hashDocumentoPessoa, hashTokenArea } from "./tokens.ts";

/**
 * F3 da área "Minha festa" (125): o que a FAMÍLIA faz. Tudo parte da SESSÃO (lerSessao), nunca de ids de festa,
 * empresa ou pessoa vindos do pedido. Sem a 125 (tabelas ausentes) nada é gravado: a rota responde 503 e a leitura
 * não mostra as partes novas. O banco confere de novo cada regra (gatilhos da 125): o código é a primeira barreira.
 *
 * Nenhuma ação dá baixa em pagamento, altera a pendência interna ou envia mensagem: "Já paguei" só avisa a equipe;
 * "Feito" só marca na tabela da família; o convite devolve um link que a própria pessoa repassa.
 */
export async function acoesInstaladas(tx: DbExecutor): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT to_regclass('public.area_familia_avisos_pagamento') IS NOT NULL
        AND to_regclass('public.festa_pendencias_familia') IS NOT NULL
        AND to_regclass('public.area_familia_aviso_empresa') IS NOT NULL AS ok`,
  );
  return r.rows[0]?.ok === true;
}

export type AcaoFamilia =
  | { acao: "AVISAR_PAGAMENTO"; parcela: string; observacao?: string | null }
  | { acao: "PENDENCIA_FEITA"; pendencia: string }
  | { acao: "CONVIDAR_SEGUNDO"; nome: string; whatsapp: string; documento?: string | null }
  | { acao: "LINK_SEGUNDO" }
  | { acao: "REMOVER_SEGUNDO" };

export type MotivoRecusaAcao =
  | "NAO_ENCONTRADO" | "PARCELA_SEM_SALDO" | "AVISO_JA_ENVIADO" | "PENDENCIA_INDISPONIVEL" | "PENDENCIA_JA_FEITA"
  | "SO_CONTRATANTE" | "SEGUNDO_JA_CADASTRADO" | "SEGUNDO_AUSENTE" | "DADOS_INVALIDOS";

export type ResultadoAcao =
  | { ok: true; acao: "AVISAR_PAGAMENTO"; parcela: number }
  | { ok: true; acao: "PENDENCIA_FEITA" }
  | { ok: true; acao: "CONVIDAR_SEGUNDO" | "LINK_SEGUNDO"; caminho: string; expiraEm: string; linkId: string }
  | { ok: true; acao: "REMOVER_SEGUNDO" }
  | { ok: false; motivo: MotivoRecusaAcao };

const recusa = (motivo: MotivoRecusaAcao): ResultadoAcao => ({ ok: false, motivo });

async function evento(tx: DbExecutor, s: SessaoArea, tipo: string, pessoaId: string | null, motivo: string | null = null) {
  await tx.query(
    `INSERT INTO area_familia_eventos (festa_id, empresa_id, pessoa_id, autor_pessoa_id, tipo, motivo)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
    [s.festaId, s.empresaId, pessoaId, s.pessoaId, tipo, motivo],
  );
}

/** "Já paguei": só parcela do contrato da sessão, com saldo, sem outro aviso pendente. Guarda saldo e número do momento. */
async function avisarPagamento(tx: DbExecutor, s: SessaoArea, parcelaId: string, observacao: string | null | undefined, hoje: string): Promise<ResultadoAcao> {
  const obs = textoLivre(observacao, 280);
  if (obs === false) return recusa("DADOS_INVALIDOS");
  const alvo = await contratoDaSessao(tx, s);
  if (!alvo) return recusa("NAO_ENCONTRADO");
  const parcela = (await listarRecebiveisDoContrato(tx, s.empresaId, alvo.contratoId, hoje)).find((r) => r.id === parcelaId);
  if (!parcela) return recusa("NAO_ENCONTRADO");
  const estado = estadoDaParcela(parcela, hoje);
  if (estado === "PAGA" || estado === "CANCELADA" || parcela.saldoCentavos <= 0) return recusa("PARCELA_SEM_SALDO");
  try {
    await tx.query("SAVEPOINT aviso_pagamento");
    await tx.query(
      `INSERT INTO area_familia_avisos_pagamento (festa_id, empresa_id, pessoa_id, parcela_id, parcela_numero, saldo_centavos, observacao)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)`,
      [s.festaId, s.empresaId, s.pessoaId, parcela.id, parcela.parcela, parcela.saldoCentavos, obs],
    );
    await tx.query("RELEASE SAVEPOINT aviso_pagamento");
  } catch (error) {
    if (isUniqueViolation(error)) {
      await tx.query("ROLLBACK TO SAVEPOINT aviso_pagamento");
      return recusa("AVISO_JA_ENVIADO");
    }
    throw error;
  }
  await evento(tx, s, "AVISO_PAGAMENTO", s.pessoaId); // motivo da 123 só aceita código; a parcela fica no próprio aviso
  return { ok: true, acao: "AVISAR_PAGAMENTO", parcela: parcela.parcela };
}

/** "Feito": só pendência que a equipe tornou visível, ainda aberta e não marcada. A pendência interna não muda. */
async function marcarPendenciaFeita(tx: DbExecutor, s: SessaoArea, pendenciaId: string): Promise<ResultadoAcao> {
  const linha = (await tx.query<{ visivel: boolean; estado: string; natureza: string; feito: boolean }>(
    `SELECT pf.visivel, p.estado, p.natureza, pf.feito_em IS NOT NULL AS feito
       FROM festa_pendencias_familia pf
       JOIN festa_pendencias p ON p.id = pf.pendencia_id AND p.festa_id = pf.festa_id
      WHERE pf.pendencia_id = $1::uuid AND pf.festa_id = $2::uuid AND pf.empresa_id = $3::uuid
      FOR UPDATE OF pf`,
    [pendenciaId, s.festaId, s.empresaId],
  )).rows[0];
  if (!linha || !linha.visivel || linha.natureza !== "CLIENTE") return recusa("NAO_ENCONTRADO");
  if (linha.feito) return recusa("PENDENCIA_JA_FEITA");
  if (linha.estado !== "ABERTA" && linha.estado !== "EM_TRATAMENTO") return recusa("PENDENCIA_INDISPONIVEL");
  await tx.query(
    `UPDATE festa_pendencias_familia SET feito_em = clock_timestamp(), feito_por_pessoa_id = $2::uuid, devolvido_em = NULL, devolvido_por_usuario_id = NULL
      WHERE pendencia_id = $1::uuid AND feito_em IS NULL`,
    [pendenciaId, s.pessoaId],
  );
  await evento(tx, s, "PENDENCIA_FEITA", s.pessoaId);
  return { ok: true, acao: "PENDENCIA_FEITA" };
}

/** WhatsApp só com dígitos, 10 a 13 (com ou sem DDI). Mesma regra do painel. */
function whatsappValido(valor: string) {
  const d = valor.replace(/\D/g, "");
  return /^[0-9]{10,13}$/.test(d) ? d : null;
}

async function segundoAtivo(tx: DbExecutor, festaId: string) {
  return (await tx.query<{ id: string }>(
    "SELECT id::text AS id FROM festa_pessoas WHERE festa_id = $1::uuid AND papel = 'SEGUNDO_RESPONSAVEL' AND removido_em IS NULL FOR UPDATE",
    [festaId],
  )).rows[0] ?? null;
}

/** Link novo do segundo responsável, gerado pelo contratante (o anterior cai com NOVO_LINK). Mesmo prazo do painel. */
async function linkDoSegundo(tx: DbExecutor, s: SessaoArea, pessoaId: string) {
  const area = (await tx.query<{ codigo: string; fecha_em: Date }>(
    `SELECT e.codigo, ${SQL_FECHAMENTO_AREA} AS fecha_em
       FROM festas f JOIN contratos c ON c.id = f.contrato_id JOIN fechamentos fe ON fe.id = c.fechamento_id
       JOIN empresas e ON e.id = $2::uuid
      WHERE f.id = $1::uuid`,
    [s.festaId, s.empresaId],
  )).rows[0];
  await tx.query("SELECT kidmais_123_revogar_links($1::uuid, $2::uuid, 'NOVO_LINK')", [s.festaId, pessoaId]);
  const token = gerarTokenArea();
  const link = (await tx.query<{ id: string; expira_em: Date }>(
    `INSERT INTO festa_links_area (pessoa_id, festa_id, empresa_id, token_hash, expira_em, criado_por_pessoa_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, LEAST($5::timestamptz, now() + interval '400 days'), $6::uuid) RETURNING id::text AS id, expira_em`,
    [pessoaId, s.festaId, s.empresaId, hashTokenArea(token), new Date(area.fecha_em).toISOString(), s.pessoaId],
  )).rows[0];
  await evento(tx, s, "LINK_GERADO", pessoaId);
  return { caminho: `${caminhoArea(area.codigo)}#${token}`, expiraEm: new Date(link.expira_em).toISOString(), linkId: link.id };
}

async function convidarSegundo(tx: DbExecutor, s: SessaoArea, input: { nome: string; whatsapp: string; documento?: string | null }, pepper: string): Promise<ResultadoAcao> {
  const nome = textoLivre(input.nome, 120);
  const whatsapp = whatsappValido(input.whatsapp);
  const documento = (input.documento ?? "").replace(/\D/g, "");
  if (!nome || !whatsapp || (documento && documento.length !== 11)) return recusa("DADOS_INVALIDOS");
  if (await segundoAtivo(tx, s.festaId)) return recusa("SEGUNDO_JA_CADASTRADO");
  let id: string;
  try {
    await tx.query("SAVEPOINT convite_segundo");
    id = (await tx.query<{ id: string }>(
      `INSERT INTO festa_pessoas (festa_id, empresa_id, papel, nome, whatsapp, documento_hash, criado_por_pessoa_id)
       VALUES ($1::uuid, $2::uuid, 'SEGUNDO_RESPONSAVEL', $3, $4, $5, $6::uuid) RETURNING id::text AS id`,
      [s.festaId, s.empresaId, nome, whatsapp, documento ? hashDocumentoPessoa(documento, pepper) : null, s.pessoaId],
    )).rows[0].id;
    await tx.query("RELEASE SAVEPOINT convite_segundo");
  } catch (error) {
    if (isUniqueViolation(error)) {
      await tx.query("ROLLBACK TO SAVEPOINT convite_segundo");
      return recusa("SEGUNDO_JA_CADASTRADO");
    }
    throw error;
  }
  await evento(tx, s, "PESSOA_CADASTRADA", id);
  return { ok: true, acao: "CONVIDAR_SEGUNDO", ...(await linkDoSegundo(tx, s, id)) };
}

/** Remove o segundo responsável: a 123 derruba os aparelhos e o link dele; a 125 confere a autoria. */
async function removerSegundo(tx: DbExecutor, s: SessaoArea): Promise<ResultadoAcao> {
  const alvo = await segundoAtivo(tx, s.festaId);
  if (!alvo) return recusa("SEGUNDO_AUSENTE");
  await tx.query(
    `UPDATE festa_pessoas SET removido_em = clock_timestamp(), removido_por_pessoa_id = $2::uuid
      WHERE id = $1::uuid AND papel = 'SEGUNDO_RESPONSAVEL' AND removido_em IS NULL`,
    [alvo.id, s.pessoaId],
  );
  await evento(tx, s, "PESSOA_REMOVIDA", alvo.id);
  return { ok: true, acao: "REMOVER_SEGUNDO" };
}

/**
 * Executa uma ação da família na transação do pedido. A sessão já foi relida e presa NESTA transação (agirComSessao). Convidar,
 * gerar link e remover são só do contratante (o segundo responsável vê tudo, mas não convida nem remove ninguém).
 */
export async function executarAcaoFamilia(tx: DbExecutor, s: SessaoArea, acao: AcaoFamilia, deps: { pepper: string; hoje: string }): Promise<ResultadoAcao> {
  // Trava a linha da festa: ações concorrentes da mesma festa (convite x remoção) ficam em fila.
  const festa = (await tx.query("SELECT 1 FROM festas WHERE id = $1::uuid FOR UPDATE", [s.festaId])).rowCount;
  if (festa !== 1) return recusa("NAO_ENCONTRADO");
  switch (acao.acao) {
    case "AVISAR_PAGAMENTO": return avisarPagamento(tx, s, acao.parcela, acao.observacao, deps.hoje);
    case "PENDENCIA_FEITA": return marcarPendenciaFeita(tx, s, acao.pendencia);
    default: break;
  }
  if (s.papel !== "CONTRATANTE") return recusa("SO_CONTRATANTE");
  if (acao.acao === "CONVIDAR_SEGUNDO") return convidarSegundo(tx, s, acao, deps.pepper);
  if (acao.acao === "REMOVER_SEGUNDO") return removerSegundo(tx, s);
  const alvo = await segundoAtivo(tx, s.festaId);
  if (!alvo) return recusa("SEGUNDO_AUSENTE");
  return { ok: true, acao: "LINK_SEGUNDO", ...(await linkDoSegundo(tx, s, alvo.id)) };
}

/**
 * Ponto de entrada da rota, dentro da transação: trava a festa (FOR UPDATE) e SÓ DEPOIS relê a sessão presa (FOR SHARE
 * na pessoa e na sessão). Ordem igual à do painel (festa → sessões): "desconectar todos" que chegou antes faz esta
 * releitura falhar; uma revogação que chega depois espera o COMMIT desta ação.
 */
export async function agirComSessao(
  tx: DbExecutor, empresa: string, token: string, previa: SessaoArea, acao: AcaoFamilia, deps: { pepper: string; hoje: string },
): Promise<ResultadoAcao | "SESSAO" | "INDISPONIVEL"> {
  const festa = (await tx.query("SELECT 1 FROM festas WHERE id = $1::uuid FOR UPDATE", [previa.festaId])).rowCount;
  if (festa !== 1) return "SESSAO";
  const atual = await lerSessao(tx, empresa, token, { travar: true });
  if (!atual || atual.sessaoId !== previa.sessaoId || atual.festaId !== previa.festaId) return "SESSAO";
  if (!(await acoesInstaladas(tx))) return "INDISPONIVEL";
  return executarAcaoFamilia(tx, atual, acao, deps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Leitura das partes da F3 (para lerMinhaFesta). Sem a 125: nada.
// ---------------------------------------------------------------------------------------------------------------------
export type PendenciaFamilia = { id: string; texto: string; prazo: string | null; feita: boolean; devolvida: boolean };
/** linkId: id do link ativo (não é segredo; o segredo é o token). A tela só mostra um link gerado nesta visita enquanto
 * ele for o link ativo do servidor (ver visita.ts). */
export type SegundoResumo = { nome: string; whatsappMascarado: string | null; linkAtivoAte: string | null; linkId: string | null; criadoPelaFamilia: boolean } | null;
export type AcoesDaFamilia = {
  disponivel: boolean;
  avisoFixo: string | null;
  pendencias: PendenciaFamilia[];
  /** Ids das parcelas com aviso "Já paguei" ainda pendente de conferência. */
  parcelasAvisadas: string[];
  /** Só para o contratante (null = sem segundo); para o segundo responsável fica undefined. */
  segundo: SegundoResumo | undefined;
};

export const SEM_ACOES: AcoesDaFamilia = { disponivel: false, avisoFixo: null, pendencias: [], parcelasAvisadas: [], segundo: undefined };

export async function lerAcoesDaFamilia(tx: DbExecutor, s: SessaoArea): Promise<AcoesDaFamilia> {
  if (!(await acoesInstaladas(tx))) return SEM_ACOES;
  const aviso = (await tx.query<{ texto: string | null }>(
    "SELECT texto FROM area_familia_aviso_empresa WHERE empresa_id = $1::uuid", [s.empresaId])).rows[0]?.texto ?? null;
  // Só pendência CLIENTE, visível e ainda aberta (ou marcada feita aguardando a equipe). O texto é o PARA A FAMÍLIA.
  const pendencias = (await tx.query<{ id: string; texto: string; prazo: string | null; feita: boolean; devolvida: boolean }>(
    `SELECT pf.pendencia_id::text AS id, pf.texto, to_char(p.prazo AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS prazo,
            pf.feito_em IS NOT NULL AS feita, pf.devolvido_em IS NOT NULL AS devolvida
       FROM festa_pendencias_familia pf
       JOIN festa_pendencias p ON p.id = pf.pendencia_id AND p.festa_id = pf.festa_id
      WHERE pf.festa_id = $1::uuid AND pf.empresa_id = $2::uuid AND pf.visivel AND p.natureza = 'CLIENTE'
        AND p.estado IN ('ABERTA', 'EM_TRATAMENTO')
      ORDER BY p.prazo NULLS LAST, pf.criado_em`,
    [s.festaId, s.empresaId],
  )).rows;
  const parcelasAvisadas = (await tx.query<{ id: string }>(
    "SELECT parcela_id::text AS id FROM area_familia_avisos_pagamento WHERE festa_id = $1::uuid AND estado = 'PENDENTE'",
    [s.festaId],
  )).rows.map((r) => r.id);
  let segundo: SegundoResumo | undefined;
  if (s.papel === "CONTRATANTE") {
    const r = (await tx.query<{ nome: string | null; whatsapp: string | null; link_ate: Date | null; link_id: string | null; pela_familia: boolean }>(
      `SELECT p.nome, p.whatsapp, p.criado_por_pessoa_id IS NOT NULL AS pela_familia, l.expira_em AS link_ate, l.id::text AS link_id
         FROM festa_pessoas p
         LEFT JOIN LATERAL (SELECT x.id, x.expira_em FROM festa_links_area x
                             WHERE x.pessoa_id = p.id AND x.revogado_em IS NULL AND x.expira_em > clock_timestamp()
                             ORDER BY x.criado_em DESC LIMIT 1) l ON true
        WHERE p.festa_id = $1::uuid AND p.papel = 'SEGUNDO_RESPONSAVEL' AND p.removido_em IS NULL`,
      [s.festaId],
    )).rows[0];
    segundo = r ? {
      nome: (r.nome ?? "").trim(), whatsappMascarado: r.whatsapp ? mascararTelefoneIdentidade(r.whatsapp) : null,
      linkAtivoAte: r.link_ate ? new Date(r.link_ate).toISOString() : null, linkId: r.link_id, criadoPelaFamilia: r.pela_familia,
    } : null;
  }
  return { disponivel: true, avisoFixo: aviso, pendencias, parcelasAvisadas, segundo };
}
