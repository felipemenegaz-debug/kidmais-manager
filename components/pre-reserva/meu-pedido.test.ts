import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { achar, carregarComponente, cssFalso, elementos, talvez, texto, tique } from "../admin/teste-componente.ts";
import * as formato from "../../lib/area-familia/formato.ts";
import * as rotas from "../../lib/fechamentos/rota-publica.ts";
import * as termos from "../../lib/pre-reserva/termos.ts";
import * as modelo from "./meu-pedido.ts";
import type { Oferta, Pedido } from "./meu-pedido.ts";

const oferta: Oferta = {
  disponivel: true, sinalCentavos: 10000, recebedor: { nome: "Buffet", cidade: "São Paulo" }, salao: null,
  versaoOferta: "versao-da-oferta", termos: { versao: termos.VERSAO_TERMOS_PRE_RESERVA, texto: termos.TERMOS_PRE_RESERVA },
};
const pedido: Pedido = {
  id: "11111111-1111-4111-8111-111111111111", protocolo: "KM-11111111", status: "AGUARDANDO_CONTRATO",
  data: "2026-12-03", inicio: "16:00:00", fim: "19:00:00", unidade: "Centro", salao: "Salão principal", oferta,
  preReserva: { aceite: null, aguardandoConferencia: false, novoAceiteNecessario: false, garantia: null, dinheiro: [], mensagemConferencia: null },
};
const ate = "2026-12-02T02:30:00.000Z";
const instanteServidor = Date.parse(ate) - 30_000;
const garantia: Pedido = {
  ...pedido, oferta: { disponivel: false, motivo: "GARANTIA_EXISTENTE" },
  preReserva: {
    ...pedido.preReserva, garantia: { situacao: "ATIVA", ate },
    dinheiro: [{ situacao: "EM_GARANTIA", valorCentavos: 10000, devolverDesde: null }],
  },
};
const aceite = {
  sequencia: 1, sinalCentavos: 10000, aceitoEm: "2026-11-21T15:30:00.000Z",
  inicioEvento: "2026-12-03T19:00:00.000Z", fimEvento: "2026-12-03T22:00:00.000Z", salao: pedido.salao,
  recebedor: oferta.recebedor, termos: oferta.termos,
};
const aguardando: Pedido = {
  ...pedido, preReserva: { ...pedido.preReserva, aceite, aguardandoConferencia: true },
};
const novaOferta: Pedido = {
  ...pedido, preReserva: { ...pedido.preReserva, novoAceiteNecessario: true,
    garantia: { situacao: "SEM_GARANTIA", ate: null },
    dinheiro: [{ situacao: "DEVOLVIDO", valorCentavos: 10000, devolverDesde: ate }],
  },
};
const pilotoDesligado = { disponivel: false, motivo: "PILOTO_DESLIGADO" } as const;
const indisponivel = { ...pedido, oferta: pilotoDesligado };

function respostaDaSessao(pedidos: Pedido[], agora = instanteServidor, expiraEm = instanteServidor + 60_000) {
  return Response.json({ ok: true, data: { pedidos, expiraEm: new Date(expiraEm) } }, {
    headers: { Date: new Date(agora).toUTCString() },
  });
}

test("rótulos da família e motivos da oferta são em português", () => {
  assert.equal(modelo.rotuloPedido("AGUARDANDO_CONTRATO"), "Aguardando contrato");
  assert.equal(modelo.rotuloPedido("CONFIRMADO"), "Confirmado");
  assert.equal(modelo.rotuloGarantia("ATIVA"), "Horário garantido");
  assert.equal(modelo.rotuloGarantia("EXPIRADA"), "A garantia venceu");
  assert.deepEqual(["A_DEVOLVER", "EM_DEVOLUCAO", "DEVOLVIDO", "CREDITO_CONTRATO"].map(modelo.rotuloDinheiro),
    ["A devolver", "Em devolução", "Devolvido", "Crédito no contrato"]);
  assert.deepEqual(Object.keys(modelo.MOTIVOS_OFERTA), [
    "GARANTIA_EXISTENTE", "PEDIDO_INELEGIVEL", "PILOTO_DESLIGADO", "ORCAMENTO_ONLINE_INDISPONIVEL", "ACESSO_COMERCIAL_RESTRITO",
    "PRE_RESERVA_SEM_PIX", "SINAL_INDISPONIVEL", "MENOS_DE_24_HORAS", "HORARIO_INDISPONIVEL", "PIX_NAO_PENDENTE",
  ]);
  for (const [codigo, mensagem] of Object.entries(modelo.MOTIVOS_OFERTA)) {
    assert.equal(modelo.rotuloErro(codigo), mensagem);
    assert.match(mensagem, /^[A-ZÀ-Ü][^_]+\.$/);
  }
  assert.match(modelo.rotuloErro("LIMITE_REQUISICOES"), /Muitas tentativas/);
  assert.match(modelo.rotuloErro("CODIGO_NAO_CONFIRMADO"), /incorreto ou vencido/);
  assert.match(modelo.rotuloErro("PRE_RESERVA_INDISPONIVEL"), /pedido comum segue/);
});

test("a validade usa a data e a hora de São Paulo, inclusive na virada do dia", () => {
  assert.match(modelo.formatarValidade(ate) ?? "", /^01\/12\/2026\D+23:30$/);
  assert.equal(modelo.formatarValidade("inválido"), null);
});

test("ações seguem a oferta, o aceite vigente e a garantia em cada pedido", () => {
  assert.deepEqual(modelo.acoesDoPedido(pedido, instanteServidor), { aceitar: true, pix: false, desistir: false });
  assert.deepEqual(modelo.acoesDoPedido(novaOferta, instanteServidor), { aceitar: true, pix: false, desistir: false });
  assert.deepEqual(modelo.acoesDoPedido(garantia, instanteServidor), { aceitar: false, pix: false, desistir: true });
  assert.deepEqual(modelo.acoesDoPedido(garantia, Date.parse(ate)), { aceitar: false, pix: false, desistir: false });
  assert.deepEqual(modelo.acoesDoPedido(indisponivel, instanteServidor), { aceitar: false, pix: false, desistir: false });
  assert.deepEqual(modelo.acoesDoPedido({ ...aguardando, oferta: pilotoDesligado }, instanteServidor), { aceitar: false, pix: true, desistir: false });
  assert.deepEqual(modelo.acoesDoPedido({ ...garantia, oferta: pilotoDesligado }, instanteServidor), { aceitar: false, pix: false, desistir: true });
  assert.deepEqual(modelo.acoesDoPedido({
    ...garantia, preReserva: { ...garantia.preReserva, garantia: { situacao: "EXPIRADA", ate } },
  }, instanteServidor), { aceitar: false, pix: false, desistir: false });
});

test("corpos incluem exatamente os campos das rotas e os termos correspondem à versão exibida", () => {
  assert.deepEqual(modelo.corpoEntrada("123.456.789-00"), { cpf: "12345678900" });
  assert.deepEqual(modelo.corpoCodigo("desafio-opaco", " 012345 "), { desafio: "desafio-opaco", codigo: "012345" });
  assert.equal(modelo.termosDaOferta(oferta), termos.TERMOS_PRE_RESERVA);
  const atualizada = { ...oferta, versaoOferta: "nova-oferta", termos: { versao: "nova-versao", texto: "Termos atualizados da API." } };
  assert.equal(modelo.termosDaOferta(atualizada), atualizada.termos.texto);
  assert.deepEqual(modelo.corpoAceite(atualizada), { versaoOferta: "nova-oferta", termosVersao: "nova-versao" });
  assert.equal(modelo.corpoDesistencia(false), null);
  assert.deepEqual(modelo.corpoDesistencia(true), { confirmarLiberacao: true });
});

test("uma leitura anterior perde o direito de aplicar a resposta ao iniciar outra", () => {
  const referencia = { current: 0 };
  const anterior = modelo.iniciarLeitura(referencia);
  assert.equal(anterior(), true);
  const atual = modelo.iniciarLeitura(referencia);
  assert.equal(atual(), true);
  assert.equal(anterior(), false);
});

function carregarTela(confirmar: (titulo: string, mensagem: string) => Promise<boolean> = async () => false) {
  return carregarComponente("components/pre-reserva/MeuPedido.tsx", {
    "@/components/JanelaConfirmacao": { dialogo: { confirmar } },
    "@/components/fechamento/MarcaPublica": { useMarcaPublica: () => ({ nome: "Buffet local", kidmais: false }) },
    "@/components/site/FundoFesta": { default: "fundo" },
    "@/components/site/fonte": { fonteTexto: { variable: "texto" }, fonteTitulo: { variable: "titulo" } },
    "@/components/site/PausaGlobal": { PausaGlobal: "pausa" },
    "@/lib/area-familia/formato": formato,
    "@/lib/fechamentos/rota-publica": rotas,
    "@/lib/pre-reserva/termos": termos,
    "./meu-pedido": modelo,
    "../area-familia/AreaFamilia.module.css": cssFalso,
    "./MeuPedido.module.css": cssFalso,
  });
}

function clicar(arvore: unknown, rotulo: string) {
  (achar(arvore, "button", rotulo).props.onClick as (e: object) => void)({ currentTarget: {} });
}

function submeter(arvore: unknown) {
  return (achar(arvore, "form").props.onSubmit as (e: object) => unknown)({ preventDefault() {} });
}

function alterar(arvore: unknown, target: object) {
  (achar(arvore, "input").props.onChange as (e: object) => void)({ target });
}

function controlarTempo(t: TestContext, diferencaDoAparelho: number) {
  let decorrido = 0;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: instanteServidor + diferencaDoAparelho });
  t.mock.method(performance, "now", () => decorrido);
  return (milissegundos: number) => {
    decorrido += milissegundos;
    t.mock.timers.tick(milissegundos);
  };
}

test("novo aceite oculta QR, garantia existente oculta oferta e indisponibilidade oculta todas as ações", () => {
  const tela = carregarTela();
  const props = {
    agora: instanteServidor, ocupado: false, erro: "", gravar: async () => {}, verPix: async () => {},
    pix: { pedidoId: pedido.id, dados: { aceiteSequencia: 1, valorCentavos: 10000, qrSvg: "<svg/>", copiaECola: "pix-sintetico" } },
  };
  const renovado = tela.render("CartaoPedido", { ...props, pedido: novaOferta });
  assert.match(texto(renovado), /oferta mudou ou foi reaberta/);
  assert.match(texto(renovado), /Devolvido/);
  assert.equal(talvez(renovado, "button", "Ver Pix do sinal"), undefined);
  assert.ok(!elementos(renovado).some(e => e.type === tela.modulo.PixDoSinal));
  const pendente = tela.render("CartaoPedido", { ...props, pedido: { ...aguardando, oferta: pilotoDesligado } });
  assert.ok(elementos(pendente).some(e => e.type === tela.modulo.PixDoSinal));
  const ativo = tela.render("CartaoPedido", { ...props, pedido: garantia });
  assert.match(texto(ativo), /Horário garantido até 01\/12\/2026\D+23:30/);
  assert.ok(achar(ativo, "button", "Desistir da garantia"));
  assert.equal(talvez(ativo, tela.modulo.AceitarOferta, ""), undefined);
  const bloqueado = tela.render("CartaoPedido", { ...props, pedido: indisponivel });
  assert.match(texto(bloqueado), /pedido comum segue normalmente/);
  assert.equal(talvez(bloqueado, tela.modulo.AceitarOferta, ""), undefined);
  for (const botao of ["Desistir da garantia", "Ver Pix do sinal"]) assert.equal(talvez(bloqueado, "button", botao), undefined);
});

test("sessão encerrada no Pix volta para a entrada com aviso, e schema ausente informa sobre o pedido comum", async (t) => {
  const tela = carregarTela();
  t.mock.method(globalThis, "fetch", async (url: string) => url.endsWith("/pix")
    ? Response.json({ ok: false, codigo: "SESSAO_ENCERRADA" }, { status: 401 })
    : respostaDaSessao([aguardando]));
  const render = () => tela.render("default", { empresa: null });
  render();
  tela.efeitos();
  await tique();
  const cartao = achar(render(), tela.modulo.CartaoPedido);
  await (cartao.props.verPix as () => Promise<void>)();
  assert.equal(achar(render(), tela.modulo.Entrada).props.aviso, modelo.SESSAO_ENCERRADA);
  assert.ok(!elementos(render()).some(e => e.type === tela.modulo.CartaoPedido));

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, codigo: "PRE_RESERVA_INDISPONIVEL" }, { status: 503 }));
  const semSchema = carregarTela();
  semSchema.render("default", { empresa: null });
  semSchema.efeitos();
  await tique();
  const bloqueado = semSchema.render("default", { empresa: null });
  assert.match(texto(bloqueado), /pré-reserva está indisponível.*pedido comum segue normalmente/);
  assert.ok(!elementos(bloqueado).some(e => e.type === semSchema.modulo.CartaoPedido || e.type === semSchema.modulo.Entrada));
});

test("desistência só grava depois da confirmação que explica a liberação e o destino do sinal", async () => {
  const envios: unknown[] = [];
  let confirmar = false;
  const tela = carregarTela(async (titulo, mensagem) => {
    assert.match(titulo, /Confirmar desistência/);
    assert.match(mensagem, /horário será liberado e o sinal ficará a devolver/);
    return confirmar;
  });
  const render = () => tela.render("CartaoPedido", {
    pedido: garantia, agora: instanteServidor, ocupado: false, erro: "", pix: null,
    gravar: async (acao: unknown) => { envios.push(acao); },
  });
  clicar(render(), "Desistir da garantia");
  await tique();
  assert.deepEqual(envios, []);
  confirmar = true;
  clicar(render(), "Desistir da garantia");
  await tique();
  assert.deepEqual(envios, [{ tipo: "desistencia", confirmado: true }]);
});

test("o vencimento da primeira garantia bloqueia a confirmação em aberto e atualiza o destino pela releitura", async (t) => {
  const passar = controlarTempo(t, -20 * 60_000);
  const tela = carregarTela();
  const confirmacao = Promise.withResolvers<boolean>();
  const cartao = carregarTela(() => confirmacao.promise);
  const releitura = Promise.withResolvers<Response>();
  const expirado: Pedido = { ...garantia, preReserva: { ...garantia.preReserva,
    garantia: { situacao: "EXPIRADA", ate }, dinheiro: [{ situacao: "A_DEVOLVER", valorCentavos: 10000, devolverDesde: ate }],
  } };
  const outro: Pedido = { ...garantia, id: "22222222-2222-4222-8222-222222222222", preReserva: { ...garantia.preReserva,
    garantia: { situacao: "ATIVA", ate: new Date(instanteServidor + 45_000).toISOString() },
  } };
  let leituras = 0;
  const posts: { url: string; referrerPolicy?: ReferrerPolicy; corpo: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, referrerPolicy: init.referrerPolicy, corpo: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }
    leituras++;
    if (leituras === 1) return respostaDaSessao([outro, garantia]);
    if (leituras === 2) return releitura.promise;
    return respostaDaSessao([expirado], Date.parse(ate));
  });
  const render = () => tela.render("default", { empresa: null });
  function renderCartao(id: string) {
    const props = elementos(render()).find(e => e.type === tela.modulo.CartaoPedido && (e.props.pedido as Pedido).id === id)?.props;
    assert.ok(props);
    return cartao.render("CartaoPedido", props);
  }
  render();
  tela.efeitos();
  await tique();
  const antes = renderCartao(pedido.id);
  tela.efeitos();
  clicar(antes, "Desistir da garantia");
  passar(29_999);
  assert.equal(leituras, 1);
  passar(1);
  assert.equal(leituras, 2);
  const durante = renderCartao(pedido.id);
  assert.match(texto(durante), /Atualizando a situação da garantia/);
  assert.doesNotMatch(texto(durante), /Horário garantido|Vinculado à garantia|A devolver/);
  assert.equal(talvez(durante, "button", "Desistir da garantia"), undefined);
  releitura.resolve(respostaDaSessao([outro, expirado], Date.parse(ate)));
  await tique();
  const depois = renderCartao(pedido.id);
  assert.match(texto(depois), /A garantia venceu.*A devolver/);
  assert.equal(talvez(depois, "button", "Desistir da garantia"), undefined);
  confirmacao.resolve(true);
  await tique();
  assert.deepEqual(posts, []);

  clicar(renderCartao(outro.id), "Desistir da garantia");
  await tique();
  assert.deepEqual(posts, [{ url: `/api/meu-pedido/${outro.id}/desistencia`, referrerPolicy: "same-origin", corpo: { confirmarLiberacao: true } }]);
  assert.equal(leituras, 3);
});

for (const diferenca of [20, -20]) {
  test(`a sessão é relida no prazo do servidor com aparelho ${diferenca > 0 ? "adiantado" : "atrasado"}`, async (t) => {
    const passar = controlarTempo(t, diferenca * 60_000);
    const tela = carregarTela();
    const releitura = Promise.withResolvers<Response>();
    let leituras = 0;
    t.mock.method(globalThis, "fetch", async () => ++leituras === 1 ? respostaDaSessao([pedido]) : releitura.promise);
    const render = () => tela.render("default", { empresa: null });
    render();
    tela.efeitos();
    await tique();
    assert.ok(achar(render(), tela.modulo.CartaoPedido));
    tela.efeitos();
    passar(59_999);
    assert.equal(leituras, 1);
    assert.ok(achar(render(), tela.modulo.CartaoPedido));
    passar(1);
    assert.equal(leituras, 2);
    assert.ok(!elementos(render()).some(e => e.type === tela.modulo.CartaoPedido));
    releitura.resolve(Response.json({ ok: false, codigo: "SESSAO_ENCERRADA" }, { status: 401 }));
    await tique();
    assert.equal(achar(render(), tela.modulo.Entrada).props.aviso, modelo.SESSAO_ENCERRADA);
  });
}

test("o formulário exige marcar os termos integrais e desmarca depois do envio", () => {
  const tela = carregarTela();
  let envios = 0;
  const render = () => tela.render("AceitarOferta", { oferta, ocupado: false, aceitar: async () => { envios++; } });
  assert.ok(texto(render()).includes(termos.TERMOS_PRE_RESERVA));
  assert.equal(achar(render(), "button", "Aceitar pré-reserva").props.disabled, true);
  submeter(render());
  assert.equal(envios, 0);
  alterar(render(), { checked: true });
  submeter(render());
  assert.equal(envios, 1);
  assert.equal(achar(render(), "button", "Aceitar pré-reserva").props.disabled, true);
});

test("a entrada envia a confirmação mesmo com o aparelho adiantado e distingue a recusa por prazo", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: instanteServidor + 20 * 60_000 });
  const tela = carregarTela();
  let agora = instanteServidor;
  let confirmou = false;
  const requisicoes: { url: string; referrerPolicy?: ReferrerPolicy }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    requisicoes.push({ url, referrerPolicy: init?.referrerPolicy });
    const headers = { Date: new Date(agora).toUTCString() };
    return url.includes("/iniciar")
      ? Response.json({ ok: true, data: { desafio: "opaco", expiraEm: ate } }, { headers })
      : confirmou ? Response.json({ ok: true }, { headers })
        : Response.json({ ok: false, codigo: "CODIGO_NAO_CONFIRMADO" }, { status: 401, headers });
  });
  let entradas = 0;
  const render = () => tela.render("Entrada", { empresa: "buffet", aviso: "", aoEntrar: async () => { entradas++; } });
  alterar(render(), { value: "123.456.789-00" });
  await submeter(render());
  const mensagem = /Se houver um cadastro para este CPF, o código será enviado/;
  assert.match(texto(render()), mensagem);
  alterar(render(), { value: "012345" });
  await submeter(render());
  assert.match(texto(render()), /Código incorreto ou vencido/);
  assert.equal(achar(render(), "input").props["aria-describedby"], achar(render(), "p", /Código incorreto/).props.id);
  confirmou = true;
  await submeter(render());
  assert.equal(entradas, 1);
  confirmou = false;
  agora = Date.parse(ate);
  t.mock.timers.setTime(agora - 20 * 60_000);
  await submeter(render());
  assert.match(texto(render()), /O código venceu/);
  assert.deepEqual(requisicoes, [
    { url: "/api/meu-pedido/entrada/iniciar?empresa=buffet", referrerPolicy: "same-origin" },
    ...Array.from({ length: 3 }, () => ({ url: "/api/meu-pedido/entrada/confirmar?empresa=buffet", referrerPolicy: "same-origin" })),
  ]);
});

test("409 de aceite recarrega e mostra a nova versão, sem envio duplo nem QR de uma leitura anterior", async (t) => {
  const tela = carregarTela();
  const pixAtrasado = Promise.withResolvers<Response>();
  const mudanca = Promise.withResolvers<Response>();
  const ofertaAtual = { ...oferta, versaoOferta: "nova-oferta" };
  const chamadas: { url: string; corpo?: unknown; referrerPolicy?: ReferrerPolicy }[] = [];
  let leituras = 0;
  const outro = { ...aguardando, id: "22222222-2222-4222-8222-222222222222" };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    chamadas.push({ url, corpo: init?.body ? JSON.parse(String(init.body)) : undefined, referrerPolicy: init?.referrerPolicy });
    if (url.includes("/pix?")) return pixAtrasado.promise;
    if (url.includes("/aceite?")) return mudanca.promise;
    leituras++;
    return respostaDaSessao(leituras === 1 ? [pedido, outro] : [{ ...novaOferta, oferta: ofertaAtual }, outro]);
  });
  const render = () => tela.render("default", { empresa: "buffet" });
  render();
  tela.efeitos();
  await tique();
  const cartoes = achar(render(), "ul").props.children as { props: { children: { props: Record<string, unknown> } } }[];
  const acao = { tipo: "aceite", oferta };
  const verPix = cartoes[1].props.children.props.verPix as () => Promise<void>;
  const gravar = cartoes[0].props.children.props.gravar as (acao: object) => Promise<void>;
  const pixEmCurso = verPix();
  const post = gravar(acao);
  await gravar(acao);
  mudanca.resolve(Response.json({ ok: false, codigo: "OFERTA_DESATUALIZADA" }, { status: 409 }));
  await post;
  pixAtrasado.resolve(Response.json({ ok: true, data: { aceiteSequencia: 1, qrSvg: "<svg/>" } }));
  await pixEmCurso;
  const atualizados = achar(render(), "ul").props.children as typeof cartoes;
  assert.equal(atualizados[1].props.children.props.pix, null);
  const atual = atualizados[0].props.children.props;
  const nova = (atual.pedido as Pedido).oferta;
  assert.ok(nova.disponivel);
  assert.equal(nova.versaoOferta, ofertaAtual.versaoOferta);
  assert.match(String(atual.erro), /A oferta mudou/);
  assert.deepEqual(chamadas, [
    { url: "/api/meu-pedido?empresa=buffet", corpo: undefined, referrerPolicy: undefined },
    { url: `/api/meu-pedido/${outro.id}/pix?empresa=buffet`, corpo: undefined, referrerPolicy: undefined },
    { url: `/api/meu-pedido/${pedido.id}/aceite?empresa=buffet`, corpo: modelo.corpoAceite(oferta), referrerPolicy: "same-origin" },
    { url: "/api/meu-pedido?empresa=buffet", corpo: undefined, referrerPolicy: undefined },
  ]);
});
