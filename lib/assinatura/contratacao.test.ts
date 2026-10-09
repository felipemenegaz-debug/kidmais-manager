import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AsaasFalhou } from './asaas.ts';
import { resultadoIncerto } from './cobranca.ts';
import { extrairEvento } from './sincronizacao.ts';
import { decidirCompensacao } from './compensacao.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

test('resultado da criação: só 4xx definitivo é "não criado"; tempo, rede, 5xx, 408/409/429 e resposta ilegível são incertos', () => {
    assert.equal(resultadoIncerto(new AsaasFalhou('criar assinatura', 400, 'HTTP')), false);
    assert.equal(resultadoIncerto(new AsaasFalhou('criar assinatura', 401, 'HTTP')), false);
    for (const [status, motivo] of [[null, 'TEMPO_ESGOTADO'], [null, 'REDE'], [500, 'HTTP'], [503, 'HTTP'], [408, 'HTTP'], [409, 'HTTP'], [429, 'HTTP'], [200, 'RESPOSTA_INVALIDA']] as const)
        assert.equal(resultadoIncerto(new AsaasFalhou('criar assinatura', status, motivo)), true, `${status} ${motivo}`);
    assert.equal(resultadoIncerto(new Error('outro')), false);
});

test('pendências internas não entram pelo webhook: tipo e prefixo reservados são recusados', () => {
    const base = { dateCreated: '2026-10-07 10:00:00', subscription: { id: 'sub_1', externalReference: '11111111-1111-4111-8111-111111111111' } };
    assert.ok(extrairEvento({ ...base, id: 'evt_1', event: 'SUBSCRIPTION_UPDATED' }));
    assert.equal(extrairEvento({ ...base, id: 'evt_2', event: 'KIDMAIS_RECONCILIAR_CONTRATACAO' }), null);
    assert.equal(extrairEvento({ ...base, id: 'kidmais:contratacao:x', event: 'SUBSCRIPTION_UPDATED' }), null);
});

test('nenhuma exclusão automática sem vínculo confirmado; falha de compensação vira pendência (nunca .catch vazio)', () => {
    const fonte = readFileSync('lib/assinatura/cobranca.ts', 'utf8');
    assert.doesNotMatch(fonte, /removerAssinatura\([^)]*\)\.catch\(\(\) => undefined\)/, 'compensação silenciosa removida');
    const resolver = fonte.slice(fonte.indexOf('async function resolverFalhaNoVinculo('), fonte.indexOf('export async function cancelarAssinatura'));
    // Toda exclusão automática passa pela decisão central: só depois de decidirCompensacao(...) devolver excluir.
    assert.match(resolver, /decidirCompensacao\(provedor, \{ empresaId, vinculo, vinculoAnterior, candidataId: b\.assinatura\.id \}\)[\s\S]*if \(decisao\?\.excluir\) \{\s*await compensarComMarcador\(deps, provedor, empresaId, b, origem\);\s*throw error;/);
    // Na contratação, nenhuma chamada direta: a exclusão passa por removerComResultado, uma vez, DEPOIS do marcador gravado.
    assert.equal(resolver.match(/removerAssinatura\(/g), null);
    assert.equal(resolver.match(/removerComResultado\(/g)?.length, 1);
    const compensar = resolver.slice(resolver.indexOf('async function compensarComMarcador('));
    // Registro prévio na transação independente (deps.withTransaction): sem marcador confirmado, não há DELETE.
    assert.match(compensar, /const marcador = await persistirMarcadorPrevio\(deps\.withTransaction, empresaId, assinaturaId\);\s*if \(!marcador\) \{\s*await substituirPorPendencia\([^;]*motivo: 'COMPENSACAO_FALHOU' \}\);\s*return;\s*\}\s*const remocao = await removerComResultado\(provedor, assinaturaId\);/,
        'marcador não gravado → não exclui');
    assert.match(compensar, /registrarResultadoRemocao\(deps\.withTransaction, empresaId, marcador, remocao, origem,/);
    const rec = readFileSync('lib/assinatura/reconciliacao-contratacao.ts', 'utf8');
    // Único ponto que chama o provedor para excluir; sem confirmação só com `removida` verdadeiro, 4xx = recusa, o resto = desconhecido.
    assert.equal(rec.match(/removerAssinatura\(/g)?.length, 1);
    assert.match(rec, /return \(await provedor\.removerAssinatura\(assinaturaId\)\)\.removida \? \{ resultado: 'CONFIRMADA' \} : \{ resultado: 'DESCONHECIDA' \};/);
    assert.match(rec, /return remocaoPodeTerOcorrido\(error\) \? \{ resultado: 'DESCONHECIDA' \} : \{ resultado: 'RECUSADA', erro: error \};/);
    // Marcador prévio: só na transação independente (COMMIT próprio), com limite de espera por lock e uma exclusão por assinatura.
    const previo = rec.slice(rec.indexOf('export async function persistirMarcadorPrevio('), rec.indexOf('export async function registrarResultadoRemocao('));
    assert.match(previo, /if \(!independente\)\s*return null;/);
    assert.match(previo, /return await independente\(async \(tx\) => \{\s*await limitesIndependente\(tx\);\s*await tx\.query\("SELECT pg_advisory_xact_lock\(hashtext\('kidmais:remocao'\), hashtext\(\$1\)\)", \[assinaturaId\]\);/);
    assert.match(previo, /catch \{\s*return null;\s*\}/);
    assert.match(rec, /SET LOCAL lock_timeout = '3s'/);
    // Resultado gravado na mesma transação independente: sucesso só em CONFIRMADA; sem confirmação o marcador fica aberto.
    const resultado = rec.slice(rec.indexOf('export async function registrarResultadoRemocao('));
    assert.equal(resultado.slice(0, resultado.indexOf('\nexport ')).match(/ASSINATURA_DUPLICADA_REMOVIDA/g)?.length, 1);
    assert.match(resultado, /if \(remocao\.resultado === 'CONFIRMADA'\) \{\s*await fecharMarcadorRemocao\(tx, empresaId, marcadorId, 'REMOCAO_CONFIRMADA'\);\s*await auditarCobranca\(tx, \{ acao: 'ASSINATURA_DUPLICADA_REMOVIDA'/);
    assert.match(resultado, /else \{\s*await manterMarcadorRemocao\(tx, empresaId, marcadorId\);\s*await auditarCobranca\(tx, \{ acao: 'ASSINATURA_REMOCAO_SEM_CONFIRMACAO'/);
    // Reconciliação: decisão central → marcador prévio confirmado → DELETE; sem marcador, ADIADA (nada excluído).
    assert.match(rec, /if \(semConfirmacao\.has\(d\.id\)\) \{[\s\S]*?continue;\s*\}\s*const decisao = await decidirCompensacao\([\s\S]*if \(!decisao\.excluir\) \{[\s\S]*continue;\s*\}[\s\S]*?const marcadorId = await persistirMarcadorPrevio\(independente, empresaId, d\.id\);\s*if \(!marcadorId\)\s*return \{ resultado: 'ADIADA', motivo: 'MARCADOR_NAO_GRAVADO', ids: \[d\.id\] \};\s*const remocao = await removerComResultado\(provedor, d\.id\);/);
    assert.equal(rec.match(/removerComResultado\(provedor,/g)?.length, 1);
    // Sem confirmação (ou resultado não gravado) nunca conta como removida.
    assert.equal(rec.match(/registro\.confirmadas\.push\(/g)?.length, 1);
    assert.match(rec, /if \(remocao\.resultado !== 'CONFIRMADA' \|\| !gravado\) \{[\s\S]*?registro\.semConfirmacao\.push\(d\.id\);[\s\S]*?return revisao\(\);\s*\}\s*registro\.confirmadas\.push\(d\.id\);/);
    assert.match(fonte, /pg_try_advisory_xact_lock\(hashtext\('kidmais:contratacao'\), hashtext\(\$1\)\)/);
});

test('decisão central de compensação: exclui só com vínculo confirmado, vigente, da mesma empresa e candidata só com cobrança em aberto', async () => {
    const E = '11111111-1111-4111-8111-111111111111';
    const subs = new Map<string, AssinaturaProvedor>();
    const pays = new Map<string, CobrancaProvedor[]>();
    const nova = (id: string, o: Partial<AssinaturaProvedor> = {}, status = 'PENDING') => {
        subs.set(id, { id, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: 'cus_1', externalReference: E, ...o });
        pays.set(id, [{ id: `pay_${id}`, status, dueDate: '2026-10-20', paymentDate: null, invoiceUrl: null, deleted: false }]);
    };
    const leituras: string[] = [];
    const provedor = {
        obterAssinatura: async (id: string) => { leituras.push(`assinatura:${id}`); const a = subs.get(id); return a ? { ...a } : null; },
        listarCobrancasDaAssinatura: async (id: string) => { leituras.push(`cobrancas:${id}`); return pays.get(id) ?? []; },
    };
    nova('vigente'); nova('cand'); nova('cancelada', { status: 'INACTIVE', deleted: true }); nova('alheia', { externalReference: 'outra' });
    nova('paga', {}, 'RECEIVED'); nova('confirmada', {}, 'CONFIRMED'); nova('estornada', {}, 'REFUNDED'); nova('analise', {}, 'AWAITING_RISK_ANALYSIS');
    nova('candAlheia', { externalReference: 'outra' });
    const d = (vinculo: string | null | undefined, candidataId: string, vinculoAnterior?: string | null) => decidirCompensacao(provedor, { empresaId: E, vinculo, candidataId, vinculoAnterior });
    assert.deepEqual(await d('vigente', 'cand', null), { excluir: true });
    assert.deepEqual(await d('vigente', 'cand'), { excluir: true });
    const casos: Array<[string | null | undefined, string, string | null | undefined, string]> = [
        [null, 'cand', null, 'VINCULO_NAO_CONFIRMADO'], [undefined, 'cand', null, 'VINCULO_NAO_CONFIRMADO'],
        ['cand', 'cand', null, 'CANDIDATA_E_A_VINCULADA'], ['vigente', 'cand', 'vigente', 'VINCULO_NAO_MUDOU'],
        ['cancelada', 'cand', null, 'VINCULADA_NAO_VIGENTE'], ['sumida', 'cand', null, 'VINCULADA_NAO_VIGENTE'],
        ['alheia', 'cand', null, 'VINCULADA_DE_OUTRA_EMPRESA'], ['vigente', 'sumida', null, 'CANDIDATA_INEXISTENTE'],
        ['vigente', 'candAlheia', null, 'CANDIDATA_DE_OUTRA_EMPRESA'], ['vigente', 'paga', null, 'CANDIDATA_COM_PAGAMENTO'],
        ['vigente', 'confirmada', null, 'CANDIDATA_COM_PAGAMENTO'], ['vigente', 'estornada', null, 'CANDIDATA_COM_COBRANCA_INDEFINIDA'],
        ['vigente', 'analise', null, 'CANDIDATA_COM_COBRANCA_INDEFINIDA'],
    ];
    for (const [vinculo, cand, anterior, motivo] of casos)
        assert.deepEqual(await d(vinculo, cand, anterior), { excluir: false, motivo }, `${vinculo} × ${cand}`);
    leituras.length = 0;
    await d('vigente', 'cand');
    assert.deepEqual(leituras, ['assinatura:vigente', 'assinatura:cand', 'cobrancas:cand'], 'confirma a vigente, a candidata e os pagamentos');
    await assert.rejects(decidirCompensacao({ ...provedor, listarCobrancasDaAssinatura: async () => { throw new AsaasFalhou('listar cobranças', null, 'REDE'); } }, { empresaId: E, vinculo: 'vigente', candidataId: 'cand' }), AsaasFalhou);
});
