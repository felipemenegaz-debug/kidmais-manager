/**
 * Worker de manutenção dos créditos (095), idempotente e por empresa (scripts/creditos-manutencao.cjs; simulação por
 * padrão). Não depende de evento do Asaas: plano anual recebe franquia mês a mês por aqui.
 *   - expira o disponível de lotes vencidos (EXPIRACAO por lote, uma vez);
 *   - franquia mensal de Convites para empresas CORTADAS: o mesmo limite legado (convite_carteiras ativo), com acesso
 *     COMPLETO, chave FRANQUIA:<AAAA-MM> (nunca duas no mês), vencendo no fim do mês; o mês do corte já tem o lote LEGADO;
 *     Wall-e não recebe franquia enquanto indisponível (e nenhuma franquia proposta é aplicada sem decisão);
 *   - avisos de vencimento de lotes pagos/cortesia em 30 e 7 dias (outbox deduplicado por lote e marco);
 *   - com CREDITOS_FRANQUIA_PLANO_ATIVO e a 116: franquia pela tabela do plano (lib/creditos/franquias.ts) no lugar do
 *     limite legado, e avisos de 80%/100% da franquia do mês. Empresa sem limite (isenta, teste, legado) segue o legado.
 * Ordem de travas: empresa (FOR SHARE) → carteira → assinatura, em qualquer caminho (com ou sem a flag) — ver franquias.ts.
 */
import type { DbExecutor } from '../db/contracts';
import { lerEstadoComercial } from '../assinatura/estado.ts';
import { fimDoMesBrasilia, mesBrasilia } from './dominio.ts';
import { creditarLote, expirarVencidos, lerCarteira } from './ledger.ts';
import { enfileirarNotificacao } from './notificacoes.ts';
import { flagsCreditos } from './config.ts';
import { avisosDeUsoFranquia, franquiasInstaladas, reconhecerFranquia, travarEmpresaAntesDaCarteira } from './franquias.ts';

export async function empresasComCarteira(tx: DbExecutor) {
    return (await tx.query<{ empresa_id: string }>('SELECT DISTINCT empresa_id FROM ia_credito_carteiras ORDER BY empresa_id')).rows.map((r) => r.empresa_id);
}

export async function concederFranquiaConvites(tx: DbExecutor, empresaId: string) {
    const w = await lerCarteira(tx, empresaId, 'CONVITES', true);
    if (!w) return { concedida: false, motivo: 'SEM_CORTE' };
    const agora = Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
    const mes = mesBrasilia(agora);
    const corte = (await tx.query<{ mes: string }>("SELECT to_char(mes, 'YYYY-MM-DD') AS mes FROM ia_credito_cortes WHERE empresa_id = $1::uuid AND recurso = 'CONVITES'",
        [empresaId])).rows[0];
    if (corte?.mes === mes) return { concedida: false, motivo: 'MES_DO_CORTE' };
    const legado = (await tx.query<{ limite_mensal: number; ativo: boolean }>('SELECT limite_mensal, ativo FROM convite_carteiras WHERE empresa_id = $1::uuid', [empresaId])).rows[0];
    if (!legado?.ativo || legado.limite_mensal <= 0) return { concedida: false, motivo: 'SEM_FRANQUIA_CONFIGURADA' };
    if ((await lerEstadoComercial(tx, empresaId)).acesso.nivel !== 'COMPLETO') return { concedida: false, motivo: 'ACESSO_NAO_COMPLETO' };
    const r = await creditarLote(tx, { empresaId, recurso: 'CONVITES', origem: 'FRANQUIA', chaveOrigem: `FRANQUIA:${mes.slice(0, 7)}`, quantidade: Number(legado.limite_mensal),
        venceEm: fimDoMesBrasilia(agora), ciclo: mes, ator: 'SISTEMA' });
    return { concedida: r.novo, motivo: r.novo ? null : 'JA_CONCEDIDA' };
}

export async function avisosVencimento(tx: DbExecutor, empresaId: string) {
    const lotes = (await tx.query<{ id: string; protocolo: string | null; dias: number }>(`SELECT l.id, p.protocolo, ceil(extract(epoch FROM l.vence_em - clock_timestamp()) / 86400)::int AS dias
        FROM ia_credito_lotes l LEFT JOIN ia_credito_pedidos p ON p.id = l.pedido_id AND p.empresa_id = l.empresa_id
        WHERE l.empresa_id = $1::uuid AND l.origem IN ('COMPRA', 'CORTESIA') AND l.disponivel > 0 AND l.vence_em > clock_timestamp()
          AND l.vence_em <= clock_timestamp() + interval '30 days'`, [empresaId])).rows;
    let n = 0;
    for (const l of lotes) {
        const tipo = l.dias <= 7 ? 'LOTE_VENCENDO_7' : 'LOTE_VENCENDO_30';
        await enfileirarNotificacao(tx, { empresaId, tipo, dedupe: `${tipo}:${l.id}`, protocolo: l.protocolo });
        n += 1;
    }
    return n;
}

/** Franquia do mês: pela tabela do plano com a flag e a 116; senão (ou empresa sem limite) o caminho legado intacto. */
export async function franquiaDoMes(tx: DbExecutor, empresaId: string, env: Record<string, string | undefined> = process.env) {
    if (!flagsCreditos(env).franquiaPlano || !await franquiasInstaladas(tx)) return { ...await concederFranquiaConvites(tx, empresaId), porPlano: false };
    const r = await reconhecerFranquia(tx, empresaId);
    if (r.motivo === 'SEM_LIMITE') return { ...await concederFranquiaConvites(tx, empresaId), porPlano: false };
    return { concedida: r.concedida, motivo: r.motivo, porPlano: true };
}

export async function manutencaoEmpresa(tx: DbExecutor, empresaId: string, env: Record<string, string | undefined> = process.env) {
    // Antes de expirarVencidos (que já trava a carteira): os avisos inserem notificações, cuja FK pede a empresa.
    await travarEmpresaAntesDaCarteira(tx, empresaId);
    const expirados = { CONVITES: await expirarVencidos(tx, empresaId, 'CONVITES'), WALLE: await expirarVencidos(tx, empresaId, 'WALLE') };
    const franquia = await franquiaDoMes(tx, empresaId, env);
    const avisos = await avisosVencimento(tx, empresaId) + (franquia.porPlano ? await avisosDeUsoFranquia(tx, empresaId) : 0);
    return { expirados, franquia, avisos };
}
