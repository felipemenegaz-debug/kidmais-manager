import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../admin/teste-componente.ts';

/**
 * Página pública do contrato HISTÓRICO (assinado em papel), renderizada de verdade com as APIs simuladas: CPF → código →
 * documentos. Prova a identificação "assinado em papel", a ausência de qualquer assinatura digital ou comprovante
 * fictício e que o original não é exposto ao público (o acesso autorizado é o do Admin, por papel).
 */
const CONTRATO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEXTO_PAPEL = 'Contrato assinado em papel, conferido pela Kidmais na importação. Não há assinatura eletrônica nem comprovante digital: a prova é o documento original.';
const contextoHistorico = {
  contrato: { id: CONTRATO, status: 'ASSINADO', assinadoEm: '2025-03-01T12:00:00Z' },
  comprovantes: [],
  versao: { id: 'v1', numero: 1, status: 'ASSINADA', snapshotHash: 'h', resumo: { templateVersao: 1, pdfHash: 'r' },
    contratoOficial: { disponivel: false, modeloCodigo: null, templateVersao: null, pdfHash: null, homologadoParaProducao: false },
    documentoTemplateVersao: null, documentoPdfHash: null, documentoHomologadoParaProducao: false, assinadoEm: '2025-03-01T12:00:00Z' },
  evento: { data: '2026-11-14', horarioInicio: '14:00:00', horarioFim: '18:00:00', pacote: 'Festa de 2019', pacoteCodigo: 'X', aniversariante: 'Lia', valorFinalContrato: 8500 },
  assinatura: { tipo: 'PAPEL', texto: TEXTO_PAPEL },
  aceitePermitido: false,
};

function montar() {
  const chamadas: string[] = [];
  const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (url: string) => {
    chamadas.push(url);
    if (url.endsWith('/acesso')) return json({ ok: true, data: { canais: [{ canal: 'WHATSAPP', destinoMascarado: '(11) *****-0000' }] } });
    if (url.endsWith('/identidade/iniciar')) return json({ ok: true, data: { validacaoId: 'val', acessoToken: 'acesso' } });
    if (url === '/api/identidade/confirmar-codigo') return json({ ok: true, provaToken: 'prova' });
    if (url.endsWith('/contexto')) return json({ ok: true, data: contextoHistorico });
    if (url.endsWith('/resumo')) return new Response(new Blob(['%PDF-resumo'], { type: 'application/pdf' }), { status: 200 });
    throw new Error(`chamada não prevista na página histórica: ${url}`);
  }) as typeof fetch;
  const tela = carregarComponente('components/contrato/ContratoPublico.tsx', { 'next/image': { default: 'img' }, './ContratoPublico.module.css': cssFalso });
  return { tela, chamadas };
}

const evento = (value: string) => ({ target: { value } });
const ver = (tela: ReturnType<typeof montar>['tela']) => tela.render('default', { contratoId: CONTRATO });
async function esperar() { for (let i = 0; i < 6; i++) await tique(); }

test('página pública histórica: "assinado em papel", sem aceite eletrônico, sem comprovante e sem documento eletrônico', async () => {
  const { tela, chamadas } = montar();
  (achar(ver(tela), 'input').props.onChange as (e: unknown) => void)(evento('123.456.789-00'));
  (achar(ver(tela), 'button', 'Continuar').props.onClick as () => void)();
  await esperar();
  (achar(ver(tela), 'button', 'Enviar código').props.onClick as () => void)();
  await esperar();
  (achar(ver(tela), 'input').props.onChange as (e: unknown) => void)(evento('123456'));
  (achar(ver(tela), 'button', 'Abrir documentos').props.onClick as () => void)();
  await esperar();
  const a = ver(tela);
  const pagina = texto(a);
  // Identificação.
  assert.match(pagina, /Status.*Assinado em papel/);
  assert.match(pagina, /Contrato assinado em papel/);
  assert.ok(pagina.includes(TEXTO_PAPEL));
  assert.match(pagina, /Este contrato foi assinado em papel; não há aceite eletrônico\./);
  // Nenhuma assinatura digital fictícia.
  assert.doesNotMatch(pagina, /Aceitar e assinar eletronicamente|Aceite registrado|Este Contrato já está assinado|Baixar comprovante|antes do aceite eletrônico/);
  assert.ok(!elementos(a).some((e) => e.type === 'input' && (e as Elemento).props.type === 'checkbox'), 'nenhuma caixa de aceite');
  const abaContrato = elementos(a).find((e) => e.type === 'button' && /2\. Contrato Oficial/.test(texto(e)))!;
  assert.equal(abaContrato.props.disabled, true);
  assert.match(texto(abaContrato), /Assinado em papel/);
  // Nenhum documento eletrônico nem aceite/comprovante pedido ao servidor.
  assert.deepEqual(chamadas.filter((u) => /\/pdf$|\/aceite$|\/comprovante$/.test(u)), []);
  // Original: nunca exposto na página pública; orientação para pedir à Kidmais.
  assert.ok(!elementos(a).some((e) => e.type === 'a' && /importados|original/.test(String(e.props.href ?? ''))), 'sem link para o original');
  assert.match(pagina, /Para obter uma cópia do documento original, solicite à Kidmais/);
});

test('acesso ao original pelo caminho apropriado: só no Admin, rota protegida, para papel autorizado', () => {
  const card = carregarComponente('components/admin/OrigemHistoricaContrato.tsx', { './contratos-ux.module.css': cssFalso });
  const origem = (podeVerOriginal: boolean) => ({ importacaoId: 'imp1', conferidoEm: '2026-10-02T12:00:00Z', conferidoPor: 'Ana', conferidoPapel: 'ADMINISTRATIVO', declaracao: 'x', unidade: null,
    documento: { id: 'd', nome: 'contrato.pdf', contentType: 'application/pdf', tamanhoBytes: 10 }, podeVerOriginal, financeiroPendente: false, caminhoFinanceiro: 'CONCLUIDO', financeiro: null, campos: [], contratoHistorico: null });
  const links = (arvore: unknown) => elementos(arvore).filter((e) => e.type === 'a').map((e) => String(e.props.href));
  const autorizado = card.render('default', { origem: origem(true) });
  assert.match(texto(autorizado), /Contrato histórico — assinado em papel/);
  assert.match(texto(autorizado), /Não há assinatura digital, OTP nem comprovante eletrônico/);
  assert.deepEqual(links(autorizado), ['/api/admin/contratos/importados/imp1/original', '/api/admin/contratos/importados/imp1/original?baixar=1']);
  const restrito = card.render('default', { origem: origem(false) });
  assert.deepEqual(links(restrito), []);
  assert.match(texto(restrito), /restrita aos papéis Administrativo e Representante autorizado/);
});
