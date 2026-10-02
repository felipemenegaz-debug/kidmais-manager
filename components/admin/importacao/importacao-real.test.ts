import test from 'node:test';
import assert from 'node:assert/strict';
import * as cliente from './cliente-importacao.ts';
import { achar, carregarComponente, cssFalso, tique, texto, elementos } from '../teste-componente.ts';

type Pedido = { url: string; init: RequestInit };
function buscador(resposta: (p: Pedido) => Promise<Response>) {
  const pedidos: Pedido[] = [];
  return { pedidos, buscar: async (url: string, init: RequestInit = {}) => { const p = { url, init }; pedidos.push(p); return resposta(p); } };
}

const importacao = { id: '00000001-1111-4111-8111-111111111111', versao: 2, status: 'EM_REVISAO', extracao: { fonte: 'DOCUMENTO', arquivo: { nome: 'c.pdf', tipo: 'application/pdf', tamanhoBytes: 10 }, secoes: [] }, revisados: [], decisaoCliente: null };

test('estado da importação: só ok explícito liga o modo real; recusa ou rede ⇒ demonstração', async () => {
  const ok = buscador(async () => Response.json({ ok: true, data: { habilitado: true, envioExterno: false } }));
  assert.equal(await cliente.importacaoHabilitada(ok.buscar), true);
  assert.equal(ok.pedidos[0].url, '/api/admin/inteligencia/importacoes');
  assert.deepEqual(JSON.parse(String(ok.pedidos[0].init.body)), { acao: 'estado' });
  assert.equal(await cliente.importacaoHabilitada(buscador(async () => Response.json({ ok: false, codigo: 'INTELIGENCIA_DESATIVADA' }, { status: 503 })).buscar), false);
  assert.equal(await cliente.importacaoHabilitada(buscador(async () => { throw new TypeError('offline'); }).buscar), false);
});

test('envio: multipart só com o arquivo; depois abre a importação pelo documento; ações levam só id, versão e o campo revisado', async () => {
  const documentoId = '0000000d-1111-4111-8111-111111111111';
  const b = buscador(async (p) => Response.json({ ok: true, data: p.url.endsWith('/documentos') ? { documentoId, reaproveitado: false, metodo: 'DETERMINISTICO', extracao: importacao.extracao, avisos: ['ENVIO_EXTERNO_NAO_AUTORIZADO'] } : { importacao } }));
  const arquivo = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'contrato.pdf', { type: 'application/pdf' });
  const enviado = await cliente.enviarContrato(b.buscar, arquivo);
  assert.equal(enviado.ok, true);
  if (enviado.ok) assert.deepEqual(enviado.dados.avisos, ['ENVIO_EXTERNO_NAO_AUTORIZADO']);
  assert.equal(b.pedidos[0].url, '/api/admin/inteligencia/documentos');
  const form = b.pedidos[0].init.body as FormData;
  assert.deepEqual([...form.keys()], ['arquivo']);
  assert.equal(b.pedidos[1].url, '/api/admin/inteligencia/importacoes');
  assert.deepEqual(JSON.parse(String(b.pedidos[1].init.body)), { acao: 'abrir', documentoId });
  await cliente.agirNaImportacao(b.buscar, importacao, { acao: 'revisar', campoId: 'contratante.cpf', valor: '529.982.247-25' });
  assert.deepEqual(JSON.parse(String(b.pedidos[2].init.body)), { acao: 'revisar', campoId: 'contratante.cpf', valor: '529.982.247-25', importacaoId: importacao.id, versao: 2 });
  await cliente.agirNaImportacao(b.buscar, importacao, { acao: 'revisar', campoId: 'valores.total', confirmarDivergencia: true });
  assert.deepEqual(JSON.parse(String(b.pedidos[3].init.body)), { acao: 'revisar', campoId: 'valores.total', confirmarDivergencia: true, importacaoId: importacao.id, versao: 2 });
  await cliente.agirNaImportacao(b.buscar, importacao, { acao: 'ler' });
  assert.deepEqual(JSON.parse(String(b.pedidos[4].init.body)), { acao: 'ler', importacaoId: importacao.id });
  const recusa = await cliente.agirNaImportacao(buscador(async () => Response.json({ ok: false, erro: 'A revisão mudou em outra aba. Atualize a página.', codigo: 'IMPORTACAO_DESATUALIZADA' }, { status: 409 })).buscar, importacao, { acao: 'preparar' });
  assert.deepEqual(recusa, { ok: false, mensagem: 'A revisão mudou em outra aba. Atualize a página.', codigo: 'IMPORTACAO_DESATUALIZADA' });
});

test('tela: falha mostra indisponibilidade, nunca dados de demonstração; liberação abre modo real', async () => {
  for (const [habilitado, esperado] of [[false, 'Demo'], [true, 'Real']] as const) {
    const Demo = function Demo() {};
    const Real = function Real() {};
    const tela = carregarComponente('components/admin/importacao/ImportacaoContrato.tsx', {
      'next/link': { default: 'a' },
      '@/lib/http/admin-fetch': { adminFetch: async () => new Response() },
      './ImportarContratoAntigo': { default: Demo },
      './ImportacaoReal': { default: Real },
      './cliente-importacao': { verificarImportacao: async () => habilitado ? ({ ok: true, dados: { habilitado: true } }) : ({ ok: false, mensagem: 'Importação desabilitada', codigo: 'INTELIGENCIA_DESATIVADA' }) },
      './importacao.module.css': cssFalso,
    });
    tela.render();
    tela.efeitos();
    await tique();
    const arvore = tela.render();
    if (esperado === 'Real') assert(achar(arvore, Real)); else { assert(!elementos(arvore).some((e) => e.type === Demo)); assert.match(texto(arvore), /Importação desabilitada/); }
  }
});
