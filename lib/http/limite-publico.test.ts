import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

type Limitador = { verificar(origem: string, grupo: 'LEITURA' | 'PEDIDO', empresa?: string | null): number | null };
const { criarLimitador } = carregarModulo('lib/http/limite-publico.ts', {}) as { criarLimitador(agora: () => number, maximoEntidades?: number): Limitador };

test('leitura: 120 por minuto por origem; outra origem não é afetada; libera na janela seguinte', () => {
    let agora = 0;
    const l = criarLimitador(() => agora);
    for (let i = 0; i < 120; i++) assert.equal(l.verificar('1.1.1.1', 'LEITURA'), null);
    const espera = l.verificar('1.1.1.1', 'LEITURA');
    assert.ok(espera !== null && espera > 0 && espera <= 60);
    assert.equal(l.verificar('2.2.2.2', 'LEITURA'), null);
    agora = 60_000;
    assert.equal(l.verificar('1.1.1.1', 'LEITURA'), null);
});

test('pedido: 10 por hora por origem e 60 por hora por endereço de empresa; leitura e pedido têm baldes separados', () => {
    const l = criarLimitador(() => 0);
    for (let i = 0; i < 10; i++) assert.equal(l.verificar('1.1.1.1', 'PEDIDO', 'buffet-a'), null);
    assert.ok(l.verificar('1.1.1.1', 'PEDIDO', 'buffet-a')! > 0);
    assert.equal(l.verificar('1.1.1.1', 'LEITURA'), null);
    const m = criarLimitador(() => 0);
    for (let i = 0; i < 60; i++) assert.equal(m.verificar(`10.0.0.${i}`, 'PEDIDO', 'buffet-a'), null);
    assert.ok(m.verificar('10.0.1.1', 'PEDIDO', 'buffet-a')! > 0, 'teto por empresa');
    assert.equal(m.verificar('10.0.1.1', 'PEDIDO', 'buffet-b'), null, 'outra empresa não é afetada');
});

test('rotas públicas aplicam o limite antes de qualquer leitura do pedido ou do banco', () => {
    const rotas: Array<[string, string, string]> = [
        ['app/api/fechamentos/pacotes/route.ts', 'GET', 'LEITURA'], ['app/api/fechamentos/catalogo/route.ts', 'GET', 'LEITURA'],
        ['app/api/fechamentos/adicionais/route.ts', 'GET', 'LEITURA'], ['app/api/fechamentos/cotacao/route.ts', 'POST', 'LEITURA'],
        ['app/api/disponibilidade/route.ts', 'GET', 'LEITURA'], ['app/api/fechamentos/route.ts', 'POST', 'PEDIDO'],
    ];
    for (const [arquivo, metodo, grupo] of rotas) {
        const fonte = readFileSync(arquivo, 'utf8').replace(/\r\n/g, '\n');
        assert.match(fonte, new RegExp(`export async function ${metodo}\\(request: NextRequest\\) \\{\\n  const limite = await limitarPublico\\(request, "${grupo}"\\);\\n  if \\(limite\\) return limite;`), arquivo);
    }
});

test('sem origem confiável: nunca o teto de um IP para todos; baldes por empresa com teto 10×; PEDIDO mantém o teto por empresa', () => {
    const l = criarLimitador(() => 0) as unknown as { verificar(origem: string | null, grupo: 'LEITURA' | 'PEDIDO' | 'IDENTIDADE', empresa?: string | null): number | null };
    for (let i = 0; i < 10; i++) assert.equal(l.verificar(null, 'PEDIDO', 'buffet-a'), null);
    assert.equal(l.verificar(null, 'PEDIDO', 'buffet-a'), null, 'o 11º pedido sem origem na mesma empresa passa');
    assert.equal(l.verificar(null, 'PEDIDO', 'buffet-b'), null, 'outra empresa não é afetada');
    for (let i = 0; i < 49; i++) l.verificar(null, 'PEDIDO', 'buffet-a');
    assert.ok(l.verificar(null, 'PEDIDO', 'buffet-a')! > 0, 'teto por empresa (60/h) continua contra abuso');
    assert.equal(l.verificar(null, 'PEDIDO', 'buffet-b'), null);
    assert.equal(l.verificar('1.1.1.1', 'PEDIDO', 'buffet-b'), null, 'origem conhecida tem balde próprio');
    for (let i = 0; i < 1200; i++) assert.equal(l.verificar(null, 'LEITURA', 'buffet-c'), null);
    assert.ok(l.verificar(null, 'LEITURA', 'buffet-c')! > 0, 'leitura sem origem: 1200/min por empresa');
    assert.equal(l.verificar(null, 'LEITURA', 'buffet-d'), null);
    for (let i = 0; i < 200; i++) assert.equal(l.verificar(null, 'IDENTIDADE'), null);
    assert.ok(l.verificar(null, 'IDENTIDADE')! > 0, 'identidade sem origem e sem empresa: teto global alto (200/h)');
});

type Carregar = (limite: number) => Promise<Array<{ codigo: string; id: string }>>;
type Registro = {
    confirmarEmpresaPublica(c: string, id: string): void;
    empresaPublicaConfirmada(c: string | null): string | null;
    idDaEmpresaPublica(c: string, carregar: Carregar, agora?: number): Promise<string | null>;
    INTERVALO_CARGA_MS: number;
    CAPACIDADE_EMPRESAS_CONFIRMADAS: number;
};
/** Instância nova dos módulos reais (equivale a um processo recém-iniciado: registro vazio). */
function carregarReal() {
    const json = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: init?.headers });
    const cache = new Map<string, Record<string, unknown>>();
    const registro = carregarModulo('lib/http/empresas-publicas.ts', {}, cache) as unknown as Registro;
    const mod = carregarModulo('lib/http/limite-publico.ts', { 'next/server': { NextResponse: { json } } }, cache) as { limitarPublico(r: unknown, g: string, carregar?: Carregar): Promise<Response | null> };
    return { ...mod, ...registro };
}
/** Carga sintética das empresas ATIVAS, contando as chamadas. */
function cargaDe(ativas: Record<string, string>) {
    const carga = Object.assign(async () => { carga.chamadas += 1; return Object.entries(ativas).map(([codigo, id]) => ({ codigo, id })); }, { chamadas: 0 });
    return carga;
}
async function comAmbiente(env: Record<string, string | undefined>, corpo: () => Promise<void>) {
    const anterior = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try { await corpo(); } finally {
        for (const [k, v] of Object.entries(anterior)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}
const pedidoPublico = (empresa: string | null, cabecalhos: Record<string, string> = { 'x-forwarded-for': '177.10.20.30, 104.23.190.11' }) => ({
    headers: { get: (n: string) => cabecalhos[n] ?? null }, url: `https://k.example/api/fechamentos${empresa === null ? '' : `?empresa=${empresa}`}`,
});
const SEM_ORIGEM = { RENDER: 'true', ORIGEM_CLIENTE_BORDA: undefined };
const COM_BORDA = { RENDER: 'true', ORIGEM_CLIENTE_BORDA: 'render-cloudflare-sobrescreve' };

test('limitarPublico real (reprodução da revisão): 10 PEDIDO de A sem CF não dão 429 ao primeiro de B, nem em outra empresa', async () => {
    const { limitarPublico } = carregarReal();
    const carga = cargaDe({ 'buffet-a': 'id-a', 'buffet-b': 'id-b' });
    await comAmbiente(SEM_ORIGEM, async () => {
        for (let i = 0; i < 10; i++) assert.equal(await limitarPublico(pedidoPublico('buffet-a'), 'PEDIDO', carga), null);
        assert.equal(await limitarPublico(pedidoPublico('buffet-a', { 'x-forwarded-for': '189.6.16.247, 104.23.190.11' }), 'PEDIDO', carga), null, 'B na mesma empresa');
        assert.equal(await limitarPublico(pedidoPublico('buffet-b', { 'x-forwarded-for': '189.6.16.247, 104.23.190.11' }), 'PEDIDO', carga), null, 'B em outra empresa');
    });
});

test('P2-R3-1/P2-R4-1: processo recém-iniciado, 20.000 códigos inventados saturam o balde comum — empresa legítima nunca vista e origem nova seguem', async () => {
    const { limitarPublico, empresaPublicaConfirmada } = carregarReal(); // registro vazio: como depois de reinício/deploy
    const carga = cargaDe({ 'buffet-b': 'id-b' });
    await comAmbiente(SEM_ORIGEM, async () => {
        let limitados = 0;
        for (let i = 0; i < 20_000; i++) limitados += await limitarPublico(pedidoPublico(`codigo-falso-${i}`), 'IDENTIDADE', carga) ? 1 : 0;
        assert.equal(limitados, 20_000 - 200, 'inventados dividem UM balde (200/h): a proteção contra abuso continua');
        for (let i = 0; i < 1_300; i++) await limitarPublico(pedidoPublico(`leitura-falsa-${i}`), 'LEITURA', carga);
        for (let i = 0; i < 120; i++) await limitarPublico(pedidoPublico(`pedido-falso-${i}`), 'PEDIDO', carga);
        assert.equal(carga.chamadas, 1, '21.420 códigos desconhecidos custaram UMA carga (intervalo de 30 s), nenhuma consulta por código');
        assert.equal(empresaPublicaConfirmada('buffet-b'), 'id-b', 'a carga reconheceu a empresa legítima sem visita à página');
        for (const grupo of ['IDENTIDADE', 'LEITURA', 'PEDIDO'])
            assert.equal(await limitarPublico(pedidoPublico('buffet-b'), grupo, carga), null, `empresa legítima (nunca vista neste processo) em ${grupo}`);
        assert.equal(await limitarPublico(pedidoPublico(null), 'IDENTIDADE', carga), null, 'endereço padrão tem balde próprio');
    });
    await comAmbiente(COM_BORDA, async () => {
        const origemNova = { 'x-forwarded-for': '189.6.16.247, 104.23.190.11', 'cf-connecting-ip': '189.6.16.247' };
        for (let i = 0; i < 10; i++)
            for (let j = 0; j < 10; j++) await limitarPublico(pedidoPublico(`outro-falso-${i}-${j}`, { 'x-forwarded-for': `8.8.${i}.1, 104.23.190.11`, 'cf-connecting-ip': `8.8.${i}.1` }), 'PEDIDO', carga);
        for (const grupo of ['IDENTIDADE', 'LEITURA', 'PEDIDO'])
            assert.equal(await limitarPublico(pedidoPublico('buffet-b', origemNova), grupo, carga), null, `origem confiável nova em ${grupo} (PEDIDO_EMPRESA da B não é o comum)`);
    });
});

test('P2-R4-1: depois de sair do registro (capacidade), a empresa volta pela carga antes de ser cobrada; intervalo, formato e falha da carga', async () => {
    const { idDaEmpresaPublica, confirmarEmpresaPublica, empresaPublicaConfirmada, INTERVALO_CARGA_MS, CAPACIDADE_EMPRESAS_CONFIRMADAS } = carregarReal();
    const carga = cargaDe({ 'buffet-b': 'id-b' });
    let t = 1_000_000;
    assert.equal(await idDaEmpresaPublica('buffet-b', carga, t), 'id-b');
    for (let i = 0; i <= CAPACIDADE_EMPRESAS_CONFIRMADAS; i++) confirmarEmpresaPublica(`outra-${i}`, `id-${i}`);
    assert.equal(empresaPublicaConfirmada('buffet-b'), null, 'saiu do registro');
    assert.equal(await idDaEmpresaPublica('buffet-b', carga, t + 1), null, 'dentro do intervalo, sem nova consulta');
    assert.equal(carga.chamadas, 1);
    t += INTERVALO_CARGA_MS;
    assert.equal(await idDaEmpresaPublica('buffet-b', carga, t), 'id-b', 'intervalo vencido: a carga a traz de volta');
    assert.equal(carga.chamadas, 2);
    for (const ruim of ['A', 'x', 'buffet_a', '../a', 'a'.repeat(70), 'invalido_1'])
        assert.equal(await idDaEmpresaPublica(ruim, carga, t + 10 * INTERVALO_CARGA_MS), null, ruim);
    assert.equal(carga.chamadas, 2, 'formato inválido nunca consulta');
    const falha = Object.assign(async () => { throw new Error('banco fora'); }, {});
    const novo = carregarReal();
    assert.equal(await novo.idDaEmpresaPublica('buffet-c', falha, t), null, 'falha da carga: desconhecido, sem lançar');
});

test('limitador: chaves só canônicas — pedidos não confirmados ocupam um balde; com origem, um por IP e um teto comum', async () => {
    const l = criarLimitador(() => 0) as unknown as { verificar(o: string | null, g: string, e?: string | null): number | null; tamanho(): number };
    for (let i = 0; i < 1000; i++) l.verificar(null, 'IDENTIDADE', 'empresa-nao-confirmada');
    assert.equal(l.tamanho(), 1, 'mil pedidos não confirmados: um balde');
    for (let i = 0; i < 5; i++) l.verificar(`8.8.8.${i}`, 'PEDIDO', 'empresa-nao-confirmada');
    assert.equal(l.tamanho(), 5 + 1, 'cinco IPs + a MESMA entrada das não confirmadas (contadores juntos)');
    const fonte = readFileSync('lib/http/limite-publico.ts', 'utf8');
    assert.match(fonte, /verificar\(origem, grupo, await chaveDaEmpresaPublica\(/, 'limitarPublico só passa a chave canônica');
});

test('formulário do site: slug inventado não cria balde — o site é resolvido antes e o limite conta pelo id do site', () => {
    const fonte = readFileSync('app/api/publico/marketing/[slug]/contato/route.ts', 'utf8');
    const resolve = fonte.indexOf('await sitePublicoPorSlug(db(), slug)'), limita = fonte.indexOf('limitador.verificar(');
    assert.ok(resolve > 0 && limita > resolve, 'resolve o site antes de limitar');
    assert.ok(fonte.includes('limitador.verificar(ipDaRequisicao(request), "PEDIDO", ' + String.fromCharCode(96) + 'site:' + '$' + '{site.siteId}' + String.fromCharCode(96) + ')'));
    assert.ok(!fonte.includes('site:' + '$' + '{slug'), 'nunca o slug bruto na chave');
});

test('P2-R5-1: com o registro cheio (20.000 empresas usando os três grupos e o teto de PEDIDO), a empresa seguinte segue em todos, inclusive PEDIDO com IP novo', () => {
    const t = 0;
    const l = criarLimitador(() => t) as unknown as { verificar(o: string | null, g: string, e?: string | null): number | null; tamanho(): number };
    const { CAPACIDADE_EMPRESAS_CONFIRMADAS } = carregarModulo('lib/http/empresas-publicas.ts', {}) as { CAPACIDADE_EMPRESAS_CONFIRMADAS: number };
    for (let i = 0; i < CAPACIDADE_EMPRESAS_CONFIRMADAS; i++) {
        const empresa = `empresa:id-${i}`;
        for (const grupo of ['IDENTIDADE', 'LEITURA', 'PEDIDO']) assert.equal(l.verificar(null, grupo, empresa), null);
        const ip = Math.floor(i / 10); // 10 PEDIDO por IP: 2.000 IPs, longe do mapa de IPs
        assert.equal(l.verificar(`8.0.${ip >> 8}.${ip & 255}`, 'PEDIDO', empresa), null);
    }
    l.verificar(null, 'IDENTIDADE', null);
    l.verificar(null, 'IDENTIDADE', 'empresa-nao-confirmada');
    const nova = 'empresa:id-nova';
    for (const grupo of ['IDENTIDADE', 'LEITURA', 'PEDIDO']) assert.equal(l.verificar(null, grupo, nova), null, `empresa nova em ${grupo} sem origem`);
    assert.equal(l.verificar('189.6.16.247', 'PEDIDO', nova), null, 'PEDIDO com IP confiável novo');
    assert.equal(l.tamanho(), CAPACIDADE_EMPRESAS_CONFIRMADAS + 3 + CAPACIDADE_EMPRESAS_CONFIRMADAS / 10 + 1, 'uma entrada por empresa (não três) + endereço padrão, não confirmadas e a nova + os IPs');
    // As cotas vigentes continuam: a empresa 0 já usou 2 de 60 no teto de PEDIDO (um sem origem, um com IP); 58 a mais
    // passam e a seguinte não.
    for (let i = 0; i < 58; i++) assert.equal(l.verificar(`9.0.0.${i}`, 'PEDIDO', 'empresa:id-0'), null);
    assert.ok(l.verificar('9.0.1.1', 'PEDIDO', 'empresa:id-0')! > 0, 'teto de PEDIDO por empresa preservado');
});

test('P2-R5-1: o limite de entradas vem do registro (2× + folga) e, cheio de entradas vigentes, recusa a nova sem apagar cotas', () => {
    const mod = carregarModulo('lib/http/limite-publico.ts', { 'next/server': { NextResponse: { json: () => null } } }) as { MAXIMO_ENTIDADES: number };
    const { CAPACIDADE_EMPRESAS_CONFIRMADAS } = carregarModulo('lib/http/empresas-publicas.ts', {}) as { CAPACIDADE_EMPRESAS_CONFIRMADAS: number };
    assert.equal(mod.MAXIMO_ENTIDADES, 2 * CAPACIDADE_EMPRESAS_CONFIRMADAS + 64);
    let t = 0;
    const l = criarLimitador(() => t, 3) as unknown as { verificar(o: string | null, g: string, e?: string | null): number | null };
    for (const e of ['a', 'b', 'c']) assert.equal(l.verificar(null, 'LEITURA', e), null);
    assert.ok(l.verificar(null, 'LEITURA', 'd')! > 0, 'cheio de entradas vigentes: fail-closed só para a nova');
    assert.equal(l.verificar(null, 'LEITURA', 'a'), null, 'as existentes seguem com a cota delas');
    t = 60_000;
    assert.equal(l.verificar(null, 'LEITURA', 'd'), null, 'janela vencida: entradas vencidas saem e a nova entra');
});

test('P3-R5-2: carga no teto de 20.000 fica marcada e avisada uma vez, sem dado de empresa', async () => {
    const reg = carregarModulo('lib/http/empresas-publicas.ts', {}) as {
        idDaEmpresaPublica(c: string, carregar: (limite: number) => Promise<Array<{ codigo: string; id: string }>>, agora?: number): Promise<string | null>;
        estadoDaCarga(): { noTeto: boolean; capacidade: number };
        INTERVALO_CARGA_MS: number;
    };
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => { avisos.push(m); };
    try {
        const cheia = async (limite: number) => Array.from({ length: limite }, (_, i) => ({ codigo: `empresa-${String(i).padStart(5, '0')}`, id: `id-${i}` }));
        assert.equal(reg.estadoDaCarga().noTeto, false);
        assert.equal(await reg.idDaEmpresaPublica('zz-fora-do-prefixo', cheia, 0), null, 'empresa além do teto: desconhecida');
        assert.deepEqual(reg.estadoDaCarga(), { noTeto: true, capacidade: 20_000 });
        await reg.idDaEmpresaPublica('zz-outra-fora', cheia, reg.INTERVALO_CARGA_MS);
        assert.equal(avisos.length, 1, 'aviso uma vez por processo');
        assert.match(avisos[0], /no teto \(20000\)/);
        assert.doesNotMatch(avisos[0], /empresa-0|id-/);
    } finally { console.warn = original; }
});
