import { createHash } from 'node:crypto';

const statuses = ['enqueued', 'failed', 'sent', 'delivered', 'read'] as const;
type Status = typeof statuses[number];
export type EventoSanitizado = {
    eventType: 'message-event' | 'message' | 'user-event' | 'unknown';
    status: Status | 'received' | 'ignored' | 'sandbox-start';
    timestamp: number;
    messageIdHash?: string;
    destinationMasked?: string;
    failureCode?: number | string;
    failureReason?: string;
};

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shortString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function sanitizeFailureReason(value: unknown, sensitiveValues: readonly string[]): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalize = (text: string) => text.normalize('NFKC')
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
    let reason = normalize(value);
    // Redact before truncation, including known credentials/IDs echoed by the sender.
    for (const sensitive of sensitiveValues) {
        const normalized = normalize(sensitive);
        if (normalized) reason = reason.split(normalized).join('[REDACTED]');
    }
    // Do not echo serialized payloads, encoded data, headers or credential-like text.
    if (/[{}\\%]/u.test(reason)
        || /(?:^|[^\p{L}\p{N}])(?:api[-_ ]?key|webhook[-_ ]?secret|secret|password|senha|token|otp|authorization|bearer|cookies?|headers?|credentials?)(?:$|[^\p{L}\p{N}])/iu.test(reason)
        || /\bsk[_-]/iu.test(reason)) return '[REDACTED]';
    reason = reason
        .replace(/(?:https?:\/\/|www\.)\S+|(?<!\S)\S+@\S+/giu, '[REDACTED]')
        .replace(/\+?\d(?:[\s().+-]*\d){3,}/gu, '[REDACTED]')
        .replace(/[\p{L}\p{N}_+/=-]{24,}/gu, '[REDACTED]');
    return reason.slice(0, 300).trim() || undefined;
}

function failureDetails(value: unknown, sensitiveValues: readonly string[]): Pick<EventoSanitizado, 'failureCode' | 'failureReason'> {
    if (!object(value)) return {};
    const { code } = value;
    // Error codes are short numbers/identifiers, never arbitrary diagnostic text.
    const numericCode = typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 999999;
    const stringCode = typeof code === 'string' && !sensitiveValues.includes(code)
        && (/^\d{1,6}$/.test(code) || (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(code)
            && sanitizeFailureReason(code, sensitiveValues) === code));
    const failureReason = sanitizeFailureReason(value.reason, sensitiveValues);
    return {
        ...(numericCode || stringCode ? { failureCode: code as number | string } : {}),
        ...(failureReason ? { failureReason } : {}),
    };
}

/** Pure projection: only bounded, sanitized failure diagnostics may accompany metadata. */
export function parseGupshupV2(value: unknown, sensitiveValues: readonly string[] = []): EventoSanitizado | null {
    if (!object(value) || value.version !== 2 || value.app !== 'KidmaisManager'
        || !Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0
        || !shortString(value.type) || !object(value.payload)) return null;

    const base = { timestamp: value.timestamp as number };
    if (value.type === 'user-event') {
        if (!shortString(value.payload.type)) return null;
        if (value.payload.type === 'sandbox-start') {
            return { ...base, eventType: 'user-event', status: 'sandbox-start' };
        }
    }
    if (value.type !== 'message-event' && value.type !== 'message') {
        return { ...base, eventType: 'unknown', status: 'ignored' };
    }
    const payload = value.payload;
    if (!shortString(payload.type)) return null;
    if (value.type === 'message-event' && !statuses.includes(payload.type as Status)) {
        return { ...base, eventType: 'message-event', status: 'ignored' };
    }
    if (!shortString(payload.id)) return null;
    const destination = payload.destination;
    return {
        ...base,
        eventType: value.type,
        status: value.type === 'message' ? 'received' : payload.type as Status,
        messageIdHash: createHash('sha256').update(payload.id).digest('hex').slice(0, 16),
        // Inbound source/sender are deliberately omitted. Only a masked destination is logged.
        ...(typeof destination === 'string' && /^\+?\d{8,15}$/.test(destination)
            ? { destinationMasked: `***${destination.slice(-2)}` } : {}),
        ...(value.type === 'message-event' && payload.type === 'failed'
            ? failureDetails(payload.payload, [...sensitiveValues, payload.id,
                ...(typeof payload.gsId === 'string' ? [payload.gsId] : []),
                ...(typeof destination === 'string' ? [destination] : [])]) : {}),
    };
}

/** Form support: envelope fields + JSON payload, or a single `message` JSON envelope. */
export function decodeGupshupBody(text: string, contentType: string): unknown {
    if (contentType === 'application/json') return JSON.parse(text);
    const form = new URLSearchParams(text);
    for (const key of form.keys()) {
        if (form.getAll(key).length !== 1) throw new Error('Ambiguous form');
    }
    if (form.has('message')) {
        if (form.size !== 1) throw new Error('Ambiguous envelope');
        return JSON.parse(form.get('message')!);
    }
    return {
        app: form.get('app'),
        timestamp: /^\d+$/.test(form.get('timestamp') ?? '') ? Number(form.get('timestamp')) : null,
        version: form.get('version') === '2' ? 2 : null,
        type: form.get('type'),
        payload: JSON.parse(form.get('payload') ?? 'null'),
    };
}
