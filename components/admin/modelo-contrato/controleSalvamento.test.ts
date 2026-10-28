import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MENSAGEM_CONFLITO, MENSAGEM_INCERTO, PRAZO_MS, criarControleSalvamento, mensagemEncerrado,
  type DependenciasSalvamento, type RascunhoServidor, type RespostaServidor,
} from './controleSalvamento.ts';
import { cliqueComum, deveConfirmarSaida, type CliqueSaida } from './protegerSaida.ts';

/**
 * Salvar manual do modelo de contrato (plano v3, D6 e rev. 10) com promessas controladas e relógio simulado: o teste
 * decide quando cada PATCH/GET responde, falha ou fica parado, e quando o prazo de 15 s passa.
 */
type Pedido<T> = { resolver(v: T): void; rejeitar(e: Error): void; corpo?: unknown };
function cenario(versao = 3) {
  const patches: Array<Pedido<RespostaServidor>> = [];
  const gets: Array<Pedido<RespostaServidor>> = [];
  let relogio = 0;
  let id = 0;
  const timers = new Map<number, { quando: number; fn: () => void }>();
  let seq = 0;
  const deps: DependenciasSalvamento = {
    patch: (corpo) => new Promise((resolver, rejeitar) => { patches.push({ resolver, rejeitar, corpo }); }),
    get: () => new Promise((resolver, rejeitar) => { gets.push({ resolver, rejeitar }); }),
    definirPrazo: (fn, ms) => { const t = ++seq; timers.set(t, { quando: relogio + ms, fn }); return t; },
    limparPrazo: (t) => { timers.delete(t as number); },
    novoEnvioId: () => `envio-${++id}`,
    agora: () => new Date(Date.UTC(2026, 9, 28, 14, 32) + relogio),
  };
  const controle = criarControleSalvamento(deps, { versao });
  return {
    controle, patches, gets,
    async avancar(ms: number) {
      relogio += ms;
      for (const [t, x] of [...timers]) if (x.quando <= relogio) { timers.delete(t); x.fn(); }
      await tique();
    },
  };
}
const tique = () => new Promise((r) => setImmediate(r));
const rascunho = (versao: number, envioId?: string, situacao = 'RASCUNHO'): RascunhoServidor => ({ id: 'r1', situacao, versao, revisao: { conteudo: { titulo: 'x' }, avisos: [], ...(envioId ? { envioId } : {}) } });
const ok = (d: RascunhoServidor): RespostaServidor => ({ ok: true, data: d });
const recusa = (status: number, erro = 'Este rascunho foi alterado em outra tela.'): RespostaServidor => ({ ok: false, status, erro });
const obter = () => ({ conteudo: { titulo: ' com espaços ' }, avisos: [] });
const envioDe = (p: { corpo?: unknown }) => (p.corpo as { revisao: { envioId: string } }).revisao.envioId;

test('salvar: um envio por vez com envioId; sem edição no meio → salvo; com edição → continua não salvo', async () => {
  const s = cenario();
  s.controle.editar();
  const r = s.controle.salvar(obter);
  await tique();
  assert.equal(s.controle.estado().enviando, true);
  assert.deepEqual(await s.controle.salvar(obter), { ok: false, motivo: 'Aguarde o salvamento em andamento.' });
  assert.equal(s.patches.length, 1, 'sem segundo PATCH da mesma aba');
  assert.deepEqual(s.patches[0].corpo, { versao: 3, revisao: { ...obter(), envioId: 'envio-1' } });
  s.patches[0].resolver(ok(rascunho(4, 'envio-1')));
  assert.equal((await r).ok, true);
  assert.equal(s.controle.alterado(), false);
  assert.equal(s.controle.estado().versao, 4);
  assert.equal(s.controle.estado().salvoEm?.toISOString(), '2026-10-28T14:32:00.000Z');

  s.controle.editar();
  const r2 = s.controle.salvar(obter);
  await tique();
  s.controle.editar(); // edição durante o envio
  s.patches[1].resolver(ok(rascunho(5, 'envio-2')));
  assert.equal((await r2).ok, true);
  assert.equal(s.controle.estado().versao, 5);
  assert.equal(s.controle.alterado(), true, 'continua "Alterações não salvas"');
});

test('PATCH travado → 15 s → incerto, botão livre, envio pendente; resposta antiga depois do prazo é ignorada', async () => {
  const s = cenario();
  s.controle.editar();
  const r = s.controle.salvar(obter);
  await tique();
  await s.avancar(PRAZO_MS - 1);
  assert.equal(s.controle.estado().enviando, true);
  await s.avancar(1);
  assert.deepEqual(await r, { ok: false, motivo: MENSAGEM_INCERTO, incerto: true });
  const e = s.controle.estado();
  assert.equal(e.enviando, false);
  assert.deepEqual(e.pendentes, [{ envioId: 'envio-1', revisaoLocal: 1 }]);
  assert.equal(s.controle.alterado(), true, 'texto mantido como não salvo');
  s.patches[0].resolver(ok(rascunho(4, 'envio-1')));
  await tique();
  assert.equal(s.controle.estado().versao, 3, 'resposta tardia não muda nada');
  assert.equal(s.controle.envioNaoConfirmado(), true);
});

test('falha de rede (ou da confirmação de sessão) → incerto, igual ao prazo', async () => {
  const s = cenario();
  s.controle.editar();
  const r = s.controle.salvar(obter);
  await tique();
  s.patches[0].rejeitar(Error('Não foi possível confirmar a sessão depois da resposta.'));
  assert.equal((await r as { incerto?: boolean }).incerto, true);
});

async function incerto() {
  const s = cenario();
  s.controle.editar();
  const r = s.controle.salvar(obter);
  await tique();
  await s.avancar(PRAZO_MS);
  await r;
  return s;
}

test('Conferir: envioId igual ao pendente → chegou (adota a versão; o .trim() do servidor não importa)', async () => {
  const s = await incerto();
  const c = s.controle.conferir();
  await tique();
  s.gets[0].resolver(ok({ ...rascunho(4, 'envio-1'), revisao: { conteudo: { titulo: 'com espaços' }, avisos: [], envioId: 'envio-1' } }));
  assert.equal(await c, 'chegou');
  assert.equal(s.controle.estado().versao, 4);
  assert.equal(s.controle.alterado(), false);
  assert.deepEqual(s.controle.estado().pendentes, []);
});

test('Conferir: chegou, mas houve edição depois → adota a versão e mantém a pendência', async () => {
  const s = await incerto();
  s.controle.editar();
  const c = s.controle.conferir();
  await tique();
  s.gets[0].resolver(ok(rascunho(4, 'envio-1')));
  assert.equal(await c, 'chegou');
  assert.equal(s.controle.estado().versao, 4);
  assert.equal(s.controle.alterado(), true);
});

test('Conferir: envioId diferente e mesma versão → ainda não confirmado; versão maior → conflito', async () => {
  const s = await incerto();
  const c = s.controle.conferir();
  await tique();
  s.gets[0].resolver(ok(rascunho(3, 'outro')));
  assert.equal(await c, 'nao_confirmado');
  assert.equal(s.controle.estado().naoConfirmado, true);
  assert.equal(s.controle.estado().conflito, false);

  const t = await incerto();
  const c2 = t.controle.conferir();
  await tique();
  t.gets[0].resolver(ok(rascunho(4, 'outro')));
  assert.equal(await c2, 'conflito');
  assert.equal(t.controle.estado().conflito, true);
  assert.deepEqual(await t.controle.salvar(obter), { ok: false, motivo: MENSAGEM_CONFLITO });
  assert.equal(t.patches.length, 1, 'nada é sobrescrito');
});

test('o PATCH antigo chega entre o Conferir e a repetição → 409 → confere, adota e reenvia UMA vez → salvo, sem conflito', async () => {
  const s = await incerto();
  const conf = s.controle.conferir();
  await tique();
  s.gets[0].resolver(ok(rascunho(3)));
  assert.equal(await conf, 'nao_confirmado');
  s.controle.editar();
  const r = s.controle.salvar(obter);
  await tique();
  assert.equal(envioDe(s.patches[1]), 'envio-2');
  s.patches[1].resolver(recusa(409));
  await tique();
  s.gets[1].resolver(ok(rascunho(4, 'envio-1')));
  await tique(); await tique();
  assert.equal(s.patches.length, 3, 'reenvio único');
  assert.deepEqual(s.patches[2].corpo, { versao: 4, revisao: { ...obter(), envioId: 'envio-3' } });
  s.patches[2].resolver(ok(rascunho(5, 'envio-3')));
  assert.equal((await r).ok, true);
  assert.equal(s.controle.estado().conflito, false);
  assert.equal(s.controle.alterado(), false);
});

test('segundo 409 depois do reenvio único → encerra a tentativa e mostra conflito (sem terceiro envio)', async () => {
  const s = await incerto();
  const conf = s.controle.conferir(); await tique();
  s.gets[0].resolver(ok(rascunho(3)));
  await conf;
  const r = s.controle.salvar(obter);
  await tique();
  s.patches[1].resolver(recusa(409)); await tique();
  assert.equal(s.gets.length, 2, 'confere antes de mostrar conflito');
  s.gets[1].resolver(ok(rascunho(4, 'envio-1'))); await tique(); await tique();
  assert.equal(s.patches.length, 3, 'reenvio único');
  s.patches[2].resolver(recusa(409));
  assert.deepEqual(await r, { ok: false, motivo: MENSAGEM_CONFLITO });
  assert.equal(s.patches.length, 3);
  assert.equal(s.controle.estado().conflito, true);
});

test('409 sem envio incerto → conflito direto, sem Conferir', async () => {
  const s = cenario();
  s.controle.editar();
  const r = s.controle.salvar(obter);
  await tique();
  s.patches[0].resolver(recusa(409));
  assert.deepEqual(await r, { ok: false, motivo: MENSAGEM_CONFLITO });
  assert.equal(s.controle.estado().conflito, true, 'faixa de conflito');
  assert.equal(s.gets.length, 0);
});

test('salvar depois de envio incerto confere antes; Conferir travado → 15 s → falha com "Tentar de novo", sem travar o Salvar', async () => {
  const s = await incerto();
  const r = s.controle.salvar(obter);
  await tique();
  assert.equal(s.gets.length, 1, 'confere antes de repetir');
  assert.equal(s.patches.length, 1);
  await s.avancar(PRAZO_MS);
  assert.equal((await r).ok, false);
  assert.equal(s.controle.estado().falhaConferir, true);
  assert.equal(s.controle.estado().conferindo, false);
  s.gets[0].resolver(ok(rascunho(9, 'x')));
  await tique();
  assert.equal(s.controle.estado().conflito, false, 'resposta antiga do Conferir ignorada');
  const r2 = s.controle.salvar(obter);
  await tique();
  s.gets[1].resolver(ok(rascunho(3)));
  await tique(); await tique();
  assert.equal(s.patches.length, 2, 'Salvar segue utilizável');
  s.patches[1].resolver(ok(rascunho(4, envioDe(s.patches[1]))));
  assert.equal((await r2).ok, true);
});

test('rascunho publicado ou descartado em outra aba durante a reconciliação → para, texto só para consulta, sem PATCH nem publicar', async () => {
  for (const situacao of ['PUBLICADA', 'DESCARTADA']) {
    const s = await incerto();
    const c = s.controle.conferir(); await tique();
    s.gets[0].resolver(ok(rascunho(4, 'envio-1', situacao)));
    assert.equal(await c, 'encerrado');
    assert.deepEqual(s.controle.estado().encerrado, { situacao, pendenteChegou: true });
    assert.match(mensagemEncerrado(s.controle.estado().encerrado!), situacao === 'PUBLICADA' ? /publicado em outra aba.*chegou antes/ : /descartado em outra aba.*chegou antes/);
    assert.equal((await s.controle.salvar(obter)).ok, false);
    assert.equal((await s.controle.prepararPublicacao(obter)).ok, false);
    assert.equal(s.patches.length, 1, 'nenhum PATCH repetido');
  }
  const t = await incerto();
  const r = t.controle.salvar(obter); await tique();
  t.gets[0].resolver(ok(rascunho(3, 'outro', 'PUBLICADA')));
  assert.equal((await r).ok, false);
  assert.deepEqual(t.controle.estado().encerrado, { situacao: 'PUBLICADA', pendenteChegou: false });
});

test('publicar: salva antes e usa a versão confirmada; incerto ou travado → não publica e não espera para sempre', async () => {
  const s = cenario();
  s.controle.editar();
  const p = s.controle.prepararPublicacao(obter);
  await tique();
  assert.equal(s.patches.length, 1, 'salva antes de publicar');
  s.patches[0].resolver(ok(rascunho(4, 'envio-1')));
  assert.deepEqual(await p, { ok: true, versao: 4 });

  const t = cenario();
  t.controle.editar();
  const p2 = t.controle.prepararPublicacao(obter);
  await tique();
  await t.avancar(PRAZO_MS);
  const r2 = await p2;
  assert.equal(r2.ok, false);
  assert.match((r2 as { motivo: string }).motivo, /^Não publicado: O salvamento não foi confirmado/);

  const u = cenario();
  assert.deepEqual(await u.controle.prepararPublicacao(obter), { ok: true, versao: 3 }, 'sem alteração: não salva');
  assert.equal(u.patches.length, 0);
});

test('reiniciar (outro rascunho ou recarregar depois de conflito) zera pendências e ignora respostas em voo', async () => {
  const s = await incerto();
  const r = s.controle.salvar(obter); await tique();
  assert.equal(s.gets.length, 1, 'confere antes de repetir');
  s.controle.reiniciar(7);
  s.gets[0].resolver(ok(rascunho(9, 'x')));
  await r;
  const e = s.controle.estado();
  assert.deepEqual({ versao: e.versao, pendentes: e.pendentes, conflito: e.conflito, alterado: s.controle.alterado() }, { versao: 7, pendentes: [], conflito: false, alterado: false });
});

// ── Saídas controladas ─────────────────────────────────────────────────────────
const LOCAL = { origin: 'https://app.kidmais.test', pathname: '/admin/configuracoes/importar-documentos', search: '?documento=contrato' };
const clique = (ancora: Partial<NonNullable<CliqueSaida['ancora']>> | null, extra: Partial<CliqueSaida> = {}): CliqueSaida => ({
  defaultPrevented: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  ancora: ancora && { href: '/admin/festas', target: '', download: false, semProtecao: false, ...ancora }, ...extra,
});

test('deveConfirmarSaida: pergunta só com alteração e só em link interno comum', () => {
  assert.equal(deveConfirmarSaida(clique({}), true, LOCAL), '/admin/festas');
  assert.equal(deveConfirmarSaida(clique({}), false, LOCAL), null, 'sem alteração: só navega');
  assert.equal(deveConfirmarSaida(clique({ href: '/admin/configuracoes/importar-documentos?documento=tabela' }), true, LOCAL), '/admin/configuracoes/importar-documentos?documento=tabela');
  const ignorados: Array<[string, CliqueSaida]> = [
    ['já tratado', clique({}, { defaultPrevented: true })], ['botão do meio', clique({}, { button: 1 })],
    ['ctrl', clique({}, { ctrlKey: true })], ['cmd', clique({}, { metaKey: true })], ['shift', clique({}, { shiftKey: true })], ['alt', clique({}, { altKey: true })],
    ['_blank', clique({ target: '_blank' })], ['download', clique({ download: true })], ['externo', clique({ href: 'https://outro.example/x' })],
    ['âncora na página', clique({ href: '#clausulas' })], ['data-sem-protecao (abas)', clique({ semProtecao: true })], ['sem âncora', clique(null)],
  ];
  for (const [nome, e] of ignorados) assert.equal(deveConfirmarSaida(e, true, LOCAL), null, nome);
  assert.equal(deveConfirmarSaida(clique({ target: '_self' }), true, LOCAL), '/admin/festas');
  assert.equal(cliqueComum(clique({})), true);
  assert.equal(cliqueComum(clique({}, { ctrlKey: true })), false);
});

test('descartar (fechar o rascunho): resposta em voo vira "ignorada", não muda o estado nem avisa a tela', async () => {
  const s = cenario();
  let avisos = 0;
  s.controle.assinar(() => { avisos++; });
  s.controle.editar();
  const r = s.controle.salvar(obter);
  await tique();
  const antes = avisos;
  s.controle.descartar();
  s.patches[0].resolver(ok(rascunho(4, 'envio-1')));
  const res = await r;
  assert.deepEqual(res, { ok: false, motivo: 'Resposta antiga ignorada.', ignorada: true });
  assert.equal(avisos, antes, 'nenhum aviso depois de descartar');
  assert.equal(s.controle.estado().versao, 3);
  assert.equal((await s.controle.salvar(obter) as { ignorada?: true }).ignorada, true, 'controle fechado não envia');
  assert.equal(s.patches.length, 1);
  assert.equal((await s.controle.prepararPublicacao(obter) as { ignorada?: true }).ignorada, true);
});
