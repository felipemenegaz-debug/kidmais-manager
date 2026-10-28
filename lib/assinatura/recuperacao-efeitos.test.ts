import assert from 'node:assert/strict';
import test from 'node:test';
import { diferenca, efeitosPresentes, efeitoTolerado, semEfeito, valoresDoInstante, type Fotografia } from './recuperacao-efeitos.ts';
import { hashCanonico } from './recuperacao-hash.ts';

/** B-14 (§3.3, §3.4): efeitos a partir de fotografias. Sem banco: as fotografias são montadas à mão. */
const EMP = '11111111-1111-4111-8111-111111111111';
const assinatura = (extra: Record<string, unknown> = {}) => ({ empresa_id: EMP, situacao: 'ATIVA', periodo_atual_fim: '2026-11-20T03:00:00+00:00',
    provedor_situacao: 'ACTIVE', sincronizado_em: '2026-10-27T10:00:00+00:00', atualizado_em: '2026-10-27T10:00:00+00:00', versao: 7,
    em_atraso_desde: null, cancelada_em: null, encerrada_em: null, ...extra });

test('assinatura correta: só observação e derivadas do gatilho → SEM_EFEITO', () => {
    const antes: Fotografia = { empresa_assinaturas: [assinatura()] };
    const depois: Fotografia = { empresa_assinaturas: [assinatura({ sincronizado_em: '2026-10-27T11:00:00+00:00', atualizado_em: '2026-10-27T11:00:00+00:00', versao: 8 })] };
    const e = diferenca(antes, depois);
    assert.equal(e.length, 1);
    assert.deepEqual(Object.keys(e[0].colunas), ['atualizado_em', 'sincronizado_em', 'versao']);
    assert.deepEqual(e[0].colunas.versao, { antes: 7, depois: { $gerado: 'contador' } });
    assert.equal(semEfeito(e), true);
});

test('mudança comercial junto da observação deixa de ser tolerada', () => {
    const antes: Fotografia = { empresa_assinaturas: [assinatura({ situacao: 'EM_ATRASO', em_atraso_desde: '2026-10-01T03:00:00+00:00' })] };
    const depois: Fotografia = { empresa_assinaturas: [assinatura({ versao: 8, sincronizado_em: 'x' })] };
    const e = diferenca(antes, depois);
    assert.equal(semEfeito(e), false);
    assert.deepEqual(e[0].colunas.situacao, { antes: 'EM_ATRASO', depois: 'ATIVA' });
});

test('derivada sem observação (ex.: só versao) não é tolerada: o gatilho só se justifica pelo UPDATE de observação', () => {
    const e = diferenca({ empresa_assinaturas: [assinatura()] }, { empresa_assinaturas: [assinatura({ versao: 8, atualizado_em: 'y' })] });
    assert.equal(efeitoTolerado(e[0]), false);
});

test('crédito correto: conferida_em + atualizada_em da cobrança e reconciliado_em do pedido → SEM_EFEITO', () => {
    const cob = (extra: Record<string, unknown> = {}) => ({ id: 'c-1', provedor: 'ASAAS', ambiente: 'producao', conta: 'k', pagamento_id: 'pay_1', situacao_provedor: 'RECEIVED',
        conferida_em: 't0', atualizada_em: 't0', estornado_centavos: 0, ...extra });
    const ped = (extra: Record<string, unknown> = {}) => ({ id: 'p-1', estado: 'CREDITADO', reconciliado_em: 't0', atualizado_em: 'a0', ...extra });
    const e = diferenca({ ia_credito_cobrancas: [cob()], ia_credito_pedidos: [ped()] },
        { ia_credito_cobrancas: [cob({ conferida_em: 't1', atualizada_em: 't1' })], ia_credito_pedidos: [ped({ reconciliado_em: 't1' })] });
    assert.equal(semEfeito(e), true);
    const comEstorno = diferenca({ ia_credito_cobrancas: [cob()] }, { ia_credito_cobrancas: [cob({ conferida_em: 't1', atualizada_em: 't1', estornado_centavos: 5000 })] });
    assert.equal(semEfeito(comEstorno), false);
});

test('crédito novo: lote, lançamento e notificação viram INSERT com símbolos; o lançamento aponta o símbolo do lote', () => {
    const antes: Fotografia = { ia_credito_lotes: [], ia_credito_lancamentos: [], ia_credito_notificacoes: [] };
    const depois: Fotografia = {
        ia_credito_lotes: [{ id: 'uuid-lote-novo', recurso: 'WALLE', chave_origem: 'COMPRA:p-1', quantidade: 100, vence_em: '2027-01-21T03:00:00+00:00', criado_em: 'now' }],
        ia_credito_lancamentos: [{ id: 991, recurso: 'WALLE', operacao: 'COMPRA:p-1', tipo: 'CREDITO', lote_id: 'uuid-lote-novo', quantidade: 100, criado_em: 'now' }],
        ia_credito_notificacoes: [{ id: 'uuid-n', dedupe: 'PAGAMENTO_CONFIRMADO:p-1', tipo: 'PAGAMENTO_CONFIRMADO', criada_em: 'now', proxima_em: 'now' }],
    };
    const e = diferenca(antes, depois);
    assert.deepEqual(e.map((x) => [x.tabela, x.chave, x.operacao]), [
        ['ia_credito_lancamentos', 'WALLE:COMPRA:p-1:CREDITO:WALLE:COMPRA:p-1', 'INSERT'],
        ['ia_credito_lotes', 'WALLE:COMPRA:p-1', 'INSERT'],
        ['ia_credito_notificacoes', 'PAGAMENTO_CONFIRMADO:p-1', 'INSERT'],
    ]);
    assert.deepEqual(e[0].colunas.lote_id.depois, '$ia_credito_lotes:WALLE:COMPRA:p-1');
    assert.deepEqual(e[0].colunas.id.depois, { $gerado: 'id' });
    assert.equal(e[1].colunas.vence_em.depois, '2027-01-21T03:00:00+00:00', 'vencimento é comercial: valor fixo');
    assert.equal(semEfeito(e), false);
});

test('T1 e T2 com ids, instantes e contadores diferentes produzem os mesmos efeitos (mesmo hash)', () => {
    const base: Fotografia = { empresa_assinaturas: [assinatura({ situacao: 'EM_ATRASO' })], ia_credito_lotes: [], ia_credito_lancamentos: [] };
    const em = (id: string, n: number, instante: string): Fotografia => ({
        empresa_assinaturas: [assinatura({ sincronizado_em: instante, atualizado_em: instante, versao: 7 + n })],
        ia_credito_lotes: [{ id, recurso: 'CONVITES', chave_origem: 'COMPRA:p-9', vence_em: '2027-02-01T03:00:00+00:00', criado_em: instante }],
        ia_credito_lancamentos: [{ id: 100 + n, recurso: 'CONVITES', operacao: 'COMPRA:p-9', tipo: 'CREDITO', lote_id: id, criado_em: instante }],
    });
    assert.equal(hashCanonico(diferenca(base, em('uuid-a', 1, 't1'))), hashCanonico(diferenca(base, em('uuid-b', 2, 't2'))));
});

test('numeric fracionário vira texto; chave natural repetida (duas auditorias iguais) pareia com sufixo', () => {
    const aud = (id: string) => ({ id, acao: 'ASSINATURA_SINCRONIZADA', entidade_id: EMP, criado_em: 'x', request_id: id });
    const e = diferenca({ auditoria: [] }, { auditoria: [aud('a1'), aud('a2')], ia_credito_lotes: [] });
    assert.deepEqual(e.map((x) => x.chave), [`ASSINATURA_SINCRONIZADA:${EMP}`, `ASSINATURA_SINCRONIZADA:${EMP}#2`]);
    const f = diferenca({ ia_credito_pedidos: [{ id: 'p', custo: 1 }] }, { ia_credito_pedidos: [{ id: 'p', custo: 1.25 }] });
    assert.equal(f[0].colunas.custo.depois, '1.25');
});

test('valoresDoInstante: só as colunas comerciais derivadas do instante, com o valor da proposta', () => {
    const e = diferenca({ empresa_assinaturas: [assinatura()] }, { empresa_assinaturas: [assinatura({ situacao: 'CANCELADA_FIM_PERIODO', cancelada_em: '2026-10-27T12:34:56.789+00:00', versao: 8 })] });
    assert.deepEqual(valoresDoInstante(e), [{ tabela: 'empresa_assinaturas', chave: EMP, coluna: 'cancelada_em', valor: '2026-10-27T12:34:56.789+00:00' }]);
});

test('chave natural repetida: a linha que já existia pareia pelo id, qualquer que seja a ordem da fotografia (hash estável)', () => {
    const aud = (id: string, criado: string) => ({ id, acao: 'ASSINATURA_SINCRONIZADA', entidade_id: EMP, criado_em: criado, request_id: id, dados_depois: { via: 'X' } });
    const antiga = aud('ffff-antiga', 't0');
    const antes: Fotografia = { auditoria: [antiga] };
    // Em T1 o id novo sorteado fica antes da antiga na fotografia; em T2, depois. O efeito tem de ser o mesmo INSERT.
    const t1 = diferenca(antes, { auditoria: [aud('0000-nova', 't1'), antiga] });
    const t2 = diferenca(antes, { auditoria: [antiga, aud('zzzz-nova', 't2')] });
    assert.deepEqual(t1.map((e) => [e.chave, e.operacao]), [[`ASSINATURA_SINCRONIZADA:${EMP}#2`, 'INSERT']]);
    assert.equal(hashCanonico(t1), hashCanonico(t2));
});

test('P2-3 (incremento 4): efeitosPresentes exige a prova da aplicação — auditoria histórica igual não serve; vínculo simbólico resolvido', () => {
    const EMP = '11111111-1111-4111-8111-111111111111', EXEC = '22222222-2222-4222-8222-222222222222';
    const inicio = Date.parse('2026-10-28T10:00:00Z');
    const aud = (id: string, criado: string, req: string) => ({ id, acao: 'ASSINATURA_SINCRONIZADA', entidade_id: EMP, dados_depois: { caso: 'c', via: 'RECUPERACAO_B14' }, criado_em: criado, request_id: req });
    const antes: Fotografia = { auditoria: [aud('a1', '2026-10-01T00:00:00Z', 'r0')] };
    const depois: Fotografia = { auditoria: [aud('a1', '2026-10-01T00:00:00Z', 'r0'), aud('a2', '2026-10-28T10:00:01Z', EXEC)] };
    const efeitos = diferenca(antes, depois);
    assert.deepEqual(efeitos.map((e) => [e.tabela, e.operacao]), [['auditoria', 'INSERT']]);
    const prova = { desdeMs: inicio, requestId: EXEC };
    // Contraexemplo do Astra: só a fotografia anterior (a auditoria histórica tem o mesmo conteúdo) → não presente.
    assert.equal(efeitosPresentes(antes, efeitos, prova), false);
    assert.equal(efeitosPresentes(depois, efeitos, prova), true);
    // Linha nova, mas de outra execução (request_id) ou anterior ao início da aplicação → não presente.
    assert.equal(efeitosPresentes({ auditoria: [aud('a1', '2026-10-01T00:00:00Z', 'r0'), aud('a3', '2026-10-28T10:00:01Z', 'outra')] }, efeitos, prova), false);
    assert.equal(efeitosPresentes(depois, efeitos, { desdeMs: Date.parse('2026-10-28T11:00:00Z'), requestId: EXEC }), false);

    // Lote novo + lançamento que aponta para ele: o lote_id tem de ser o id concreto do lote inserido por esta aplicação.
    const lote = (id: string, criado: string) => ({ id, recurso: 'WALLE', chave_origem: 'COMPRA:p1', quantidade: 1000, criado_em: criado, liberado_em: criado, atualizado_em: criado });
    const lanc = (id: string, loteId: string, criado: string) => ({ id, recurso: 'WALLE', operacao: 'CREDITO:p1', tipo: 'CREDITO', lote_id: loteId, quantidade: 1000, criado_em: criado });
    const T = '2026-10-28T10:00:02Z';
    const e2 = diferenca({ ia_credito_lotes: [], ia_credito_lancamentos: [] }, { ia_credito_lotes: [lote('L1', T)], ia_credito_lancamentos: [lanc('X1', 'L1', T)] });
    assert.ok(e2.some((e) => e.tabela === 'ia_credito_lancamentos' && String(e.colunas.lote_id?.depois).startsWith('$ia_credito_lotes:')));
    assert.equal(efeitosPresentes({ ia_credito_lotes: [lote('L9', T)], ia_credito_lancamentos: [lanc('X9', 'L9', T)] }, e2, prova), true);
    // Lançamento apontando para OUTRO lote: a chave natural do lançamento não acha a linha (o lote dele é outro) → não presente.
    assert.equal(efeitosPresentes({ ia_credito_lotes: [lote('L9', T), { ...lote('L8', T), chave_origem: 'COMPRA:p2' }], ia_credito_lancamentos: [lanc('X9', 'L8', T)] }, e2, prova), false);
    // DELETE nunca é localizável.
    assert.equal(efeitosPresentes(depois, [{ tabela: 'auditoria', chave: 'x', operacao: 'DELETE', colunas: {} }], prova), false);
});
