import test from 'node:test';
import assert from 'node:assert/strict';
import * as modeloPreco from '../../lib/comercial/modelo-preco.ts';
import { achar, carregarComponente, cssFalso, texto } from './teste-componente.ts';

/** Pedido de Felipe (23/10/2026): completar os preços por quantidade de forma simples, sem mexer no que foi digitado. */
type Ponto = { convidados: string; valor: string };
type Modulo = {
  acrescimoSugerido(p: Ponto[], intervalo: number): number | null;
  completarPrecos(p: Ponto[], acrescimo: number, intervalo: number): Ponto[];
};
const carregar = () => carregarComponente('components/admin/PrecosPorQuantidade.tsx', {
  '@/lib/comercial/modelo-preco': modeloPreco, './precos-quantidade.module.css': cssFalso, './workspace.module.css': cssFalso,
});
const m = carregar().modulo as unknown as Modulo;
const tela = (valores: string[]) => [20, 30, 40, 50, 60, 70, 80, 90, 100].map((q, i) => ({ convidados: String(q), valor: valores[i] ?? '' }));

test('sugestão pelo ritmo dos preços digitados: 3.000 → 3.500 → 4.000 sugere R$ 500,00 a cada 10 convidados', () => {
  assert.equal(m.acrescimoSugerido(tela(['3000', '3500', '4000']), 10), 50000);
  assert.equal(m.acrescimoSugerido(tela(['3000', '3500', '4000']), 5), 25000, 'acompanha o intervalo da tela');
  assert.equal(m.acrescimoSugerido(tela(['3000']), 10), null, 'um preço só: sem ritmo');
  assert.equal(m.acrescimoSugerido(tela(['3000', '2800']), 10), null, 'preço caindo: sem sugestão');
  assert.equal(m.acrescimoSugerido(tela([]), 10), null);
});

test('completar preenche só os vazios, a partir do último preço, e o resultado passa na regra do servidor', () => {
  const antes = tela(['3000', '3500', '4000']);
  const depois = m.completarPrecos(antes, 50000, 10);
  assert.deepEqual(depois.map((p) => p.valor), ['3000', '3500', '4000', '4500,00', '5000,00', '5500,00', '6000,00', '6500,00', '7000,00']);
  assert.deepEqual(antes.map((p) => p.valor).slice(3), ['', '', '', '', '', ''], 'não altera a lista recebida');
  const pontos = depois.map((p) => ({ convidados: Number(p.convidados), valor: modeloPreco.normalizarValorInformado(p.valor) }));
  assert.doesNotThrow(() => modeloPreco.validarPontos(pontos, { minimo: 20, maximo: 100 }));
  // Preço digitado no meio continua o dele; os seguintes partem dele.
  const meio = m.completarPrecos(tela(['3000', '', '', '6000']), 50000, 10);
  assert.deepEqual(meio.map((p) => p.valor).slice(0, 6), ['3000', '3500,00', '4000,00', '6000', '6500,00', '7000,00']);
  // Sem ponto de partida acima, fica vazio; acréscimo negativo ou intervalo inválido não mudam nada.
  assert.deepEqual(m.completarPrecos(tela(['', '', '4000']), 50000, 10).map((p) => p.valor).slice(0, 4), ['', '', '4000', '4500,00']);
  assert.deepEqual(m.completarPrecos(antes, -100, 10), antes);
  assert.deepEqual(m.completarPrecos(antes, 50000, 0), antes);
  // Quantidades fora de ordem e espaçamento irregular: o valor é por convidado.
  const irregular = m.completarPrecos([{ convidados: '35', valor: '' }, { convidados: '20', valor: '3000' }, { convidados: '25', valor: '' }], 50000, 10);
  assert.deepEqual(irregular.map((p) => p.valor), ['3750,00', '3000', '3250,00']);
  assert.deepEqual(m.completarPrecos(tela(['3000,50']), 1000, 10).map((p) => p.valor).slice(0, 2), ['3000,50', '3010,50']);
});

test('parecer do Astra (23/10): texto inválido nunca é sobrescrito; o arredondamento não se acumula', () => {
  // P2: "abc" fica como está (o operador corrige); os vazios seguem do último preço válido.
  const invalido = m.completarPrecos(tela(['3000', 'abc', '']), 50000, 10);
  assert.deepEqual(invalido.map((p) => p.valor).slice(0, 4), ['3000', 'abc', '4000,00', '4500,00']);
  assert.deepEqual(m.completarPrecos(tela(['3000', '  ']), 50000, 10).map((p) => p.valor).slice(0, 2), ['3000', '3500,00'], 'só espaços = vazio');
  // P3: 20 = R$ 100,00, R$ 10,01 a cada 10 → 25 = 105,01 e 30 = 110,01 (âncora no digitado, sem acumular).
  const pontos = [{ convidados: '20', valor: '100' }, { convidados: '25', valor: '' }, { convidados: '30', valor: '' }, { convidados: '100', valor: '' }];
  assert.deepEqual(m.completarPrecos(pontos, 1001, 10).map((p) => p.valor), ['100', '105,01', '110,01', '180,08']);
  // Preço digitado no meio vira a nova âncora para os de baixo.
  assert.deepEqual(m.completarPrecos([...pontos.slice(0, 2), { convidados: '30', valor: '120' }, { convidados: '40', valor: '' }], 1001, 10).map((p) => p.valor),
    ['100', '105,01', '120', '130,01']);
});

test('tela: o painel mostra a sugestão, diz quantos preços completa e o selo diz quantos faltam', () => {
  const precos = carregar();
  let recebido: Ponto[] | null = null;
  const arvore = precos.render('PrecosPorQuantidade', { pontos: tela(['3000', '3500', '4000']), minimo: 20, maximo: 100, onChange: (p: Ponto[]) => { recebido = p; } });
  const t = texto(arvore);
  assert.match(t, /Completar os preços/);
  assert.match(t, /Faltam 6 preços/);
  assert.doesNotMatch(t, /A primeira deve ser 20 e a última 100/, 'com preços vazios, o selo não acusa os limites');
  assert.equal(achar(arvore, 'input', 'Valor a somar a cada intervalo de convidados').props.value, '500,00');
  const botao = achar(arvore, 'button', /Completar 6 preços/);
  (botao.props.onClick as () => void)();
  assert.deepEqual((recebido as Ponto[] | null)?.map((p) => p.valor).slice(3), ['4500,00', '5000,00', '5500,00', '6000,00', '6500,00', '7000,00']);
  // Tudo preenchido: sem painel e o selo volta a dizer a cobertura.
  const cheia = texto(precos.render('PrecosPorQuantidade', { pontos: tela(['3000', '3500', '4000', '4500', '5000', '5500', '6000', '6500', '7000']), minimo: 20, maximo: 100, onChange: () => {} }));
  assert.doesNotMatch(cheia, /Completar os preços/);
  assert.match(cheia, /Cobre 20 a 100 convidados/);
  // Um preço só: pede o valor a somar.
  const um = texto(precos.render('PrecosPorQuantidade', { pontos: tela(['3000']), minimo: 20, maximo: 100, onChange: () => {} }));
  assert.match(um, /Informe quanto somar/);
});
