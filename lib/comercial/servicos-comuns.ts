import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { migration070Aplicada } from "./migration-070.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

/**
 * "Adicionar serviços comuns" (fase S-A2, 103; plano rev. 4 aprovado com ressalvas pelo Astra em 25/10/2026).
 * Cria, SÓ na empresa da sessão, os adicionais de serviço que os pais mais procuram, na categoria global SERVICOS.
 *   * códigos determinísticos reservados (não usa o gerador com sufixo aleatório do cadastro comum);
 *   * INSERT ... ON CONFLICT (empresa_id, codigo) WHERE empresa_id IS NOT NULL DO NOTHING — o índice parcial da 031;
 *   * o resultado de cada item vem de uma NOVA leitura depois do INSERT (o RETURNING vazio de um conflito concorrente
 *     não prova ausência); nada é sobrescrito nem reativado;
 *   * sem preço e sem faixas: não chama a sucessão de tabela (que exige tabela publicada). INCLUSO dispensa preço;
 *     EXTRA continua exigindo preço no cadastro comum;
 *   * em cada pacote o buffet marca INCLUSO/EXTRA/INDISPONIVEL pela tela de pacotes que já existe.
 */
export const SERVICOS_COMUNS = [
  { codigo: "SERVICO_ANIMACAO", nome: "Animação e personagem" },
  { codigo: "SERVICO_GERENTE", nome: "Gerente de festa" },
  { codigo: "SERVICO_MONITORES", nome: "Monitores de recreação" },
  { codigo: "SERVICO_RECREACAO", nome: "Recreação" },
] as const;

export type ResultadoServico = "CRIADO" | "JA_EXISTIA" | "INATIVO" | "CONFLITO";
export const TEXTO_RESULTADO: Record<ResultadoServico, string> = {
  CRIADO: "criado",
  JA_EXISTIA: "já existia",
  INATIVO: "já existe, mas está inativo (não foi reativado)",
  CONFLITO: "o código já é usado por outro adicional (nada foi alterado)",
};

type Contexto = { empresaId: string; usuarioId: string; requestId: string };

export async function servicosInstalados(db: DbExecutor) {
  const r = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM adicional_categorias WHERE codigo = 'SERVICOS' AND ativo AND arquivado_em IS NULL) AS ok`);
  return Boolean(r.rows[0]?.ok);
}

export async function criarServicosComuns(tx: DbExecutor, ctx: Contexto) {
  if (!(await migration070Aplicada(tx))) {
    throw new PacoteAdminError("MIGRACAO_PENDENTE", "A atualização do banco para adicionais do buffet (070) ainda não foi aplicada.", 503);
  }
  const categoria = await tx.query<{ id: string }>(
    `SELECT id::text FROM adicional_categorias WHERE codigo = 'SERVICOS' AND ativo AND arquivado_em IS NULL`);
  const categoriaId = categoria.rows[0]?.id
    ?? (() => { throw new PacoteAdminError("RECURSO_INDISPONIVEL", "A categoria Serviços ainda não está disponível.", 409); })();
  const criados = new Set<string>();
  for (const s of SERVICOS_COMUNS) {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao, ativo)
       VALUES ($1::uuid, $2, $3, 'SERVICOS', $4::uuid, 'PACOTE',
               (SELECT COALESCE(max(ordem_exibicao), 0) + 1 FROM adicionais WHERE empresa_id = $1::uuid), true)
       ON CONFLICT (empresa_id, codigo) WHERE empresa_id IS NOT NULL DO NOTHING
       RETURNING id::text`, [ctx.empresaId, s.codigo, s.nome, categoriaId]);
    if (r.rows[0]) criados.add(s.codigo);
  }
  const atuais = await tx.query<{ id: string; codigo: string; nome: string; categoria: string; ativo: boolean }>(
    `SELECT id::text, codigo, nome, categoria, ativo FROM adicionais WHERE empresa_id = $1::uuid AND codigo = ANY($2::text[])`,
    [ctx.empresaId, SERVICOS_COMUNS.map((s) => s.codigo)]);
  const resultado = SERVICOS_COMUNS.map((s) => {
    const a = atuais.rows.find((x) => x.codigo === s.codigo);
    // Conflito tem precedência (código ocupado por outra categoria, inclusive se também inativo): nada é tocado.
    const situacao: ResultadoServico = !a ? "CONFLITO"
      : a.categoria !== "SERVICOS" ? "CONFLITO"
        : criados.has(s.codigo) ? "CRIADO"
          : !a.ativo ? "INATIVO" : "JA_EXISTIA";
    return { codigo: s.codigo, nome: a?.nome ?? s.nome, adicionalId: a?.id ?? null, situacao, texto: TEXTO_RESULTADO[situacao] };
  });
  if (criados.size > 0) {
    await auditarMutacaoComercial(tx, {
      usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: "SERVICOS_COMUNS", acao: "ADICIONAIS_SERVICOS_CRIADOS",
      entidadeTipo: "ADICIONAL", entidadeId: resultado.find((x) => x.situacao === "CRIADO")?.adicionalId ?? ctx.empresaId,
      empresaId: ctx.empresaId, antes: null, depois: { criados: [...criados] },
    });
  }
  return resultado;
}
