import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeGupshupBody, parseGupshupV2 } from './parser.ts';
import type { EventoSanitizado } from './parser.ts';

export const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 3000;
export const SECRET_HEADER = 'X-Kidmais-Webhook-Secret';
type Environment = { GUPSHUP_WEBHOOK_SECRET?: string; KIDMAIS_DEPLOY_ENV?: string; RENDER?: string };

export function secretMatches(received: string | null, expected: string): boolean {
    if (!received || received.length > 1024 || received.includes(',')) return false;
    const hash = (value: string) => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(received), hash(expected));
}

class BodyError extends Error {
    status: number;
    constructor(status: number) { super('Invalid body'); this.status = status; }
}

async function readLimitedBody(request: Request): Promise<string> {
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
        throw new BodyError(413);
    }
    if (!request.body) throw new BodyError(400);
    const reader = request.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BodyError(408)), BODY_TIMEOUT_MS);
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await Promise.race([reader.read(), timeout]);
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) throw new BodyError(413);
            chunks.push(value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
        clearTimeout(timer);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

const response = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

/** No database, provider calls, OTP, cookies or administrative session dependencies. */
export async function receiveGupshupWebhook(
    request: Request,
    env: Environment,
    scheduleLog: (event: EventoSanitizado) => void,
): Promise<Response> {
    if (request.method !== 'POST') return response(405);
    const secret = env.GUPSHUP_WEBHOOK_SECRET;
    if (!['staging', 'production'].includes(env.KIDMAIS_DEPLOY_ENV ?? '') || !secret || !/^[\x21-\x7e]{32,1024}$/.test(secret)
        || secret.includes(',')) return response(503);
    // Forwarded proto is trusted only behind Render, with the deployment environment checked above.
    const https = env.RENDER === 'true'
        ? request.headers.get('x-forwarded-proto') === 'https'
        : new URL(request.url).protocol === 'https:';
    if (!https) return response(403);
    const receivedSecret = request.headers.get(SECRET_HEADER);
    // A supplied but invalid header must never fall back to the public handshake.
    if (receivedSecret !== null && !secretMatches(receivedSecret, secret)) return response(401);

    const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded') return response(415);
    if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') return response(415);
    let event: EventoSanitizado | null;
    try {
        event = parseGupshupV2(decodeGupshupBody(await readLimitedBody(request), contentType), [secret]);
    } catch (error) {
        return response(error instanceof BodyError ? error.status : 400);
    }
    if (!event) return response(400);
    // Callback setup may send sandbox-start without custom headers. Only this fully
    // validated handshake may omit the header in either explicitly allowed environment.
    if (receivedSecret === null && !(event.eventType === 'user-event' && event.status === 'sandbox-start')) {
        return response(401);
    }
    // Only a small sanitized projection crosses into after-response logging.
    scheduleLog(event);
    return response(204);
}
