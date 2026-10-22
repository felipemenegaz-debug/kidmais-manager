import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo, executorFalso } from './teste-carregador.ts';

/**
 * Sem origem confiável (null), nenhum fluxo público de acesso pode cair numa chave única com o limite de um IP
 * (revisão de 22/10: dez pedidos de A sem CF bloqueavam o primeiro de B). Os limites dublados aqui contam em memória
 * por (tipo, valor, namespace), como a tabela limites_autenticacao; nenhum banco é aberto.
 */
type Mod = Record<string, (...args: never[]) => unknown>;
type Regra = { namespace?: string; janelaSegundos: number; limite: number };

function limitesEmMemoria() {
    const contagem = new Map<string, number>();
    const chamadas: Array<{ tipo: string; valor: string; namespace: string | undefined; limite: number }> = [];
    const servico = {
        consumirLimite: async (_tx: unknown, tipo: string, valor: string, regra: Regra) => {
            chamadas.push({ tipo, valor, namespace: regra.namespace, limite: regra.limite });
            const k = `${regra.namespace}|${tipo}|${valor}`;
            contagem.set(k, (contagem.get(k) ?? 0) + 1);
            return contagem.get(k)! <= regra.limite;
        },
        prazoDoLimite: async () => 900,
        revogarSessoesDoUsuario: async () => 0,
        criarSessaoAdministrativa: async () => { throw new Error('não usado'); },
        limparLimite: async () => undefined,
    };
    return { servico, chamadas, contagem };
}

function carregar(arquivo: string) {
    const limites = limitesEmMemoria();
    const dubles = {
        'db/postgres': { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } },
        'autenticacao/service': limites.servico,
    };
    return { mod: carregarModulo(arquivo, dubles) as Mod, limites };
}

const semOrigem = { requestId: '00000000-0000-4000-8000-0000000000bb', ip: null, userAgent: 'teste' };
const token = (c: string) => c.repeat(43);
const depsTx = (tx = executorFalso([]), extra: Record<string, unknown> = {}) => ({
    withTransaction: async (w: (t: typeof tx) => Promise<unknown>) => w(tx),
    registrarAuditoria: async () => undefined, enviarEmail: async () => undefined, criarHashSenha: async () => 'h', conferirSenha: async () => false, gerarToken: () => 'x', ...extra,
});

test('consumirOrigem: com IP usa a chave da origem; sem IP, o identificador do fluxo ou um teto global alto (namespace própria)', async () => {
    const { mod, limites } = carregar('lib/acessos/limite-origem.ts');
    const consumir = mod.consumirOrigem as (tx: unknown, ip: string | null, regra: Regra, sem: unknown) => Promise<{ aguardar: number | null } | null>;
    const regra = { namespace: 'convite', janelaSegundos: 900, limite: 2 };
    assert.equal(await consumir({}, '2804:14c:65:a1::1', regra, { porIdentificador: 'tok' }), null);
    assert.equal(await consumir({}, null, regra, { porIdentificador: 'tok-a' }), null);
    assert.equal(await consumir({}, null, regra, { tetoGlobal: 300 }), null);
    assert.deepEqual(limites.chamadas, [
        { tipo: 'ORIGEM', valor: '2804:14c:65:a1::/64', namespace: 'convite', limite: 2 },
        { tipo: 'IDENTIFICADOR', valor: 'tok-a', namespace: 'convite-sem-origem', limite: 2 },
        { tipo: 'ORIGEM', valor: 'SEM_ORIGEM_CONFIAVEL', namespace: 'convite-sem-origem', limite: 300 },
    ]);
    assert.ok(!limites.chamadas.some((c) => c.valor === 'ORIGEM_NAO_VERIFICADA'));
    await consumir({}, null, regra, { porIdentificador: 'tok-a' });
    assert.deepEqual(await consumir({}, null, regra, { porIdentificador: 'tok-a' }), { aguardar: 900 }, 'o próprio link continua limitado');
});

test('convite sem origem: quem esgota a janela com um link não bloqueia outra pessoa com outro link (consulta e aceite)', async () => {
    process.env.ADMIN_AUTH_SECRET = 'segredo-sintetico-de-teste-unitario-0123456789';
    const { mod } = carregar('lib/acessos/convites.ts');
    const consultar = mod.consultarConvite as (raw: unknown, ctx: unknown, deps: unknown) => Promise<{ situacao: string }>;
    for (let i = 0; i < 30; i++)
        assert.equal((await consultar({ token: token('A') }, semOrigem, depsTx())).situacao, 'INVALIDO');
    await assert.rejects(consultar({ token: token('A') }, semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus === 429, 'A segue limitado');
    const deB = await consultar({ token: token('B') }, semOrigem, depsTx()).then((r) => r.situacao, (e: { httpStatus?: number }) => `erro ${e.httpStatus}`);
    assert.equal(deB, 'INVALIDO', 'B não recebe 429');
    const aceitar = mod.aceitarConvite as (raw: unknown, ctx: unknown, deps: unknown) => Promise<unknown>;
    const corpo = (c: string) => ({ token: token(c), nome: 'Pessoa Nova', senha: 'nova-senha-1', confirmacao: 'nova-senha-1' });
    for (let i = 0; i < 30; i++)
        await assert.rejects(aceitar(corpo('C'), semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus !== 429);
    await assert.rejects(aceitar(corpo('C'), semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus === 429);
    await assert.rejects(aceitar(corpo('D'), semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus !== 429, 'outro link não herda o bloqueio');
});

test('recuperação sem origem: 10 pedidos de A não bloqueiam B; teto global alto (300) contra envio em massa; redefinição por link', async () => {
    process.env.ADMIN_AUTH_SECRET = 'segredo-sintetico-de-teste-unitario-0123456789';
    const { mod } = carregar('lib/acessos/recuperacao.ts');
    const pedir = mod.processarPedidoPublico as (input: { email: string }, ctx: unknown, deps: unknown) => Promise<void>;
    const resultados: string[] = [];
    const deps = depsTx(executorFalso([]), { registrarAuditoria: async (a: { dadosDepois: { resultado: string } }) => { resultados.push(a.dadosDepois.resultado); } });
    for (let i = 0; i < 11; i++)
        await pedir({ email: `a${i}@exemplo.test` }, semOrigem, deps);
    await pedir({ email: 'b@exemplo.test' }, semOrigem, deps);
    assert.deepEqual(new Set(resultados), new Set(['SEM_CONTA_ATIVA']), 'nenhum LIMITE por origem no 11º nem para B');
    resultados.length = 0;
    for (let i = 0; i < 300; i++)
        await pedir({ email: `m${i}@exemplo.test` }, semOrigem, deps);
    assert.equal(resultados.filter((r) => r === 'LIMITE').length, 12, 'o teto global de 300 continua valendo (12 + 300 − 300)');

    const redefinir = mod.redefinirSenhaComToken as (raw: unknown, ctx: unknown, deps: unknown) => Promise<unknown>;
    const corpo = (c: string) => ({ token: token(c), novaSenha: 'nova-senha-1', confirmacao: 'nova-senha-1' });
    for (let i = 0; i < 10; i++)
        await assert.rejects(redefinir(corpo('E'), semOrigem, depsTx()), (e: { code?: string }) => e.code === 'LINK_INVALIDO');
    await assert.rejects(redefinir(corpo('E'), semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus === 429);
    await assert.rejects(redefinir(corpo('F'), semOrigem, depsTx()), (e: { code?: string }) => e.code === 'LINK_INVALIDO', 'outro link não recebe 429');
});

test('cadastro sem origem: 10 pedidos de A não bloqueiam B; teto global alto; confirmação limitada pelo próprio link', async () => {
    process.env.ADMIN_AUTH_SECRET = 'segredo-sintetico-de-teste-unitario-0123456789';
    const { mod } = carregar('lib/cadastro/publico.ts');
    const pedir = mod.processarPedidoCadastro as (input: unknown, ctx: unknown, deps: unknown) => Promise<{ enviado: boolean; motivo?: string }>;
    // Conta existente: caminho sem scrypt; o resultado mostra se o limite deixou passar.
    const tx = executorFalso([[/FROM usuarios_administrativos/, () => [{ id: '00000000-0000-4000-8000-000000000001' }]]]);
    const pedido = (email: string) => ({ email, nome: 'Pessoa', senha: 'nova-senha-1', confirmacao: 'nova-senha-1' });
    for (let i = 0; i < 11; i++)
        assert.equal((await pedir(pedido(`a${i}@exemplo.test`), semOrigem, depsTx(tx))).enviado, true, `pedido ${i + 1} de A`);
    assert.equal((await pedir(pedido('b@exemplo.test'), semOrigem, depsTx(tx))).enviado, true, 'B não é bloqueado');
    let limitados = 0;
    for (let i = 0; i < 300; i++)
        limitados += (await pedir(pedido(`m${i}@exemplo.test`), semOrigem, depsTx(tx))).motivo === 'LIMITE' ? 1 : 0;
    assert.equal(limitados, 12, 'teto global de 300');

    const confirmar = mod.confirmarCadastro as (raw: unknown, ctx: unknown, deps: unknown) => Promise<unknown>;
    for (let i = 0; i < 30; i++)
        await assert.rejects(confirmar({ token: token('G') }, semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus === 410);
    await assert.rejects(confirmar({ token: token('G') }, semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus === 429);
    await assert.rejects(confirmar({ token: token('H') }, semOrigem, depsTx()), (e: { httpStatus?: number }) => e.httpStatus === 410, 'outro link não recebe 429');
});

test('nenhum fluxo público usa mais a chave ORIGEM_NAO_VERIFICADA', async () => {
    const { readFileSync } = await import('node:fs');
    for (const arquivo of ['lib/acessos/convites.ts', 'lib/acessos/recuperacao.ts', 'lib/cadastro/publico.ts', 'lib/assinatura/webhook-asaas.ts', 'lib/http/limite-publico.ts', 'app/api/publico/marketing/[slug]/contato/route.ts'])
        assert.doesNotMatch(readFileSync(arquivo, 'utf8'), /ORIGEM_NAO_VERIFICADA/, arquivo);
});
