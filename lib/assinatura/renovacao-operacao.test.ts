import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { DbExecutor } from '../db/contracts';
import { alertasRenovacao, renovacoesEmRevisao, type RenovacaoOperacao } from './renovacao-operacao.ts';

/** G4 sem banco: concessão, 075 instalada e linhas simuladas; o SQL real roda só em PostgreSQL descartável. */
const DEV = { usuario_id: '99999999-9999-4999-8999-999999999999' };
function banco(o: { concessao: boolean; instalada?: boolean; linhas?: object[] }) {
    const sqls: string[] = [];
    const tx = {
        async query(sql: string) {
            const s = sql.replace(/\s+/g, ' ').trim(); sqls.push(s);
            const rows = (r: object[]) => ({ rows: r as never[], rowCount: r.length });
            if (s.includes('FROM plataforma_desenvolvedores')) return rows(o.concessao ? [{ id: 'd1' }] : []);
            if (s.startsWith('SELECT to_regclass')) return rows([{ instalada075: o.instalada !== false }]);
            if (s.includes('FROM assinatura_renovacoes r')) return rows(o.linhas ?? []);
            throw new Error(`SQL inesperado: ${s.slice(0, 80)}`);
        },
    } as unknown as DbExecutor;
    return { tx, sqls };
}
const linha = (o: Record<string, unknown> = {}) => ({
    id: '44444444-4444-4444-8444-444444444444', empresa_id: '11111111-1111-4111-8111-111111111111', empresa: 'Buffet A', estado: 'REVISAO',
    ultimo_erro: 'ENTREGA_RECUSADA', primeira_data_regular: '2027-10-09', aviso_enviado: true, atualizada_em: '2026-10-10T12:00:00Z', total: 2, ...o,
});

test('sem concessão de desenvolvedor: 404 genérico e nenhuma leitura de renovação', async () => {
    const b = banco({ concessao: false, linhas: [linha()] });
    await assert.rejects(renovacoesEmRevisao(b.tx, DEV), (e: { httpStatus?: number; message: string }) => e.httpStatus === 404 && e.message === 'Recurso não encontrado.');
    assert.equal(b.sqls.length, 1);
    assert.match(b.sqls[0], /FROM plataforma_desenvolvedores .* FOR SHARE OF d/);
});

test('formato da saída: campos mínimos, sem destinatário, e-mail, mensagem, chave ou id externo', async () => {
    const b = banco({ concessao: true, linhas: [linha(), linha({ id: '55555555-5555-4555-8555-555555555555', estado: 'AVISANDO', ultimo_erro: 'ENVIO_INCERTO', aviso_enviado: false })] });
    const r = await renovacoesEmRevisao(b.tx, DEV);
    assert.equal(r.instalada, true); assert.equal(r.total, 2);
    assert.deepEqual(Object.keys(r.itens[0]).sort(), ['atualizadaEm', 'avisoEnviado', 'empresa', 'empresaId', 'estado', 'motivo', 'primeiraDataRegular', 'renovacaoId']);
    assert.deepEqual(r.itens[1], { renovacaoId: '55555555-5555-4555-8555-555555555555', empresaId: '11111111-1111-4111-8111-111111111111', empresa: 'Buffet A',
        estado: 'AVISANDO', motivo: 'ENVIO_INCERTO', primeiraDataRegular: '2027-10-09', avisoEnviado: false, atualizadaEm: '2026-10-10T12:00:00Z' });
    const sql = b.sqls.find((s) => s.includes('FROM assinatura_renovacoes r'))!;
    assert.doesNotMatch(sql, /mensagem|destinatario|aviso_id_externo|email|usuarios_administrativos/, 'SQL não lê dado pessoal');
    assert.match(sql, /^SELECT /); assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE)\b/);
    const vazio = await renovacoesEmRevisao(banco({ concessao: true, instalada: false }).tx, DEV);
    assert.deepEqual(vazio, { instalada: false, itens: [], total: 0 });
});

test('alertas do resumo: REVISAO urgente, parada em atenção, link para a situação comercial da empresa', () => {
    const base: RenovacaoOperacao = { renovacaoId: 'r1', empresaId: 'e1', empresa: 'Buffet A', estado: 'REVISAO', motivo: 'JANELA_AVISO_PERDIDA',
        primeiraDataRegular: '2027-10-09', avisoEnviado: false, atualizadaEm: '2026-10-10T12:00:00Z' };
    const [a, b] = alertasRenovacao([base, { ...base, estado: 'APLICANDO', motivo: null }]);
    assert.deepEqual([a.codigo, a.severidade, b.severidade], ['RENOVACAO_REVISAO', 'ALTA', 'MEDIA']);
    assert.match(a.detalhe, /JANELA_AVISO_PERDIDA.*Nenhum aumento/);
    assert.equal(a.acao?.href, '/desenvolvedor/empresas/e1#t-comercial');
});

test('rota GET usa a guarda do painel; resumo soma os alertas depois da concessão', () => {
    const rota = readFileSync('app/api/desenvolvedor/renovacoes/route.ts', 'utf8');
    assert.match(rota, /return rotaDesenvolvedor\(request,/); assert.doesNotMatch(rota, /export async function (POST|PUT|PATCH|DELETE)/);
    const resumo = readFileSync('lib/desenvolvedor/resumo.ts', 'utf8');
    const corpo = resumo.slice(resumo.indexOf('export async function resumoPainel('));
    assert.ok(corpo.indexOf('await exigirDesenvolvedorNaTransacao(tx, sessao);') < corpo.indexOf('await lerRenovacoesOperacao(tx)'));
});
