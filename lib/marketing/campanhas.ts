import { z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import { MarketingError, conflito, naoEncontrado } from "./erros.ts";
import { CODIGO_ORIGEM } from "./origens.ts";
import { CODIGO_CAMPANHA, UTM_VALOR } from "./utm.ts";

export const CANAIS_CAMPANHA = ["GOOGLE", "INSTAGRAM", "FACEBOOK", "WHATSAPP", "EMAIL", "INDICACAO", "OFFLINE", "OUTRO"] as const;
export type CanalCampanha = (typeof CANAIS_CAMPANHA)[number];
export const ROTULO_CANAL_CAMPANHA: Record<CanalCampanha, string> = {
  GOOGLE: "Google", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", WHATSAPP: "WhatsApp", EMAIL: "E-mail",
  INDICACAO: "Indicação", OFFLINE: "Material impresso / offline", OUTRO: "Outro",
};
/** Padrão de utm_source/utm_medium e origem de aquisição por canal (editáveis na criação). */
export const PADRAO_POR_CANAL: Record<CanalCampanha, { utmSource: string; utmMedium: string; origem: string }> = {
  GOOGLE: { utmSource: "google", utmMedium: "cpc", origem: "GOOGLE" },
  INSTAGRAM: { utmSource: "instagram", utmMedium: "social", origem: "INSTAGRAM" },
  FACEBOOK: { utmSource: "facebook", utmMedium: "social", origem: "FACEBOOK" },
  WHATSAPP: { utmSource: "whatsapp", utmMedium: "mensagem", origem: "OUTRO" },
  EMAIL: { utmSource: "email", utmMedium: "email", origem: "OUTRO" },
  INDICACAO: { utmSource: "indicacao", utmMedium: "referral", origem: "INDICACAO" },
  OFFLINE: { utmSource: "impresso", utmMedium: "offline", origem: "PASSAGEM_FRENTE" },
  OUTRO: { utmSource: "outro", utmMedium: "outro", origem: "OUTRO" },
};

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.");
const uuid = z.string().uuid();
const camposEditaveis = {
  nome: z.string().trim().min(2, "Dê um nome à campanha.").max(120),
  canal: z.enum(CANAIS_CAMPANHA),
  origemCodigo: z.string().regex(CODIGO_ORIGEM),
  objetivo: z.string().trim().max(500).nullable().optional(),
  inicio: data,
  fim: data.nullable().optional(),
  orcamentoCentavos: z.number().int().min(0).max(99_999_999_999).nullable().optional(),
  utmSource: z.string().trim().toLowerCase().regex(UTM_VALOR, "Use letras minúsculas, números, ponto, hífen ou sublinhado."),
  utmMedium: z.string().trim().toLowerCase().regex(UTM_VALOR, "Use letras minúsculas, números, ponto, hífen ou sublinhado."),
  unidadeId: uuid.nullable().optional(),
  siteId: uuid.nullable().optional(),
};
export const esquemaCriarCampanha = z.object({
  acao: z.literal("criar"),
  codigo: z.string().trim().toLowerCase().regex(CODIGO_CAMPANHA, "Identificador: 4 a 48 caracteres, minúsculas, números e hífen."),
  ...camposEditaveis,
}).strict();
export const esquemaEditarCampanha = z.object({ acao: z.literal("editar"), id: uuid, versao: z.number().int().min(1), ...camposEditaveis }).strict();
export const esquemaEstadoCampanha = z.object({ acao: z.enum(["pausar", "reativar", "arquivar"]), id: uuid, versao: z.number().int().min(1) }).strict();
export const esquemaAcaoCampanha = z.discriminatedUnion("acao", [esquemaCriarCampanha, esquemaEditarCampanha,
  esquemaEstadoCampanha.extend({ acao: z.literal("pausar") }), esquemaEstadoCampanha.extend({ acao: z.literal("reativar") }),
  esquemaEstadoCampanha.extend({ acao: z.literal("arquivar") })]);
export type AcaoCampanha = z.infer<typeof esquemaAcaoCampanha>;

export type Campanha = {
  id: string; codigo: string; nome: string; canal: CanalCampanha; origemCodigo: string; objetivo: string | null;
  inicio: string; fim: string | null; orcamentoCentavos: number | null; utmSource: string; utmMedium: string;
  status: "ATIVA" | "PAUSADA" | "ARQUIVADA"; unidadeId: string | null; siteId: string | null; versao: number;
  criadaEm: string; atualizadaEm: string;
};

type Linha = {
  id: string; codigo: string; nome: string; canal: CanalCampanha; origem_codigo: string; objetivo: string | null; inicio: string; fim: string | null;
  orcamento_centavos: string | null; utm_source: string; utm_medium: string; status: Campanha["status"]; estabelecimento_id: string | null;
  site_id: string | null; versao: number; criada_em: string; atualizada_em: string;
};
const COLUNAS = `id::text, codigo, nome, canal, origem_codigo, objetivo, inicio::text, fim::text, orcamento_centavos::text, utm_source, utm_medium,
  status, estabelecimento_id::text, site_id::text, versao, criada_em::text, atualizada_em::text`;

function mapear(l: Linha): Campanha {
  return {
    id: l.id, codigo: l.codigo, nome: l.nome, canal: l.canal, origemCodigo: l.origem_codigo, objetivo: l.objetivo, inicio: l.inicio, fim: l.fim,
    orcamentoCentavos: l.orcamento_centavos === null ? null : Number(l.orcamento_centavos), utmSource: l.utm_source, utmMedium: l.utm_medium,
    status: l.status, unidadeId: l.estabelecimento_id, siteId: l.site_id, versao: l.versao, criadaEm: l.criada_em, atualizadaEm: l.atualizada_em,
  };
}

/** Unidade (opcional) precisa ser da empresa e não desativada (mesma regra das mensagens prontas da 082). */
export async function exigirUnidadeDaEmpresa(tx: DbExecutor, empresaId: string, unidadeId: string | null | undefined) {
  if (!unidadeId) return null;
  const r = await tx.query<{ id: string }>(
    `SELECT id::text FROM estabelecimentos WHERE id = $1::uuid AND empresa_id = $2::uuid AND status <> 'DESATIVADO'`,
    [unidadeId, empresaId],
  );
  if (r.rows.length !== 1) throw new MarketingError("MARKETING_UNIDADE_INVALIDA", "Unidade não encontrada nesta empresa.", 404);
  return r.rows[0].id;
}

async function exigirSiteDaEmpresa(tx: DbExecutor, empresaId: string, siteId: string | null | undefined) {
  if (!siteId) return null;
  const r = await tx.query<{ id: string }>(`SELECT id::text FROM marketing_sites WHERE id = $1::uuid AND empresa_id = $2::uuid`, [siteId, empresaId]);
  if (r.rows.length !== 1) throw new MarketingError("MARKETING_SITE_INVALIDO", "Site não encontrado nesta empresa.", 404);
  return r.rows[0].id;
}

function validarPeriodo(inicio: string, fim: string | null | undefined) {
  if (fim && fim < inicio) throw new MarketingError("MARKETING_PERIODO_INVALIDO", "O fim da campanha precisa ser igual ou depois do início.", 400);
}

export async function listarCampanhas(tx: DbExecutor, empresaId: string, filtros: { incluirArquivadas?: boolean; unidadeId?: string | null } = {}) {
  const r = await tx.query<Linha>(
    `SELECT ${COLUNAS} FROM marketing_campanhas
      WHERE empresa_id = $1::uuid AND ($2::boolean OR status <> 'ARQUIVADA')
        AND ($3::uuid IS NULL OR estabelecimento_id IS NULL OR estabelecimento_id = $3::uuid)
      ORDER BY (status = 'ARQUIVADA'), inicio DESC, nome, id`,
    [empresaId, filtros.incluirArquivadas === true, filtros.unidadeId ?? null],
  );
  return r.rows.map(mapear);
}

export async function lerCampanha(tx: DbExecutor, empresaId: string, id: string) {
  const r = await tx.query<Linha>(`SELECT ${COLUNAS} FROM marketing_campanhas WHERE id = $1::uuid AND empresa_id = $2::uuid`, [id, empresaId]);
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

/** Campanha por código dentro da empresa do site (captura pública). Arquivada não atribui. */
export async function campanhaPorCodigo(tx: DbExecutor, empresaId: string, codigo: string) {
  const r = await tx.query<Linha>(
    `SELECT ${COLUNAS} FROM marketing_campanhas WHERE empresa_id = $1::uuid AND codigo = $2 AND status <> 'ARQUIVADA'`,
    [empresaId, codigo],
  );
  return r.rows[0] ? mapear(r.rows[0]) : null;
}

export async function executarAcaoCampanha(tx: DbExecutor, empresaId: string, usuarioId: string, acao: AcaoCampanha): Promise<Campanha> {
  if (acao.acao === "criar" || acao.acao === "editar") {
    validarPeriodo(acao.inicio, acao.fim);
    const unidade = await exigirUnidadeDaEmpresa(tx, empresaId, acao.unidadeId);
    const site = await exigirSiteDaEmpresa(tx, empresaId, acao.siteId);
    const valores = [acao.nome, acao.canal, acao.origemCodigo, acao.objetivo || null, acao.inicio, acao.fim ?? null,
      acao.orcamentoCentavos ?? null, acao.utmSource, acao.utmMedium, unidade, site, usuarioId];
    if (acao.acao === "criar") {
      try {
        const r = await tx.query<Linha>(
          `INSERT INTO marketing_campanhas (empresa_id, codigo, nome, canal, origem_codigo, objetivo, inicio, fim, orcamento_centavos,
             utm_source, utm_medium, estabelecimento_id, site_id, criada_por, atualizada_por)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12::uuid, $13::uuid, $14::uuid, $14::uuid)
           RETURNING ${COLUNAS}`,
          [empresaId, acao.codigo, ...valores],
        );
        return mapear(r.rows[0]);
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).constraint === "marketing_campanhas_codigo_uk") {
          throw new MarketingError("MARKETING_CODIGO_EM_USO", "Já existe uma campanha com este identificador nesta empresa.", 409);
        }
        throw error;
      }
    }
    const r = await tx.query<Linha>(
      `UPDATE marketing_campanhas SET nome = $3, canal = $4, origem_codigo = $5, objetivo = $6, inicio = $7::date, fim = $8::date,
         orcamento_centavos = $9, utm_source = $10, utm_medium = $11, estabelecimento_id = $12::uuid, site_id = $13::uuid,
         atualizada_por = $14::uuid, atualizada_em = clock_timestamp(), versao = versao + 1
       WHERE id = $1::uuid AND empresa_id = $2::uuid AND versao = $15 AND status <> 'ARQUIVADA'
       RETURNING ${COLUNAS}`,
      [acao.id, empresaId, ...valores, acao.versao],
    );
    if (r.rows.length !== 1) await distinguirFalha(tx, empresaId, acao.id);
    return mapear(r.rows[0]);
  }
  const destino = acao.acao === "pausar" ? "PAUSADA" : acao.acao === "reativar" ? "ATIVA" : "ARQUIVADA";
  const origemPermitida = acao.acao === "pausar" ? ["ATIVA"] : acao.acao === "reativar" ? ["PAUSADA"] : ["ATIVA", "PAUSADA"];
  const r = await tx.query<Linha>(
    `UPDATE marketing_campanhas SET status = $3, arquivada_em = CASE WHEN $3 = 'ARQUIVADA' THEN clock_timestamp() ELSE NULL END,
       atualizada_por = $4::uuid, atualizada_em = clock_timestamp(), versao = versao + 1
     WHERE id = $1::uuid AND empresa_id = $2::uuid AND versao = $5 AND status = ANY($6::text[])
     RETURNING ${COLUNAS}`,
    [acao.id, empresaId, destino, usuarioId, acao.versao, origemPermitida],
  );
  if (r.rows.length !== 1) await distinguirFalha(tx, empresaId, acao.id);
  return mapear(r.rows[0]);
}

async function distinguirFalha(tx: DbExecutor, empresaId: string, id: string): Promise<never> {
  const atual = await lerCampanha(tx, empresaId, id);
  if (!atual) naoEncontrado("Campanha não encontrada nesta empresa.");
  if (atual.status === "ARQUIVADA") throw new MarketingError("MARKETING_CAMPANHA_ARQUIVADA", "Campanha arquivada não pode ser alterada.", 409);
  conflito();
}
