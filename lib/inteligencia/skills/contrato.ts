import { z } from "zod";

/**
 * Skills V1 — playbooks de runtime do Kidmais Intelligence (feature SKILLS).
 *
 * NÃO confundir com skills de desenvolvimento (.claude/.codex, docs/SEGURANCA_SKILLS.md): aquelas são tooling e
 * nunca entram no runtime. Estas são CONTEÚDO de atendimento — tom de voz, procedimentos, objeções, templates,
 * formatação — em três níveis: PLATAFORMA → EMPRESA → ESTABELECIMENTO.
 *
 * Uma skill NUNCA é autoridade: não concede preço fora do Core, desconto, permissão, papel, acesso, alteração
 * financeira, contrato nem desvio de Policy. Classes de uso só READ/SUGGEST (nunca CONFIRM). Toda skill tem
 * proveniência, versão, hash, permissões, restrições e estado de revisão; só APROVADA/RESTRITA com o hash revisado
 * igual ao hash atual é carregada. Skill de TERCEIRO exige referência fixa (commit) e revisor — nunca instrução
 * remota automática.
 */
export const VERSAO_SKILLS = "skills-v1.0.0";

export const NIVEIS = ["PLATAFORMA", "EMPRESA", "ESTABELECIMENTO"] as const;
export const FINALIDADES = ["TOM", "ATENDIMENTO", "SUGESTAO_TEXTO", "PROCEDIMENTO", "OBJECAO", "FORMATACAO"] as const;
export const ORIGENS = ["INTERNA", "EMPRESA", "TERCEIRO"] as const;
export const ESTADOS_REVISAO = ["APROVADA", "RESTRITA", "PENDENTE", "REJEITADA"] as const;

/**
 * Marcadores de template: lista FECHADA. O valor é preenchido pelo Core (serviço de domínio, tenant comprovado),
 * nunca pela skill nem pelo modelo. Marcador fora da lista ⇒ skill recusada.
 */
export const MARCADORES_PERMITIDOS = [
  "nome_cliente", "nome_aniversariante", "data_festa", "horario_festa", "nome_pacote", "convidados",
  "nome_empresa", "valor_em_aberto", "data_vencimento", "situacao_contrato",
] as const;

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const TEXTO = (max: number) => z.string().trim().min(1).max(max);
const HASH = z.string().regex(/^[0-9a-f]{64}$/);

export const conteudoSchema = z.object({
  tom: TEXTO(400).nullable(),
  instrucoes: z.array(TEXTO(300)).max(20),
  procedimentos: z.array(z.object({ titulo: TEXTO(120), passos: z.array(TEXTO(300)).min(1).max(15) }).strict()).max(20),
  objecoes: z.array(z.object({ objecao: TEXTO(200), resposta: TEXTO(600) }).strict()).max(20),
  templates: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,48}$/),
    titulo: TEXTO(120),
    texto: TEXTO(1200),
    marcadores: z.array(z.enum(MARCADORES_PERMITIDOS)).max(10),
  }).strict()).max(20),
  formatacao: z.object({ maxParagrafos: z.number().int().min(1).max(10).nullable(), usarListas: z.boolean().nullable() }).strict(),
}).strict();

export const skillSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,48}$/),
  nivel: z.enum(NIVEIS),
  escopo: z.object({ empresaId: UUID.nullable(), estabelecimentoId: UUID.nullable() }).strict(),
  finalidades: z.array(z.enum(FINALIDADES)).min(1).max(FINALIDADES.length),
  /** Capacidades que a skill orienta. Vazia ⇒ vale para a finalidade em geral. Nunca curinga. */
  capacidades: z.array(z.string().regex(/^[a-z_]{1,64}$/)).max(20),
  versao: z.string().regex(/^\d+\.\d+\.\d+$/),
  proveniencia: z.object({
    origem: z.enum(ORIGENS),
    autor: TEXTO(120),
    /** Commit (TERCEIRO: obrigatório, 40 hex), id de revisão interna ou referência do cadastro da empresa. */
    referencia: TEXTO(120),
  }).strict(),
  revisao: z.object({
    estado: z.enum(ESTADOS_REVISAO),
    revisor: TEXTO(120).nullable(),
    revisadoEm: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** Hash do conteúdo que foi de fato revisado. Mudou o conteúdo ⇒ precisa de nova revisão. */
    hashRevisado: HASH.nullable(),
  }).strict(),
  /** Uma skill só pode orientar leitura e sugestão. CONFIRM/DENY não existem aqui. */
  permissoes: z.object({ classes: z.array(z.enum(["READ", "SUGGEST"])).min(1).max(2) }).strict(),
  restricoes: z.array(TEXTO(200)).max(20),
  conteudo: conteudoSchema,
  hash: HASH,
}).strict();

export type Skill = z.infer<typeof skillSchema>;
export type NivelSkillV1 = (typeof NIVEIS)[number];

/** Motivos de recusa de uma skill (proveniência, revisão, integridade ou conteúdo com autoridade). */
export const MOTIVOS_RECUSA_SKILL = [
  "SCHEMA_INVALIDO", "HASH_DIVERGENTE", "REVISAO_PENDENTE", "REVISAO_REJEITADA", "REVISAO_DE_OUTRO_CONTEUDO",
  "TERCEIRO_SEM_COMMIT", "TERCEIRO_SEM_REVISOR", "RESTRITA_SEM_RESTRICOES", "ESCOPO_INCOERENTE",
  "CONTEUDO_PRECO", "CONTEUDO_DESCONTO", "CONTEUDO_PERMISSAO", "CONTEUDO_FINANCEIRO", "CONTEUDO_CONTRATO",
  "CONTEUDO_DESVIO_POLITICA", "CONTEUDO_REMOTO", "CONTEUDO_SEGREDO", "OVERRIDE_AMPLIA", "CONTEUDO_OCULTO", "SEM_BASE_PLATAFORMA", "MARCADOR_DESCONHECIDO", "MARCADOR_NAO_DECLARADO",
] as const;
export type MotivoRecusaSkill = (typeof MOTIVOS_RECUSA_SKILL)[number];
