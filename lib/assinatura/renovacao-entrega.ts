/**
 * G3 — falha de entrega do aviso de renovação Fundador, informada pelo webhook do Resend.
 * Rota pública: app/api/integracoes/resend/webhook/route.ts.
 *
 *   1. RESEND_WEBHOOK_SECRET ausente ou fora do formato `whsec_<base64>` → 503, nada é lido nem gravado;
 *   2. corpo ≤ 64 KB (mesmo leitor do webhook do Asaas); assinatura Svix (`svix-id`, `svix-timestamp`,
 *      `svix-signature`, HMAC-SHA256 de `id.timestamp.corpo`) conferida em tempo constante, com tolerância de 5 min
 *      no carimbo → senão 401, sem tocar no banco;
 *   3. só `email.bounced`, `email.complained` e `email.failed` mudam estado; qualquer outro tipo (inclusive
 *      `email.delivery_delayed`, transitório: o próprio Resend continua tentando) é reconhecido com 200 e ignorado;
 *   4. o aviso é localizado pelo identificador externo gravado (`assinatura_renovacoes.aviso_id_externo`) e só
 *      `AVISADA → REVISAO` é feito (transição já permitida pela 075), com `ultimo_erro` = motivo. Repetição é
 *      idempotente (`JA_EM_REVISAO`); id desconhecido (convites, recuperação de senha, outros envios) é 200 sem efeito.
 * Mesma trava por empresa do processador (lib/assinatura/cobranca.ts → travaPorEmpresa): se ele está rodando, 503 e o
 * Resend reentrega depois. Com o aviso em REVISAO, a próxima execução do processador suspende a geração em vez de
 * aumentar o preço. Nenhum e-mail, destinatário ou corpo do evento é gravado ou registrado em log.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { CorpoInvalido, lerCorpoLimitado } from './webhook-asaas.ts';
import { auditarCobranca } from './sincronizacao-auditoria.ts';
import { renovacaoInstalada } from './renovacao-repositorio.ts';

export const TOLERANCIA_ASSINATURA_S = 300;
/** Tipo do evento do Resend → `ultimo_erro` (CHECK da 075: ^[A-Z0-9_]{1,80}$). */
export const EVENTOS_FALHA_ENTREGA: ReadonlyMap<string, string> = new Map([
    ['email.bounced', 'ENTREGA_RECUSADA'],
    ['email.complained', 'ENTREGA_RECLAMADA'],
    ['email.failed', 'ENTREGA_FALHOU'],
]);

export type ResultadoFalhaEntrega = 'REVISAO_REGISTRADA' | 'JA_EM_REVISAO' | 'ESTADO_NAO_ELEGIVEL' | 'DESCONHECIDO' | 'AMBIGUO' | 'OCUPADO' | 'NAO_INSTALADA';
export type DepsWebhookResend = {
    env: Record<string, string | undefined>;
    withTransaction: <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
    /** Relógio (ms) para a tolerância do carimbo; padrão Date.now. */
    agora?: () => number;
};

/** Chave HMAC a partir de RESEND_WEBHOOK_SECRET; null = webhook desligado. Nunca devolve nem registra o valor. */
export function chaveWebhookResend(env: Record<string, string | undefined>): Buffer | null {
    const segredo = env.RESEND_WEBHOOK_SECRET?.trim();
    if (!segredo || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(segredo))
        return null;
    const chave = Buffer.from(segredo.slice(6), 'base64');
    return chave.length >= 16 ? chave : null;
}

export function assinaturaResendConfere(chave: Buffer, cabecalhos: { id: string | null; carimbo: string | null; assinatura: string | null }, corpo: string, agoraMs: number) {
    const { id, carimbo, assinatura } = cabecalhos;
    if (!id || !carimbo || !assinatura || id.length > 256 || assinatura.length > 4096 || !/^\d{1,12}$/.test(carimbo))
        return false;
    if (Math.abs(agoraMs / 1000 - Number(carimbo)) > TOLERANCIA_ASSINATURA_S)
        return false;
    const esperada = createHmac('sha256', chave).update(`${id}.${carimbo}.${corpo}`).digest();
    return assinatura.split(' ').some((parte) => {
        const [versao, valor] = parte.split(',', 2);
        if (versao !== 'v1' || !valor)
            return false;
        const recebida = Buffer.from(valor, 'base64');
        return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
    });
}

/**
 * Domínio: registra a falha de entrega do aviso cujo identificador externo é `idExterno`. Só AVISADA → REVISAO.
 * Chamado dentro de uma transação; não confia em nada do evento além do id e do tipo já validados.
 */
export async function registrarFalhaEntrega(tx: DbExecutor, entrada: { idExterno: string; motivo: string; eventoId: string }): Promise<ResultadoFalhaEntrega> {
    if (!await renovacaoInstalada(tx))
        return 'NAO_INSTALADA';
    const achados = (await tx.query<{ id: string; empresaId: string }>(
        'SELECT id, empresa_id AS "empresaId" FROM assinatura_renovacoes WHERE aviso_id_externo = $1 LIMIT 2', [entrada.idExterno])).rows;
    if (achados.length === 0)
        return 'DESCONHECIDO';
    if (achados.length > 1)
        return 'AMBIGUO';
    const { id, empresaId } = achados[0];
    // Mesma trava do processador da renovação (travaPorEmpresa); sem espera: o provedor reentrega.
    if ((await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('kidmais:contratacao'), hashtext($1)) AS ok", [empresaId])).rows[0]?.ok !== true)
        return 'OCUPADO';
    await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId]);
    const atual = (await tx.query<{ estado: string }>(
        'SELECT estado FROM assinatura_renovacoes WHERE id = $1::uuid AND empresa_id = $2::uuid AND aviso_id_externo = $3 FOR UPDATE',
        [id, empresaId, entrada.idExterno])).rows[0];
    if (!atual)
        return 'DESCONHECIDO';
    if (atual.estado === 'REVISAO')
        return 'JA_EM_REVISAO';
    if (atual.estado !== 'AVISADA')
        return 'ESTADO_NAO_ELEGIVEL';
    const r = await tx.query(
        `UPDATE assinatura_renovacoes SET estado = 'REVISAO', ultimo_erro = $3
          WHERE id = $1::uuid AND empresa_id = $2::uuid AND estado = 'AVISADA' RETURNING id`, [id, empresaId, entrada.motivo]);
    if (r.rowCount !== 1)
        return 'ESTADO_NAO_ELEGIVEL';
    await auditarCobranca(tx, {
        acao: 'RENOVACAO_ENTREGA_FALHOU', empresaId, origem: { tipo: 'WEBHOOK', eventoId: entrada.eventoId.slice(0, 120) },
        antes: { estado: 'AVISADA' }, depois: { renovacaoId: id, estado: 'REVISAO', motivo: entrada.motivo },
    });
    return 'REVISAO_REGISTRADA';
}

const resposta = (status: number, corpo?: unknown) => new Response(corpo === undefined ? null : JSON.stringify(corpo), {
    status, headers: { 'Cache-Control': 'no-store', ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
});

export async function receberWebhookResend(request: Request, deps: DepsWebhookResend): Promise<Response> {
    if (request.method !== 'POST')
        return resposta(405);
    const chave = chaveWebhookResend(deps.env);
    if (!chave)
        return resposta(503);
    const cabecalhos = { id: request.headers.get('svix-id'), carimbo: request.headers.get('svix-timestamp'), assinatura: request.headers.get('svix-signature') };
    if (!cabecalhos.id || !cabecalhos.carimbo || !cabecalhos.assinatura)
        return resposta(401);
    let corpo: string;
    try {
        const tipo = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (tipo && tipo !== 'application/json')
            return resposta(415);
        corpo = await lerCorpoLimitado(request);
    }
    catch (error) {
        return resposta(error instanceof CorpoInvalido ? error.status : 400);
    }
    if (!assinaturaResendConfere(chave, cabecalhos, corpo, (deps.agora ?? Date.now)()))
        return resposta(401);
    let evento: { type?: unknown; data?: { email_id?: unknown } | null } | null;
    try {
        evento = JSON.parse(corpo);
    }
    catch {
        return resposta(400);
    }
    if (!evento || typeof evento !== 'object' || typeof evento.type !== 'string')
        return resposta(400);
    const motivo = EVENTOS_FALHA_ENTREGA.get(evento.type);
    if (!motivo)
        return resposta(200, { recebido: true, resultado: 'IGNORADO' });
    const idExterno = evento.data?.email_id;
    if (typeof idExterno !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(idExterno))
        return resposta(400);
    const resultado = await deps.withTransaction((tx) => registrarFalhaEntrega(tx, { idExterno, motivo, eventoId: cabecalhos.id! }));
    if (resultado === 'OCUPADO')
        return resposta(503);
    if (resultado === 'ESTADO_NAO_ELEGIVEL' || resultado === 'AMBIGUO')
        console.warn(`[Resend webhook] falha de entrega de aviso de renovação não aplicada: ${resultado}.`);
    return resposta(200, { recebido: true, resultado });
}
