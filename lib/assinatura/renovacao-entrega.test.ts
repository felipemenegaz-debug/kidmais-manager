import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DbExecutor } from '../db/contracts';
import { assinaturaResendConfere, chaveWebhookResend, receberWebhookResend, registrarFalhaEntrega, TOLERANCIA_ASSINATURA_S } from './renovacao-entrega.ts';

/**
 * G3 sem banco nem rede: banco EM MEMÓRIA que entende só o SQL do módulo e impõe a transição da 075 (AVISADA → REVISAO).
 * Segredo sintético gerado aqui; nenhum valor real.
 */
const CHAVE = Buffer.alloc(24, 7);
const SEGREDO = `whsec_${CHAVE.toString('base64')}`;
const AGORA = 1_791_600_000_000;
const EMP = '11111111-1111-4111-8111-111111111111';
const REG = '44444444-4444-4444-8444-444444444444';

type Linha = { id: string; empresa_id: string; estado: string; ultimo_erro: string | null; aviso_id_externo: string | null };
function banco(linhas: Linha[], opcoes: { instalada?: boolean; ocupado?: boolean } = {}) {
    const auditoria: unknown[][] = [], sqls: string[] = [];
    const tx = {
        async query(sql: string, p: readonly unknown[] = []) {
            const s = sql.replace(/\s+/g, ' ').trim(); sqls.push(s);
            const rows = (r: object[]) => ({ rows: r as never[], rowCount: r.length });
            if (s.startsWith('SELECT to_regclass')) return rows([{ instalada075: opcoes.instalada !== false }]);
            if (s.startsWith('SELECT id, empresa_id AS "empresaId" FROM assinatura_renovacoes WHERE aviso_id_externo'))
                return rows(linhas.filter((l) => l.aviso_id_externo === p[0]).slice(0, 2).map((l) => ({ id: l.id, empresaId: l.empresa_id })));
            if (s.startsWith('SELECT pg_try_advisory_xact_lock')) return rows([{ ok: !opcoes.ocupado }]);
            if (s.startsWith('SELECT id FROM empresas')) return rows([{ id: p[0] }]);
            if (s.startsWith('SELECT estado FROM assinatura_renovacoes'))
                return rows(linhas.filter((l) => l.id === p[0] && l.empresa_id === p[1] && l.aviso_id_externo === p[2]).map((l) => ({ estado: l.estado })));
            if (s.startsWith('UPDATE assinatura_renovacoes')) {
                const l = linhas.find((x) => x.id === p[0] && x.empresa_id === p[1] && x.estado === 'AVISADA');
                if (!l) return rows([]);
                l.estado = 'REVISAO'; l.ultimo_erro = String(p[2]);
                assert.match(l.ultimo_erro, /^[A-Z0-9_]{1,80}$/, 'CHECK da 075');
                return rows([{ id: l.id }]);
            }
            if (s.startsWith('INSERT INTO auditoria')) { auditoria.push([...p]); return rows([]); }
            throw new Error(`SQL inesperado: ${s.slice(0, 80)}`);
        },
    } as unknown as DbExecutor;
    return { tx, auditoria, sqls, withTransaction: async <T>(f: (t: DbExecutor) => Promise<T>) => f(tx) };
}
const aviso = (o: Partial<Linha> = {}): Linha => ({ id: REG, empresa_id: EMP, estado: 'AVISADA', ultimo_erro: null, aviso_id_externo: 'email_1', ...o });

function requisicao(evento: unknown, o: { segredo?: Buffer; carimbo?: number; id?: string; assinatura?: string; corpo?: string } = {}) {
    const corpo = o.corpo ?? JSON.stringify(evento);
    const id = o.id ?? 'msg_1', carimbo = String(o.carimbo ?? AGORA / 1000);
    const assinatura = o.assinatura ?? `v1,${createHmac('sha256', o.segredo ?? CHAVE).update(`${id}.${carimbo}.${corpo}`).digest('base64')}`;
    return new Request('https://kidmais.example/api/integracoes/resend/webhook', {
        method: 'POST', body: corpo, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': carimbo, 'svix-signature': assinatura },
    });
}
const bounce = (id = 'email_1', type = 'email.bounced') => ({ type, created_at: '2026-10-10T12:00:00Z', data: { email_id: id, to: ['gestor@example.invalid'] } });
const env = { RESEND_WEBHOOK_SECRET: SEGREDO };

test('sem RESEND_WEBHOOK_SECRET (ou fora do formato) a rota fica desligada: 503 sem ler o corpo nem tocar no banco', async () => {
    for (const e of [{}, { RESEND_WEBHOOK_SECRET: '' }, { RESEND_WEBHOOK_SECRET: 'segredo-sem-prefixo' }, { RESEND_WEBHOOK_SECRET: 'whsec_curto' }]) {
        const b = banco([aviso()]);
        const r = await receberWebhookResend(requisicao(bounce()), { env: e, withTransaction: b.withTransaction, agora: () => AGORA });
        assert.equal(r.status, 503); assert.deepEqual(b.sqls, []);
    }
    assert.equal(chaveWebhookResend(env)?.equals(CHAVE), true);
});

test('assinatura inválida, ausente, de outro segredo ou carimbo fora da tolerância: 401 e nenhuma consulta', async () => {
    const casos = [
        requisicao(bounce(), { segredo: Buffer.alloc(24, 9) }),
        requisicao(bounce(), { assinatura: 'v1,AAAA' }),
        requisicao(bounce(), { assinatura: '' }),
        requisicao(bounce(), { carimbo: AGORA / 1000 - TOLERANCIA_ASSINATURA_S - 1 }),
        requisicao(bounce(), { carimbo: AGORA / 1000 + TOLERANCIA_ASSINATURA_S + 1 }),
    ];
    // Corpo adulterado depois de assinado.
    const assinado = `v1,${createHmac('sha256', CHAVE).update(`msg_1.${AGORA / 1000}.${JSON.stringify(bounce())}`).digest('base64')}`;
    casos.push(requisicao(null, { corpo: JSON.stringify(bounce('email_2')), assinatura: assinado }));
    for (const req of casos) {
        const b = banco([aviso()]);
        const r = await receberWebhookResend(req, { env, withTransaction: b.withTransaction, agora: () => AGORA });
        assert.equal(r.status, 401); assert.deepEqual(b.sqls, []);
    }
    assert.equal(assinaturaResendConfere(CHAVE, { id: 'a', carimbo: 'x', assinatura: 'v1,a' }, '{}', AGORA), false);
    // Várias assinaturas (rotação de segredo): basta uma conferir.
    const valida = `v1,${createHmac('sha256', CHAVE).update(`a.${AGORA / 1000}.{}`).digest('base64')}`;
    assert.equal(assinaturaResendConfere(CHAVE, { id: 'a', carimbo: String(AGORA / 1000), assinatura: `v1,AAAA ${valida}` }, '{}', AGORA), true);
});

test('evento desconhecido ou transitório (delivery_delayed, delivered) é reconhecido com 200 sem tocar no banco', async () => {
    for (const type of ['email.delivery_delayed', 'email.delivered', 'email.sent', 'constructor', 'contact.created']) {
        const b = banco([aviso()]);
        const r = await receberWebhookResend(requisicao(bounce('email_1', type)), { env, withTransaction: b.withTransaction, agora: () => AGORA });
        assert.equal(r.status, 200); assert.deepEqual(await r.json(), { recebido: true, resultado: 'IGNORADO' });
        assert.deepEqual(b.sqls, []);
    }
    const b = banco([aviso()]);
    for (const corpo of ['nao-json', '[]', JSON.stringify({ type: 'email.bounced', data: {} }), JSON.stringify({ type: 'email.bounced', data: { email_id: 'x y' } })]) {
        const r = await receberWebhookResend(requisicao(null, { corpo }), { env, withTransaction: b.withTransaction, agora: () => AGORA });
        assert.equal(r.status, 400, corpo);
    }
    assert.deepEqual(b.sqls, []);
});

test('id externo desconhecido (convite, recuperação, outro envio): 200 sem alteração nem auditoria', async () => {
    const b = banco([aviso()]);
    const r = await receberWebhookResend(requisicao(bounce('email_outro')), { env, withTransaction: b.withTransaction, agora: () => AGORA });
    assert.equal(r.status, 200); assert.equal((await r.json()).resultado, 'DESCONHECIDO');
    assert.equal(b.auditoria.length, 0);
    const sem075 = banco([], { instalada: false });
    assert.equal(await registrarFalhaEntrega(sem075.tx, { idExterno: 'email_1', motivo: 'ENTREGA_RECUSADA', eventoId: 'msg' }), 'NAO_INSTALADA');
});

test('bounce move AVISADA → REVISAO com o motivo; repetição é idempotente; reclamação usa motivo próprio', async () => {
    const linhas = [aviso()], b = banco(linhas);
    const r1 = await receberWebhookResend(requisicao(bounce()), { env, withTransaction: b.withTransaction, agora: () => AGORA });
    assert.equal(r1.status, 200); assert.equal((await r1.json()).resultado, 'REVISAO_REGISTRADA');
    assert.deepEqual([linhas[0].estado, linhas[0].ultimo_erro], ['REVISAO', 'ENTREGA_RECUSADA']);
    assert.equal(b.auditoria.length, 1);
    assert.doesNotMatch(JSON.stringify(b.auditoria), /@/, 'auditoria sem destinatário');
    const r2 = await receberWebhookResend(requisicao(bounce(), { id: 'msg_2' }), { env, withTransaction: b.withTransaction, agora: () => AGORA });
    assert.equal((await r2.json()).resultado, 'JA_EM_REVISAO');
    assert.equal(b.auditoria.length, 1, 'repetição não audita de novo');
    assert.equal(linhas[0].ultimo_erro, 'ENTREGA_RECUSADA');

    const outra = [aviso()], c = banco(outra);
    await receberWebhookResend(requisicao(bounce('email_1', 'email.complained')), { env, withTransaction: c.withTransaction, agora: () => AGORA });
    assert.deepEqual([outra[0].estado, outra[0].ultimo_erro], ['REVISAO', 'ENTREGA_RECLAMADA']);
});

test('estado não elegível, id ambíguo e processador em execução não alteram nada; ocupado pede reentrega (503)', async () => {
    for (const estado of ['APLICANDO', 'REGULAR', 'CANCELADA', 'AVISANDO']) {
        const linhas = [aviso({ estado })], b = banco(linhas);
        assert.equal(await registrarFalhaEntrega(b.tx, { idExterno: 'email_1', motivo: 'ENTREGA_RECUSADA', eventoId: 'msg' }), 'ESTADO_NAO_ELEGIVEL');
        assert.equal(linhas[0].estado, estado); assert.equal(b.auditoria.length, 0);
    }
    const dup = banco([aviso(), aviso({ id: '55555555-5555-4555-8555-555555555555' })]);
    assert.equal(await registrarFalhaEntrega(dup.tx, { idExterno: 'email_1', motivo: 'ENTREGA_RECUSADA', eventoId: 'msg' }), 'AMBIGUO');
    const linhas = [aviso()], ocupado = banco(linhas, { ocupado: true });
    const r = await receberWebhookResend(requisicao(bounce()), { env, withTransaction: ocupado.withTransaction, agora: () => AGORA });
    assert.equal(r.status, 503); assert.equal(linhas[0].estado, 'AVISADA');
});

test('rota delega ao domínio, sem SQL próprio, e a 075 permite AVISADA → REVISAO', () => {
    const rota = readFileSync('app/api/integracoes/resend/webhook/route.ts', 'utf8');
    assert.match(rota, /receberWebhookResend/);
    assert.doesNotMatch(rota, /\b(?:SELECT|UPDATE|INSERT)\b/);
    const m075 = readFileSync('database/migrations/20261009_075_renovacao_fundador.sql', 'utf8');
    assert.match(m075, /OLD\.estado = 'AVISADA' AND NEW\.estado IN \('APLICANDO','REVISAO','CANCELADA'\)/);
    assert.match(m075, /aviso_id_externo text/);
});
