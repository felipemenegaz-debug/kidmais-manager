import assert from 'node:assert/strict';
import test from 'node:test';
import type { Leitura } from './recuperacao-caso.ts';
import { classificar, type EntradaClasse } from './recuperacao-classes.ts';
import type { Fotografia } from './recuperacao-efeitos.ts';
import type { Efeito } from './recuperacao-hash.ts';

/** B-14 (§3.6.1, §4): recusas antes da classe; SEM_EFEITO ≠ RECONCILIADA; ausência nunca é prova. Sem banco. */
const EMP = '11111111-1111-4111-8111-111111111111';
const assinaturaLocal = (extra: Record<string, unknown> = {}) => ({ empresa_id: EMP, situacao: 'ATIVA', ciclo: 'MENSAL', periodo_atual_fim: '2026-11-20T03:00:00.000Z',
    provedor_assinatura_id: 'sub_1', ...extra });
const leituras = (cobrancas: Record<string, unknown>[]): Leitura[] => [
    { metodo: 'obterAssinatura', args: ['sub_1'], resultado: { id: 'sub_1', status: 'ACTIVE', deleted: false } },
    { metodo: 'listarCobrancasDaAssinatura', args: ['sub_1'], resultado: cobrancas },
];
const paga = (extra: Record<string, unknown> = {}) => ({ id: 'pay_1', status: 'RECEIVED', dueDate: '2026-10-20', deleted: false, assinaturaId: 'sub_1', ...extra });
const observacao: Efeito[] = [{ tabela: 'empresa_assinaturas', chave: EMP, operacao: 'UPDATE', colunas: { sincronizado_em: { antes: 't0', depois: { $gerado: 'instante' } } } }];
const empresa = (extra: Partial<EntradaClasse> = {}): EntradaClasse => ({ modo: 'RESTORE', tipo: 'EMPRESA', id: EMP, empresaId: EMP,
    resultado: { resultado: 'SINCRONIZADA', recusa: null }, antes: { empresa_assinaturas: [assinaturaLocal()] }, efeitos: observacao, leituras: leituras([paga()]), ...extra });

test('assinatura coerente, só observação e vínculo comprovado → RECONCILIADA', () => {
    assert.deepEqual(classificar(empresa()), { classe: 'RECONCILIADA', recusas: [], semEfeito: true, comprovado: true, motivo: null });
});

test('SEM_EFEITO sem vínculo comprovado não é RECONCILIADA (cobrança de outra assinatura; assinatura lida ≠ gravada)', () => {
    const c = classificar(empresa({ leituras: leituras([paga({ assinaturaId: 'sub_outra' })]) }));
    assert.deepEqual([c.classe, c.semEfeito, c.motivo], ['CORRELACIONADA_NAO_COMPROVADA', true, 'NAO_COMPROVADO:COBRANCAS_DA_ASSINATURA_NAO_COMPROVADAS']);
    assert.equal(classificar(empresa({ antes: { empresa_assinaturas: [assinaturaLocal({ provedor_assinatura_id: 'sub_9' })] } })).motivo, 'NAO_COMPROVADO:ASSINATURA_NAO_COMPROVADA');
});

test('período local maior que o calculado: recusa só no RESTORE; a JANELA segue a regra da candidata', () => {
    const entrada = { antes: { empresa_assinaturas: [assinaturaLocal({ periodo_atual_fim: '2027-01-20T03:00:00.000Z' })] } as Fotografia };
    const r = classificar(empresa(entrada));
    assert.equal(r.classe, 'CORRELACIONADA_NAO_COMPROVADA');
    assert.deepEqual(r.recusas, ['PERIODO_LOCAL_MAIOR']);
    assert.equal(classificar(empresa({ ...entrada, modo: 'JANELA' })).classe, 'RECONCILIADA');
});

test('queda de situação e data do instante viram PROPOSTA com as recusas marcadas; encerramento no fim do período não é do instante', () => {
    const atraso: Efeito[] = [{ tabela: 'empresa_assinaturas', chave: EMP, operacao: 'UPDATE', colunas: { situacao: { antes: 'ATIVA', depois: 'EM_ATRASO' } } }];
    assert.deepEqual(classificar(empresa({ efeitos: atraso })), { classe: 'PROPOSTA', recusas: ['QUEDA_SITUACAO'], semEfeito: false, comprovado: true, motivo: 'QUEDA_SITUACAO' });
    const cancelada: Efeito[] = [{ tabela: 'empresa_assinaturas', chave: EMP, operacao: 'UPDATE', colunas: {
        situacao: { antes: 'ATIVA', depois: 'CANCELADA_FIM_PERIODO' }, cancelada_em: { antes: null, depois: '2026-10-27T12:00:00.000Z' } } }];
    assert.deepEqual(classificar(empresa({ efeitos: cancelada })).recusas, ['DATA_DO_INSTANTE', 'QUEDA_SITUACAO']);
    const noFim: Efeito[] = [{ tabela: 'empresa_assinaturas', chave: EMP, operacao: 'UPDATE', colunas: {
        situacao: { antes: 'CANCELADA_FIM_PERIODO', depois: 'ENCERRADA' }, encerrada_em: { antes: null, depois: '2026-11-20T03:00:00+00:00' } } }];
    assert.deepEqual(classificar(empresa({ efeitos: noFim })).recusas, ['QUEDA_SITUACAO']);
});

test('oferta/Fundador: o serviço lançou o código de domínio → sem proposta, recusa marcada', () => {
    const c = classificar(empresa({ falha: 'ERRO_INTERNO: FUNDADOR_DIVERGENTE', resultado: null, efeitos: [] }));
    assert.equal(c.classe, 'CORRELACIONADA_NAO_COMPROVADA');
    assert.deepEqual(c.recusas, ['FALHA:ERRO_INTERNO: FUNDADOR_DIVERGENTE', 'OFERTA_FUNDADOR']);
});

test('089/097 e estorno remoto bloqueiam a RECONCILIADA mesmo sem efeito', () => {
    assert.deepEqual(classificar(empresa({ antes: { empresa_assinaturas: [assinaturaLocal()], assinatura_arrependimentos: [{ id: 'a' }] } })).recusas, ['ENCERRAMENTO_089_097']);
    assert.deepEqual(classificar(empresa({ leituras: leituras([paga(), paga({ id: 'pay_0', status: 'REFUNDED' })]) })).recusas, ['ESTORNO_CHARGEBACK']);
    assert.deepEqual(classificar(empresa({ leituras: leituras([paga({ estornos: [{ id: 'r', status: 'DONE' }] })]) })).recusas, ['ESTORNO_CHARGEBACK']);
});

test('recusa do próprio serviço vale nos dois modos', () => {
    for (const modo of ['JANELA', 'RESTORE'] as const)
        assert.deepEqual(classificar(empresa({ modo, resultado: { resultado: 'SINCRONIZADA', recusa: 'CICLO_DESCONHECIDO' } })).recusas, ['SERVICO:CICLO_DESCONHECIDO']);
});

// Créditos: pedido CREDITADO coerente (fotografia completa) e contraexemplos da revisão de 27/10.
const CTX = { ambiente: 'producao', conta: 'k' };
const PED = 'p-1';
const obs: Efeito[] = [{ tabela: 'ia_credito_cobrancas', chave: 'x', operacao: 'UPDATE', colunas: { conferida_em: { antes: 't', depois: { $gerado: 'instante' } } } }];
const lidaCobranca = (status = 'RECEIVED', extra: Record<string, unknown> = {}): Leitura => ({ metodo: 'obterCobranca', args: ['pay_a'], resultado: { id: 'pay_a', status, deleted: false, ...extra } });
function creditado(): Fotografia {
    return {
        ia_credito_pedidos: [{ id: PED, empresa_id: EMP, estado: 'CREDITADO', recurso: 'WALLE', quantidade: 1000, creditado_em: 't1' }],
        ia_credito_cobrancas: [{ pedido_id: PED, pagamento_id: 'pay_a', ambiente: 'producao', conta: 'k', canonica: true, situacao_provedor: 'RECEIVED', estornado_centavos: 0, disputa: 'NENHUMA' }],
        ia_credito_lotes: [{ id: 'l1', pedido_id: PED, recurso: 'WALLE', quantidade: 1000, disponivel: 700, reservado: 100, bloqueado: 0, consumido: 200, expirado: 0, cancelado: 0 },
            { id: 'l0', pedido_id: null, recurso: 'WALLE', quantidade: 50, disponivel: 0, reservado: 0, bloqueado: 0, consumido: 0, expirado: 50, cancelado: 0 }],
        ia_credito_lancamentos: [{ lote_id: 'l1', tipo: 'CREDITO', quantidade: 1000 }, { lote_id: 'l1', tipo: 'RESERVA', quantidade: 300 }, { lote_id: 'l1', tipo: 'CONSUMO', quantidade: 200 },
            { lote_id: 'l0', tipo: 'CREDITO', quantidade: 50 }, { lote_id: 'l0', tipo: 'EXPIRACAO', quantidade: 50 }],
        ia_credito_carteiras: [{ empresa_id: EMP, recurso: 'WALLE', saldo: 800, reservado: 100, bloqueado: 0 }],
    };
}
const pedido = (extra: Partial<EntradaClasse> = {}): EntradaClasse => ({ modo: 'JANELA', tipo: 'PEDIDO', id: PED, empresaId: EMP, resultado: { resultado: 'JA_CONCLUIDO' },
    antes: creditado(), efeitos: obs, leituras: [lidaCobranca()], ...extra });
const motivoPedido = (antes: Fotografia, extra: Partial<EntradaClasse> = {}) => classificar(pedido({ antes, ...extra }), CTX).motivo;

test('créditos: CREDITADO com lote, lançamentos e carteira coerentes → RECONCILIADA', () => {
    assert.deepEqual(classificar(pedido(), CTX), { classe: 'RECONCILIADA', recusas: [], semEfeito: true, comprovado: true, motivo: null });
});

test('P1-2: ausência e incoerência nunca são prova (sem cobrança, sem lote, lote/carteira divergentes, cobrança extra, outra conta)', () => {
    const f = creditado();
    assert.equal(motivoPedido({ ...f, ia_credito_cobrancas: [], ia_credito_pedidos: [{ ...f.ia_credito_pedidos[0], estado: 'CRIACAO_EM_CURSO', creditado_em: null }], ia_credito_lotes: [] },
        { resultado: { resultado: 'SEM_MUDANCA', motivo: 'CRIACAO_EM_CURSO' }, leituras: [] }), 'NAO_COMPROVADO:SERVICO_CRIACAO_EM_CURSO');
    assert.equal(motivoPedido({ ...f, ia_credito_cobrancas: [] }), 'NAO_COMPROVADO:SEM_COBRANCA');
    assert.equal(motivoPedido({ ...f, ia_credito_pedidos: [] }), 'NAO_COMPROVADO:PEDIDO_INEXISTENTE');
    assert.equal(motivoPedido({ ...f, ia_credito_lotes: f.ia_credito_lotes.slice(1) }), 'NAO_COMPROVADO:CREDITADO_SEM_LOTE');
    assert.equal(motivoPedido({ ...f, ia_credito_lotes: [{ ...f.ia_credito_lotes[0], disponivel: 800, reservado: 0 }, f.ia_credito_lotes[1]] }), 'NAO_COMPROVADO:LOTE_DIVERGENTE_DOS_LANCAMENTOS');
    assert.equal(motivoPedido({ ...f, ia_credito_lancamentos: f.ia_credito_lancamentos.filter((l) => !(l.lote_id === 'l1' && l.tipo === 'CREDITO')) }), 'NAO_COMPROVADO:LANCAMENTO_DE_CREDITO_DIVERGENTE');
    assert.equal(motivoPedido({ ...f, ia_credito_carteiras: [{ ...f.ia_credito_carteiras[0], saldo: 1800 }] }), 'NAO_COMPROVADO:CARTEIRA_DIVERGENTE_DOS_LOTES');
    assert.equal(motivoPedido({ ...f, ia_credito_carteiras: [] }), 'NAO_COMPROVADO:SEM_CARTEIRA');
    assert.equal(motivoPedido({ ...f, ia_credito_cobrancas: [...f.ia_credito_cobrancas, { ...f.ia_credito_cobrancas[0], pagamento_id: 'pay_b', canonica: false }] }), 'NAO_COMPROVADO:COBRANCA_NAO_CANONICA');
    assert.equal(classificar(pedido(), { ambiente: 'producao', conta: 'outra' }).motivo, 'NAO_COMPROVADO:CONTA_OU_AMBIENTE_DIVERGENTE');
    assert.equal(motivoPedido(f, { leituras: [] }), 'NAO_COMPROVADO:COBRANCA_NAO_LIDA');
    assert.equal(motivoPedido(f, { leituras: [lidaCobranca('CONFIRMED')] }), 'NAO_COMPROVADO:STATUS_LOCAL_DIVERGENTE');
    assert.equal(motivoPedido({ ...f, ia_credito_devolucoes: [{ pedido_id: PED }] }), 'NAO_COMPROVADO:DEVOLUCAO');
    assert.equal(motivoPedido(f, { leituras: [lidaCobranca('RECEIVED', { estornos: [{ id: 'r' }] })] }), 'NAO_COMPROVADO:ESTORNO_OU_DISPUTA');
});

test('créditos sem crédito: AGUARDANDO/PENDING, VENCIDO/OVERDUE e ENCERRADO/removida sem lote → RECONCILIADA; com lote ou status trocado, não', () => {
    const sem = (estado: string, status: string, deleted = false) => {
        const f = creditado();
        return classificar(pedido({ resultado: { resultado: 'SEM_MUDANCA' }, leituras: [lidaCobranca(status, { deleted })],
            antes: { ...f, ia_credito_pedidos: [{ ...f.ia_credito_pedidos[0], estado, creditado_em: null }], ia_credito_cobrancas: [{ ...f.ia_credito_cobrancas[0], situacao_provedor: status }],
                ia_credito_lotes: f.ia_credito_lotes.slice(1) } }), CTX);
    };
    assert.equal(sem('AGUARDANDO_PAGAMENTO', 'PENDING').classe, 'RECONCILIADA');
    assert.equal(sem('VENCIDO', 'OVERDUE').classe, 'RECONCILIADA');
    assert.equal(sem('ENCERRADO', 'PENDING', true).classe, 'RECONCILIADA');
    assert.equal(sem('AGUARDANDO_PAGAMENTO', 'OVERDUE').motivo, 'NAO_COMPROVADO:AGUARDANDO_INCOERENTE');
    assert.equal(sem('REVISAO', 'RECEIVED').motivo, 'NAO_COMPROVADO:ESTADO_NAO_COMPROVAVEL_REVISAO');
});

test('créditos com estorno, disputa ou devolução: recusa no RESTORE; revisão do serviço (vencido na recuperação) fica marcada', () => {
    const f = creditado();
    assert.deepEqual(classificar(pedido({ modo: 'RESTORE', antes: { ...f, ia_credito_cobrancas: [{ ...f.ia_credito_cobrancas[0], disputa: 'ABERTA' }] } }), CTX).recusas, ['CREDITOS_ESTORNO_DISPUTA_DEVOLUCAO']);
    assert.deepEqual(classificar(pedido({ modo: 'RESTORE', antes: { ...f, ia_credito_devolucoes: [{ id: 'd', pedido_id: PED }] } }), CTX).recusas, ['CREDITOS_ESTORNO_DISPUTA_DEVOLUCAO']);
    const vencido = classificar(pedido({ modo: 'RESTORE', resultado: { resultado: 'REVISAO', motivo: 'CREDITO_VENCIDO_NA_RECUPERACAO' },
        efeitos: [{ tabela: 'ia_credito_pedidos', chave: PED, operacao: 'UPDATE', colunas: { estado: { antes: 'AGUARDANDO_PAGAMENTO', depois: 'REVISAO' } } }] }), CTX);
    assert.deepEqual([vencido.classe, vencido.recusas], ['PROPOSTA', ['SERVICO:CREDITO_VENCIDO_NA_RECUPERACAO']]);
});

test('P2-3: evento inexistente, IGNORADO ou já concluído sem o objeto comprovado não é RECONCILIADA', () => {
    const ev = (situacao: string | null, relacionadoReconciliado?: boolean): EntradaClasse => ({ modo: 'JANELA', tipo: 'EVENTO', id: 'e1', empresaId: EMP,
        resultado: { situacao: 'JA_CONCLUIDO', empresaId: EMP }, efeitos: [], leituras: [], relacionadoReconciliado,
        antes: { cobranca_eventos: situacao ? [{ id: 'e1', situacao }] : [] } });
    assert.equal(classificar(ev(null)).motivo, 'NAO_COMPROVADO:EVENTO_INEXISTENTE');
    assert.equal(classificar(ev('IGNORADO', true)).motivo, 'NAO_COMPROVADO:EVENTO_IGNORADO');
    assert.equal(classificar(ev('PROCESSADO')).motivo, 'NAO_COMPROVADO:OBJETO_DO_EVENTO_NAO_COMPROVADO');
    assert.equal(classificar(ev('PROCESSADO', true)).classe, 'RECONCILIADA');
});

test('órfã e indeterminada só existem no RESTORE', () => {
    assert.equal(classificar({ modo: 'RESTORE', tipo: 'ORFA_CREDITOS' }).classe, 'ORFA_CREDITOS');
    assert.throws(() => classificar({ modo: 'JANELA', tipo: 'INDETERMINADA' }));
});
