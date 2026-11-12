import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { DbExecutor } from '../db/contracts';
import { registrarAvisosDaTransicao, registrarDevolucaoAviso } from './avisos-repositorio.ts';
import { registrarFalhaEntrega } from './renovacao-entrega.ts';

/**
 * Gancho da sincronização e devolução (087) com banco EM MEMÓRIA que entende só o SQL destes módulos: UNIQUE do evento,
 * SAVEPOINT e falha injetável no INSERT. Nenhum banco real; dados sintéticos.
 */
const E = '11111111-1111-4111-8111-111111111111';
const G = '33333333-3333-4333-8333-333333333333';
const LIGADO = { ASSINATURA_AVISOS_EMAIL: 'ligado' };
const ANTES = { situacao: 'TESTE' as const, periodoAtualFim: null, canceladaEm: null, encerradaEm: null };
const DEPOIS = { situacao: 'ATIVA' as const, periodoAtualFim: '2026-11-29T03:00:00.000Z', canceladaEm: null, encerradaEm: null };

type Aviso = { id: string; empresa_id: string; tipo: string; marco: string; destinatario_id: string; mensagem: string; estado: string; id_externo: string | null; ultimo_erro: string | null };
function banco(o: { instalada?: boolean; falharInsert?: boolean; avisos?: Aviso[] } = {}) {
    const sqls: string[] = [], avisos: Aviso[] = o.avisos ?? [], auditoria: unknown[][] = [];
    const tx = {
        async query(sql: string, p: readonly unknown[] = []) {
            const s = sql.replace(/\s+/g, ' ').trim(); sqls.push(s);
            const rows = (r: object[]) => ({ rows: r as never[], rowCount: r.length });
            if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) kidmais_avisos_assinatura$/.test(s)) return rows([]);
            if (s.includes('instalada087')) return rows([{ instalada087: o.instalada !== false }]);
            if (s.includes('instalada075')) return rows([{ instalada075: false }]);
            if (s.startsWith('SELECT nome, (status')) return rows([{ nome: 'Buffet Sintético', ativa: true }]);
            if (s.includes('clock_timestamp()') && s.includes('AS agora')) return rows([{ agora: '2026-10-29T12:00:00.000Z' }]);
            if (s.includes("to_regclass('public.empresa_assinaturas') IS NOT NULL AS ok")) return rows([{ ok: true }]);
            if (s.includes('instalado074')) return rows([{ instalado074: false }]);
            if (s.startsWith('SELECT situacao, ciclo')) return rows([{ situacao: 'ATIVA', ciclo: 'MENSAL', teste_inicio: '2026-10-14T03:00:00.000Z', teste_fim: '2026-10-29T03:00:00.000Z',
                periodo_atual_fim: DEPOIS.periodoAtualFim, em_atraso_desde: null, encerrada_em: null, versao: 2 }]);
            if (s.startsWith('SELECT id, tipo, to_char(valida_ate')) return rows([]);
            if (s.startsWith('SELECT u.id::text AS id, u.email FROM memberships')) return rows([{ id: G, email: 'gestao@example.invalid' }]);
            if (s.startsWith('INSERT INTO assinatura_avisos')) {
                if (o.falharInsert) throw new Error('violação sintética');
                if (avisos.some((a) => a.empresa_id === p[1] && a.tipo === p[2] && a.marco === p[3] && a.destinatario_id === p[4])) return rows([]);
                avisos.push({ id: String(p[0]), empresa_id: String(p[1]), tipo: String(p[2]), marco: String(p[3]), destinatario_id: String(p[4]), mensagem: String(p[5]), estado: 'PENDENTE', id_externo: null, ultimo_erro: null });
                return rows([{ id: p[0] }]);
            }
            if (s.startsWith('SELECT id::text AS id, empresa_id::text AS "empresaId", estado, tipo FROM assinatura_avisos WHERE id_externo'))
                return rows(avisos.filter((a) => a.id_externo === p[0]).slice(0, 2).map((a) => ({ id: a.id, empresaId: a.empresa_id, estado: a.estado, tipo: a.tipo })));
            if (s.startsWith("UPDATE assinatura_avisos SET estado = 'DEVOLVIDO'")) {
                const a = avisos.find((x) => x.id === p[0] && x.estado === 'ENVIADO');
                if (!a) return rows([]);
                a.estado = 'DEVOLVIDO'; a.ultimo_erro = String(p[1]);
                return rows([{ id: a.id }]);
            }
            if (s.startsWith('INSERT INTO auditoria')) { auditoria.push([...p]); return rows([]); }
            throw new Error(`SQL inesperado: ${s.slice(0, 90)}`);
        },
    } as unknown as DbExecutor;
    return { tx, sqls, avisos, auditoria };
}
const opcoes = (env: Record<string, string> = LIGADO) => ({ env, origem: () => 'https://manager.example', gerarId: () => '55555555-5555-4555-8555-555555555555' });

test('desligado (padrão): nenhuma consulta, nenhum aviso — a sincronização fica exatamente como antes', async () => {
    const b = banco();
    assert.equal(await registrarAvisosDaTransicao(b.tx, E, ANTES, DEPOIS, opcoes({})), 0);
    assert.deepEqual(b.sqls, []);
});

test('pagamento confirmado: intenção gravada uma vez na transação; reentrega/reconciliação com a mesma transição não duplica', async () => {
    const b = banco();
    assert.equal(await registrarAvisosDaTransicao(b.tx, E, ANTES, DEPOIS, opcoes()), 1);
    assert.equal(await registrarAvisosDaTransicao(b.tx, E, ANTES, DEPOIS, { ...opcoes(), gerarId: () => '66666666-6666-4666-8666-666666666666' }), 0);
    assert.equal(b.avisos.length, 1);
    assert.deepEqual([b.avisos[0].tipo, b.avisos[0].marco, b.avisos[0].destinatario_id], ['PAGAMENTO_CONFIRMADO', DEPOIS.periodoAtualFim, G]);
    const m = JSON.parse(b.avisos[0].mensagem);
    assert.equal(m.idempotencia, 'kidmais-aviso-assinatura/55555555-5555-4555-8555-555555555555');
    assert.equal(b.sqls[0], 'SAVEPOINT kidmais_avisos_assinatura');
    assert.equal(b.sqls.at(-1), 'RELEASE SAVEPOINT kidmais_avisos_assinatura');
    assert.ok(!b.sqls.some((s) => s.startsWith('ROLLBACK')));
});

test('sem transição relevante ou sem a 087: só o SAVEPOINT, nada gravado', async () => {
    const b = banco();
    assert.equal(await registrarAvisosDaTransicao(b.tx, E, DEPOIS, DEPOIS, opcoes()), 0);
    assert.deepEqual(b.sqls, ['SAVEPOINT kidmais_avisos_assinatura', 'RELEASE SAVEPOINT kidmais_avisos_assinatura']);
    const c = banco({ instalada: false });
    assert.equal(await registrarAvisosDaTransicao(c.tx, E, ANTES, DEPOIS, opcoes()), 0);
    assert.equal(c.avisos.length, 0);
});

test('falha ao gravar o aviso NUNCA derruba a sincronização: SAVEPOINT desfeito e resultado 0', async () => {
    const b = banco({ falharInsert: true });
    const aviso = console.warn; const avisosLog: unknown[][] = []; console.warn = (...a: unknown[]) => { avisosLog.push(a); };
    try {
        assert.equal(await registrarAvisosDaTransicao(b.tx, E, ANTES, DEPOIS, opcoes()), 0);
        assert.equal(await registrarAvisosDaTransicao(b.tx, E, ANTES, DEPOIS, { ...opcoes(), origem: () => { throw new Error('origem ausente'); } }), 0);
        assert.equal(await registrarAvisosDaTransicao(b.tx, E, ANTES, DEPOIS, opcoes({ ...LIGADO, ASSINATURA_REGULARIZACAO_DIAS: 'x' })), 0);
    }
    finally { console.warn = aviso; }
    assert.equal(b.sqls.filter((s) => s === 'ROLLBACK TO SAVEPOINT kidmais_avisos_assinatura').length, 3);
    assert.ok(avisosLog.every((a) => !JSON.stringify(a).includes('example.invalid')), 'log sem e-mail');
});

test('sincronizarEmpresa chama o gancho só no ramo que GRAVA a transição, depois do UPDATE e da auditoria', () => {
    const fonte = readFileSync('lib/assinatura/sincronizacao.ts', 'utf8').replace(/\r\n/g, '\n');
    // Production: `if (alvo.mudou || oferta) {`; staging (B-14): `const gravou = (alvo.mudou || oferta) && (await tx.query(UPDATE…))` + `if (gravou) {`.
    const ramo = Math.max(fonte.indexOf('if (alvo.mudou || oferta) {'), fonte.indexOf('const gravou = (alvo.mudou || oferta)'));
    const update = fonte.indexOf('UPDATE empresa_assinaturas SET situacao = $2', ramo);
    const auditoria = fonte.indexOf("acao: 'ASSINATURA_SINCRONIZADA'", update);
    const gancho = fonte.indexOf('await registrarAvisosDaTransicao(tx, empresaId,', auditoria);
    const senao = fonte.indexOf('else {', ramo);
    assert.ok(ramo > 0 && update > ramo && auditoria > update && gancho > auditoria && gancho < senao);
    assert.equal(fonte.split('registrarAvisosDaTransicao(').length - 1, 1);
});

test('devolução (bounce do Resend): ENVIADO → DEVOLVIDO, idempotente e auditada sem e-mail; renovação continua com prioridade', async () => {
    const enviado = (o: Partial<Aviso> = {}): Aviso => ({ id: '77777777-7777-4777-8777-777777777777', empresa_id: E, tipo: 'SOMENTE_LEITURA', marco: 'x', destinatario_id: G,
        mensagem: '{}', estado: 'ENVIADO', id_externo: 'email_9', ultimo_erro: null, ...o });
    const b = banco({ avisos: [enviado()] });
    const entrada = { idExterno: 'email_9', motivo: 'ENTREGA_RECUSADA', eventoId: 'msg_1' };
    assert.equal(await registrarFalhaEntrega(b.tx, entrada), 'AVISO_DEVOLVIDO');
    assert.equal(b.avisos[0].estado, 'DEVOLVIDO');
    assert.equal(await registrarFalhaEntrega(b.tx, entrada), 'AVISO_JA_DEVOLVIDO');
    assert.equal(b.auditoria.length, 1);
    assert.ok(!JSON.stringify(b.auditoria).includes('example.invalid'));
    assert.equal(await registrarFalhaEntrega(b.tx, { ...entrada, idExterno: 'email_outro' }), 'NAO_INSTALADA', 'id desconhecido: resultado anterior');
    assert.equal(await registrarDevolucaoAviso(banco({ avisos: [enviado({ estado: 'ENVIANDO' })] }).tx, entrada), 'AVISO_NAO_ELEGIVEL');
    assert.equal(await registrarDevolucaoAviso(banco({ instalada: false }).tx, entrada), 'DESCONHECIDO');
    assert.equal(await registrarDevolucaoAviso(banco({ avisos: [enviado(), enviado({ id: '88888888-8888-4888-8888-888888888888' })] }).tx, entrada), 'AMBIGUO');
});
