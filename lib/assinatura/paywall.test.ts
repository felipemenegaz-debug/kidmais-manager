import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import type { AcessoComercial } from './acesso.ts';
import { decidirPaywall, empresaEfetivaDaSessao, exigirAcessoComercial, rotaSemprePermitida } from './paywall.ts';

const completo: AcessoComercial = { nivel: 'COMPLETO', motivo: 'TESTE', ate: '2026-10-20T00:00:00.000Z' };
const leitura: AcessoComercial = { nivel: 'SOMENTE_LEITURA', motivo: 'TESTE_ENCERRADO', ate: '2026-12-20T00:00:00.000Z' };
const bloqueado: AcessoComercial = { nivel: 'BLOQUEADO', motivo: 'PAGAMENTO_PENDENTE', ate: null };

test('matriz nível × método: completo libera tudo; leitura só GET/HEAD; bloqueado nada — exceto conta, cobrança, exportação e painel', () => {
    const rota = '/api/admin/clientes';
    for (const m of ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'])
        assert.equal(decidirPaywall(completo, m, rota).permitido, true, m);
    for (const m of ['GET', 'HEAD', 'get'])
        assert.equal(decidirPaywall(leitura, m, rota).permitido, true, m);
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const d = decidirPaywall(leitura, m, rota);
        assert.equal(d.permitido, false, m);
        if (!d.permitido) {
            assert.deepEqual([d.status, d.codigo, d.nivel, d.motivo], [402, 'ASSINATURA_NECESSARIA', 'SOMENTE_LEITURA', 'TESTE_ENCERRADO']);
            assert.match(d.mensagem, /O teste grátis terminou\..*somente leitura/);
        }
    }
    for (const m of ['GET', 'POST']) {
        const d = decidirPaywall(bloqueado, m, rota);
        assert.equal(d.permitido, false);
        if (!d.permitido) assert.match(d.mensagem, /seus dados continuam guardados/);
    }
    for (const sempre of ['/api/admin/autenticacao', '/api/admin/perfil/senha', '/api/admin/assinatura', '/api/admin/assinatura/checkout', '/api/admin/exportacao/clientes', '/api/desenvolvedor/resumo'])
        for (const m of ['GET', 'POST'])
            assert.equal(decidirPaywall(bloqueado, m, sempre).permitido, true, `${m} ${sempre}`);
});

test('rotas sempre permitidas não vazam por prefixo parecido', () => {
    assert.equal(rotaSemprePermitida('/api/admin/assinatura/'), true);
    assert.equal(rotaSemprePermitida('/api/admin/assinaturas-falsas'), false);
    assert.equal(rotaSemprePermitida('/api/admin/autenticacao-x'), false);
    assert.equal(rotaSemprePermitida('/api/admin/perfil'), false, 'só a troca de senha, não o perfil inteiro');
    assert.equal(rotaSemprePermitida('/api/admin/configuracoes/perfil-empresa'), false);
});

function txFalso(memberships: string[], consultas: string[] = []) {
    return { async query(sql: string) { consultas.push(sql); return { rows: memberships.map((id) => ({ id })), rowCount: memberships.length }; } } as unknown as DbExecutor;
}

test('empresa efetiva: a selecionada na sessão; sem seleção só a única ativa; várias sem seleção = nenhuma (provarTenant recusa)', async () => {
    const consultas: string[] = [];
    assert.equal(await empresaEfetivaDaSessao(txFalso(['b'], consultas), { usuario_id: 'u', empresa_ativa_id: 'a' }), 'a');
    assert.equal(consultas.length, 0, 'seleção da sessão não consulta');
    assert.equal(await empresaEfetivaDaSessao(txFalso(['b']), { usuario_id: 'u', empresa_ativa_id: null }), 'b');
    assert.equal(await empresaEfetivaDaSessao(txFalso(['b', 'c']), { usuario_id: 'u' }), null);
    assert.equal(await empresaEfetivaDaSessao(txFalso([]), { usuario_id: 'u' }), null);
});

test('exigirAcessoComercial: 402 com nível e motivo; sem empresa ou rota sempre permitida não lê o estado', async () => {
    const estado = (acesso: AcessoComercial) => async () => ({ instalado: true, assinatura: null, excecoes: [], agora: '2026-10-07T00:00:00.000Z', acesso });
    const sessao = { usuario_id: 'u', empresa_ativa_id: 'e1' };
    await exigirAcessoComercial(txFalso([]), sessao, 'POST', '/api/admin/clientes', { lerEstado: estado(completo) as never });
    await exigirAcessoComercial(txFalso([]), sessao, 'GET', '/api/admin/clientes', { lerEstado: estado(leitura) as never });
    await assert.rejects(exigirAcessoComercial(txFalso([]), sessao, 'POST', '/api/admin/clientes', { lerEstado: estado(leitura) as never }),
        (e: { code?: string; httpStatus?: number; details?: Record<string, unknown> }) => e.code === 'ASSINATURA_NECESSARIA' && e.httpStatus === 402 && e.details?.nivel === 'SOMENTE_LEITURA' && e.details?.ate === leitura.ate);
    const naoLer = { lerEstado: (async () => { throw new Error('não deveria ler'); }) as never };
    await exigirAcessoComercial(txFalso([]), sessao, 'POST', '/api/admin/assinatura', naoLer);
    await exigirAcessoComercial(txFalso(['x', 'y']), { usuario_id: 'u', empresa_ativa_id: null }, 'POST', '/api/admin/clientes', naoLer);
});

/** Toda rota /api/admin passa pela guarda que aplica o paywall: diretamente ou pelos dois agregadores conhecidos. */
test('toda rota /api/admin passa por exigirApiAdminCrmDisponivel (onde o paywall é aplicado)', () => {
    const guarda = readFileSync('lib/http/admin-crm-api.ts', 'utf8');
    const corpo = guarda.slice(guarda.indexOf('export async function exigirApiAdminCrmDisponivel('));
    assert.match(corpo.split('\n}\n')[0], /await exigirAcessoComercial\(db\(\), session, request\.method,/);
    const rotas: string[] = [];
    const varrer = (dir: string) => {
        for (const nome of readdirSync(dir)) {
            const p = path.join(dir, nome);
            if (statSync(p).isDirectory()) varrer(p);
            else if (nome === 'route.ts') rotas.push(p);
        }
    };
    varrer('app/api/admin');
    assert.ok(rotas.length >= 60, `${rotas.length} rotas`);
    const agregadores = [/from "@\/lib\/financeiro\/http"/, /from "\.\.?\/(\.\.\/)?dependencias"/, /from "(\.\/|\.\.\/[a-z]+\/)composicao"/];
    for (const r of rotas) {
        const texto = readFileSync(r, 'utf8');
        assert.ok(texto.includes('exigirApiAdminCrmDisponivel') || agregadores.some((a) => a.test(texto)), `${r} não passa pela guarda administrativa`);
    }
    assert.match(readFileSync('lib/financeiro/http.ts', 'utf8'), /await exigirApiAdminCrmDisponivel\(request\)/);
    assert.match(readFileSync('app/api/admin/inteligencia/dependencias.ts', 'utf8'), /exigirApiAdminCrmDisponivel\(request\)/);
    for (const c of ['documentos', 'importacoes', 'operacoes'])
        assert.match(readFileSync(`app/api/admin/inteligencia/${c}/composicao.ts`, 'utf8'), /import \{ dependenciasGateway[^}]*\} from "\.\.\/dependencias"/, c);
});
