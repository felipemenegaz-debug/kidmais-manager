import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { DbExecutor } from '../db/contracts';
import { alertasRenovacao, ehFixtureHomologacao, renovacoesEmRevisao, type RenovacaoOperacao } from './renovacao-operacao.ts';

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
    id: '44444444-4444-4444-8444-444444444444', empresa_id: '11111111-1111-4111-8111-111111111111', empresa: 'Buffet A', empresa_codigo: 'buffet-a', empresa_status: 'ATIVA',
    estado: 'REVISAO', ultimo_erro: 'ENTREGA_RECUSADA', primeira_data_regular: '2027-10-09', aviso_enviado: true, atualizada_em: '2026-10-10T12:00:00Z', total: 2, ...o,
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
    assert.deepEqual(Object.keys(r.itens[0]).sort(), ['atualizadaEm', 'avisoEnviado', 'empresa', 'empresaId', 'empresaStatus', 'estado', 'fixtureHomologacao', 'motivo', 'primeiraDataRegular', 'renovacaoId']);
    assert.deepEqual(r.itens[1], { renovacaoId: '55555555-5555-4555-8555-555555555555', empresaId: '11111111-1111-4111-8111-111111111111', empresa: 'Buffet A',
        empresaStatus: 'ATIVA', fixtureHomologacao: false, estado: 'AVISANDO', motivo: 'ENVIO_INCERTO', primeiraDataRegular: '2027-10-09', avisoEnviado: false, atualizadaEm: '2026-10-10T12:00:00Z' });
    const sql = b.sqls.find((s) => s.includes('FROM assinatura_renovacoes r'))!;
    assert.doesNotMatch(sql, /mensagem|destinatario|aviso_id_externo|email|usuarios_administrativos/, 'SQL não lê dado pessoal');
    assert.doesNotMatch(JSON.stringify(r), /buffet-a/, 'o código da empresa só serve para classificar, não sai na resposta');
    assert.match(sql, /^SELECT /); assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE)\b/);
    const vazio = await renovacoesEmRevisao(banco({ concessao: true, instalada: false }).tx, DEV);
    assert.deepEqual(vazio, { instalada: false, itens: [], total: 0 });
});

test('alertas do resumo: REVISAO urgente, parada em atenção, link para a situação comercial da empresa', () => {
    const base: RenovacaoOperacao = { renovacaoId: 'r1', empresaId: 'e1', empresa: 'Buffet A', empresaStatus: 'ATIVA', fixtureHomologacao: false, estado: 'REVISAO', motivo: 'JANELA_AVISO_PERDIDA',
        primeiraDataRegular: '2027-10-09', avisoEnviado: false, atualizadaEm: '2026-10-10T12:00:00Z' };
    const [a, b] = alertasRenovacao([base, { ...base, estado: 'APLICANDO', motivo: null }]);
    assert.deepEqual([a.codigo, a.severidade, b.severidade], ['RENOVACAO_REVISAO', 'ALTA', 'MEDIA']);
    assert.match(a.detalhe, /JANELA_AVISO_PERDIDA.*Nenhum aumento/);
    assert.equal(a.acao?.href, '/desenvolvedor/empresas/e1#t-comercial');
    assert.equal(a.titulo, 'Renovação Fundador em revisão');
});

test('fixture de homologação: exige código hml- E nome "TESTE " (conservador, nunca rebaixa cliente real)', () => {
    const casos: [string | null, string | null, boolean][] = [
        ['hml-pr-essencial', 'TESTE Kidmais — pagamento e renovação staging 20261010 r3 F1', true],
        ['hml-fundador-premium', 'TESTE Kidmais — Fundador staging 20261010 r2 FM', true],
        ['hml-renovacao-falha', 'TESTE Kidmais — Renovação staging 20261010 r1 RF', true],
        ['hmlbuffet', 'TESTE Kidmais — x', false], // começa com "hml" mas sem o hífen
        ['hml-buffet-real', 'Buffet Hml Festas', false], // empresa real com código hml-: nome não é TESTE
        ['hml-x', 'teste minúsculo', false], ['hml-x', 'TESTEKidmais', false], ['HML-x', 'TESTE Kidmais — x', false],
        ['buffet-a', 'TESTE Kidmais — nome sem código sintético', false],
        ['nav-essencial', 'Buffet Sintético Essencial (TESTE navegador)', false], ['nav-teste', 'TESTE x', false],
        [null, 'TESTE Kidmais — x', false], ['hml-x', null, false], ['', '', false],
    ];
    for (const [codigo, nome, esperado] of casos) assert.equal(ehFixtureHomologacao({ codigo, nome }), esperado, `${codigo} / ${nome}`);
});

test('desativadas e fixtures seguem visíveis e distinguidas: reais antes de fixtures, sem filtro por status', async () => {
    const fixture = linha({ id: 'f1', empresa_id: 'ef', empresa: 'TESTE Kidmais — Renovação staging 20261010 r1 RF', empresa_codigo: 'hml-renovacao-falha', empresa_status: 'DESATIVADA' });
    const desativada = linha({ id: 'd1', empresa_id: 'ed', empresa: 'Buffet Antigo', empresa_codigo: 'buffet-antigo', empresa_status: 'DESATIVADA' });
    const hmlReal = linha({ id: 'h1', empresa_id: 'eh', empresa: 'Buffet Hml', empresa_codigo: 'hml-buffet', estado: 'APLICANDO', ultimo_erro: null });
    // O SQL já põe fixtures por último; o sort estável no código garante o mesmo mesmo se as linhas vierem misturadas.
    const b = banco({ concessao: true, linhas: [fixture, linha(), desativada, hmlReal] });
    const r = await renovacoesEmRevisao(b.tx, DEV);
    assert.deepEqual(r.itens.map((i) => `${i.renovacaoId}:${i.empresaStatus}:${i.fixtureHomologacao}`),
        ['44444444-4444-4444-8444-444444444444:ATIVA:false', 'd1:DESATIVADA:false', 'h1:ATIVA:false', 'f1:DESATIVADA:true']);
    const sql = b.sqls.find((s) => s.includes('FROM assinatura_renovacoes r'))!;
    assert.doesNotMatch(sql, /e\.status\s*(=|<>|!=|IN)/, 'nenhum filtro por status da empresa');
    assert.ok(sql.includes("ORDER BY ((left(e.codigo, 4) = 'hml-') AND left(e.nome, 6) = 'TESTE ') IS TRUE, (r.estado = 'REVISAO') DESC"), 'fixtures por último antes do LIMIT');

    const al = alertasRenovacao(r.itens);
    assert.deepEqual(al.map((a) => [a.severidade, a.titulo]), [
        ['ALTA', 'Renovação Fundador em revisão'],
        ['MEDIA', 'Renovação Fundador em revisão (empresa desativada)'],
        ['MEDIA', 'Renovação Fundador parada'],
        ['INFO', 'Renovação Fundador em revisão (fixture de homologação, desativada)'],
    ]);
    const ativaFixture = alertasRenovacao([{ ...r.itens[3], empresaStatus: 'ATIVA' }])[0];
    assert.deepEqual([ativaFixture.severidade, ativaFixture.titulo], ['INFO', 'Renovação Fundador em revisão (fixture de homologação)']);
    assert.ok(al.every((a) => a.acao?.href === `/desenvolvedor/empresas/${a.empresaId}#t-comercial`));
});

test('rota GET usa a guarda do painel; resumo soma os alertas depois da concessão', () => {
    const rota = readFileSync('app/api/desenvolvedor/renovacoes/route.ts', 'utf8');
    assert.match(rota, /return rotaDesenvolvedor\(request,/); assert.doesNotMatch(rota, /export async function (POST|PUT|PATCH|DELETE)/);
    const resumo = readFileSync('lib/desenvolvedor/resumo.ts', 'utf8');
    const corpo = resumo.slice(resumo.indexOf('export async function resumoPainel('));
    assert.ok(corpo.indexOf('await exigirDesenvolvedorNaTransacao(tx, sessao);') < corpo.indexOf('await lerRenovacoesOperacao(tx)'));
});
