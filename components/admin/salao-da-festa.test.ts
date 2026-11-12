import assert from 'node:assert/strict';
import test from 'node:test';
import { achar, carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';

/**
 * S-E restante ("Desistir da troca", P1-3): o card SalaoDaFesta com contrato que fixa o salão A e revisão aberta trocando
 * para B. Desistir é no próprio card (sem prompt/confirm), envia o que foi LIDO (esperado) e, depois de 409 ou falha de
 * rede, só deixa tentar de novo após uma releitura bem-sucedida.
 */
const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nome: 'Salão A' };
const B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nome: 'Salão B' };
const troca = (mudar: Record<string, unknown> = {}) => ({
  salaoAtual: A, opcoes: [{ id: A.id, nome: A.nome, livre: true, permitido: true }, { id: B.id, nome: B.nome, livre: true, permitido: true }], confirmada: true, contratoFixa: A,
  trocaEmAndamento: { revisaoId: 'r1', estado: 'EM_ELABORACAO', salao: B, contratoId: 'k1', versaoId: 'v2', revisaoEdicao: 4, revisaoOperacional: 7, ...mudar },
});

type Resposta = { status?: number; corpo?: unknown; falhar?: boolean };
function montar(leituras: Resposta[], envios: Resposta[]) {
  const chamadas: Array<{ url: string; init?: RequestInit }> = [];
  const responder = (r: Resposta) => { if (r.falhar) throw new TypeError('rede'); return new Response(JSON.stringify(r.corpo), { status: r.status ?? 200 }); };
  const tela = carregarComponente('components/admin/SalaoDaFesta.tsx', {
    'next/link': { default: 'a' },
    '@/lib/http/admin-fetch': { adminFetch: async (url: string, init?: RequestInit) => {
      chamadas.push({ url, init });
      return responder(init?.method === 'POST' ? envios.shift()! : leituras.shift()!);
    } },
    './AdminPrimaryButton': { AdminPrimaryButton: 'button' },
    './workspace.module.css': cssFalso,
  });
  const ver = () => tela.render('SalaoDaFesta', { fechamentoId: 'f1' });
  return { tela, chamadas, ver };
}
async function carregar(m: ReturnType<typeof montar>) {
  m.ver(); m.tela.efeitos(); await tique(); await tique();
  return m.ver();
}
const clicar = (arvore: unknown, rotulo: string) => (achar(arvore, 'button', rotulo).props.onClick as () => void)();
const motivo = (arvore: unknown, valor: string) => (elementos(arvore).find((e) => e.type === 'textarea')!.props.onChange as (e: unknown) => void)({ target: { value: valor } });

test('troca em andamento: "Desistir da troca" e "Abrir revisão"; formulário no card, motivo mínimo e o aviso da revisão inteira', async () => {
  const m = montar([{ corpo: { ok: true, data: troca() } }], []);
  let a = await carregar(m);
  assert.match(texto(a), /Troca para Salão B em andamento/);
  assert.doesNotMatch(texto(a), /cancele a revisão no contrato/);
  assert(elementos(a).some((e) => e.type === 'a' && e.props.href === '/admin/contratos?contratoId=k1#alteracoes'));
  clicar(a, 'Desistir da troca');
  a = m.ver();
  assert.match(texto(a), /Cancela a revisão inteira, inclusive outras alterações dela; o contrato assinado continua valendo no salão Salão A\./);
  assert.equal(achar(a, 'button', 'Confirmar desistência').props.disabled, true, 'motivo vazio');
  motivo(a, 'ab');
  assert.equal(achar(m.ver(), 'button', 'Confirmar desistência').props.disabled, true, 'motivo com menos de 3 letras');
  clicar(m.ver(), 'Voltar');
  assert.equal(elementos(m.ver()).some((e) => e.type === 'textarea'), false);
});

test('confirmar envia cancelar_revisao com a revisão da edição e o esperado LIDO; sucesso relê o card', async () => {
  const m = montar([{ corpo: { ok: true, data: troca() } }, { corpo: { ok: true, data: { ...troca(), trocaEmAndamento: null } } }], [{ corpo: { ok: true, data: { cancelada: true } } }]);
  const a = await carregar(m);
  clicar(a, 'Desistir da troca');
  motivo(m.ver(), 'Cliente desistiu');
  clicar(m.ver(), 'Confirmar desistência');
  await tique(); await tique(); await tique();
  const envio = m.chamadas.find((c) => c.init?.method === 'POST')!;
  assert.equal(envio.url, '/api/admin/contratos/versoes/v2');
  assert.deepEqual(JSON.parse(String(envio.init!.body)), {
    acao: 'cancelar_revisao', revisao: 4, motivo: 'Cliente desistiu',
    esperado: { revisaoId: 'r1', revisaoOperacional: 7, estado: 'EM_ELABORACAO', salaoDestinoId: B.id },
  });
  assert.match(texto(m.ver()), /Troca desistida: a revisão foi cancelada e o contrato assinado continua valendo no salão Salão A\./);
  assert.equal(m.chamadas.filter((c) => !c.init?.method).length, 2, 'releu o card');
});

test('409: relê; com releitura bem-sucedida mostra o estado novo e exige nova conferência (formulário vazio)', async () => {
  const novo = troca({ salao: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nome: 'Salão C' }, revisaoOperacional: 8 });
  const m = montar([{ corpo: { ok: true, data: troca() } }, { corpo: { ok: true, data: novo } }], [{ status: 409, corpo: { ok: false, erro: 'A revisão mudou desde que você abriu a tela.' } }]);
  const a = await carregar(m);
  clicar(a, 'Desistir da troca');
  motivo(m.ver(), 'Cliente desistiu');
  clicar(m.ver(), 'Confirmar desistência');
  await tique(); await tique(); await tique();
  const b = m.ver();
  assert.match(texto(b), /A revisão mudou desde que você abriu a tela/);
  assert.match(texto(b), /Troca para Salão C em andamento/, 'mostra o estado relido');
  assert.equal(elementos(b).some((e) => e.type === 'textarea'), false, 'formulário fechado: nova conferência');
  clicar(b, 'Desistir da troca');
  assert.equal(elementos(m.ver()).find((e) => e.type === 'textarea')!.props.value, '', 'motivo vazio');
});

test('409 com releitura que FALHA: "Confirmar desistência" continua desabilitado até uma releitura bem-sucedida', async () => {
  const m = montar([{ corpo: { ok: true, data: troca() } }, { falhar: true }, { corpo: { ok: true, data: troca({ estado: 'CONGELADA' }) } }],
    [{ status: 409, corpo: { ok: false, erro: 'A revisão mudou desde que você abriu a tela.' } }]);
  const a = await carregar(m);
  clicar(a, 'Desistir da troca');
  motivo(m.ver(), 'Cliente desistiu');
  clicar(m.ver(), 'Confirmar desistência');
  await tique(); await tique(); await tique();
  let b = m.ver();
  motivo(b, 'Cliente desistiu de novo');
  b = m.ver();
  assert.equal(achar(b, 'button', 'Confirmar desistência').props.disabled, true, 'sem releitura bem-sucedida');
  assert.match(texto(b), /Releia o salão da festa antes de tentar de novo/);
  clicar(b, 'Reler');
  await tique(); await tique(); await tique();
  b = m.ver();
  assert.doesNotMatch(texto(b), /Releia o salão da festa/);
  assert.equal(elementos(b).some((e) => e.type === 'textarea'), false);
  assert.equal(m.chamadas.filter((c) => c.init?.method === 'POST').length, 1, 'nenhuma nova tentativa sozinha');
});

test('falha de rede no envio também exige nova conferência; destino nulo ou igual ao fixado não mostra "Desistir"', async () => {
  const m = montar([{ corpo: { ok: true, data: troca() } }, { falhar: true }], [{ falhar: true }]);
  const a = await carregar(m);
  clicar(a, 'Desistir da troca');
  motivo(m.ver(), 'Cliente desistiu');
  clicar(m.ver(), 'Confirmar desistência');
  await tique(); await tique(); await tique();
  assert.equal(achar(m.ver(), 'button', 'Confirmar desistência').props.disabled, true);
  for (const salao of [null, A]) {
    const n = montar([{ corpo: { ok: true, data: troca({ salao }) } }], []);
    const c = await carregar(n);
    assert.equal(elementos(c).some((e) => e.type === 'button' && texto(e) === 'Desistir da troca'), false, String(salao?.nome ?? 'nulo'));
  }
});
