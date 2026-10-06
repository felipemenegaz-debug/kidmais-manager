import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo, executorFalso } from './teste-carregador.ts';

/**
 * Limites de tentativas com prazo calculável: as respostas 429 levam `Retry-After` (segundos) quando o servidor sabe
 * quando a janela acaba; sem prazo, nenhum cabeçalho é inventado. Sem banco (executorFalso).
 */
type Mod = Record<string, (...args: never[]) => unknown>;
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
const dubles = {
    'db/postgres': { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } },
    'clientes/repositories/auditoria.repository': { registrarAuditoria: async () => undefined },
    'next/server': { NextResponse: { json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: init?.headers }) } },
};
// Um único cache: as classes de erro são as mesmas instâncias em todos os módulos carregados (instanceof válido).
const cache = new Map<string, Record<string, unknown>>();
const http = carregarModulo('lib/acessos/http.ts', dubles, cache) as Mod;
const erros = carregarModulo('lib/acessos/erros.ts', dubles, cache) as Mod;
const service = carregarModulo('lib/autenticacao/service.ts', dubles, cache) as Mod;
const convites = carregarModulo('lib/acessos/convites.ts', dubles, cache) as Mod;

test('falhar(): 429 com prazo leva Retry-After inteiro (arredondado para cima); sem prazo ou fora do 429, nenhum cabeçalho', async () => {
    const falhar = http.falhar as (e: unknown) => Response;
    const erroAcesso = erros.erroAcesso as (c: string, m: string, s: number, d?: Record<string, unknown>) => Error;
    const comPrazo = falhar(erroAcesso('LIMITE_TENTATIVAS', 'Aguarde.', 429, { retryAfterSegundos: 41.2 }));
    assert.equal(comPrazo.status, 429);
    assert.equal(comPrazo.headers.get('Retry-After'), '42');
    assert.equal((await comPrazo.json()).detalhes.retryAfterSegundos, 41.2);
    assert.equal(falhar(erroAcesso('LIMITE_TENTATIVAS', 'Aguarde.', 429)).headers.get('Retry-After'), null, 'sem prazo calculável, sem cabeçalho');
    assert.equal(falhar(erroAcesso('LIMITE_TENTATIVAS', 'Aguarde.', 429, { retryAfterSegundos: 0 })).headers.get('Retry-After'), null);
    assert.equal(falhar(erroAcesso('CONFLITO', 'x', 409, { retryAfterSegundos: 30 })).headers.get('Retry-After'), null, 'só em 429');
    const autenticacao = (service.authError as (m: string, s: number, d?: Record<string, unknown>) => Error)('Aguarde antes de tentar novamente.', 429, { retryAfterSegundos: 900 });
    assert.equal(falhar(autenticacao).headers.get('Retry-After'), '900');
});

test('prazoDoLimite lê o fim do bloqueio pelo relógio do banco; sem bloqueio vigente devolve null', async () => {
    const prazo = service.prazoDoLimite as (tx: unknown, t: string, v: string, ns?: string) => Promise<number | null>;
    const tx = executorFalso([[/FROM limites_autenticacao WHERE chave_hash=\$1 AND bloqueado_ate > clock_timestamp\(\)/, () => [{ segundos: '37' }]]]);
    assert.equal(await prazo(tx, 'ORIGEM', '1.2.3.4', 'convite'), 37);
    assert.match(tx.executados[0].sql, /GREATEST\(1, ceil\(extract\(epoch FROM \(bloqueado_ate - clock_timestamp\(\)\)\)\)\)/);
    assert.equal(await prazo(executorFalso([]), 'IDENTIFICADOR', 'a@b.test'), null);
    assert.equal(await prazo(executorFalso([[/limites_autenticacao/, () => [{ segundos: 0 }]]]), 'IDENTIFICADOR', 'a@b.test'), null);
});

test('reenvio de convite dentro do intervalo mínimo: 429 com o prazo restante; recuperação pelo painel idem', async () => {
    const renovar = convites.renovarConviteNaTransacao as (tx: unknown, deps: unknown, e: string, c: string) => Promise<unknown>;
    const linha = { id: 'c1', empresa_id: 'e1', email: 'a@b.test', nome_sugerido: null, papel: 'ADMINISTRATIVO', status: 'PENDENTE', expira_em: '2030-01-01', expirado: false, envios: 1, ultimo_envio_em: '2026-10-05', criado_por: 'u', criado_em: '2026-10-05', aceito_em: null, cancelado_em: null, segundos_desde_envio: 14 };
    const tx = executorFalso([[/FROM convites_acesso c WHERE c\.id = \$1::uuid AND c\.empresa_id = \$2::uuid FOR UPDATE/, () => [linha]]]);
    await assert.rejects(renovar(tx, { gerarToken: () => 'x' }, 'e1', 'c1'), (e: { code?: string; httpStatus?: number; details?: { retryAfterSegundos?: number } }) => e.code === 'LIMITE_TENTATIVAS' && e.httpStatus === 429 && e.details?.retryAfterSegundos === 46);
    assert.ok(!tx.executados.some((q) => /UPDATE convites_acesso/.test(q.sql)), 'nenhum token novo dentro do intervalo');
    const vinculos = readFileSync('lib/desenvolvedor/vinculos.ts', 'utf8');
    assert.match(vinculos, /LIMITE_TENTATIVAS'.*429, \{ retryAfterSegundos: r\.aguardar \}/);
    const recuperacao = readFileSync('lib/acessos/recuperacao.ts', 'utf8');
    assert.match(recuperacao, /retryAfterSegundos: resultado\.aguardar/);
    const senha = readFileSync('lib/acessos/senha-propria.ts', 'utf8');
    assert.match(senha, /retryAfterSegundos: resultado\.aguardar/);
    const login = readFileSync('app/api/admin/autenticacao/route.ts', 'utf8');
    assert.match(login, /res\.headers\.set\('Retry-After'/);
});
