import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import { EMPRESA_SAAS_DO_PERFIL } from './autorizacao.ts';

/**
 * Associação Perfil (026) ↔ empresa SaaS (031). Antes, com várias empresas, o perfil legado (código EMP-*) só se
 * associava à instalação de UMA empresa; a primeira contratante provisionada pelo painel desfazia a associação da
 * Kidmais. Agora o único perfil órfão da instalação pertence à empresa legada `kidmais`, e perfis novos se associam
 * pelo código. A prova com PostgreSQL fica em lib/desenvolvedor/painel-063.postgres.test.ts.
 */
const { perfilDoTenant, perfilDoTenantOuNulo } = carregarModulo('lib/perfil/tenant.ts', {}) as {
    perfilDoTenant: (tx: unknown, id: string) => Promise<string>;
    perfilDoTenantOuNulo: (tx: unknown, id: string) => Promise<string | null>;
};

test('regra de associação: UUID, código, instalação única e o perfil órfão único da empresa legada kidmais', () => {
    assert.match(EMPRESA_SAAS_DO_PERFIL, /id = p\.id OR codigo = lower\(p\.codigo\)/);
    assert.match(EMPRESA_SAAS_DO_PERFIL, /\(SELECT count\(\*\) FROM empresas\) = 1 AND\s+\(SELECT count\(\*\) FROM public\.perfil_empresas\) = 1/);
    assert.match(EMPRESA_SAAS_DO_PERFIL, /codigo = 'kidmais'/);
    assert.match(EMPRESA_SAAS_DO_PERFIL, /NOT EXISTS \(SELECT 1 FROM empresas x WHERE x\.id = p\.id OR x\.codigo = lower\(p\.codigo\)\)/, 'o perfil não pode ter empresa própria');
    assert.match(EMPRESA_SAAS_DO_PERFIL, /WHERE NOT EXISTS \(SELECT 1 FROM empresas y WHERE y\.id = q\.id OR y\.codigo = lower\(q\.codigo\)\)\) = 1/, 'só quando há exatamente um perfil órfão');
    assert.match(EMPRESA_SAAS_DO_PERFIL, /count\(\*\) OVER \(\) AS candidatos/, 'mais de um candidato continua fechando o acesso');
});

test('perfil do tenant: nenhum → null (empresa nova) ou 409 no fluxo que exige; um → id; dois → 409 sem escolher', async () => {
    const vazio = executorFalso([[/SELECT p\.id/, () => []]]);
    assert.equal(await perfilDoTenantOuNulo(vazio, 'e1'), null);
    assert.match(vazio.executados[0].sql, /e\.candidatos=1 AND e\.status='ATIVA'/);
    assert.deepEqual(vazio.executados[0].params, ['e1']);
    await assert.rejects(perfilDoTenant(executorFalso([[/SELECT p\.id/, () => []]]), 'e1'), (e: { code?: string; httpStatus?: number }) => e.code === 'PERFIL_ESTRUTURA_AUSENTE' && e.httpStatus === 409);
    assert.equal(await perfilDoTenantOuNulo(executorFalso([[/SELECT p\.id/, () => [{ id: 'p1' }]]]), 'e1'), 'p1');
    const dois = executorFalso([[/SELECT p\.id/, () => [{ id: 'p1' }, { id: 'p2' }]]]);
    await assert.rejects(perfilDoTenantOuNulo(dois, 'e1'), (e: { code?: string }) => e.code === 'PERFIL_ESTRUTURA_AUSENTE');
});
