import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/** E2 — regras e descontos de `data/disponibilidade.json` só para a empresa dona da agenda pública. */
type Mod = Record<string, (...args: never[]) => Promise<unknown>>;
const mod = carregarModulo('lib/disponibilidade/config-legada.ts', {}) as Mod;
const dona = mod.empresaDonaDaConfigLegada as unknown as (tx: unknown, env: Record<string, string | undefined>) => Promise<string | null>;
const exigir = mod.exigirDonaDaConfigLegada as unknown as (tx: unknown, empresa: string, env: Record<string, string | undefined>) => Promise<void>;

const PUBLICA = '00000000-0000-4000-8000-0000000000a1';
const KIDMAIS = '00000000-0000-4000-8000-0000000000a2';
const OUTRA = '00000000-0000-4000-8000-0000000000a3';

function banco(opcoes: { existe?: string[]; kidmais?: boolean; ativas?: string[] }) {
    return executorFalso([
        [/WHERE id = \$1::uuid/, (p) => ((opcoes.existe ?? []).includes(String(p[0])) ? [{ id: p[0] }] : [])],
        [/codigo = 'kidmais'/, () => (opcoes.kidmais ? [{ id: KIDMAIS }] : [])],
        [/status <> 'DESATIVADA'/, () => (opcoes.ativas ?? []).map((id) => ({ id }))],
    ]);
}

test('dona: AGENDA_PUBLICA_EMPRESA_ID existente; senão a kidmais; senão a única empresa; senão ninguém', async () => {
    assert.equal(await dona(banco({ existe: [PUBLICA], kidmais: true }), { AGENDA_PUBLICA_EMPRESA_ID: PUBLICA }), PUBLICA);
    assert.equal(await dona(banco({ existe: [], kidmais: true }), { AGENDA_PUBLICA_EMPRESA_ID: PUBLICA }), KIDMAIS, 'env apontando para empresa inexistente não vale');
    assert.equal(await dona(banco({ kidmais: true }), { AGENDA_PUBLICA_EMPRESA_ID: 'nao-uuid' }), KIDMAIS);
    assert.equal(await dona(banco({ ativas: [OUTRA] }), {}), OUTRA, 'instalação de uma empresa só');
    assert.equal(await dona(banco({ ativas: [OUTRA, PUBLICA] }), {}), null, 'várias empresas sem dona definida: ninguém altera');
});

test('exigir: empresa que não é a dona recebe 403 AGENDA_CONFIG_DA_INSTALACAO; a dona passa', async () => {
    const tx = banco({ existe: [PUBLICA] });
    await assert.rejects(exigir(tx, OUTRA, { AGENDA_PUBLICA_EMPRESA_ID: PUBLICA }), (e: { code: string; httpStatus: number }) => e.code === 'AGENDA_CONFIG_DA_INSTALACAO' && e.httpStatus === 403);
    await exigir(tx, PUBLICA, { AGENDA_PUBLICA_EMPRESA_ID: PUBLICA });
});

test('rota da agenda: leitura vazia e gravação recusada fora da dona, antes de abrir o arquivo; tela esconde os controles', () => {
    const rota = readFileSync('app/api/admin/disponibilidade/route.ts', 'utf8');
    assert.match(rota, /const configuracaoComercial = await ehDonaDaConfigLegada\(tx, empresaComprovada\);/);
    assert.match(rota, /configuracaoComercial \? await lerComercial\(\) : \{ pacoteOverrides: \[\], descontos: \[\] \}/);
    const posGravacao = rota.indexOf('await exigirDonaDaConfigLegada(tx, tenant.empresaComprovada);');
    assert.ok(posGravacao > 0 && posGravacao < rota.indexOf('const config = await lerComercial();'), 'checagem antes de ler/gravar o arquivo');
    assert.equal((rota.match(/montarConfigAdmin\(tx, escopo, tenant\.empresaComprovada\)/g) ?? []).length, 2);
    const tela = readFileSync('components/admin/AdminDisponibilidade.tsx', 'utf8');
    assert.match(tela, /configuracaoComercial: admin\.configuracaoComercial !== false/);
    assert.match(tela, /\{configuracaoComercial \? \(<>/);
    assert.match(tela, /não estão disponíveis para esta empresa/);
});
