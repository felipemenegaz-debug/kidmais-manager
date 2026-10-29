import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as conteudoMod from '../../../lib/contratos/modelo-empresa/conteudo.ts';
import * as contratadaMod from '../../../lib/contratos/modelo-empresa/contratada.ts';
import * as edicaoMod from '../../../lib/contratos/modelo-empresa/edicao.ts';
import * as fixosMod from '../../../lib/contratos/modelo-empresa/valores-fixos.ts';
import { CAMPOS_CONTRATO, CAMPOS_IDENTIFICACAO } from '../../../lib/contratos/modelo-empresa/campos.ts';
import type { ConteudoModelo } from '../../../lib/contratos/modelo-empresa/conteudo.ts';
import * as controleMod from './controleSalvamento.ts';
import * as protegerMod from './protegerSaida.ts';
import { achar, carregarComponente, cssFalso, elementos, texto, tique, type Elemento } from '../teste-componente.ts';

/**
 * Tela do modelo de contrato dirigida de verdade (hooks isolados, fetch controlado), cenários da revisão do código pelo
 * Astra (28/10/2026): P2-1 resposta de salvamento de um rascunho não contamina outro; P2-2 ler/reler abre com a
 * contratada efetiva (GET depois da leitura); P2-3 "Inserir" fora da edição não reaproveita seleção antiga.
 */
function Botao(props: { children?: unknown }) { return props.children; }
const Partes = {
  BlocoIdentificacao: function BlocoIdentificacao() {}, ClausulaLeitura: function ClausulaLeitura() {}, ContadorPublicar: function ContadorPublicar() {},
  EstadoSalvamento: function EstadoSalvamento() {}, ListaValoresFixos: function ListaValoresFixos() {}, PainelObrigatorios: function PainelObrigatorios() {},
};

const D1 = (titulo: string): ConteudoModelo => ({
  titulo, contratada: { nome: 'Buffet do Modelo', documento: '', endereco: '', representante: '' }, preambulo: [], observacoes: [], cidadeAssinatura: 'Goiânia/GO',
  clausulas: [
    { titulo: 'Objeto', texto: 'Festa {{festa.pacote}} em {{festa.data}}, das {{festa.inicio}} às {{festa.fim}}, {{festa.convidados}} convidados.' },
    { titulo: 'Valor', texto: 'Total de {{valor.total}}, {{pagamento.condicao}}.' },
  ],
});
const PERFIL = { versao: 3, razao_social: 'Buffet Perfil Ltda', cnpj: '11222333000181', sede_cep: '74000000', sede_logradouro: 'Rua A', sede_numero: '1', sede_sem_numero: false, sede_complemento: null, sede_bairro: 'Centro', sede_cidade: 'Goiânia', sede_uf: 'GO' };
const rascunho = (id: string, nome: string, versao: number, comContratada = true) => ({
  id, situacao: 'RASCUNHO', arquivoNome: nome, versao, avisos: [], revisao: { conteudo: D1(`Contrato ${nome}`), avisos: [] },
  contratadaEfetiva: comContratada ? contratadaMod.comporContratada({ ...PERFIL, razao_social: `Buffet ${nome} Ltda` }, D1('x')) : undefined,
});
const PAINEL = {
  migracaoPendente: false, ativo: null, versoes: [], perfilVersaoAtual: null, identificacao: CAMPOS_IDENTIFICACAO,
  campos: CAMPOS_CONTRATO.map(({ chave, rotulo, grupo, exemplo }) => ({ chave, rotulo, grupo, exemplo })),
  rascunhos: [{ id: 'A', arquivoNome: 'a.pdf', criadoEm: '2026-10-28T10:00:00Z' }, { id: 'B', arquivoNome: 'b.pdf', criadoEm: '2026-10-28T11:00:00Z' }],
};

type Pedido = { url: string; metodo: string; corpo: unknown; responder(dados: unknown, status?: number): void; responderCom(r: Response): void };
function montar() {
  const pedidos: Pedido[] = [];
  const adminFetch = (url: string, init: RequestInit = {}) => new Promise<Response>((resolver) => {
    pedidos.push({
      url, metodo: init.method ?? 'GET', corpo: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      responder: (dados, status = 200) => resolver(Response.json(status < 300 ? { ok: true, data: dados } : { ok: false, erro: String(dados) }, { status })),
      responderCom: (r: Response) => resolver(r),
    });
  });
  const g = globalThis as Record<string, unknown>;
  g.document ??= { addEventListener() {}, removeEventListener() {} };
  const abertos: string[] = [];
  g.window = { addEventListener() {}, removeEventListener() {}, location: { origin: 'http://x', pathname: '/', search: '' }, confirm: () => true, open: (u: string) => { abertos.push(u); } };
  const m = carregarComponente('components/admin/ModeloContrato.tsx', {
    'next/navigation': { useRouter: () => ({ push() {} }) },
    '@/lib/http/admin-fetch': { adminFetch },
    '@/lib/contratos/modelo-empresa/conteudo': conteudoMod, '@/lib/contratos/modelo-empresa/contratada': contratadaMod,
    '@/lib/contratos/modelo-empresa/edicao': edicaoMod, '@/lib/contratos/modelo-empresa/valores-fixos': fixosMod,
    './modelo-contrato/controleSalvamento': controleMod, './modelo-contrato/protegerSaida': protegerMod, './modelo-contrato/partes': Partes,
    './workspace.module.css': cssFalso, './importacao-tabela.module.css': cssFalso, './modelo-contrato.module.css': cssFalso,
    './AdminPrimaryButton': { AdminPrimaryButton: Botao }, './importacao-tabela': { mensagemAviso: (a: string) => a },
  });
  let arvore: unknown = m.render();
  const tela = {
    pedidos, abertos,
    get arvore() { return arvore; },
    async atualizar() { for (let i = 0; i < 4; i++) { arvore = m.render(); m.efeitos(); await tique(); } arvore = m.render(); return arvore; },
    ultimo(metodo: string, url?: string) {
      const p = [...pedidos].reverse().find((x) => x.metodo === metodo && (url === undefined || x.url === url));
      assert(p, `pedido ${metodo} ${url ?? ''} não feito`);
      return p;
    },
    botao(rotulo: string | RegExp) { return achar(arvore, 'button', rotulo); },
    parte<T extends keyof typeof Partes>(nome: T) { return elementos(arvore).find((e) => e.type === Partes[nome]) as Elemento | undefined; },
    badge() { return texto(elementos(arvore).find((e) => e.props?.className === 'badge')); },
  };
  return tela;
}
const clicar = (e: Elemento) => (e.props.onClick as () => void)();

async function abrirDoPainel(t: ReturnType<typeof montar>, id: 'A' | 'B', versao: number) {
  await t.atualizar();
  const i = PAINEL.rascunhos.findIndex((r) => r.id === id);
  clicar(elementos(t.arvore).filter((e) => e.type === 'button' && texto(e) === 'Continuar revisão')[i]);
  await t.atualizar();
  t.ultimo('GET', `/api/admin/configuracoes/modelo-contrato/${id}`).responder(rascunho(id, `${id.toLowerCase()}.pdf`, versao));
  await t.atualizar();
}

test('P2-1: resposta do Salvar de A chega depois de abrir B → não muda B (nome, versão, contratada, salvo)', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await abrirDoPainel(t, 'A', 4);
  assert.equal(t.badge(), 'a.pdf');
  (t.parte('BlocoIdentificacao')!.props.onCampo as (c: string, v: string) => void)('representante', 'Ana');
  await t.atualizar();
  clicar(t.botao('Salvar rascunho'));
  await t.atualizar();
  const patchA = t.ultimo('PATCH');
  assert.equal(patchA.url, '/api/admin/configuracoes/modelo-contrato/A');
  clicar(t.botao('Voltar à lista'));
  await t.atualizar();
  clicar(t.botao(/^Sair sem salvar/));
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder?.(PAINEL);
  await abrirDoPainel(t, 'B', 7);
  assert.equal(t.badge(), 'b.pdf');
  (t.parte('BlocoIdentificacao')!.props.onCampo as (c: string, v: string) => void)('representante', 'Bia');
  await t.atualizar();
  assert.equal(t.parte('EstadoSalvamento')!.props.alterado, true);

  patchA.responder({ ...rascunho('A', 'a.pdf', 5), revisao: { conteudo: D1('Contrato a.pdf'), avisos: [], envioId: (patchA.corpo as { revisao: { envioId: string } }).revisao.envioId } });
  await t.atualizar();
  assert.equal(t.badge(), 'b.pdf', 'a tela continua em B');
  assert.equal(t.parte('EstadoSalvamento')!.props.alterado, true, 'B continua com alterações não salvas');
  assert.equal(t.parte('EstadoSalvamento')!.props.salvoEm, null);
  assert.equal((t.parte('BlocoIdentificacao')!.props.contratada as { valores: { nome: string } }).valores.nome, 'Buffet b.pdf Ltda');
  clicar(t.botao('Salvar rascunho'));
  await t.atualizar();
  const patchB = t.ultimo('PATCH');
  assert.equal(patchB.url, '/api/admin/configuracoes/modelo-contrato/B');
  assert.equal((patchB.corpo as { versao: number }).versao, 7, 'B salva com a própria versão');
  assert.equal((patchB.corpo as { revisao: { conteudo: { titulo: string } } }).revisao.conteudo.titulo, 'Contrato b.pdf');
  patchB.responder(rascunho('B', 'b.pdf', 8));
  await t.atualizar();
});

test('P2-2: ler um contrato abre pelo GET do rascunho, com a contratada efetiva e Publicar liberado', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await t.atualizar();
  (achar(t.arvore, 'input').props.onChange as (e: unknown) => void)({ target: { files: [{ name: 'c.pdf' }] } });
  await t.atualizar();
  clicar(achar(t.arvore, Botao, 'Ler contrato'));
  await t.atualizar();
  t.ultimo('POST', '/api/admin/inteligencia/modelo-contrato').responder(rascunho('C', 'c.pdf', 2, false));
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato/C').responder(rascunho('C', 'c.pdf', 2));
  await t.atualizar();
  assert.equal((t.parte('BlocoIdentificacao')!.props.contratada as { estado: string }).estado, 'PERFIL');
  assert.equal(achar(t.arvore, Botao, 'Publicar modelo').props.disabled, false);
});

test('P2-3: seleção feita na edição não vale depois de "Concluir" nem em outra cláusula; Inserir pergunta a cláusula', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await abrirDoPainel(t, 'A', 4);
  const textoAntes = () => (t.parte('BlocoIdentificacao') && elementos(t.arvore).filter((e) => e.type === Partes.ClausulaLeitura).map((e) => (e.props.clausula as { texto: string }).texto));
  const inserir = () => (t.parte('PainelObrigatorios')!.props.onInserir as (c: string) => void)('festa.data');
  const editar = async (i: number) => { clicar(elementos(t.arvore).filter((e) => e.type === 'button' && /^(Editar|Concluir)$/.test(texto(e)))[i]); await t.atualizar(); };
  const selecionar = async () => {
    const area = achar(t.arvore, 'textarea');
    (area.props.onSelect as (e: unknown) => void)({ currentTarget: { selectionStart: 0, selectionEnd: 5, value: area.props.value } });
    await t.atualizar();
  };

  await editar(0); await selecionar(); await editar(0); // seleciona e conclui
  const antes = textoAntes();
  inserir(); await t.atualizar();
  assert.match(texto(t.arvore), /Em qual cláusula inserir Data da festa\?/);
  assert.deepEqual(textoAntes(), antes, 'nada substituído');
  clicar(t.botao('Cancelar')); await t.atualizar();

  await editar(0); await selecionar(); await editar(1); // seleção na 1, edição passa para a 2
  inserir(); await t.atualizar();
  assert.match(texto(t.arvore), /Em qual cláusula inserir/);
  clicar(t.botao('Cancelar')); await t.atualizar();

  await editar(0); await selecionar(); // seleção na cláusula em edição: insere no cursor
  inserir(); await t.atualizar();
  const area = achar(t.arvore, 'textarea');
  assert.match(String(area.props.value), /^\{\{festa\.data\}\} \{\{festa\.pacote\}\}/);
});

// ── Rodada 3 (revisão Astra R2): toda resposta tardia de outra abertura é ignorada, não só a do Salvar ─────────────
const editarB = async (t: ReturnType<typeof montar>) => {
  (t.parte('BlocoIdentificacao')!.props.onCampo as (c: string, v: string) => void)('representante', 'Bia');
  await t.atualizar();
  assert.equal(t.parte('EstadoSalvamento')!.props.alterado, true);
};
async function irParaB(t: ReturnType<typeof montar>) {
  clicar(t.botao('Voltar à lista'));
  await t.atualizar();
  await abrirDoPainel(t, 'B', 7);
  assert.equal(t.badge(), 'b.pdf');
  await editarB(t);
}

test('R2: descarte de A confirmado, B aberto e editado antes da resposta → B continua aberto, com as alterações', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await abrirDoPainel(t, 'A', 4);
  clicar(t.botao('Descartar rascunho'));
  await t.atualizar();
  const descarteA = t.ultimo('POST', '/api/admin/configuracoes/modelo-contrato/A');
  assert.deepEqual(descarteA.corpo, { acao: 'descartar' });
  await irParaB(t);
  descarteA.responder({ descartado: true });
  await t.atualizar();
  assert.equal(t.badge(), 'b.pdf', 'B não foi fechado');
  assert.equal(t.parte('EstadoSalvamento')!.props.alterado, true, 'alterações de B preservadas');
  assert.doesNotMatch(texto(t.arvore), /Rascunho descartado/);
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await t.atualizar();
});

test('R2: prévia de A responde depois de abrir B → não abre o PDF de A nem troca a contratada de B (nem por null)', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await abrirDoPainel(t, 'A', 4);
  clicar(t.botao('Prévia em PDF'));
  await t.atualizar();
  const previaA = t.ultimo('POST', '/api/admin/configuracoes/modelo-contrato/A');
  await irParaB(t);
  const contratadaB = t.parte('BlocoIdentificacao')!.props.contratada;
  // Prévia de A com impressão diferente (dispararia "Atualizar dados" na abertura antiga).
  const pedidosAntes = t.pedidos.length;
  const corpo = new Blob(['%PDF-1.4']);
  const resposta = new Response(corpo, { status: 200, headers: { 'X-Contratada-Sha256': 'f'.repeat(64), 'Content-Type': 'application/pdf' } });
  previaA.responderCom(resposta);
  await t.atualizar();
  const getsDeA = t.pedidos.slice(pedidosAntes).filter((p) => p.metodo === 'GET' && p.url.endsWith('/A'));
  for (const g of getsDeA) g.responder({ ...rascunho('A', 'a.pdf', 4), situacao: 'DESCARTADA', contratadaEfetiva: null });
  await t.atualizar();
  assert.equal(getsDeA.length, 0, 'nem consulta A');
  assert.deepEqual(t.abertos, [], 'PDF de A não é aberto sobre B');
  assert.equal(t.parte('BlocoIdentificacao')!.props.contratada, contratadaB, 'contratada de B intacta');
  assert.equal(t.badge(), 'b.pdf');
});

for (const ordem of ['B responde primeiro', 'A responde primeiro'] as const) {
  test(`R3: clicar A e depois B (${ordem}) → abre B, a última escolha`, async () => {
    const t = montar();
    await t.atualizar();
    t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
    await t.atualizar();
    const continuar = () => elementos(t.arvore).filter((e) => e.type === 'button' && texto(e) === 'Continuar revisão');
    clicar(continuar()[0]);
    await t.atualizar();
    const getA = t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato/A');
    clicar(continuar()[1]);
    await t.atualizar();
    const getB = t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato/B');
    const [primeiro, segundo] = ordem === 'A responde primeiro'
      ? [() => getA.responder(rascunho('A', 'a.pdf', 4)), () => getB.responder(rascunho('B', 'b.pdf', 7))]
      : [() => getB.responder(rascunho('B', 'b.pdf', 7)), () => getA.responder(rascunho('A', 'a.pdf', 4))];
    primeiro();
    await t.atualizar();
    if (ordem === 'A responde primeiro') {
      assert.equal(t.badge(), '', 'A não abre: não é mais a última escolha');
      assert.equal(achar(t.arvore, 'main').props['aria-busy'], true, 'B segue pendente: a tela continua ocupada (Astra R4, P3)');
      assert.equal(achar(t.arvore, Botao, 'Ler contrato').props.disabled, true);
    }
    segundo();
    await t.atualizar();
    assert.equal(t.badge(), 'b.pdf');
  });
}

test('R3: ler C e, durante a leitura, abrir A → a leitura que termina depois não substitui A', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await t.atualizar();
  (achar(t.arvore, 'input').props.onChange as (e: unknown) => void)({ target: { files: [{ name: 'c.pdf' }] } });
  await t.atualizar();
  clicar(achar(t.arvore, Botao, 'Ler contrato'));
  await t.atualizar();
  const leitura = t.ultimo('POST', '/api/admin/inteligencia/modelo-contrato');
  clicar(elementos(t.arvore).filter((e) => e.type === 'button' && texto(e) === 'Continuar revisão')[0]);
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato/A').responder(rascunho('A', 'a.pdf', 4));
  await t.atualizar();
  assert.equal(t.badge(), 'a.pdf');
  const antes = t.pedidos.length;
  leitura.responder(rascunho('C', 'c.pdf', 2, false));
  await t.atualizar();
  assert.equal(t.pedidos.slice(antes).some((p) => p.url.endsWith('/C')), false, 'nem busca C');
  assert.equal(t.badge(), 'a.pdf');
});

test('P3: a tela passa TODOS os valores fixos à lista (também os que têm sugestão)', () => {
  assert.match(readFileSync('components/admin/ModeloContrato.tsx', 'utf8'), /<ListaValoresFixos valoresFixos=\{fixos\} \/>/);
});

// ── Plano UX achados Frente C (rev. 3), A3: "Lendo o contrato com IA…" só durante a leitura pela IA ─────────────────
const LENDO = /Lendo o contrato com IA/;
const escolherArquivo = async (t: ReturnType<typeof montar>) => {
  (achar(t.arvore, 'input').props.onChange as (e: unknown) => void)({ target: { files: [{ name: 'c.pdf' }] } });
  await t.atualizar();
};

test('A3: abrir rascunho, prévia e descartar não mostram "Lendo"; ler mostra e o erro desliga', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await t.atualizar();
  clicar(elementos(t.arvore).filter((e) => e.type === 'button' && texto(e) === 'Continuar revisão')[0]);
  await t.atualizar();
  assert.doesNotMatch(texto(t.arvore), LENDO, 'abrir rascunho pendente: sem "Lendo"');
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato/A').responder(rascunho('A', 'a.pdf', 4));
  await t.atualizar();
  clicar(t.botao('Prévia em PDF'));
  await t.atualizar();
  assert.doesNotMatch(texto(t.arvore), LENDO, 'prévia pendente: sem "Lendo"');
  t.ultimo('POST', '/api/admin/configuracoes/modelo-contrato/A').responder('falhou', 500);
  await t.atualizar();
  clicar(t.botao('Voltar à lista'));
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder?.(PAINEL);
  await t.atualizar();
  await escolherArquivo(t);
  clicar(achar(t.arvore, Botao, 'Ler contrato'));
  await t.atualizar();
  assert.match(texto(t.arvore), LENDO, 'leitura pendente: mostra "Lendo"');
  t.ultimo('POST', '/api/admin/inteligencia/modelo-contrato').responder('A leitura falhou.', 500);
  await t.atualizar();
  assert.doesNotMatch(texto(t.arvore), LENDO, 'erro na leitura desliga');
});

test('A3: "Ler de novo" no ramo "Leitura não concluída" mostra "Lendo" até a resposta', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await t.atualizar();
  clicar(elementos(t.arvore).filter((e) => e.type === 'button' && texto(e) === 'Continuar revisão')[0]);
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato/A').responder({ ...rascunho('A', 'a.pdf', 4), revisao: null, avisos: ['MODELO_INESPERADO'] });
  await t.atualizar();
  assert.match(texto(t.arvore), /Leitura não concluída/);
  assert.doesNotMatch(texto(t.arvore), LENDO);
  clicar(achar(t.arvore, Botao, 'Ler de novo'));
  await t.atualizar();
  assert.match(texto(t.arvore), /Leitura não concluída/);
  assert.match(texto(t.arvore), LENDO, 'reler pendente no ramo "Leitura não concluída"');
  t.ultimo('POST', '/api/admin/inteligencia/modelo-contrato?id=A').responder({ ...rascunho('A', 'a.pdf', 5), revisao: null, avisos: ['MODELO_INESPERADO'] });
  await t.atualizar();
  assert.doesNotMatch(texto(t.arvore), LENDO, 'reler concluído desliga');
});

test('A3: leitura sobreposta a abrir rascunho — "Lendo" não fica preso nem some antes da leitura acabar', async () => {
  const t = montar();
  await t.atualizar();
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato').responder(PAINEL);
  await t.atualizar();
  await escolherArquivo(t);
  clicar(achar(t.arvore, Botao, 'Ler contrato'));
  await t.atualizar();
  const leitura = t.ultimo('POST', '/api/admin/inteligencia/modelo-contrato');
  clicar(elementos(t.arvore).filter((e) => e.type === 'button' && texto(e) === 'Continuar revisão')[0]);
  await t.atualizar();
  // As duas pendentes, no painel: a leitura está em andamento, então "Lendo" aparece.
  assert.match(texto(t.arvore), LENDO);
  // A LEITURA termina primeiro e a abertura do rascunho continua pendente (a tela segue no painel e ainda ocupada):
  // "Lendo" some já aqui, porque só a leitura o liga. Na versão antiga ele ficava enquanto houvesse qualquer operação.
  leitura.responder('falhou', 500);
  await t.atualizar();
  assert.match(texto(t.arvore), /Importar o contrato da loja/, 'ainda no painel, com a abertura pendente');
  assert.doesNotMatch(texto(t.arvore), LENDO, 'leitura encerrada: sem "Lendo", mesmo com a abertura pendente');
  t.ultimo('GET', '/api/admin/configuracoes/modelo-contrato/A').responder(rascunho('A', 'a.pdf', 4));
  await t.atualizar();
  assert.doesNotMatch(texto(t.arvore), LENDO, 'nada preso depois das duas respostas');
});
