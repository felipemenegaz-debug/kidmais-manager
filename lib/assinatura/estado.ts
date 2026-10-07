import type { DbExecutor } from '../db/contracts';
import { calcularAcessoComercial, type AcessoComercial, type AssinaturaGravada, type ExcecaoGravada } from './acesso.ts';

/**
 * Estado comercial da empresa COMPROVADA (067), lido na transação do tenant. Sem a 067 instalada, ou sem linha de
 * assinatura, o acesso é COMPLETO (sem cobrança) — exatamente o comportamento de hoje.
 * O instante de referência é o relógio do banco (clock_timestamp), o mesmo de todas as gravações.
 */
export type EstadoComercial = {
    instalado: boolean;
    assinatura: (AssinaturaGravada & { ciclo: 'MENSAL' | 'ANUAL' | null; testeInicio: string; versao: number }) | null;
    excecoes: Array<ExcecaoGravada & { id: string }>;
    agora: string;
    acesso: AcessoComercial;
};

export async function comercialInstalado(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.empresa_assinaturas') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

export async function lerEstadoComercial(tx: DbExecutor, empresaId: string): Promise<EstadoComercial> {
    // ISO UTC com milissegundos: Date.parse não aceita o fuso '-03' sem minutos que o PostgreSQL devolve em ::text.
    const agora = (await tx.query<{ agora: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS agora`)).rows[0].agora;
    const agoraMs = Date.parse(agora);
    if (!await comercialInstalado(tx))
        return { instalado: false, assinatura: null, excecoes: [], agora, acesso: calcularAcessoComercial(null) };
    const a = (await tx.query<{
        situacao: AssinaturaGravada['situacao']; ciclo: 'MENSAL' | 'ANUAL' | null; teste_inicio: string; teste_fim: string;
        periodo_atual_fim: string | null; em_atraso_desde: string | null; encerrada_em: string | null; versao: number;
    }>(
        `SELECT situacao, ciclo, to_char(teste_inicio AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS teste_inicio,
                to_char(teste_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS teste_fim,
                to_char(periodo_atual_fim AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS periodo_atual_fim,
                to_char(em_atraso_desde AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS em_atraso_desde,
                to_char(encerrada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS encerrada_em, versao
           FROM empresa_assinaturas WHERE empresa_id = $1::uuid`, [empresaId])).rows[0];
    const excecoes = (await tx.query<{ id: string; tipo: ExcecaoGravada['tipo']; valida_ate: string; revogada_em: string | null }>(
        `SELECT id, tipo, to_char(valida_ate AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS valida_ate,
                to_char(revogada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS revogada_em
           FROM empresa_excecoes_comerciais WHERE empresa_id = $1::uuid AND revogada_em IS NULL AND valida_ate > clock_timestamp()
          ORDER BY valida_ate DESC`, [empresaId])).rows.map((e) => ({ id: e.id, tipo: e.tipo, validaAte: e.valida_ate, revogadaEm: e.revogada_em }));
    const assinatura = a ? {
        situacao: a.situacao, ciclo: a.ciclo, testeInicio: a.teste_inicio, testeFim: a.teste_fim, periodoAtualFim: a.periodo_atual_fim,
        emAtrasoDesde: a.em_atraso_desde, encerradaEm: a.encerrada_em, versao: a.versao,
    } : null;
    return { instalado: true, assinatura, excecoes, agora, acesso: calcularAcessoComercial(assinatura, excecoes, agoraMs) };
}
