import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abrirDeNovo, aplicarAbertura, aplicarEnvio, classificar, concluirItem, CONSULTAS_EM_ANDAMENTO_MS, continuarLote, iniciarPasso, loteOcioso, loteOcupado,
  MAXIMO_POR_LOTE, MENSAGEM_CONSULTAS_ESGOTADAS, MENSAGEM_INCERTA, MENSAGEM_LIMITE_ABERTURAS, MENSAGENS_RETIRADA, novoLote, pausaEmAndamento, pausaIncerta, prepararArquivos,
  proximoParaRevisar, proximoPasso, retirar, situacaoNaLista, tentarDeNovo, type Lote, type Retorno,
} from './fila-lote.ts';
import { criarArmazemLote, rodarLote, type Aplicar } from './executor-lote.ts';
/** Mesma forma do ErroContextoAdmin (o adminFetch real é coberto em admin-fetch-tipo.test.ts). */
class ErroContextoAdmin extends Error { tipo: string; enviado: boolean; constructor(tipo: string, mensagem: string, enviado: boolean) { super(mensagem); this.tipo = tipo; this.enviado = enviado; } }

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lote = (n: number) => novoLote(Array.from({ length: n }, (_, k) => ({ id: `i${k}`, aberturaId: UUID(100 + k), nome: `c${k}.pdf`, tamanho: 10 })));
const resp = (status: number, corpo: unknown): Retorno => ({ tipo: 'resposta', status, corpo });
const okDoc = (documentoId: string, avisos: string[] = [], valor: string | null = 'Ana') => resp(200, { ok: true, data: { documentoId, avisos, extracao: { secoes: [{ campos: [{ valor }] }] } } });
const okImp = (status: 'EM_REVISAO' | 'IMPORTADA' | 'DESCARTADA', id = UUID(900), versao = 1) => resp(200, { ok: true, data: { importacao: { id, versao, status } } });
const erro = (status: number, codigo: string | null, msg = 'erro do servidor') => resp(status, { ok: false, erro: msg, ...(codigo ? { codigo } : {}) });
const excecao = (tipo: string | undefined, enviado: boolean): Retorno => ({ tipo: 'excecao', erro: { tipo, enviado, message: 'm' } });

test('classificar: precedência contexto > recurso > cota > em andamento > ok > item; incerto para rede, ilegível e 5xx', () => {
  for (const t of ['SESSAO_NAO_CONFIRMADA', 'CONTEXTO_MUDOU', 'SESSAO_ENCERRADA', 'RECUSADA_PELO_CONTEXTO']) assert.equal(classificar(excecao(t, false)).sinal, 'CONTEXTO');
  assert.equal(classificar(excecao('REDE', true)).sinal, 'INCERTO');
  assert.equal(classificar(excecao('RESULTADO_INCERTO', true)).sinal, 'INCERTO');
  assert.equal(classificar(excecao(undefined, false)).sinal, 'INCERTO');
  assert.equal(classificar(erro(401, null)).sinal, 'CONTEXTO');
  assert.equal(classificar(erro(403, 'INTELIGENCIA_DESATIVADA')).sinal, 'CONTEXTO', '403 vence o código de recurso');
  assert.equal(classificar(erro(409, 'TENANT_NAO_COMPROVADO')).sinal, 'CONTEXTO');
  assert.equal(classificar(erro(409, 'AUTENTICACAO_ADMINISTRATIVA')).sinal, 'CONTEXTO');
  for (const c of ['INTELIGENCIA_DESATIVADA', 'DOCUMENTOS_INDISPONIVEIS', 'IMPORTACAO_INDISPONIVEL', 'COTA_INDISPONIVEL']) assert.equal(classificar(erro(503, c)).sinal, 'RECURSO', c);
  assert.equal(classificar(erro(429, 'COTA_IMPORTACAO_ESGOTADA')).sinal, 'COTA');
  assert.equal(classificar(erro(409, 'LEITURA_EM_ANDAMENTO')).sinal, 'EM_ANDAMENTO');
  assert.equal(classificar(okDoc('d')).sinal, 'OK');
  assert.deepEqual(classificar(erro(409, 'LEITURA_EXPIRADA')), { sinal: 'ITEM', mensagem: 'erro do servidor', codigo: 'LEITURA_EXPIRADA', podeRepetir: true });
  assert.deepEqual(classificar(erro(422, 'ARQUIVO_INVALIDO')), { sinal: 'ITEM', mensagem: 'erro do servidor', codigo: 'ARQUIVO_INVALIDO', podeRepetir: false });
  assert.equal(classificar(erro(500, null)).sinal, 'INCERTO');
  assert.equal(classificar(erro(502, 'QUALQUER')).sinal, 'INCERTO');
  assert.equal(classificar(resp(200, undefined)).sinal, 'INCERTO', 'resposta ilegível');
  assert.equal(classificar(resp(200, { ok: false })).sinal, 'INCERTO', '2xx sem ok');
  assert.equal(classificar(resp(400, undefined)).sinal, 'INCERTO', '4xx ilegível');
});

test('D-LOTE-1: 21 PDFs recusados antes de qualquer envio; não-PDF fica fora; nenhum PDF recusa', () => {
  const pdf = (n: number) => ({ name: `a${n}.pdf`, size: 1, type: 'application/pdf' });
  const r = prepararArquivos(Array.from({ length: MAXIMO_POR_LOTE + 1 }, (_, k) => pdf(k)));
  assert.equal(r.ok, false);
  assert.match((r as { mensagem: string }).mensagem, /até 20 PDFs.*foram 21.*Nada foi enviado/);
  const v = prepararArquivos([...Array.from({ length: 20 }, (_, k) => pdf(k)), { name: 'x.docx', size: 1, type: 'application/msword' }, { name: 'MAIUSC.PDF', size: 1, type: '' }]);
  assert.equal(v.ok, false, '21 PDFs contando o .PDF sem tipo');
  const w = prepararArquivos([pdf(1), { name: 'x.docx', size: 1, type: 'x' }]);
  assert.deepEqual(w.ok && { n: w.arquivos.length, ignorados: w.ignorados }, { n: 1, ignorados: ['x.docx'] });
  assert.equal(prepararArquivos([{ name: 'x.png', size: 1, type: 'image/png' }]).ok, false);
});

test('fluxo feliz: envio → LIDO → abrir → PRONTO; só o próximo arquivo depois de abrir; ocioso no fim', () => {
  let l = lote(2);
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ENVIAR', itemId: 'i0' });
  l = iniciarPasso(l, { tipo: 'ENVIAR', itemId: 'i0' });
  assert.equal(l.itens[0].estado, 'ENVIANDO');
  l = aplicarEnvio(l, 'i0', okDoc(UUID(1)), 0);
  assert.equal(l.itens[0].estado, 'LIDO');
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ABRIR', itemId: 'i0' });
  l = aplicarAbertura(iniciarPasso(l, { tipo: 'ABRIR', itemId: 'i0' }), 'i0', okImp('EM_REVISAO'));
  assert.equal(l.itens[0].estado, 'PRONTO');
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ENVIAR', itemId: 'i1' });
  l = aplicarAbertura(aplicarEnvio(l, 'i1', okDoc(UUID(2)), 0), 'i1', okImp('EM_REVISAO', UUID(901)));
  assert.equal(loteOcioso(l, 0), true);
  assert.equal(proximoParaRevisar(l)?.id, 'i0');
  assert.equal(proximoParaRevisar(l, 'i0')?.id, 'i1');
  l = concluirItem(l, 'i0', 'IMPORTADA');
  assert.equal(proximoParaRevisar(l)?.id, 'i1');
  assert.equal(proximoParaRevisar(concluirItem(l, 'i1', 'DESCARTADA')), null);
});

test('R2-4: só EM_REVISAO fica PRONTO; IMPORTADA/DESCARTADA ficam ENCERRADO e não são "próximo"', () => {
  for (const st of ['IMPORTADA', 'DESCARTADA'] as const) {
    const l = aplicarAbertura(aplicarEnvio(lote(1), 'i0', okDoc(UUID(1)), 0), 'i0', okImp(st));
    assert.equal(l.itens[0].estado, 'ENCERRADO');
    assert.equal(l.itens[0].encerramento, st);
    assert.equal(proximoParaRevisar(l), null);
  }
});

test('INVALIDAR: para tudo, domina PARAR e não deixa passo; item já enviado fica incerto, não enviado volta à fila', () => {
  let l = aplicarEnvio(lote(3), 'i0', excecao('CONTEXTO_MUDOU', false), 0);
  assert.equal(l.parada?.tipo, 'INVALIDAR');
  assert.equal(l.itens[0].estado, 'NA_FILA');
  assert.equal(proximoPasso(l, 0), null);
  l = aplicarEnvio(l, 'i1', erro(503, 'DOCUMENTOS_INDISPONIVEIS'), 0);
  assert.equal(l.parada?.tipo, 'INVALIDAR', 'PARAR não substitui INVALIDAR');
  const m = aplicarEnvio(aplicarEnvio(lote(2), 'i0', erro(503, 'IMPORTACAO_INDISPONIVEL'), 0), 'i1', erro(403, null, 'sem acesso'), 0);
  assert.deepEqual(m.parada, { tipo: 'INVALIDAR', mensagem: 'sem acesso' }, 'INVALIDAR substitui PARAR');
  const e = aplicarEnvio(lote(1), 'i0', excecao('SESSAO_ENCERRADA', true), 0);
  assert.equal(e.itens[0].estado, 'INCERTO');
  assert.equal(e.itens[0].etapaIncerta, 'UPLOAD');
  const a = aplicarAbertura(aplicarEnvio(lote(1), 'i0', okDoc(UUID(1)), 0), 'i0', erro(401, null));
  assert.equal(a.itens[0].estado, 'LIDO_SEM_REVISAO');
  assert.equal(a.itens[0].recuperar, true);
});

test('PARAR: recurso fechado e cota esgotada param o lote; a primeira parada fica', () => {
  const l = aplicarEnvio(lote(3), 'i0', erro(429, 'COTA_IMPORTACAO_ESGOTADA', 'cota'), 0);
  assert.deepEqual(l.parada, { tipo: 'PARAR', mensagem: 'cota' });
  assert.equal(l.itens[0].estado, 'FALHOU');
  assert.equal(proximoPasso(l, 0), null);
  assert.deepEqual(aplicarEnvio(l, 'i1', erro(503, 'INTELIGENCIA_DESATIVADA', 'ia'), 0).parada, { tipo: 'PARAR', mensagem: 'cota' });
  const ab = aplicarAbertura(aplicarEnvio(lote(2), 'i0', okDoc(UUID(1)), 0), 'i0', erro(503, 'IMPORTACAO_INDISPONIVEL', 'fechado'));
  assert.equal(ab.parada?.tipo, 'PARAR');
  assert.equal(ab.itens[0].estado, 'LIDO_SEM_REVISAO');
});

test('orçamento: pausa até Continuar; mesmo com leitura vazia; a abertura do lido segue; pausa sobrevive à reconciliação', () => {
  let l = aplicarEnvio(lote(3), 'i0', okDoc(UUID(1), ['MODELO_ORCAMENTO'], null), 0);
  assert.deepEqual(l.pausas, ['ORCAMENTO']);
  assert.equal(l.itens[0].parcial, true);
  assert.equal(l.itens[0].temDados, false);
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ABRIR', itemId: 'i0' }, 'abrir o lido não é arquivo novo');
  // A abertura falha de forma incerta e a recuperação dá certo: ORCAMENTO continua.
  l = aplicarAbertura(l, 'i0', excecao('REDE', true));
  assert.deepEqual(l.pausas.sort(), ['INCERTO:i0', 'ORCAMENTO']);
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'RETOMAR', itemId: 'i0' });
  l = aplicarAbertura(l, 'i0', okImp('EM_REVISAO'));
  assert.deepEqual(l.pausas, ['ORCAMENTO']);
  assert.equal(proximoPasso(l, 0), null, 'nada novo sai pausado');
  // Mudar o rótulo do item (retirar o que causou o orçamento) não solta a pausa.
  l = retirar(l, 'i0', 'NA_LISTA');
  assert.deepEqual(l.pausas, ['ORCAMENTO']);
  assert.equal(proximoPasso(l, 0), null);
  l = continuarLote(l);
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ENVIAR', itemId: 'i1' });
});

test('R3-2 envio incerto: pausa, reenvia só aquele arquivo uma vez, depois espera a pessoa', () => {
  let l = aplicarEnvio(lote(3), 'i0', excecao('RESULTADO_INCERTO', true), 0);
  assert.deepEqual(l.pausas, ['INCERTO:i0']);
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ENVIAR', itemId: 'i0' });
  l = aplicarEnvio(iniciarPasso(l, { tipo: 'ENVIAR', itemId: 'i0' }), 'i0', erro(500, null), 0);
  assert.equal(l.itens[0].tentativas, 2);
  assert.equal(proximoPasso(l, 0), null, 'sem terceira tentativa automática nem arquivo novo');
  l = tentarDeNovo(l, 'i0');
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ENVIAR', itemId: 'i0' });
  l = aplicarEnvio(l, 'i0', okDoc(UUID(1)), 0);
  assert.deepEqual(l.pausas, []);
  assert.equal(l.itens[0].estado, 'LIDO');
});

test('R3-2 em andamento: consultas em 2, 5, 10 e 16 min contadas do primeiro encontro; nada novo sai; falha depois da última', () => {
  const MIN = 60_000;
  let l = aplicarEnvio(lote(2), 'i0', erro(409, 'LEITURA_EM_ANDAMENTO'), 1000);
  assert.deepEqual(l.pausas, [pausaEmAndamento('i0')]);
  const marcos: number[] = [];
  for (let k = 0; k < CONSULTAS_EM_ANDAMENTO_MS.length; k++) {
    const quando = l.itens[0].proximaConsultaEm!;
    marcos.push((quando - 1000) / MIN);
    assert.equal(proximoPasso(l, quando - 1), null, 'antes do marco: nada, nem arquivo novo');
    assert.deepEqual(proximoPasso(l, quando), { tipo: 'ENVIAR', itemId: 'i0' });
    l = aplicarEnvio(l, 'i0', erro(409, 'LEITURA_EM_ANDAMENTO'), quando + 7000);
  }
  assert.deepEqual(marcos, [2, 5, 10, 16]);
  assert.equal(l.itens[0].estado, 'FALHOU');
  assert.deepEqual(l.pausas, []);
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ENVIAR', itemId: 'i1' });
});

test('R5-2 retirar: 3 mensagens; nada apagado; só os motivos do próprio item saem', () => {
  const doc = { ...lote(1).itens[0], documentoId: UUID(1) };
  assert.equal(situacaoNaLista(doc, new Set([UUID(1)])), 'NA_LISTA');
  assert.equal(situacaoNaLista(doc, new Set()), 'FORA_DA_LISTA');
  assert.equal(situacaoNaLista(doc, null), 'DESCONHECIDO', 'lista indisponível');
  assert.equal(situacaoNaLista({ ...lote(1).itens[0], etapaIncerta: 'UPLOAD' }, new Set()), 'DESCONHECIDO');
  assert.equal(situacaoNaLista({ ...lote(1).itens[0], estado: 'FALHOU' }, null), 'FORA_DA_LISTA');
  assert.equal(new Set(Object.values(MENSAGENS_RETIRADA)).size, 3);
  let l: Lote = aplicarEnvio(aplicarEnvio(lote(3), 'i0', excecao('REDE', true), 0), 'i1', erro(409, 'LEITURA_EM_ANDAMENTO'), 0);
  l = { ...l, pausas: [...l.pausas, 'ORCAMENTO'] };
  const r = retirar(l, 'i0', 'DESCONHECIDO');
  assert.deepEqual(r.pausas.sort(), [pausaEmAndamento('i1'), 'ORCAMENTO'].sort());
  assert.equal(r.itens[0].estado, 'RETIRADO');
  assert.equal(r.itens[0].retirada, MENSAGENS_RETIRADA.DESCONHECIDO);
  assert.notEqual(proximoPasso(r, Number.MAX_SAFE_INTEGER)?.itemId, 'i0');
  assert.ok(!r.pausas.includes(pausaIncerta('i0')));
});

test('R1-5 mesmo arquivo com dois nomes: DUPLICADO pelo documentoId do servidor, sem segunda abertura', () => {
  let l = aplicarAbertura(aplicarEnvio(lote(2), 'i0', okDoc(UUID(7)), 0), 'i0', okImp('EM_REVISAO'));
  l = aplicarEnvio(l, 'i1', okDoc(UUID(7)), 0);
  assert.equal(l.itens[1].estado, 'DUPLICADO');
  assert.equal(l.itens[1].duplicadoDe, 'i0');
  assert.match(l.itens[1].motivo!, /Mesmo arquivo de "c0.pdf"/);
  assert.equal(proximoPasso(l, 0), null);
});

test('LIMITE_ABERTURAS: falha sem repetição automática e orienta a lista', () => {
  const l = aplicarAbertura(aplicarEnvio(lote(1), 'i0', okDoc(UUID(1)), 0), 'i0', erro(409, 'LIMITE_ABERTURAS'));
  assert.equal(l.itens[0].estado, 'FALHOU');
  assert.equal(l.itens[0].motivo, MENSAGEM_LIMITE_ABERTURAS);
  assert.equal(proximoPasso(l, 0)?.itemId, undefined);
  assert.equal(tentarDeNovo(l, 'i0'), l, 'com documento confirmado nunca volta ao envio');
});

/** Servidor falso: conta envios e ações, com roteiro por chamada. */
function servidor(roteiro: { upload: Array<() => Response | Promise<Response>>; acao: Array<(corpo: { acao: string; documentoId: string; aberturaId: string }) => Response | Promise<Response>> }) {
  const chamadas: Array<{ tipo: 'upload' } | { tipo: 'acao'; acao: string; aberturaId: string; documentoId: string }> = [];
  const buscar = async (url: string, init: RequestInit) => {
    if (url.endsWith('/documentos')) {
      chamadas.push({ tipo: 'upload' });
      const f = roteiro.upload.shift(); if (!f) throw Error('upload além do roteiro');
      return f();
    }
    const corpo = JSON.parse(String(init.body));
    chamadas.push({ tipo: 'acao', acao: corpo.acao, aberturaId: corpo.aberturaId, documentoId: corpo.documentoId });
    const f = roteiro.acao.shift(); if (!f) throw Error('ação além do roteiro');
    return f(corpo);
  };
  return { chamadas, buscar };
}
const jsonDoc = (id: string, avisos: string[] = []) => () => Response.json({ ok: true, data: { documentoId: id, avisos, extracao: { secoes: [] } } });
const jsonImp = (status = 'EM_REVISAO') => () => Response.json({ ok: true, data: { importacao: { id: UUID(900), versao: 1, status } } });
const rede = (enviado: boolean) => () => { throw new ErroContextoAdmin(enviado ? 'RESULTADO_INCERTO' : 'REDE', 'Falha de conexão.', enviado); };
const arquivoFalso = (id: string) => new File(['%PDF'], `${id}.pdf`, { type: 'application/pdf' });

async function rodar(l: Lote, buscar: (u: string, i: RequestInit) => Promise<Response>, agora = () => 0) {
  let atual = l;
  await rodarLote(() => atual, (a: Aplicar) => { atual = a(atual); }, { buscar, agora, arquivo: arquivoFalso }, () => true);
  return atual;
}

test('R3-3 contagem: envio vazio + abertura que falha ⇒ zero novos envios e só `retomar` com a mesma identidade', async () => {
  const s = servidor({ upload: [jsonDoc(UUID(1))], acao: [rede(true), jsonImp()] });
  const l = await rodar(lote(1), s.buscar);
  assert.deepEqual(s.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['upload', 'abrir', 'retomar']);
  const acoes = s.chamadas.filter((c) => c.tipo === 'acao') as Array<{ aberturaId: string; documentoId: string }>;
  assert.deepEqual(new Set(acoes.map((a) => a.aberturaId)), new Set([UUID(100)]));
  assert.deepEqual(new Set(acoes.map((a) => a.documentoId)), new Set([UUID(1)]));
  assert.equal(l.itens[0].estado, 'PRONTO');
});

test('R3-3 contagem: abertura incerta duas vezes ⇒ para sem terceira chamada e sem reenviar o PDF', async () => {
  const s = servidor({ upload: [jsonDoc(UUID(1))], acao: [rede(true), () => new Response('x', { status: 502 })] });
  const l = await rodar(lote(2), s.buscar);
  assert.deepEqual(s.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['upload', 'abrir', 'retomar']);
  assert.equal(l.itens[0].estado, 'LIDO_SEM_REVISAO');
  assert.equal(l.itens[1].estado, 'NA_FILA', 'pausado: arquivo novo não sai');
  // "Tentar de novo" do item: só `retomar`, nunca envio.
  const s2 = servidor({ upload: [jsonDoc(UUID(2))], acao: [jsonImp(), jsonImp()] });
  const depois = await rodar(tentarDeNovo(l, 'i0'), s2.buscar);
  assert.deepEqual(s2.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['retomar', 'upload', 'abrir']);
  assert.equal(depois.itens[0].estado, 'PRONTO');
});

test('R3-3 contagem: envio incerto + em andamento ⇒ nenhum arquivo novo até resolver', async () => {
  let agora = 0;
  const s = servidor({ upload: [rede(true), () => Response.json({ ok: false, erro: 'em andamento', codigo: 'LEITURA_EM_ANDAMENTO' }, { status: 409 }), jsonDoc(UUID(1)), jsonDoc(UUID(2))], acao: [jsonImp(), jsonImp()] });
  let l = await rodar(lote(2), s.buscar, () => agora);
  assert.equal(s.chamadas.length, 2, 'envio + uma reconciliação, depois espera');
  assert.equal(l.itens[1].estado, 'NA_FILA');
  agora = CONSULTAS_EM_ANDAMENTO_MS[0] - 1;
  l = await rodar(l, s.buscar, () => agora);
  assert.equal(s.chamadas.length, 2, 'antes de 2 min nada sai');
  agora = CONSULTAS_EM_ANDAMENTO_MS[0];
  l = await rodar(l, s.buscar, () => agora);
  assert.deepEqual(s.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['upload', 'upload', 'upload', 'abrir', 'upload', 'abrir']);
  assert.deepEqual(l.itens.map((i) => i.estado), ['PRONTO', 'PRONTO']);
});

test('INVALIDAR descarta respostas tardias; item retirado durante a chamada fica retirado', async () => {
  let liberar!: () => void;
  const s = servidor({ upload: [() => new Promise<Response>((ok) => { liberar = () => ok(jsonDoc(UUID(1))()); })], acao: [] });
  const armazem = criarArmazemLote({ buscar: s.buscar, agora: () => 0 });
  armazem.iniciar(lote(2), new Map([['i0', arquivoFalso('i0')], ['i1', arquivoFalso('i1')]]));
  await new Promise((r) => setImmediate(r));
  armazem.aplicar((l) => ({ ...l, parada: { tipo: 'INVALIDAR', mensagem: 'Empresa mudou.' } }));
  liberar();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(armazem.ler()!.itens[0].estado, 'ENVIANDO', 'resposta tardia não foi aplicada');
  assert.equal(s.chamadas.length, 1);

  let liberar2!: () => void;
  const s2 = servidor({ upload: [() => new Promise<Response>((ok) => { liberar2 = () => ok(jsonDoc(UUID(1))()); })], acao: [] });
  const a2 = criarArmazemLote({ buscar: s2.buscar, agora: () => 0 });
  a2.iniciar(lote(1), new Map([['i0', arquivoFalso('i0')]]));
  await new Promise((r) => setImmediate(r));
  a2.aplicar((l) => retirar(l, 'i0', 'DESCONHECIDO'));
  liberar2();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(a2.ler()!.itens[0].estado, 'RETIRADO');
  assert.equal(s2.chamadas.length, 1, 'nem abertura do retirado');
});

test('armazém: desmontar no meio para o laço; trocar de lote não aplica o resultado do lote anterior', async () => {
  let liberar!: () => void;
  const s = servidor({ upload: [() => new Promise<Response>((ok) => { liberar = () => ok(jsonDoc(UUID(1))()); }), jsonDoc(UUID(2))], acao: [jsonImp()] });
  const a = criarArmazemLote({ buscar: s.buscar, agora: () => 0 });
  a.iniciar(lote(1), new Map([['i0', arquivoFalso('i0')]]));
  await new Promise((r) => setImmediate(r));
  const novo = novoLote([{ id: 'n0', aberturaId: UUID(200), nome: 'n.pdf', tamanho: 1 }]);
  a.iniciar(novo, new Map([['n0', arquivoFalso('n0')]]));
  liberar();
  for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.ler()!.itens.map((i) => [i.id, i.estado]), [['n0', 'PRONTO']]);
  assert.deepEqual(s.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['upload', 'upload', 'abrir']);
});

/* ---------------------------------------------------------------- r2 (revisão do Astra) */

test('r3 P2-2: falha em cada consulta agendada (2/5/10/16 min) gasta o marco; depois da última a pausa FICA, nada sai sozinho e "Tentar de novo" reinicia só esse item', async () => {
  const MIN = 60_000;
  let agora = 0;
  const em = () => Response.json({ ok: false, erro: 'em andamento', codigo: 'LEITURA_EM_ANDAMENTO' }, { status: 409 });
  const falhas = [() => new Response('erro', { status: 500 }), rede(true), () => Response.json({ ok: true, data: { lixo: 1 } }), () => Response.json({ ok: false, erro: 'x' }, { status: 503 })];
  const s = servidor({ upload: [em, ...falhas, jsonDoc(UUID(2)), jsonDoc(UUID(3))], acao: [jsonImp(), jsonImp()] });
  let l = await rodar(lote(2), s.buscar, () => agora);
  assert.equal(s.chamadas.length, 1);
  for (const [k, marco] of [2, 5, 10, 16].entries()) {
    agora = marco * MIN - 1;
    l = await rodar(l, s.buscar, () => agora);
    assert.equal(s.chamadas.length, 1 + k, `antes de ${marco} min nada sai`);
    agora = marco * MIN;
    l = await rodar(l, s.buscar, () => agora);
    if (k < 3) {
      assert.equal(s.chamadas.length, 2 + k, `em ${marco} min: exatamente uma consulta, mesmo com a falha`);
      assert.equal(l.itens[0].estado, 'INCERTO');
      assert.equal(l.itens[0].proximaConsultaEm, [5, 10, 16][k] * MIN, 'reagendada para o marco seguinte');
      assert.deepEqual(l.pausas, [pausaEmAndamento('i0')], 'pausa preservada');
      assert.equal(l.itens[1].estado, 'NA_FILA');
      // A pessoa pode retirar a qualquer momento.
      assert.equal(retirar(l, 'i0', 'DESCONHECIDO').pausas.length, 0);
    }
  }
  // Depois da última consulta (16 min) o resultado continua desconhecido: o item segue INCERTO, sem consulta
  // marcada, a pausa FICA (R3-2) e o 2º arquivo não sai, nem muito depois.
  assert.equal(l.itens[0].estado, 'INCERTO');
  assert.equal(l.itens[0].proximaConsultaEm, null);
  assert.equal(l.itens[0].motivo, MENSAGEM_CONSULTAS_ESGOTADAS);
  assert.deepEqual(l.pausas, [pausaEmAndamento('i0')], 'pausa preservada depois da última consulta');
  for (const depois of [17, 60, 24 * 60]) {
    agora = depois * MIN;
    l = await rodar(l, s.buscar, () => agora);
  }
  assert.equal(s.chamadas.length, 5, 'nenhuma chamada automática depois da última consulta');
  assert.equal(l.itens[1].estado, 'NA_FILA', 'o lote não segue sozinho');
  assert.equal(loteOcupado(l), false, 'tela livre para a decisão da pessoa');
  // "Tentar de novo" reinicia só este item: uma reconciliação, pausa mantida até a resposta; depois o lote segue.
  const tentado = tentarDeNovo(l, 'i0');
  assert.equal(tentado.itens[0].consultas, 0);
  assert.equal(tentado.itens[0].motivo, MENSAGEM_INCERTA);
  assert.equal(tentado.itens[0].emAndamentoDesde, null);
  assert.deepEqual(tentado.pausas, l.pausas, 'pausa continua até a resposta');
  assert.deepEqual(proximoPasso(tentado, agora), { tipo: 'ENVIAR', itemId: 'i0' }, 'só o próprio item');
  l = await rodar(tentado, s.buscar, () => agora);
  assert.deepEqual(s.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['upload', 'upload', 'upload', 'upload', 'upload', 'upload', 'abrir', 'upload', 'abrir']);
  assert.deepEqual(l.itens.map((i) => i.estado), ['PRONTO', 'PRONTO']);
  assert.equal(l.pausas.length, 0);
});

test('r3 P2-2: depois das consultas, "Tentar de novo" com novo "em andamento" recomeça os marcos desde agora', () => {
  let l = aplicarEnvio(lote(2), 'i0', erro(409, 'LEITURA_EM_ANDAMENTO'), 0);
  for (const marco of CONSULTAS_EM_ANDAMENTO_MS) l = aplicarEnvio(iniciarPasso(l, proximoPasso(l, marco)!), 'i0', resp(500, null), marco);
  assert.equal(l.itens[0].estado, 'INCERTO');
  assert.equal(proximoPasso(l, Infinity), null);
  assert.equal(l.pausas.length, 1);
  const T = 100 * 60_000;
  l = tentarDeNovo(l, 'i0');
  l = aplicarEnvio(iniciarPasso(l, proximoPasso(l, T)!), 'i0', erro(409, 'LEITURA_EM_ANDAMENTO'), T);
  assert.equal(l.itens[0].proximaConsultaEm, T + CONSULTAS_EM_ANDAMENTO_MS[0], 'contagem nova, não a esgotada');
  assert.equal(l.itens[1].estado, 'NA_FILA');
});

test('r2 P2-2: iniciar a consulta consome o agendamento; falha seguida de "em andamento" continua nos marcos', () => {
  let l = aplicarEnvio(lote(1), 'i0', erro(409, 'LEITURA_EM_ANDAMENTO'), 0);
  const passo = proximoPasso(l, CONSULTAS_EM_ANDAMENTO_MS[0])!;
  l = iniciarPasso(l, passo);
  assert.equal(l.itens[0].proximaConsultaEm, null, 'consumido ao iniciar');
  l = aplicarEnvio(l, 'i0', excecao(undefined, false), CONSULTAS_EM_ANDAMENTO_MS[0]);
  assert.equal(l.itens[0].proximaConsultaEm, CONSULTAS_EM_ANDAMENTO_MS[1]);
  assert.equal(proximoPasso(l, CONSULTAS_EM_ANDAMENTO_MS[0]), null, 'nada na hora');
  l = aplicarEnvio(iniciarPasso(l, proximoPasso(l, CONSULTAS_EM_ANDAMENTO_MS[1])!), 'i0', erro(409, 'LEITURA_EM_ANDAMENTO'), CONSULTAS_EM_ANDAMENTO_MS[1]);
  assert.equal(l.itens[0].proximaConsultaEm, CONSULTAS_EM_ANDAMENTO_MS[2], 'mesma contagem desde o primeiro encontro');
  // Fora das consultas, o incerto continua com uma reconciliação automática e depois espera a pessoa.
  let m = aplicarEnvio(lote(1), 'i0', resp(500, null), 0);
  assert.deepEqual(proximoPasso(m, 0), { tipo: 'ENVIAR', itemId: 'i0' });
  m = aplicarEnvio(iniciarPasso(m, proximoPasso(m, 0)!), 'i0', resp(500, null), 0);
  assert.equal(proximoPasso(m, Infinity), null);
});

test('r2 P2-3: lote ocupado com chamada em voo ou consulta marcada (mesmo antes da hora); livre parado ou no fim', () => {
  assert.equal(loteOcupado(null), false);
  const l = lote(2);
  assert.equal(loteOcupado(l), true, 'arquivos na fila');
  assert.equal(loteOcupado(iniciarPasso(l, { tipo: 'ENVIAR', itemId: 'i0' })), true);
  const marcado = { ...aplicarEnvio(lote(1), 'i0', erro(409, 'LEITURA_EM_ANDAMENTO'), 0) };
  assert.equal(proximoPasso(marcado, 0), null);
  assert.equal(loteOcupado(marcado), true, 'consulta marcada para depois ainda ocupa');
  assert.equal(loteOcupado({ ...lote(2), parada: { tipo: 'PARAR', mensagem: 'x' } }), false);
  const fim = aplicarAbertura(aplicarEnvio(lote(1), 'i0', okDoc(UUID(1)), 0), 'i0', okImp('EM_REVISAO'));
  assert.equal(loteOcupado(fim), false);
});

test('r2 P2-1: RECUPERACAO_AMBIGUA não repete sozinha; "Abrir de novo" vai como abrir comum com a mesma identidade; incerto depois volta a retomar', async () => {
  const ambigua = () => Response.json({ ok: false, erro: 'Este contrato foi concluído ou descartado depois do envio. Confira antes de abrir de novo.', codigo: 'RECUPERACAO_AMBIGUA' }, { status: 409 });
  const s = servidor({ upload: [jsonDoc(UUID(1))], acao: [rede(true), ambigua] });
  let l = await rodar(lote(1), s.buscar);
  assert.deepEqual(s.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['upload', 'abrir', 'retomar']);
  assert.equal(l.itens[0].estado, 'LIDO_SEM_REVISAO');
  assert.equal(l.itens[0].exigeAbertura, true);
  assert.match(l.itens[0].motivo!, /concluído ou descartado depois do envio/);
  assert.equal(proximoPasso(l, Infinity), null, 'nada automático');
  assert.deepEqual(l.pausas, []);
  assert.equal(tentarDeNovo(l, 'i0'), l, '"Tentar de novo" não se aplica');
  l = abrirDeNovo(l, 'i0');
  assert.deepEqual(proximoPasso(l, 0), { tipo: 'ABRIR', itemId: 'i0' });
  const s2 = servidor({ upload: [], acao: [rede(true), jsonImp()] });
  l = await rodar(l, s2.buscar);
  assert.deepEqual(s2.chamadas.map((c) => c.tipo === 'upload' ? 'upload' : c.acao), ['abrir', 'retomar'], 'abrir explícito; perdido ⇒ retomar');
  assert.deepEqual(new Set(s2.chamadas.map((c) => (c as { aberturaId: string }).aberturaId)), new Set([UUID(100)]));
  assert.equal(l.itens[0].estado, 'PRONTO');
  assert.equal(abrirDeNovo(l, 'i0'), l, 'só vale para o item ambíguo');
});
