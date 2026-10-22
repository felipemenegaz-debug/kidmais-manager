import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';

type Limitador = { verificar(origem: string, grupo: 'LEITURA' | 'PEDIDO', empresa?: string | null): number | null };
const { criarLimitador } = carregarModulo('lib/http/limite-publico.ts', {}) as { criarLimitador(agora: () => number): Limitador };

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
        assert.match(fonte, new RegExp(`export async function ${metodo}\\(request: NextRequest\\) \\{\\n  const limite = limitarPublico\\(request, "${grupo}"\\);\\n  if \\(limite\\) return limite;`), arquivo);
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

test('limitarPublico real (reprodução da revisão): 10 PEDIDO de A sem CF não dão 429 ao primeiro de B, nem em outra empresa', () => {
    const json = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: init?.headers });
    const { limitarPublico } = carregarModulo('lib/http/limite-publico.ts', { 'next/server': { NextResponse: { json } } }) as { limitarPublico(r: unknown, g: string): Response | null };
    const anterior = { RENDER: process.env.RENDER, ORIGEM_CLIENTE_BORDA: process.env.ORIGEM_CLIENTE_BORDA };
    process.env.RENDER = 'true';
    delete process.env.ORIGEM_CLIENTE_BORDA;
    try {
        const pedido = (xff: string, empresa: string) => ({ headers: { get: (n: string) => (n === 'x-forwarded-for' ? xff : null) }, url: `https://k.example/api/fechamentos?empresa=${empresa}` });
        for (let i = 0; i < 10; i++) assert.equal(limitarPublico(pedido('177.10.20.30, 104.23.190.11', 'buffet-a'), 'PEDIDO'), null);
        assert.equal(limitarPublico(pedido('189.6.16.247, 104.23.190.11', 'buffet-a'), 'PEDIDO'), null, 'B na mesma empresa');
        assert.equal(limitarPublico(pedido('189.6.16.247, 104.23.190.11', 'buffet-b'), 'PEDIDO'), null, 'B em outra empresa');
    } finally {
        for (const [k, v] of Object.entries(anterior)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});
