/**
 * Webhook do Asaas (E8, sandbox). Rota pública, fora de /api/admin: app/api/integracoes/asaas/webhook/route.ts.
 *
 *   1. cobrança desligada (lib/assinatura/asaas.ts → configuracaoAsaas) → 503 sem gravar nada;
 *   2. limite por IP (limites_autenticacao, namespace próprio) → 429;
 *   3. cabeçalho `asaas-access-token` comparado em tempo constante com ASAAS_WEBHOOK_TOKEN; ausente/errado → 401.
 *      Só se grava a recusa na auditoria, ela mesma limitada por IP; nunca o corpo nem o token recebido;
 *   4. corpo ≤ 64 KB (413), JSON com id e tipo do evento (400);
 *   5. INSERT em cobranca_eventos ON CONFLICT (provedor, evento_id) DO NOTHING — só identificadores — e 200 imediato;
 *   6. o processamento (reconsulta do provedor) é agendado para DEPOIS da resposta (`after` do Next na rota).
 * Fonte: https://docs.asaas.com/docs/sobre-os-webhooks (token fixo no cabeçalho, entrega "ao menos uma vez", só 200 é
 * sucesso, ordem não garantida). Nada aqui confia no conteúdo do evento para mudar estado.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { configuracaoAsaas } from './asaas.ts';
import { extrairEvento, registrarEvento } from './sincronizacao.ts';

export const LIMITE_CORPO = 64 * 1024;
export const CABECALHO_TOKEN = 'asaas-access-token';
const TEMPO_CORPO_MS = 3000;
export const REGRA_IP = { namespace: 'WEBHOOK_ASAAS', janelaSegundos: 60, limite: 300 };
export const REGRA_RECUSA = { namespace: 'WEBHOOK_ASAAS_RECUSA', janelaSegundos: 600, limite: 10 };

export type ConsumirLimite = (tx: DbExecutor, tipo: 'IDENTIFICADOR' | 'ORIGEM', valor: string, regra: { namespace?: string; janelaSegundos: number; limite: number }) => Promise<boolean>;
export type DepsWebhook = {
    env: Record<string, string | undefined>;
    ip: string | null;
    withTransaction: <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
    consumirLimite: ConsumirLimite;
    /** Agenda o processamento para depois da resposta (na rota: `after` do Next). */
    agendar: (eventoInternoId: string) => void;
};

export function tokenConfere(recebido: string | null, esperado: string) {
    if (!recebido || recebido.length > 1024)
        return false;
    const h = (v: string) => createHash('sha256').update(v).digest();
    return timingSafeEqual(h(recebido), h(esperado));
}

class CorpoInvalido extends Error {
    readonly status: number;
    constructor(status: number) {
        super('corpo inválido');
        this.status = status;
    }
}

async function lerCorpoLimitado(request: Request) {
    const tamanho = request.headers.get('content-length');
    if (tamanho !== null && (!/^\d+$/.test(tamanho) || Number(tamanho) > LIMITE_CORPO))
        throw new CorpoInvalido(413);
    if (!request.body)
        throw new CorpoInvalido(400);
    const leitor = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limite = new Promise<never>((_, rejeitar) => { timer = setTimeout(() => rejeitar(new CorpoInvalido(408)), TEMPO_CORPO_MS); });
    const partes: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await Promise.race([leitor.read(), limite]);
            if (done)
                break;
            total += value.byteLength;
            if (total > LIMITE_CORPO)
                throw new CorpoInvalido(413);
            partes.push(value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(partes));
    }
    catch (error) {
        if (error instanceof CorpoInvalido)
            throw error;
        throw new CorpoInvalido(400);
    }
    finally {
        clearTimeout(timer);
        void leitor.cancel().catch(() => undefined);
        leitor.releaseLock();
    }
}

const resposta = (status: number, corpo?: unknown) => new Response(corpo === undefined ? null : JSON.stringify(corpo), {
    status, headers: { 'Cache-Control': 'no-store', ...(corpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
});

export async function receberWebhookAsaas(request: Request, deps: DepsWebhook): Promise<Response> {
    if (request.method !== 'POST')
        return resposta(405);
    const estado = configuracaoAsaas(deps.env);
    if (!estado.ligado)
        return resposta(503);
    const origem = deps.ip ?? 'ORIGEM_NAO_VERIFICADA';
    const recebido = request.headers.get(CABECALHO_TOKEN);
    const valido = tokenConfere(recebido, estado.config.webhookToken);

    // Limite por IP e registro da recusa: só o motivo, o IP (quando conhecido) e um id; nada do corpo ou do token.
    const triagem = await deps.withTransaction(async (tx) => {
        if (!await deps.consumirLimite(tx, 'ORIGEM', origem, REGRA_IP))
            return 429;
        if (valido)
            return 0;
        if (await deps.consumirLimite(tx, 'ORIGEM', origem, REGRA_RECUSA)) {
            await tx.query(
                `INSERT INTO auditoria (ator_tipo, acao, entidade_tipo, entidade_id, dados_depois, origem, request_id, ip)
                 VALUES ('SISTEMA', 'COBRANCA_WEBHOOK_RECUSADO', 'COBRANCA_WEBHOOK', $1::uuid, $2::jsonb, 'COBRANCA', $1::uuid, $3::inet)`,
                [randomUUID(), JSON.stringify({ provedor: 'ASAAS', motivo: recebido ? 'TOKEN_INVALIDO' : 'TOKEN_AUSENTE' }), deps.ip]);
        }
        return 401;
    });
    if (triagem)
        return resposta(triagem);

    let evento;
    try {
        const tipo = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (tipo && tipo !== 'application/json')
            return resposta(415);
        evento = extrairEvento(JSON.parse(await lerCorpoLimitado(request)));
    }
    catch (error) {
        return resposta(error instanceof CorpoInvalido ? error.status : 400);
    }
    if (!evento)
        return resposta(400);
    const gravado = await deps.withTransaction((tx) => registrarEvento(tx, evento));
    if (gravado.pendente)
        deps.agendar(gravado.id);
    return resposta(200, { recebido: true, duplicado: gravado.duplicado });
}
