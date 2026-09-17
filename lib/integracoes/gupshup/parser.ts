import { createHash } from 'node:crypto';

const statuses = ['enqueued', 'failed', 'sent', 'delivered', 'read'] as const;
type Status = typeof statuses[number];
export type EventoSanitizado = {
    eventType: 'message-event' | 'message' | 'user-event' | 'unknown';
    status: Status | 'received' | 'ignored' | 'sandbox-start';
    timestamp: number;
    messageIdHash?: string;
    destinationMasked?: string;
};

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shortString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

/** Pure projection: never returns message bodies, names, URLs or error reasons. */
export function parseGupshupV2(value: unknown): EventoSanitizado | null {
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
