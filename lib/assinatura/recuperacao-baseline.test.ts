import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { compararComBase, FORMATO_BASE, hashComparavel, indicadoresDoCaso, NEUTRAS_HOMOLOGACAO, prefixoDoSchema, PREFIXOS, selarBase, validarBase, type ItemBase, type LinhaDeBase } from './recuperacao-baseline.ts';
import type { PropostaDoCaso } from './recuperacao-casos.ts';
import { hashProposta, FORMATO_PROPOSTA, hashCanonico } from './recuperacao-hash.ts';

/** B-14 (§3.5): prefixos admitidos, base selada e nunca recriada, agravamento. Sem banco. */
test('prefixos: cada passo da promoção é reconhecido; parcial, fora de ordem ou desconhecida fica fora da lista', () => {
    assert.equal(PREFIXOS.length, 12);
    assert.equal(prefixoDoSchema([])?.nome, 'P0a');
    assert.equal(prefixoDoSchema(['074a', '088'])?.nome, 'P0a', 'até 088 é o production atual');
    assert.equal(prefixoDoSchema(['088', '089'])?.nome, 'P1', 'P0b e P1: mesma impressão digital');
    assert.equal(prefixoDoSchema(['089', '092', '093', '099'])?.nome, 'P4');
    assert.equal(prefixoDoSchema(['089', '092', '093', '099', '090', '094', '095', '096', '097', '100', '091'])?.nome, 'P11');
    assert.equal(prefixoDoSchema(['089', '093']), null, 'pulou a 092');
    assert.equal(prefixoDoSchema(['089', '091']), null, '091 só no fim (D-OP-4)');
    assert.equal(prefixoDoSchema(['089', '098']), null, '098 pausada: fora da lista');
});

const item = (extra: Partial<ItemBase> = {}): ItemBase => ({ identidade: 'i1', tipo: 'EMPRESA', empresa: 'e1', classe: 'PROPOSTA', estado: 'ATIVA', motivo: null,
    hashProposta: 'h1', hashComparavel: 'c1', indicadores: { cobrancas_problematicas: 1 }, limites: { periodo_atual_fim: '2026-11-20T03:00:00.000Z' }, ...extra });
const base = (itens: ItemBase[], prefixo = 'P4', instante = '2026-10-27T10:00:00.000Z'): LinhaDeBase => {
    const p = prefixoDoSchema(PREFIXOS.find((x) => x.nome === prefixo)!.migrations)!;
    return { formato: FORMATO_BASE, schema: { prefixo, impressao: p.impressao }, forma: {}, instante, itens };
};

test('validarBase: ausente, sha divergente, prefixo atual que não contém a base → BASELINE_INVALIDA código 2', () => {
    const { base: b, sha } = selarBase(base([item()]));
    const P4 = PREFIXOS[4].migrations, P6 = PREFIXOS[6].migrations, P3 = PREFIXOS[3].migrations;
    assert.equal(validarBase(b, sha, P4).valida, true);
    assert.equal(validarBase(b, sha, P6).valida, true, 'conferência em prefixo que contém o da base');
    for (const [v, detalhe] of [[validarBase(null, sha, P4), 'BASE_AUSENTE'], [validarBase(b, sha.replace(/^./, '0'), P4), 'SHA_DIVERGENTE'],
        [validarBase(b, sha, P3), 'PREFIXO_ATUAL_NAO_CONTEM_A_BASE'], [validarBase(b, sha, ['089', '093']), 'PREFIXO_ATUAL_FORA_DA_LISTA'],
        [validarBase({ ...b, itens: [item({ classe: 'NOVA' as never })] }, selarBase({ ...b, itens: [item({ classe: 'NOVA' as never })] }).sha, P4), 'CLASSE_DESCONHECIDA']] as const)
        assert.deepEqual(v, { valida: false, motivo: 'BASELINE_INVALIDA', detalhe, codigo: 2 });
    assert.equal(selarBase(base([item({ identidade: 'b' }), item({ identidade: 'a' })])).sha, selarBase(base([item({ identidade: 'a' }), item({ identidade: 'b' })])).sha, 'ordem dos itens não muda o sha');
});

test('o simples passar do tempo não muda o item; limite cruzado entre base e conferência agrava', () => {
    const b = base([item()]);
    assert.deepEqual(compararComBase(b, base([item()], 'P4', '2026-11-01T00:00:00.000Z')).agravados, []);
    assert.deepEqual(compararComBase(b, base([item()], 'P4', '2026-11-21T00:00:00.000Z')).agravados, [{ identidade: 'i1', motivos: ['LIMITE_CRUZADO'] }]);
    // Mutantes pela fotografia (HB-3, 28/10): limite que JÁ tinha vencido antes da base não é cruzado depois — a idade do
    // item (o tempo desde o limite) nunca é critério; só o limite entre o instante da base e o da conferência.
    const vencidoAntes = { limites: { periodo_atual_fim: '2026-10-20T03:00:00.000Z' } };
    assert.deepEqual(compararComBase(base([item(vencidoAntes)]), base([item(vencidoAntes)], 'P4', '2026-12-01T00:00:00.000Z')).agravados, []);
});

test('agravamentos: classe, estado, indicador, hash; o motivo não faz parte da identidade', () => {
    const b = base([item()]);
    const atual = base([item({ classe: 'CORRELACIONADA_NAO_COMPROVADA', estado: 'EM_ATRASO', motivo: 'OUTRO', hashProposta: 'h2', hashComparavel: 'c2', indicadores: { cobrancas_problematicas: 2 } })]);
    assert.deepEqual(compararComBase(b, atual).agravados, [{ identidade: 'i1', motivos: ['CLASSE_PIOR', 'ESTADO_PIOR', 'HASH_DIFERENTE', 'INDICADOR_AUMENTOU'] }]);
    assert.deepEqual(compararComBase(b, base([item({ classe: 'RECONCILIADA', estado: 'ATIVA', motivo: 'OUTRO', indicadores: {} })])).agravados, [], 'melhora não agrava');
    assert.deepEqual(compararComBase(base([item({ estado: 'X' })]), base([item({ estado: 'Y' })])).agravados[0].motivos, ['ESTADO_PIOR'], 'estado sem ordem conhecida: fecha em falha');
});

test('item novo da mesma empresa agrava; créditos novos desde um prefixo posterior ficam sem comparação; resolvidos à parte', () => {
    const b = base([item(), item({ identidade: 'i9', empresa: 'e9' })], 'P6');
    const r = compararComBase(b, base([item(), item({ identidade: 'i2' }), item({ identidade: 'c1', tipo: 'PEDIDO', empresa: 'e1' }), item({ identidade: 'n1', empresa: 'e7' })], 'P7'));
    assert.deepEqual(r, { agravados: [{ identidade: 'i2', motivos: ['ITEM_NOVO_DA_EMPRESA'] }], novosSemComparacao: ['c1'], novos: ['n1'], resolvidos: ['i9'] });
});

test('indicadores e prazos do caso: instante absoluto do limite; período local além do calculado em segundos', () => {
    const r = indicadoresDoCaso({
        empresa_assinaturas: [{ situacao: 'ATIVA', ciclo: 'MENSAL', periodo_atual_fim: '2026-12-20T03:00:00+00:00' }],
        ia_credito_cobrancas: [{ pedido_id: 'p1', situacao_provedor: 'RECEIVED', estornado_centavos: 100, disputa: 'NENHUMA' }, { pedido_id: 'p2', situacao_provedor: 'CONFIRMED', estornado_centavos: 0, disputa: 'NENHUMA' }],
        ia_credito_lotes: [{ chave_origem: 'COMPRA:p1', vence_em: '2027-01-21T03:00:00+00:00', disponivel: 10 }],
    }, [{ metodo: 'listarCobrancasDaAssinatura', args: [], resultado: [{ id: 'a', status: 'RECEIVED', dueDate: '2026-10-20', deleted: false }, { id: 'b', status: 'OVERDUE', dueDate: '2026-11-20', deleted: false }] }]);
    assert.deepEqual(r, {
        indicadores: { cobrancas_problematicas: 1, estorno_disputa_devolucao: 1, periodo_local_menos_calculado_s: 30 * 86400, creditos_pagos_sem_lote: 1 },
        limites: { periodo_atual_fim: '2026-12-20T03:00:00.000Z', [`lote:${createHash('sha256').update('undefined:COMPRA:p1').digest('hex').slice(0, 32)}`]: '2027-01-21T03:00:00.000Z' },
    });
});

test('P2-4: sincronização só de observação muda o hash estrito, mas não o comparável; mudança comercial muda os dois', () => {
    const EMP = 'e';
    const caso = (sinc: string, situacao = 'ATIVA'): PropostaDoCaso => {
        const antes = { empresa_assinaturas: [{ empresa_id: EMP, situacao, sincronizado_em: sinc, atualizado_em: sinc, versao: sinc === 't0' ? 7 : 8, provedor_situacao: 'ACTIVE' }] };
        const proposta = { formato: FORMATO_PROPOSTA, caso: 'c', precondicoes: { local: hashCanonico(antes), remoto: [] },
            efeitos: [{ tabela: 'empresa_assinaturas', chave: EMP, operacao: 'UPDATE' as const, colunas: { sincronizado_em: { antes: sinc, depois: { $gerado: 'instante' as const } } } }] };
        return { caso: { tipo: 'EMPRESA', id: EMP, empresaId: EMP }, identidade: 'i', falha: null, proposta, hash: hashProposta(proposta), semEfeito: true, resultado: null, antes };
    };
    const e0 = caso('t0'), web = caso('t9');
    assert.notEqual(e0.hash, web.hash, 'o hash estrito da aplicação continua sensível');
    assert.equal(hashComparavel(e0), hashComparavel(web));
    assert.notEqual(hashComparavel(e0), hashComparavel(caso('t9', 'EM_ATRASO')));
});

test('P2-5: cada lote com saldo tem o próprio limite; o segundo vencimento cruzado agrava mesmo com o primeiro já vencido', () => {
    const lotes = { ia_credito_lotes: [
        { recurso: 'WALLE', chave_origem: 'COMPRA:a', vence_em: '2026-10-01T03:00:00+00:00', disponivel: 5 },
        { recurso: 'WALLE', chave_origem: 'COMPRA:b', vence_em: '2026-10-28T03:00:00+00:00', disponivel: 5 },
        { recurso: 'WALLE', chave_origem: 'COMPRA:c', vence_em: '2026-10-28T03:00:00+00:00', disponivel: 0, consumido: 5 } ] };
    const { limites } = indicadoresDoCaso(lotes);
    assert.equal(Object.keys(limites).length, 2, 'lote sem saldo não conta');
    const it = item({ limites });
    const r = compararComBase(base([it], 'P7', '2026-10-27T10:00:00.000Z'), base([it], 'P7', '2026-10-29T10:00:00.000Z'));
    assert.deepEqual(r.agravados, [{ identidade: 'i1', motivos: ['LIMITE_CRUZADO'] }]);
});

test('PH (D-HML-1 = B): P11 + neutras só em sandbox; production nunca; parcial, fora de ordem ou não neutra fica fora', () => {
    const P11 = PREFIXOS[11].migrations, P10 = PREFIXOS[10].migrations;
    assert.deepEqual(NEUTRAS_HOMOLOGACAO, ['102', '103', '104', '105', '106']);
    // Staging de hoje: P11 + 102, 103 e 105 (e com 104/106).
    for (const extra of [['102'], ['102', '103', '105'], ['102', '103', '104', '105', '106'], ['105']]) {
        const p = prefixoDoSchema([...P11, ...extra], 'sandbox');
        assert.equal(p?.nome, 'PH', extra.join(','));
        assert.equal(p?.indice, 11, 'vale como P11 na matriz');
        assert.equal(prefixoDoSchema([...P11, ...extra], 'producao'), null, 'production nunca admite PH');
        assert.equal(prefixoDoSchema([...P11, ...extra]), null, 'o padrão é production');
    }
    assert.equal(prefixoDoSchema(P11, 'sandbox')?.nome, 'P11', 'sem neutra continua P11');
    for (const [aplicadas, motivo] of [[[...P10, '102'], 'P11 incompleto'], [[...P11, '107'], 'não neutra'], [[...P11, '098', '102'], '098 pausada'],
        [['102', '103'], 'só neutras'], [[...P11, '101', '102'], '101 fora da lista']] as const)
        assert.equal(prefixoDoSchema(aplicadas, 'sandbox'), null, motivo);
});

test('validarBase com PH: só em sandbox; base P11 confere em PH e vice-versa; impressão alheia recusa', () => {
    const P11 = PREFIXOS[11].migrations, PH = [...P11, '102', '103', '105'];
    const ph = prefixoDoSchema(PH, 'sandbox')!;
    const { base: b, sha } = selarBase({ formato: FORMATO_BASE, schema: { prefixo: 'PH', impressao: ph.impressao }, forma: {}, instante: '2026-10-28T10:00:00.000Z', itens: [item()] });
    assert.equal(validarBase(b, sha, PH, 'sandbox').valida, true);
    assert.equal(validarBase(b, sha, P11, 'sandbox').valida, true, 'neutra removida: P11 ainda contém o PH (mesmo índice)');
    assert.deepEqual(validarBase(b, sha, PH, 'producao'), { valida: false, motivo: 'BASELINE_INVALIDA', detalhe: 'PREFIXO_DA_BASE_FORA_DA_LISTA', codigo: 2 });
    assert.deepEqual(validarBase(b, sha, PH), { valida: false, motivo: 'BASELINE_INVALIDA', detalhe: 'PREFIXO_DA_BASE_FORA_DA_LISTA', codigo: 2 }, 'padrão production');
    // PH com impressão que não é de P11 + neutras (ex.: a de P10 + 102): recusa.
    const alheia = createHash('sha256').update([...PREFIXOS[10].migrations, '102'].sort().join(',')).digest('hex');
    const { base: b2, sha: sha2 } = selarBase({ ...b, schema: { prefixo: 'PH', impressao: alheia } });
    assert.equal(validarBase(b2, sha2, PH, 'sandbox').valida, false);
    // Base P11 selada antes; conferência no PH do staging.
    const { base: b3, sha: sha3 } = selarBase(base([item()], 'P11'));
    assert.equal(validarBase(b3, sha3, PH, 'sandbox').valida, true);
    assert.equal(validarBase(b3, sha3, PH, 'producao').valida, false, 'em production o PH é fora da lista');
});

test('revisão do HB-3 r3: hash comparável NA FORMA DA BASE — adição estrutural não agrava; mudança comercial no que existia agrava', () => {
    const forma = { ia_credito_cobrancas: ['disputa', 'estornado_centavos', 'id'], empresa_assinaturas: ['empresa_id', 'situacao'] };
    const caso = (cobranca: Record<string, unknown>, extra: Record<string, unknown[]> = {}) => ({ caso: { tipo: 'PEDIDO', id: 'p', empresaId: 'e' }, identidade: 'i', falha: null, hash: 'h',
        proposta: { formato: 1, caso: 'i', precondicoes: { local: 'x', remoto: [] }, efeitos: [] }, semEfeito: true, resultado: null,
        antes: { ia_credito_cobrancas: [cobranca], empresa_assinaturas: [{ empresa_id: 'e', situacao: 'ATIVA' }], ...extra } }) as never;
    const naBase = hashComparavel(caso({ id: 'c', disputa: 'NENHUMA', estornado_centavos: 1000 }), forma);
    // P8: coluna nova na cobrança e tabela nova (096) com linhas — estrutural: igual.
    assert.equal(hashComparavel(caso({ id: 'c', disputa: 'NENHUMA', estornado_centavos: 1000, coluna_nova_096: 'x' }, { assinatura_comprovantes: [{ id: 'k' }] }), forma), naBase);
    // O contraexemplo do Astra: estorno de R$ 10 para R$ 80, mesma classe/estado/contadores — agrava.
    assert.notEqual(hashComparavel(caso({ id: 'c', disputa: 'NENHUMA', estornado_centavos: 8000, coluna_nova_096: 'x' }), forma), naBase);
    // Coluna da base que sumiu conta como diferença.
    assert.notEqual(hashComparavel(caso({ id: 'c', disputa: 'NENHUMA' }), forma), naBase);
    // E a comparação usa esse hash, no mesmo schema ou entre prefixos.
    const b = base([item({ hashComparavel: naBase })], 'P7');
    assert.deepEqual(compararComBase(b, base([item({ hashComparavel: 'outro' })], 'P8')).agravados, [{ identidade: 'i1', motivos: ['HASH_DIFERENTE'] }]);
    assert.deepEqual(compararComBase(b, base([item({ hashComparavel: naBase })], 'P8')).agravados, []);
});

test('revisão do HB-3 r3 (achado S0 → S2): o VALOR da coluna do instante (cancelada_em) não muda o hash comparável; a presença sim', () => {
    const cancelamento = (cancelada: string | null) => ({ caso: { tipo: 'EMPRESA', id: 'e', empresaId: 'e' }, identidade: 'i', falha: null, hash: 'h', semEfeito: false, resultado: null,
        proposta: { formato: 1, caso: 'i', precondicoes: { local: 'x', remoto: [] }, efeitos: [{ tabela: 'empresa_assinaturas', chave: 'e', operacao: 'UPDATE',
            colunas: { situacao: { antes: 'ATIVA', depois: 'CANCELADA_FIM_PERIODO' }, cancelada_em: { antes: null, depois: cancelada } } }] },
        antes: { empresa_assinaturas: [{ empresa_id: 'e', situacao: 'ATIVA' }] } }) as never;
    assert.equal(hashComparavel(cancelamento('2026-10-28T10:00:00.226Z')), hashComparavel(cancelamento('2026-10-28T10:00:00.529Z')));
    assert.notEqual(hashComparavel(cancelamento('2026-10-28T10:00:00.226Z')), hashComparavel(cancelamento(null)));
    const forma = { empresa_assinaturas: ['cancelada_em', 'empresa_id', 'situacao'] };
    assert.equal(hashComparavel(cancelamento('2026-10-28T10:00:00.226Z'), forma), hashComparavel(cancelamento('2026-10-28T11:00:00.000Z'), forma));
});
