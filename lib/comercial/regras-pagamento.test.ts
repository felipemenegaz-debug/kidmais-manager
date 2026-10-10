/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import type { DbExecutor } from '../db/contracts';
import { calcularCondicaoComercial, percentualLegado, type FormaComercial } from './condicao-pagamento.ts';
import { lerRegrasPagamento, regraNaCondicao, REGRAS_LEGADAS, REGRAS_NEUTRAS } from './regras-pagamento.ts';
import { textoCondicoesPagamento, textosMarca, MARCA_KIDMAIS, rotuloDescontoPix } from '../fechamentos/marca-publica.ts';

const { descontoEfetivo } = carregarModulo('lib/comercial/descontos.ts', {}) as { descontoEfetivo(c: any, p: string, d: string, h: string, auto?: boolean): { ativo: boolean } };
const ler = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const EMPRESA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FORMAS: FormaComercial[] = ['PIX_AVISTA', 'PIX_PARCELADO', 'CARTAO_CIELO'];

/** Fórmula exatamente como era antes desta etapa (referência para provar que nada muda no legado). */
function anterior(base: number, forma: FormaComercial) {
    const centavos = Math.round(base * 100);
    const percentual = forma === 'PIX_AVISTA' ? 10 : forma === 'PIX_PARCELADO' ? 3 : 0;
    const final = Math.floor((centavos * (100 - percentual) + 50) / 100);
    return { valorBaseComercial: centavos / 100, descontoFormaPagamentoPercentual: percentual, valorDescontoFormaPagamento: (centavos - final) / 100, valorFinalContrato: final / 100 };
}

test('contratos e condições existentes (sem descontoPercentual) dão exatamente o mesmo valor de antes; 10/3 explícitos também', () => {
    for (let i = 0; i < 2000; i++) {
        const base = Math.round((1 + Math.random() * 99_999) * 100) / 100;
        for (const forma of FORMAS) {
            assert.deepEqual(calcularCondicaoComercial(base, forma), anterior(base, forma));
            assert.deepEqual(calcularCondicaoComercial(base, forma, null), anterior(base, forma));
            assert.deepEqual(calcularCondicaoComercial(base, forma, percentualLegado(forma)), anterior(base, forma));
        }
    }
    assert.equal(calcularCondicaoComercial(1000, 'PIX_AVISTA', 0).valorFinalContrato, 1000);
    assert.equal(calcularCondicaoComercial(1000, 'PIX_AVISTA', 5).valorFinalContrato, 950);
    for (const ruim of [-1, 101, 2.5, Number.NaN]) assert.throws(() => calcularCondicaoComercial(1000, 'PIX_AVISTA', ruim));
});

test('regras por empresa: sem a 077 = null (legado, nada gravado); com a 077 = linha da empresa ou neutras', async () => {
    const semTabela = executorFalso([[/to_regclass\('public\.empresa_regras_pagamento'\)/, () => [{ ok: false }]]]) as unknown as DbExecutor & { executados: any[] };
    assert.equal(await lerRegrasPagamento(semTabela, EMPRESA), null);
    assert.deepEqual(await regraNaCondicao(semTabela, EMPRESA, 'PIX_AVISTA'), {});
    const linha = { pix_avista_percentual: 8, pix_parcelado_percentual: 2, cartao_rotulo: 'Cartão', desconto_dia_util: false };
    const comTabela = (temLinha: boolean) => executorFalso([
        [/to_regclass\('public\.empresa_regras_pagamento'\)/, () => [{ ok: true }]],
        [/FROM public\.empresa_regras_pagamento WHERE empresa_id = \$1::uuid/, (p) => temLinha && p[0] === EMPRESA ? [linha] : []],
    ]) as unknown as DbExecutor;
    assert.deepEqual(await lerRegrasPagamento(comTabela(true), EMPRESA), { pixAvistaPercentual: 8, pixParceladoPercentual: 2, cartaoRotulo: 'Cartão', descontoDiaUtil: false });
    assert.deepEqual(await regraNaCondicao(comTabela(true), EMPRESA, 'PIX_PARCELADO'), { descontoPercentual: 2 });
    assert.deepEqual(await regraNaCondicao(comTabela(true), EMPRESA, 'CARTAO_CIELO'), { descontoPercentual: 0 });
    assert.deepEqual(await lerRegrasPagamento(comTabela(false), EMPRESA), REGRAS_NEUTRAS);
    assert.deepEqual(await regraNaCondicao(comTabela(false), EMPRESA, 'PIX_AVISTA'), { descontoPercentual: 0 });
    assert.deepEqual(await lerRegrasPagamento(comTabela(true), null as unknown as string), REGRAS_NEUTRAS);
});

test('cálculo e criação usam o percentual gravado na condição', () => {
    assert.match(ler('lib/contratos/services/snapshot-core.ts'), /calcularCondicaoComercial\(base, input\.condicaoPagamento\.forma, input\.condicaoPagamento\.descontoPercentual\)/);
    assert.match(ler('lib/contratos/services/contrato.service.ts'), /fechamento\.condicaoPagamento\.forma, fechamento\.condicaoPagamento\.descontoPercentual\)/);
    assert.match(ler('lib/fechamentos/services/revisao-comercial.service.ts'), /calcularCondicaoComercial\(base, condicao\.forma, condicao\.descontoPercentual\)/);
    assert.match(ler('lib/fechamentos/services/fechamento.service.ts'), /\.\.\.\(await regraNaCondicao\(tx, resumoComercial\.pacote\.pacote\.empresaId \?\? null, input\.formaPagamentoPretendida\)\)/);
    assert.match(ler('lib/fechamentos/services/edicao-administrativa.service.ts'), /revisaoStatus: 'APROVADA', \.\.\.\(await regraNaCondicao\(tx, empresaEsperada, com\.forma\)\) \}/);
    assert.match(ler('lib/fechamentos/services/revisao-operacional.service.ts'), /revisaoStatus: 'APROVADA', \.\.\.\(await regraNaCondicao\(tx, empresaAutorizada, com\.forma\)\) \}/);
});

test('tela pública: Kidmais com o texto e os rótulos de hoje; outra empresa com as regras dela, sem Cielo nem -15%', () => {
    const kidmais = textosMarca(MARCA_KIDMAIS);
    assert.equal(textoCondicoesPagamento(kidmais), 'Após aprovação: PIX à vista tem 10% de desconto. PIX parcelado tem 3% de desconto; as condições são confirmadas pela equipe Kidmais. Cartão é processado pela Cielo.');
    assert.equal(rotuloDescontoPix(kidmais.pagamento.pixAvistaPercentual), '10% de desconto');
    assert.equal(kidmais.pagamento.cartaoRotulo, 'Cielo');
    const neutra = textosMarca({ kidmais: false, nome: 'Buffet X', pagamento: REGRAS_NEUTRAS });
    assert.equal(textoCondicoesPagamento(neutra), 'As condições de pagamento são confirmadas pela equipe do buffet após a aprovação.');
    assert.equal(rotuloDescontoPix(0), 'Sem desconto automático');
    assert.doesNotMatch(JSON.stringify(neutra), /Cielo/);
    assert.deepEqual(REGRAS_LEGADAS, { pixAvistaPercentual: 10, pixParceladoPercentual: 3, cartaoRotulo: 'Cielo', descontoDiaUtil: true });
    // Selo -15%: padrão (Kidmais) igual; desligado para empresa sem a regra.
    const config = { pacoteOverrides: [], descontos: [] } as any;
    assert.equal(descontoEfetivo(config, 'completa', '2026-11-03', 'noite').ativo, true);
    assert.equal(descontoEfetivo(config, 'completa', '2026-11-03', 'noite', false).ativo, false);
    const wizard = ler('components/fechamento/FechamentoWizard.tsx');
    assert.match(wizard, /calcularTotalPagamento\(valorInformado, "pix_avista", marca\.pagamento\)/);
    assert.match(wizard, /subtitle=\{marca\.pagamento\.cartaoRotulo\}/);
    assert.match(wizard, /\{marca\.pagamento\.descontoDiaUtil && pacoteTemDescontoDiaUtil\(form\.pacote\) && \(/);
    assert.doesNotMatch(wizard, /subtitle="(10|3)% de desconto"|subtitle="Cielo"/);
});

test('nome público: nome comercial aplicado do perfil; sem perfil ou ambíguo → empresas.nome', async () => {
    const carregar = (perfil: () => string | null) => carregarModulo('lib/perfil/nome-publico.ts', {
        'perfil/estrutura': { estruturaPerfilInstalada: async () => true },
        'perfil/tenant': { perfilDoTenantOuNulo: async () => perfil() },
    }) as { nomePublicoDaEmpresa(tx: DbExecutor, id: string): Promise<string | null> };
    const tx = executorFalso([
        [/FROM public\.perfil_empresas WHERE id/, () => [{ nome: '  Buffet Alegria Kids ' }]],
        [/FROM public\.empresas WHERE id/, () => [{ nome: 'Empresa Cadastro' }]],
    ]) as unknown as DbExecutor;
    assert.equal(await carregar(() => 'perfil-1').nomePublicoDaEmpresa(tx, EMPRESA), 'Buffet Alegria Kids');
    assert.equal(await carregar(() => null).nomePublicoDaEmpresa(tx, EMPRESA), 'Empresa Cadastro');
    assert.equal(await carregar(() => { throw new Error('ambíguo'); }).nomePublicoDaEmpresa(tx, EMPRESA), 'Empresa Cadastro');
    const semNome = executorFalso([[/FROM public\.perfil_empresas WHERE id/, () => [{ nome: '' }]], [/FROM public\.empresas WHERE id/, () => [{ nome: 'Empresa Cadastro' }]]]) as unknown as DbExecutor;
    assert.equal(await carregar(() => 'perfil-1').nomePublicoDaEmpresa(semNome, EMPRESA), 'Empresa Cadastro');
});

test('favicon: Kidmais com o mesmo /favicon.ico; endereço por empresa com ícone neutro', () => {
    assert.ok(!existsSync('app/favicon.ico') && existsSync('public/favicon.ico') && existsSync('public/icone-orcamento.svg'));
    assert.match(ler('app/layout.tsx'), /icons: \{ icon: \[\{ url: "\/favicon\.ico", sizes: "any" \}\] \}/);
    assert.doesNotMatch(ler('public/icone-orcamento.svg'), /kidmais/i);
});

test('migrations 076/077: preparadas com guardas, sem apagar ou alterar linhas; rollback aborta se perderia informação', () => {
    const m076 = ler('database/migrations/20261010_076_cpf_por_empresa.sql');
    assert.match(m076, /RAISE EXCEPTION '076 já aplicada\.'/);
    assert.match(m076, /CREATE UNIQUE INDEX clientes_cpf_empresa_canonico_uk\s+ON clientes \(COALESCE\(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid\), cpf\)\s+WHERE cpf IS NOT NULL AND status <> 'MESCLADO';/);
    assert.match(m076, /DROP INDEX clientes_cpf_canonico_uk;/);
    const m077 = ler('database/migrations/20261010_077_regras_pagamento_empresa.sql');
    assert.match(m077, /SELECT id, 10, 3, 'Cielo', true, '077: regras legadas preservadas para a Kidmais'\s+FROM empresas WHERE codigo = 'kidmais';/);
    for (const sql of [m076, m077]) {
        const semComentario = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
        assert.doesNotMatch(semComentario, /^\s*(DELETE|TRUNCATE|UPDATE)\b/im, "nenhum comando que altere ou apague linhas");
        assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/m);
    }
    assert.match(ler('database/rollback/20261010_076_cpf_por_empresa_down.sql'), /GROUP BY cpf HAVING count\(\*\) > 1\) THEN\s+RAISE EXCEPTION/);
    assert.match(ler('database/rollback/20261010_077_regras_pagamento_empresa_down.sql'), /há regras configuradas além da legada da Kidmais/);
    for (const check of ['076_precheck', '076_postcheck', '077_precheck', '077_postcheck'])
        assert.match(ler(`database/checks/20261010_${check}.sql`), /BEGIN TRANSACTION READ ONLY;[\s\S]*ROLLBACK;/, check);
});
