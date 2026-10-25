import test from 'node:test';
import assert from 'node:assert/strict';
import * as modeloPreco from '../../lib/comercial/modelo-preco.ts';
import * as liberacao from '../../lib/agenda/saloes-liberacao.ts';
import { achar, carregarComponente, cssFalso, texto } from './teste-componente.ts';

/** Validação no navegador de 22/10/2026 (P3): numeração do assistente no horário livre e confirmação sem limites. */
test('assistente: no horário livre são 5 passos, sem salto (3 → 4 → 5); horários fixos seguem 6', () => {
  const m = carregarComponente('components/admin/AssistenteAgenda.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({}) }, './AdminPrimaryButton': { AdminPrimaryButton: 'button' },
    '@/lib/agenda/saloes-liberacao': liberacao, './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso,
  }).modulo as { numeracaoAssistente: (p: number, m: string) => { passoVisivel: number; totalVisivel: number } };
  assert.deepEqual([3, 5, 6].map((p) => m.numeracaoAssistente(p, 'LIVRE')), [
    { passoVisivel: 3, totalVisivel: 5 }, { passoVisivel: 4, totalVisivel: 5 }, { passoVisivel: 5, totalVisivel: 5 }]);
  assert.deepEqual([3, 4, 6].map((p) => m.numeracaoAssistente(p, 'FIXO').passoVisivel), [3, 4, 6]);
  assert.equal(m.numeracaoAssistente(4, 'FIXO').totalVisivel, 6);
});

test('confirmação de preços: pacote sem mínimo/máximo explica o motivo e bloqueia o botão (nada vai ao servidor)', () => {
  const precos = carregarComponente('components/admin/PrecosPorQuantidade.tsx', {
    '@/lib/comercial/modelo-preco': modeloPreco, './precos-quantidade.module.css': cssFalso, './workspace.module.css': cssFalso,
  }).modulo;
  const nova = () => carregarComponente('components/admin/ConfirmarPrecosPacote.tsx', {
    '@/lib/comercial/modelo-preco': modeloPreco, './AdminPrimaryButton': { AdminPrimaryButton: 'button' }, './PrecosPorQuantidade': precos,
    './precos-quantidade.module.css': cssFalso, './workspace.module.css': cssFalso,
  });
  const tela = nova();
  let confirmou = false;
  const props = { nome: 'Festa Completa', faixas: [{ convidadosMin: 1, convidadosMax: null, valor: '100.00' }], proposta: [], minimo: 0, maximo: 0,
    carregando: false, onVoltar: () => {}, onConfirmar: () => { confirmou = true; } };
  const arvore = tela.render('ConfirmarPrecosPacote', props);
  assert.match(texto(arvore), /Defina os convidados mínimo e máximo deste pacote/);
  assert.match(texto(arvore), /ainda não tem mínimo e máximo de convidados/);
  assert.doesNotMatch(texto(arvore), /vai de 0 a 0/);
  const botao = achar(arvore, 'button', 'Corrija os preços para confirmar');
  assert.equal(botao.props.disabled, true);
  assert.equal(confirmou, false);
  // Controle: com limites e proposta válida, o botão fica ativo.
  const ok = nova().render('ConfirmarPrecosPacote', { ...props, minimo: 50, maximo: 70,
    proposta: [{ convidados: 50, valor: '5000.00' }, { convidados: 60, valor: '5600.00' }, { convidados: 70, valor: '6200.00' }] });
  assert.equal(achar(ok, 'button', 'Confirmar novos preços').props.disabled, false);
});

test('configuração da agenda: o aviso do horário livre explica que festas nos horários anteriores continuam ocupando', async () => {
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync('components/admin/AgendaConfiguracao.tsx', 'utf8');
  const aviso = fonte.slice(fonte.indexOf('data-aviso-modo-livre'), fonte.indexOf('</p>', fonte.indexOf('data-aviso-modo-livre')));
  assert.doesNotMatch(aviso, /só confere/);
  assert.match(aviso, /form\.capacidadeTipo === 'POR_HORARIO'/);
  // Com um salão a capacidade é sempre 1 (decisão de Felipe, 25/10): "mesmo com capacidade sobrando" deixou de fazer sentido.
  assert.match(aviso, /Festas já marcadas nos horários fixos anteriores continuam ocupando a agenda: um horário livre que se sobreponha a elas fica indisponível\.'/);
});

// Decisão de Felipe (23/10, P3 do Astra): o bloqueio de todos os salões pela festa sem salão continua e é explicado.
test('festa confirmada sem salão: a tela explica que ela ocupa todos os salões até ter um; sem confirmação, o texto de antes', async () => {
  const montar = async (dados: object) => {
    const tela = carregarComponente('components/admin/SalaoDaFesta.tsx', {
      '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({ ok: true, data: dados }) },
      './AdminPrimaryButton': { AdminPrimaryButton: 'button' }, './workspace.module.css': cssFalso,
    });
    tela.render('SalaoDaFesta', { fechamentoId: 'f' }); tela.efeitos();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    return texto(tela.render('SalaoDaFesta', { fechamentoId: 'f' }));
  };
  const opcoes = [{ id: 's1', nome: 'Salão 1', livre: true, permitido: true }];
  assert.match(await montar({ salaoAtual: null, opcoes, confirmada: true }), /esta festa ocupa todos os salões no horário dela \(e no intervalo mínimo\)\. Escolha um salão livre abaixo para liberar os demais\./);
  assert.match(await montar({ salaoAtual: null, opcoes, confirmada: false }), /Ainda sem salão\. O sistema escolhe na confirmação\./);
  assert.match(await montar({ salaoAtual: { id: 's1', nome: 'Salão 1' }, opcoes, confirmada: true }), /Salão atual: Salão 1/);
});

test('configuração da agenda: por salão explica o bloqueio pelas festas sem salão, também na confirmação da troca', async () => {
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync('components/admin/AgendaConfiguracao.tsx', 'utf8');
  assert.match(fonte, /export const AVISO_SEM_SALAO = 'Festas já marcadas sem salão definido ocupam todos os salões no horário delas \(e no intervalo mínimo\) até a equipe escolher o salão de cada uma\. Escolha o salão na tela da festa para liberar os demais\.';/);
  assert.match(fonte, /\{form\.capacidadeTipo === 'POR_SALAO' && <p className=\{css\.fraco\} data-aviso-sem-salao>\{AVISO_SEM_SALAO\}<\/p>\}/);
  assert.match(fonte, /\{form\.capacidadeTipo === 'POR_SALAO' && config\?\.capacidadeTipo !== 'POR_SALAO' && totalFestas > 0 && <p data-aviso-sem-salao-troca>\{AVISO_SEM_SALAO\}<\/p>\}/);
});
