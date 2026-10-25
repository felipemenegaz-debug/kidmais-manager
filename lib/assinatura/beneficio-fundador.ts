import type { DbExecutor } from '../db/contracts';
import { schemaCampanhaInstalado } from './campanha.ts';
import { schemaPlanosInstalado } from './ofertas.ts';

/**
 * Situação ATUAL do benefício Fundador da empresa (diagnóstico de 25/10/2026): só leitura das datas persistidas da
 * concessão — o gatilho 074a fixa o fim em confirmada_em + 12 meses (UTC); aqui nada é recalculado nem gravado — e da
 * contratação que a usa. É separada do comprovante, retrato imutável do aceite que continua dizendo "reservada".
 * Nunca expõe o documento do beneficiário nem o id do pagamento no provedor. Sem a 074a: null (comportamento anterior).
 */
export type SituacaoBeneficio = 'RESERVADA' | 'CONFIRMADA_VIGENTE' | 'ENCERRADA';
export type BeneficioFundador = {
    situacao: SituacaoBeneficio;
    reservadaEm: string;
    confirmadaEm: string | null;
    beneficioFim: string | null;
    /** Contratação (oferta) que usa a concessão: a atual da assinatura, senão a em aberto. */
    contratacaoId: string | null;
    contratacaoEstado: string | null;
};
/** Ficha do desenvolvedor: mais a vaga e a fase (090) da concessão. */
export type BeneficioFundadorDesenvolvedor = BeneficioFundador & { vaga: number | null; origem: string | null };

const ISO = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function lerBeneficio(tx: DbExecutor, empresaId: string): Promise<BeneficioFundadorDesenvolvedor | null> {
    if (!await schemaPlanosInstalado(tx)) return null;
    const origem = await schemaCampanhaInstalado(tx) ? 'f.origem' : 'NULL::text';
    // Vigência pelo relógio do banco contra o fim persistido (mesma regra de situacaoFundador): no instante do fim, encerrada.
    return (await tx.query<BeneficioFundadorDesenvolvedor>(`SELECT
            CASE WHEN f.estado = 'RESERVADA' THEN 'RESERVADA' WHEN f.beneficio_fim > clock_timestamp() THEN 'CONFIRMADA_VIGENTE' ELSE 'ENCERRADA' END AS situacao,
            ${ISO('f.reservada_em')} AS "reservadaEm", ${ISO('f.confirmada_em')} AS "confirmadaEm", ${ISO('f.beneficio_fim')} AS "beneficioFim",
            c.id AS "contratacaoId", c.estado AS "contratacaoEstado", f.vaga::int AS vaga, ${origem} AS origem
           FROM assinatura_fundadores f
           LEFT JOIN LATERAL (SELECT o.id, o.estado FROM assinatura_contratacoes o
                LEFT JOIN empresa_assinaturas a ON a.empresa_id = o.empresa_id AND a.contratacao_atual_id = o.id
               WHERE o.empresa_id = f.empresa_id AND o.fundador_id = f.id AND o.estado <> 'CANCELADA'
               ORDER BY (a.contratacao_atual_id IS NOT NULL) DESC, (o.estado = 'EM_ABERTO') DESC, o.criada_em DESC LIMIT 1) c ON true
          WHERE f.empresa_id = $1::uuid AND f.estado <> 'LIBERADA'`, [empresaId])).rows[0] ?? null;
}

/** Gestão da empresa comprovada: estado e datas do benefício, sem vaga nem fase. */
export async function consultarBeneficioFundador(tx: DbExecutor, empresaId: string): Promise<BeneficioFundador | null> {
    const b = await lerBeneficio(tx, empresaId);
    if (!b) return null;
    return { situacao: b.situacao, reservadaEm: b.reservadaEm, confirmadaEm: b.confirmadaEm, beneficioFim: b.beneficioFim,
        contratacaoId: b.contratacaoId, contratacaoEstado: b.contratacaoEstado };
}

/** Ficha da empresa no painel do desenvolvedor (autorizada pelo chamador). */
export const consultarBeneficioFundadorDesenvolvedor = lerBeneficio;
