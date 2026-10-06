import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';
import { autoridadeDaConfiguracao, itensNavegacao } from '../admin/navegacao.ts';

/**
 * D7 — o menu segue o papel NA EMPRESA selecionada (mesma regra de provarTenant) e a autoridade de plataforma da
 * identidade; cada item de Configurações é amarrado à autoridade que a API correspondente exige no servidor.
 */
const { contextoDaSessao } = carregarModulo('lib/autenticacao/contexto.ts', {}) as { contextoDaSessao: (tx: unknown, s: unknown, e?: string | null) => Promise<Record<string, unknown>> };
const A = { id: '00000000-0000-4000-8000-00000000000a', nome: 'Alfa', papel: 'REPRESENTANTE_AUTORIZADO' };
const B = { id: '00000000-0000-4000-8000-00000000000b', nome: 'Beta', papel: 'ADMINISTRATIVO' };
const banco = (empresas: unknown[], dev = false) => executorFalso([[/FROM memberships m JOIN empresas/, () => empresas], [/plataforma_desenvolvedores/, () => (dev ? [{ ok: 1 }] : [])]]);
const neutra = { usuario_id: 'u', papel: 'ADMINISTRATIVO' };

test('empresa única: selecionada; Gestão vem da membership, plataforma da identidade (independentes)', async () => {
    const c = await contextoDaSessao(banco([A]), neutra);
    assert.deepEqual([c.gestaoNaEmpresa, c.plataforma, c.selecaoNecessaria], [true, false, false]);
    assert.equal((c.empresaAtual as { id: string }).id, A.id);
    const legado = await contextoDaSessao(banco([B]), { usuario_id: 'u', papel: 'REPRESENTANTE_AUTORIZADO' });
    assert.deepEqual([legado.gestaoNaEmpresa, legado.plataforma], [false, true], 'papel global não vira Gestão na empresa');
    assert.equal((await contextoDaSessao(banco([A], true), neutra)).desenvolvedor, true);
});

test('várias empresas: sem escolha não há empresa nem Gestão; escolha só entre as próprias memberships ativas', async () => {
    const sem = await contextoDaSessao(banco([A, B]), neutra);
    assert.deepEqual([sem.empresaAtual, sem.gestaoNaEmpresa, sem.selecaoNecessaria], [null, false, true]);
    const escolhida = await contextoDaSessao(banco([A, B]), neutra, B.id);
    assert.deepEqual([(escolhida.empresaAtual as { id: string }).id, escolhida.gestaoNaEmpresa], [B.id, false]);
    const alheia = await contextoDaSessao(banco([A, B]), neutra, '00000000-0000-4000-8000-0000000000ff');
    assert.deepEqual([alheia.empresaAtual, alheia.gestaoNaEmpresa], [null, false]);
    const unica = await contextoDaSessao(banco([A]), neutra, '00000000-0000-4000-8000-0000000000ff');
    assert.equal(unica.empresaAtual, null, 'pedido de outra empresa não cai na única');
});

test('consulta: só membership ATIVA em empresa ATIVA da própria identidade', async () => {
    const tx = banco([]);
    await contextoDaSessao(tx, { usuario_id: '00000000-0000-4000-8000-000000000001', papel: 'ADMINISTRATIVO' });
    assert.match(tx.executados[0].sql, /m\.usuario_id = \$1::uuid AND m\.status = 'ATIVA' AND e\.status = 'ATIVA'/);
    assert.deepEqual(tx.executados[0].params, ['00000000-0000-4000-8000-000000000001']);
});

test('sessão escolhida prevalece sobre URL; perda de acesso não seleciona outra empresa automaticamente', async () => {
    const s = { ...neutra, empresa_ativa_id: A.id };
    const c = await contextoDaSessao(banco([A, B]), s, B.id);
    assert.equal((c.empresaAtual as { id: string }).id, A.id);
    const suspensa = await contextoDaSessao(banco([B]), s);
    assert.deepEqual([suspensa.empresaAtual, suspensa.selecaoNecessaria, suspensa.gestaoNaEmpresa], [null, true, false]);
});

test('menu: Configurações de empresa só com Gestão na empresa; WhatsApp e PDF só com autoridade de plataforma', () => {
    const conf = (p: { gestaoEmpresa: boolean; plataforma: boolean }) => itensNavegacao(p).filter((i) => i.grupo === 'Configurações').map((i) => i.href);
    assert.deepEqual(conf({ gestaoEmpresa: false, plataforma: false }), []);
    assert.deepEqual(conf({ gestaoEmpresa: true, plataforma: false }), ['/admin/configuracoes/perfil-empresa', '/admin/configuracoes/pacotes', '/admin/configuracoes/catalogo', '/admin/configuracoes/acessos', '/admin/configuracoes/pix']);
    assert.deepEqual(conf({ gestaoEmpresa: false, plataforma: true }), ['/admin/configuracoes/whatsapp', '/admin/configuracoes/tabela-pacotes']);
});

test('cada item do menu tem a autorização correspondente na API do servidor; o shell não decide pelo papel global', () => {
    const empresa: Record<string, string[]> = {
        '/admin/configuracoes/pacotes': ['app/api/admin/configuracoes/pacotes/route.ts'],
        '/admin/configuracoes/catalogo': ['app/api/admin/configuracoes/catalogo/route.ts'],
        '/admin/configuracoes/acessos': ['lib/autenticacao/usuarios.ts'],
        '/admin/configuracoes/perfil-empresa': ['lib/perfil/autorizacao.ts'],
        '/admin/configuracoes/pix': ['lib/pagamentos/pix/recebimento.ts'],
    };
    for (const [href, arquivos] of Object.entries(empresa)) {
        assert.equal(autoridadeDaConfiguracao(href), 'empresa', href);
        const texto = arquivos.map((f) => readFileSync(f, 'utf8')).join('\n');
        assert.match(texto, /exigirGestaoNoTenant|tenant\.papelAtual !== 'REPRESENTANTE_AUTORIZADO'|SELECT u\.id, m\.papel/, `${href}: papel da membership no servidor`);
    }
    for (const [href, arquivo] of [['/admin/configuracoes/tabela-pacotes', 'app/api/admin/configuracoes/tabela-pacotes/route.ts'], ['/admin/configuracoes/whatsapp', 'lib/whatsapp/onboarding.service.ts']]) {
        assert.equal(autoridadeDaConfiguracao(href), 'plataforma', href);
        assert.match(readFileSync(arquivo, 'utf8'), /temAutoridadeDePlataforma\(sessao\)/, href);
    }
    const shell = readFileSync('components/admin/AdminShell.tsx', 'utf8');
    assert.match(shell, /gestaoEmpresa: Boolean\(c\?\.gestaoNaEmpresa\)/);
    assert.doesNotMatch(shell, /data\.papel === 'REPRESENTANTE_AUTORIZADO'/);
    assert.match(readFileSync('app/api/admin/autenticacao/route.ts', 'utf8'), /contextoDaSessao\(db\(\), session\)/);
});
