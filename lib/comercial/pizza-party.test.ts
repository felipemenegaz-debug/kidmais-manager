/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { PACOTES } from '../../components/fechamento/data.ts';
import { erroConvidadosFechamento } from '../fechamentos/convidados.ts';
import { erroConvidadosPizzaParty } from './pacotes-v1.ts';

const req = createRequire(import.meta.url);
// Carrega módulos reais com postgres substituído; nenhum banco/rede é acessado.
function loader(mocks: Record<string, any>) {
  const cache: Record<string, any> = {};
  function load(name: string): any {
    const base = resolve(name);
    if (base in mocks) return mocks[base];
    const file = existsSync(base + '.ts') ? base + '.ts' : existsSync(base) && base.endsWith('.ts') ? base : base + '/index.ts';
    if (cache[file]) return cache[file];
    const exports = cache[file] = {};
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', code)((id: string) => id.startsWith('@/') ? load(id.slice(2)) : id.startsWith('.') ? load(resolve(dirname(file), id.replace(/\.ts$/, ''))) : req(id), exports);
    return exports;
  }
  return load;
}

test('Pizza: fronteiras 19/20, 79/80, 100/101 na UI e validação compartilhada', () => {
  const pizza = PACOTES.find(p => p.id === 'pizza_party_scienza')!;
  assert.equal(pizza.minPagantes, 20); assert.equal(pizza.maxPagantes, 100);
  assert.equal(pizza.precoInicial, null); assert.equal(pizza.sobConsulta, true);
  for (const n of [19, 20, 79, 80, 100, 101]) {
    const valido = n >= 20 && n <= 100;
    assert.equal(erroConvidadosPizzaParty('PIZZA_PARTY', n) === null, valido);
    assert.equal(erroConvidadosFechamento(n, pizza) === null, valido);
  }
  assert.ok(erroConvidadosPizzaParty('PIZZA_PARTY', 20.5));
  assert.equal(erroConvidadosPizzaParty('COMPLETA', 150), null);
});

test('API de extras: rejeita limites antes de consultar e filtra por faixa vigente', async () => {
  const consultas: number[] = [];
  const tx = { query: async (sql: string, args: any[]) => {
    assert.match(sql, /pa\.modalidade='EXTRA'/); assert.match(sql, /a\.ativo/);
    assert.match(sql, /x\.ativo/); assert.match(sql, /x\.convidados_min<=\$3/);
    assert.match(sql, /x\.convidados_max >= \$3/); assert.match(sql, /vigencia_fim >= \$2/);
    consultas.push(args[2]);
    // Resultado da faixa selecionada pelo SQL; um adicional sem faixa não é retornado.
    return { rows: [{ codigo: 'BEBIDA_ALCOOLICA', nome: 'Taxa de rolha', categoria: 'EXTRA', unidade_cobranca: 'PACOTE', valor: args[2] < 80 ? '190.00' : '290.00' }] };
  } };
  const load = loader({ [resolve('lib/db/postgres')]: { db: () => tx } });
  const { GET } = load('app/api/fechamentos/adicionais/route');
  const { NextRequest } = req('next/server');
  for (const n of [19, 20, 79, 80, 100, 101]) {
    const antes = consultas.length;
    const response = await GET(new NextRequest(`http://localhost/api/fechamentos/adicionais?pacote=pizza_party_scienza&data=2027-06-26&convidados=${n}`));
    const body = await response.json();
    if (n === 19 || n === 101) { assert.equal(response.status, 400); assert.equal(consultas.length, antes); assert.match(body.erro, /20 a 100/); }
    else { assert.equal(response.status, 200); assert.equal(body.adicionais.length, 1); assert.equal(body.adicionais[0].preco, n < 80 ? 190 : 290); }
  }
});

test('repositório fornece 20–100 ao editor administrativo sem regravar cadastro legado', async () => {
  const load = loader({ [resolve('lib/db/postgres')]: { db: () => { throw Error('Banco proibido'); } } });
  const { listarPacotesAtivos } = load('lib/comercial/repositories/comercial.repository');
  const pacotes = await listarPacotesAtivos({ query: async (sql: string) => {
    assert.match(sql, /^SELECT/);
    return { rows: ['PIZZA_PARTY', 'COMPLETA'].map(codigo => ({ codigo, convidados_minimos: null, convidados_maximos: null })) };
  } });
  assert.equal(pacotes[0].convidadosMinimos, 20); assert.equal(pacotes[0].convidadosMaximos, 100);
  assert.equal(pacotes[1].convidadosMinimos, null); assert.equal(pacotes[1].convidadosMaximos, null);
});

test('precificação recusa 19/101 e mantém SOB_CONSULTA dentro de 20–100', async () => {
  const load = loader({
    [resolve('lib/db/postgres')]: { db: () => { throw Error('Banco proibido'); } },
    [resolve('lib/comercial/repositories')]: {
      buscarPacoteAtivoPorId: async () => ({ id: 'pizza', codigo: 'PIZZA_PARTY', convidadosMinimos: 20, convidadosMaximos: 100 }),
      buscarTabelaPrecoVigente: async () => ({ id: 'tabela' }),
      buscarCategoriaHorarioAplicavel: async () => ({ categoriaHorario: 'PADRAO' }),
      buscarElegibilidadePacoteAplicavel: async () => ({ estado: 'SOB_CONSULTA' }),
      buscarPrecoPacoteAplicavel: async () => { throw Error('Não deve precificar base Pizza'); },
    },
  });
  const { precificarPacote } = load('lib/comercial/services/pricing.service');
  for (const convidados of [19, 20, 79, 80, 100, 101]) {
    await assert.rejects(precificarPacote({ pacoteId: 'pizza', convidados, data: '2027-06-26', configuracaoAgendaId: 'turno' }), (e: any) =>
      e.code === (convidados === 19 || convidados === 101 ? 'DADOS_INVALIDOS' : 'PACOTE_SOB_CONSULTA'));
  }
});
