import test from 'node:test';
import assert from 'node:assert/strict';
import * as cliente from './cliente-importacao.ts';
import * as revisao from '../../../lib/importacao-contrato/revisao.ts';
import type { EtapaImportacao } from './ImportacaoReal';
import { achar, carregarComponente, cssFalso, tique, texto, elementos } from '../teste-componente.ts';
import * as errosFormulario from '../../../lib/ui/erros-formulario.ts';

/** Mecanismo compartilhado de erros de formulário (N1/N2), real, com CSS falso. */
const ERROS_FORMULARIO = {
  '@/components/ui/ErrosFormulario': carregarComponente('components/ui/ErrosFormulario.tsx', { '@/lib/ui/erros-formulario': errosFormulario, './erros-formulario.module.css': cssFalso }).modulo,
  '@/lib/ui/erros-formulario': errosFormulario,
};

type Pedido = { url: string; init: RequestInit };
function buscador(resposta: (p: Pedido) => Promise<Response>) {
  const pedidos: Pedido[] = [];
  return { pedidos, buscar: async (url: string, init: RequestInit = {}) => { const p = { url, init }; pedidos.push(p); return resposta(p); } };
}

const importacao = { id: '00000001-1111-4111-8111-111111111111', versao: 2, status: 'EM_REVISAO', extracao: { fonte: 'DOCUMENTO', arquivo: { nome: 'c.pdf', tipo: 'application/pdf', tamanhoBytes: 10 }, secoes: [] }, revisados: [], decisaoCliente: null };

test('cancelar exige confirmação; continuar preserva revisão; falha no descarte não apaga estado',async()=>{
  for (const sucesso of [true,false]) {
    const acoes:unknown[]=[];
    const tela=carregarComponente('components/admin/importacao/ImportacaoReal.tsx',{
      'next/navigation': { useRouter: () => ({ replace() {} }) }, 'next/link':{default:'a'}, '@/lib/http/admin-fetch':{adminFetch:async()=>new Response()},
      '@/components/admin/inteligencia/cliente-inteligencia':{decidirOperacao:async()=>{throw Error('gate não deve ser chamado na revisão');}},
      '@/components/admin/inteligencia/AcaoKidmais':{PreviewAcao:()=>null},
      '@/lib/importacao-contrato/revisao':revisao,
      './cliente-importacao':{...cliente,agirNaImportacao:async(_buscar:unknown,_estado:unknown,acao:unknown)=>{acoes.push(acao);return sucesso?{ok:true,dados:{}}:{ok:false,mensagem:'Revisão mudou em outra aba.'};}},
      './importacao.module.css':cssFalso, './importacao-real.module.css':cssFalso, ...ERROS_FORMULARIO, './IntegracaoContrato':{default:function IntegracaoContrato(){return null;}},
    });
    const props={vitrine:{etapa:'revisao',importacao,plano:null,avisos:[],ocupado:false,erro:null} as EtapaImportacao};
    let arvore=tela.render('default',props);
    (achar(arvore,'button','Cancelar importação').props.onClick as ()=>void)();
    assert.equal(acoes.length,0);
    arvore=tela.render('default',props);
    (achar(arvore,'button','Continuar revisão').props.onClick as ()=>void)();
    assert.equal(acoes.length,0);
    arvore=tela.render('default',props);
    (achar(arvore,'button','Cancelar importação').props.onClick as ()=>void)();
    arvore=tela.render('default',props);
    (achar(arvore,'button','Sim, cancelar importação').props.onClick as ()=>void)();
    await tique();
    assert.deepEqual(acoes,[{acao:'descartar'}]);
    arvore=tela.render('default',props);
    if(sucesso) assert(achar(arvore,'h2','Enviar contrato'));
    else { assert(achar(arvore,'button','Cancelar importação')); assert.equal(elementos(arvore).find((e)=>(e.type as {name?:string}).name==='AvisoGlobal')?.props.mensagem,'Revisão mudou em outra aba.'); }
  }
});

test('estado da importação: recusa ou falha de rede são explícitas e não simulam extração', async () => {
  const ok = buscador(async () => Response.json({ ok: true, data: { habilitado: true, envioExterno: false } }));
  assert.equal(await cliente.importacaoHabilitada(ok.buscar), true);
  assert.equal(ok.pedidos[0].url, '/api/admin/inteligencia/importacoes');
  assert.deepEqual(JSON.parse(String(ok.pedidos[0].init.body)), { acao: 'estado' });
  await assert.rejects(cliente.importacaoHabilitada(buscador(async () => Response.json({ ok: false, codigo: 'INTELIGENCIA_DESATIVADA' }, { status: 503 })).buscar));
  await assert.rejects(cliente.importacaoHabilitada(buscador(async () => { throw new TypeError('offline'); }).buscar));
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

test('tela: falha explícita; demonstração exige escolha e liberação abre modo real', async () => {
  for (const [habilitado, esperado] of [[false, 'Demo'], [true, 'Real']] as const) {
    const Demo = function Demo() {};
    const Real = function Real() {};
    const tela = carregarComponente('components/admin/importacao/ImportacaoContrato.tsx', {
      'next/navigation': { useRouter: () => ({ replace() {} }) }, 'next/link': { default: 'a' },
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
    if (esperado === 'Real') assert(achar(arvore, Real)); else { assert(!elementos(arvore).some((e) => e.type === Demo)); assert.match(texto(arvore), /Importação desabilitada/); const botao = achar(arvore, 'button', 'Abrir demonstração com dados fictícios'); (botao.props.onClick as () => void)(); assert(achar(tela.render(), Demo)); }
  }
});

test('confirmar o registro não anuncia sucesso: segue para Festa e agenda; importação já registrada reabre a integração', async () => {
  const Integracao = function IntegracaoContrato() { return null; };
  const rascunho = { operacaoId: 'op', versao: 1, payloadHash: 'h', campos: [], avisos: [] };
  const tela = carregarComponente('components/admin/importacao/ImportacaoReal.tsx', {
    'next/navigation': { useRouter: () => ({ replace() {} }) }, 'next/link': { default: 'a' }, '@/lib/http/admin-fetch': { adminFetch: async () => new Response() },
    '@/components/admin/inteligencia/cliente-inteligencia': { decidirOperacao: async () => ({ tipo: 'ok', resposta: { tipo: 'resultado_acao', mensagem: 'Dados do contrato registrados e cliente criado.', destino: '/clientes/c1' } }) },
    '@/components/admin/inteligencia/AcaoKidmais': { PreviewAcao: () => null },
    '@/lib/importacao-contrato/revisao': revisao,
    './cliente-importacao': { ...cliente, agirNaImportacao: async () => ({ ok: true, dados: {} }) },
    './importacao.module.css': cssFalso, './importacao-real.module.css': cssFalso, ...ERROS_FORMULARIO, './IntegracaoContrato': { default: Integracao },
  });
  const props = { vitrine: { etapa: 'confirmacao', importacao, plano: null, rascunho, decidindo: false, erro: null } as unknown as EtapaImportacao };
  let arvore = tela.render('default', props);
  assert.match(texto(achar(arvore, 'ol')), /Dados do contrato e cliente.*Festa e agenda.*Pagamentos.*Revisão final/);
  const preview = elementos(arvore).find((e) => typeof e.type === 'function' && (e.props as { onDecidir?: unknown }).onDecidir)!;
  (preview.props.onDecidir as (r: unknown, d: string) => void)(rascunho, 'confirmar');
  await tique();
  arvore = tela.render('default', props);
  const wizard = achar(arvore, Integracao);
  assert.equal(wizard.props.importacaoId, importacao.id);
  assert.doesNotMatch(texto(arvore), /Importado|Integrado/);
  assert.match(texto(arvore), /Falta integrar ao sistema: confirme festa, agenda e pagamentos/);
  const atual = elementos(arvore).find((e) => e.type === 'li' && e.props['aria-current'] === 'step');
  assert.match(texto(atual), /Festa e agenda/);
  (wizard.props.onPasso as (p: string) => void)('revisao');
  arvore = tela.render('default', props);
  assert.match(texto(elementos(arvore).find((e) => e.type === 'li' && e.props['aria-current'] === 'step')), /Revisão final/);

  const reaberta = carregarComponente('components/admin/importacao/ImportacaoReal.tsx', {
    'next/navigation': { useRouter: () => ({ replace() {} }) }, 'next/link': { default: 'a' }, '@/lib/http/admin-fetch': { adminFetch: async () => new Response() },
    '@/components/admin/inteligencia/cliente-inteligencia': { decidirOperacao: async () => { throw Error('sem gate'); } },
    '@/components/admin/inteligencia/AcaoKidmais': { PreviewAcao: () => null }, '@/lib/importacao-contrato/revisao': revisao,
    './cliente-importacao': { ...cliente, agirNaImportacao: async () => ({ ok: true, dados: {} }) },
    './importacao.module.css': cssFalso, './importacao-real.module.css': cssFalso, ...ERROS_FORMULARIO, './IntegracaoContrato': { default: Integracao },
  });
  const r = reaberta.render('default', { vitrine: { etapa: 'integracao', importacaoId: importacao.id, acabouDeRegistrar: false } as unknown as EtapaImportacao });
  assert.match(texto(r), /Os dados deste contrato já estão registrados/);
  assert(achar(r, Integracao));
});

test('rodada 2, P2-6/P3-7: continuar com pendência abre a edição do 1º campo e o erro fica no controle; PF escolhido aparece marcado', async () => {
  const { ARQUIVO } = await import('../../../lib/importacao-contrato/apoio.test.ts');
  const { NOVO, SEM_ENDERECO } = await import('../../../lib/importacao-contrato/apoio-entrega-a.test.ts');
  const { extrairPorRegras } = await import('../../../lib/importacao-contrato/extracao.ts');
  const { aplicarRevisao, montarRevisao } = await import('../../../lib/importacao-contrato/rascunho.ts');
  const { montarPlano } = await import('../../../lib/importacao-contrato/plano.ts');
  const r = aplicarRevisao(montarRevisao(extrairPorRegras(SEM_ENDERECO), SEM_ENDERECO, ARQUIVO), [], { campoId: 'contratante.tipoPessoa', valor: 'PF' });
  assert(!('erro' in r));
  const plano = montarPlano(r.extracao, r.revisados, NOVO, null) as unknown as cliente.PlanoPublico;
  assert.equal(plano.pronto, false);
  const imp = { ...importacao, extracao: r.extracao, revisados: r.revisados } as cliente.ImportacaoPublica;
  const tela = carregarComponente('components/admin/importacao/ImportacaoReal.tsx', {
    'next/navigation': { useRouter: () => ({ replace() {} }) }, 'next/link': { default: 'a' }, '@/lib/http/admin-fetch': { adminFetch: async () => new Response() },
    '@/components/admin/inteligencia/cliente-inteligencia': { decidirOperacao: async () => { throw Error('sem gate'); } },
    '@/components/admin/inteligencia/AcaoKidmais': { PreviewAcao: () => null }, '@/lib/importacao-contrato/revisao': revisao, './cliente-importacao': cliente,
    './importacao.module.css': cssFalso, './importacao-real.module.css': cssFalso, ...ERROS_FORMULARIO, './IntegracaoContrato': { default: function IntegracaoContrato() { return null; } },
  });
  // Campo, TipoPessoa e mensagens são puros: expandidos para ver os controles de verdade.
  const PUROS = new Set(['Campo', 'TipoPessoa', 'MensagemCampo', 'ResumoErros', 'AvisoGlobal']);
  const expandir = (no: unknown): unknown => {
    if (Array.isArray(no)) return no.map(expandir);
    if (!no || typeof no !== 'object') return no;
    const e = no as { type: unknown; props: Record<string, unknown> };
    if (typeof e.type === 'function' && PUROS.has((e.type as { name: string }).name)) return expandir((e.type as (p: unknown) => unknown)(e.props));
    return { ...e, props: { ...e.props, children: expandir(e.props?.children) } };
  };
  const props = { vitrine: { etapa: 'revisao', importacao: imp, plano, avisos: [], ocupado: false, erro: null } as EtapaImportacao };
  (achar(tela.render('default', props), 'button', 'Continuar para festa e pagamentos').props.onClick as () => void)();
  const arvore = expandir(tela.render('default', props));
  const primeiro = cliente.errosDaRevisao(imp, plano)[0].campo;
  const comId = elementos(arvore).filter((e) => e.props?.id === primeiro);
  assert.equal(comId.length, 1, 'um só elemento com o ID do erro');
  assert.equal(comId[0].type, 'input', 'o ID do erro é o do controle de edição, já aberto');
  assert.equal(comId[0].props['aria-invalid'], true);
  assert.equal(comId[0].props['aria-describedby'], `${primeiro}-erro`);
  assert(elementos(arvore).some((e) => e.props?.id === `${primeiro}-erro`), 'mensagem ligada ao controle');
  assert(achar(arvore, 'button', 'Manter como lido'), 'confirmar a leitura continua possível na edição');
  const radios = elementos(arvore).filter((e) => e.props?.role === 'radio' && /^Pessoa /.test(texto(e)));
  assert.deepEqual(radios.map((e) => [texto(e), e.props['aria-checked']]), [['Pessoa física', true], ['Pessoa jurídica', false]]);
  assert.deepEqual([cliente.tipoPessoaMarcado({ id: 'contratante.tipoPessoa', rotulo: 'Tipo', valor: 'Pessoa jurídica', estado: 'PRECISA_REVISAO', origem: 'Definido pelo CNPJ lido' }, false)], [null], 'sugestão do documento não aparece marcada');
});
