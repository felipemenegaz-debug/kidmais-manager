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
