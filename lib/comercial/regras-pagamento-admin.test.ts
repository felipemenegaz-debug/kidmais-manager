/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import { REGRAS_LEGADAS } from './regras-pagamento.ts';

/**
 * D1 (16/11/2026) — Configurações › Descontos e formas de pagamento. Prova sem banco: validação (teto de 50%), Gestão no
 * servidor, ambiente sem a 077 (nada gravado), frases do histórico e os limites do que a tela pode tocar.
 * A gravação de verdade, o isolamento por empresa e "condições existentes não mudam": regras-pagamento-admin.postgres.test.ts.
 */
const m = carregarModulo('lib/comercial/regras-pagamento-admin.ts', { 'lib/db/postgres': { withTransaction() { throw new Error('sem banco'); } } }) as any;
const ler = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
/** Código sem comentários: as provas estáticas olham o que roda, não a explicação. */
const codigo = (f: string) => ler(f).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const EMPRESA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const GESTAO = { empresaComprovada: EMPRESA, membershipId: 'm', usuarioId: 'u', papelAtual: 'REPRESENTANTE_AUTORIZADO' };
const EQUIPE = { ...GESTAO, papelAtual: 'ADMINISTRATIVO' };
const VALIDO = { pixAvistaPercentual: 5, pixParceladoPercentual: 2, cartaoRotulo: 'Cartão de crédito', versao: null };
const codigoDe = (f: () => unknown) => { try { f(); } catch (e: any) { return { code: e.code, status: e.httpStatus ?? e.status, msg: e.message }; } return null; };

test('teto de 50% por desconto, inteiro e não negativo; mensagem clara acima do teto', () => {
    assert.equal(m.TETO_DESCONTO_PERCENTUAL, 50);
    assert.deepEqual(m.validarDescontos({ ...VALIDO, pixAvistaPercentual: 50, pixParceladoPercentual: 0 }).pixAvistaPercentual, 50);
    assert.equal(m.validarDescontos({ ...VALIDO, pixAvistaPercentual: '7' }).pixAvistaPercentual, 7, 'número digitado como texto');
    const acima = codigoDe(() => m.validarDescontos({ ...VALIDO, pixAvistaPercentual: 51 }));
    assert.equal(acima?.code, 'DESCONTO_ACIMA_DO_TETO');
    assert.match(acima!.msg, /Pix à vista passa do limite de 50%/);
    assert.match(codigoDe(() => m.validarDescontos({ ...VALIDO, pixParceladoPercentual: 80 }))!.msg, /Pix parcelado passa do limite de 50%/);
    for (const ruim of [-1, 2.5, 'abc', '', null, Number.NaN, Infinity])
        assert.equal(codigoDe(() => m.validarDescontos({ ...VALIDO, pixAvistaPercentual: ruim }))?.status, 400, String(ruim));
});

test('nome do cartão: espaços normalizados, 2 a 40 letras; campo fora da lista (ex.: desconto do dia útil) é recusado', () => {
    assert.equal(m.validarDescontos({ ...VALIDO, cartaoRotulo: '  Cartão   Visa ' }).cartaoRotulo, 'Cartão Visa');
    for (const ruim of ['', ' x ', 'x'.repeat(41), 12]) assert.equal(codigoDe(() => m.validarDescontos({ ...VALIDO, cartaoRotulo: ruim }))?.code, 'CARTAO_ROTULO_INVALIDO');
    assert.equal(codigoDe(() => m.validarDescontos({ ...VALIDO, descontoDiaUtil: true }))?.code, 'DADOS_INVALIDOS');
    assert.equal(codigoDe(() => m.validarDescontos({ ...VALIDO, empresaId: EMPRESA }))?.code, 'DADOS_INVALIDOS', 'empresa nunca vem do corpo para o serviço');
    assert.equal(codigoDe(() => m.validarDescontos([]))?.code, 'DADOS_INVALIDOS');
});

test('só a Gestão lê e grava: equipe recebe 403 antes de qualquer consulta', async () => {
    const db = executorFalso([]) as any;
    await assert.rejects(m.lerDescontosAdmin(db, EQUIPE), (e: any) => e.code === 'PAPEL_NAO_AUTORIZADO' && e.httpStatus === 403);
    await assert.rejects(m.salvarDescontosAdmin(db, EQUIPE, VALIDO, { requestId: null }), (e: any) => e.code === 'PAPEL_NAO_AUTORIZADO');
    assert.equal(db.executados.length, 0);
});

test('sem a 077 no ambiente: leitura mostra "indisponível" e gravar recusa com 503, sem escrever nada', async () => {
    const db = executorFalso([[/to_regclass\('public\.empresa_regras_pagamento'\)/, () => [{ ok: false }]]]) as any;
    assert.deepEqual(await m.lerDescontosAdmin(db, GESTAO), { instalada: false });
    await assert.rejects(m.salvarDescontosAdmin(db, GESTAO, VALIDO, { requestId: null }), (e: any) => e.code === 'REGRAS_PAGAMENTO_INDISPONIVEL' && e.httpStatus === 503 && /Nada foi salvo/.test(e.message));
    assert.ok(db.executados.every((q: any) => !/INSERT|UPDATE|DELETE/i.test(q.sql)), 'nenhuma escrita');
});

test('buffet sem linha: a tela traz a sugestão 5%/2%, mas o que vale continua 0% (neutras) até salvar', async () => {
    const db = executorFalso([
        [/to_regclass\('public\.empresa_regras_pagamento'\)/, () => [{ ok: true }]],
        [/FROM public\.empresa_regras_pagamento WHERE empresa_id/, () => []],
    ]) as any;
    const e = await m.lerDescontosAdmin(db, GESTAO);
    assert.deepEqual([e.instalada, e.configurada, e.versao], [true, false, null]);
    assert.deepEqual(e.formulario, { pixAvistaPercentual: 5, pixParceladoPercentual: 2, cartaoRotulo: 'Cartão de crédito' });
    assert.deepEqual([e.vigente.pixAvistaPercentual, e.vigente.pixParceladoPercentual], [0, 0]);
    assert.ok(db.executados.every((q: any) => !/INSERT|UPDATE|DELETE/i.test(q.sql)), 'ler nunca grava a sugestão');
});

test('histórico: uma frase por campo alterado; primeira gravação parte de 0%', () => {
    assert.deepEqual(m.mudancasDoHistorico(null, { pixAvistaPercentual: 5, pixParceladoPercentual: 2, cartaoRotulo: 'Cartão de crédito' }),
        ['Pix à vista: 0% → 5%', 'Pix parcelado: 0% → 2%']);
    assert.deepEqual(m.mudancasDoHistorico({ pixAvistaPercentual: 5, pixParceladoPercentual: 2, cartaoRotulo: 'Cartão de crédito' }, { pixAvistaPercentual: 5, pixParceladoPercentual: 3, cartaoRotulo: 'Visa' }),
        ['Pix parcelado: 2% → 3%', 'Nome do cartão: Cartão de crédito → Visa']);
});

test('limites do que a D1 toca: só a linha da própria empresa e a auditoria; desconto do dia útil fora da tela e do UPDATE', () => {
    const servico = codigo('lib/comercial/regras-pagamento-admin.ts');
    const tela = codigo('components/admin/DescontosPagamentoConfiguracao.tsx');
    const escritas = [...servico.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+([\w.]+)/g)].map((x) => x[2]);
    assert.deepEqual([...new Set(escritas)], ['public.empresa_regras_pagamento'], 'auditoria só por auditarMutacaoComercial');
    assert.doesNotMatch(servico, /fechament|condic(ao|oes)_|contratos/i, 'nada de fechamentos, condições ou contratos');
    const update = servico.slice(servico.indexOf('UPDATE public.empresa_regras_pagamento'), servico.indexOf('RETURNING 1', servico.indexOf('UPDATE public.empresa_regras_pagamento')));
    assert.doesNotMatch(update, /desconto_dia_util/, 'o selo da Kidmais nunca é mexido pela tela');
    assert.match(servico, /WHERE empresa_id = \$1::uuid AND atualizado_em::text = \$6/, 'UPDATE só na linha da empresa comprovada e na versão lida');
    assert.match(servico, /const empresaId = tenant\.empresaComprovada;/);
    assert.doesNotMatch(tela, /descontoDiaUtil|desconto_dia_util|dia útil/i);
    assert.match(tela, /só passa a valer depois de você salvar/);
    assert.match(tela, /Vale para fechamentos novos\. Os já feitos não mudam\./);
    assert.match(ler('app/api/admin/configuracoes/descontos/route.ts'), /withTenantTransaction\(sessao/);
});

test('Kidmais intacta: regras legadas 10%/3%/Cielo com selo, semente da 077 inalterada e nenhuma sugestão aplicada a ela', () => {
    assert.deepEqual(REGRAS_LEGADAS, { pixAvistaPercentual: 10, pixParceladoPercentual: 3, cartaoRotulo: 'Cielo', descontoDiaUtil: true });
    const migration = ler('database/migrations/20261010_077_regras_pagamento_empresa.sql');
    assert.match(migration, /SELECT id, 10, 3, 'Cielo', true,[\s\S]*?FROM empresas WHERE codigo = 'kidmais'/);
    assert.doesNotMatch(codigo('lib/comercial/regras-pagamento-admin.ts'), /kidmais/i, 'nenhum caminho especial: a Kidmais só muda se a própria Gestão dela salvar');
});
