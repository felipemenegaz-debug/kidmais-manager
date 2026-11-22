import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { dialogo } from "../JanelaConfirmacao.ts";
import { achar, carregarComponente, cssFalso, elementos, talvez, texto, tique } from "../admin/teste-componente.ts";
import * as formato from "../../lib/area-familia/formato.ts";
import { origemPublicaValida } from "../../lib/area-familia/regras-http.ts";
import { decidirEndereco, type AmbienteEnderecos } from "../../lib/enderecos/roteamento.ts";
import * as rotas from "../../lib/fechamentos/rota-publica.ts";
import { rotear } from "../../lib/marketing/dominios/hosts.ts";
import * as politica from "../../lib/pre-reserva/politica.ts";
import * as termos from "../../lib/pre-reserva/termos.ts";
import * as modelo from "./meu-pedido.ts";
import type { Oferta, Pedido } from "./meu-pedido.ts";
import { destinoMeuPedido } from "./origem-meu-pedido.ts";

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

test("o limite da oferta em São Paulo começa no primeiro milissegundo com menos de 24 horas", () => {
  const ofertaDaNoite = { ...pedido, inicio: "23:30:00" };
  const ultimas24Horas = Date.parse("2026-12-03T02:30:00.000Z");
  assert.equal(modelo.limiteDoAceite(ofertaDaNoite), ultimas24Horas + 1);
  assert.equal(modelo.acoesDoPedido(ofertaDaNoite, ultimas24Horas - modelo.MARGEM_PRAZO_MS).aceitar, true);
  assert.equal(modelo.acoesDoPedido(ofertaDaNoite, ultimas24Horas + 1 - modelo.MARGEM_PRAZO_MS).aceitar, false);
  assert.equal(modelo.limiteDoAceite({ ...ofertaDaNoite, inicio: "23:30:00.125456" }), ultimas24Horas + 126);
  assert.equal(modelo.limiteDoAceite(indisponivel), null);
});

test("relógio pessimista soma o trânsito desde o início do GET e a precisão do Date", (t) => {
  const { adiantarRelogio } = controlarTempo(t, 20 * 60_000);
  const iniciadoEm = performance.now();
  adiantarRelogio(5_000);
  const relogio = modelo.relogioDoServidor(new Date(instanteServidor).toUTCString(), iniciadoEm);
  assert.equal(relogio?.(), instanteServidor + 6_000);
  adiantarRelogio(100);
  assert.equal(relogio?.(), instanteServidor + 6_100);
  assert.equal(modelo.relogioDoServidor(null, iniciadoEm), null);
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
  for (const canal of ["WHATSAPP", "EMAIL"] as const) {
    assert.deepEqual(modelo.corpoEntrada("123.456.789-00", canal), { cpf: "12345678900", canal });
  }
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

function carregarTela(confirmar: typeof dialogo.confirmar = async () => false) {
  return carregarComponente("components/pre-reserva/MeuPedido.tsx", {
    "@/components/JanelaConfirmacao": { dialogo: { confirmar } },
    "@/components/fechamento/MarcaPublica": { useMarcaPublica: () => ({ nome: "Buffet local", kidmais: false }) },
    "@/components/site/FundoFesta": { default: "fundo" },
    "@/components/site/fonte": { fonteTexto: { variable: "texto" }, fonteTitulo: { variable: "titulo" } },
    "@/components/site/PausaGlobal": { PausaGlobal: "pausa" },
    "@/lib/area-familia/formato": formato,
    "@/lib/fechamentos/rota-publica": rotas,
    "@/lib/pre-reserva/politica": politica,
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
  return {
    passar(milissegundos: number) {
      decorrido += milissegundos;
      t.mock.timers.tick(milissegundos);
    },
    adiantarRelogio(milissegundos: number) { decorrido += milissegundos; },
    dispararTimers(milissegundos: number) { t.mock.timers.tick(milissegundos); },
  };
}

function carregarPagina(empresa: string | null, headers: () => Headers, env: AmbienteEnderecos, consultar = () => {}) {
  const arquivo = empresa ? "app/b/[empresa]/meu-pedido/page.tsx" : "app/meu-pedido/page.tsx";
  const pagina = carregarComponente(arquivo, {
    "next/headers": { headers },
    "next/navigation": {
      notFound: () => { throw new Error("404"); },
      redirect: (url: string) => { throw new Error(url); },
    },
    "@/components/pre-reserva/MeuPedido": { default: "meu-pedido" },
    "@/components/pre-reserva/origem-meu-pedido": { destinoMeuPedido: (headers: Headers, empresa: string | null) => destinoMeuPedido(headers, empresa, env) },
    "@/components/fechamento/MarcaPublica": { MarcaPublicaProvider: "marca" },
    "@/lib/comercial/cotacao-publica": { escopoCotacaoPublica: async (_db: unknown, codigo: string) => {
      consultar();
      assert.equal(codigo, empresa);
      return { empresaId: "id-buffet" };
    } },
    "@/lib/comercial/regras-pagamento": { REGRAS_LEGADAS: {} },
    "@/lib/db/postgres": { db: () => ({}) },
    "@/lib/perfil/nome-publico": { nomePublicoDaEmpresa: async () => "Buffet de teste" },
    "../empresa-publica": { logoDoAssistente: async () => null },
  });
  return () => pagina.render("default", { params: Promise.resolve({ empresa }) }) as Promise<unknown>;
}

test("PREPARACAO leva os dois caminhos ao host onde a API aceita o POST, antes de mostrar a entrada", async () => {
  const antiga = "https://kidmais.example.test";
  const nova = "https://iafest.demerzellabs.com.br";
  const env = { ENDERECOS_MODO: "PREPARACAO", ENDERECOS_ORIGEM_ANTIGA: antiga, ENDERECOS_ORIGEM_NOVA: nova, ADMIN_AUTH_ORIGIN: antiga };
  const hostNovo = new URL(nova).host;
  const hostAntigo = new URL(antiga).host;
  const cabecalhos = (host: string, proto = "https") => new Headers({ host, "x-forwarded-proto": proto });
  const postAceito = (origem: string) => origemPublicaValida(new Request(`${origem}/api/meu-pedido/entrada/iniciar`, {
    method: "POST", headers: { origin: origem, "sec-fetch-site": "same-origin" },
  }), env);
  assert.equal(postAceito(nova), false);
  assert.equal(postAceito(antiga), true);

  for (const empresa of [null, "buffet-teste"]) {
    const pathname = empresa ? `/b/${empresa}/meu-pedido` : "/meu-pedido";
    const destino = `${antiga}${pathname}`;
    const rotear = (host: string) => decidirEndereco({ metodo: "GET", host, pathname, search: "" }, env);
    assert.deepEqual(rotear(hostNovo), empresa ? { tipo: "PASSAR" } : { tipo: "REDIRECIONAR", destino });
    assert.deepEqual(rotear(hostAntigo), { tipo: "PASSAR" });
    let host = hostNovo;
    let proto = "https";
    let consultas = 0;
    const render = carregarPagina(empresa, () => cabecalhos(host, proto), env, () => { consultas++; });
    await assert.rejects(render(), { message: destino });
    host = hostAntigo;
    proto = "http";
    await assert.rejects(render(), { message: destino });
    assert.equal(consultas, 0);
    proto = "https";
    assert.equal(achar(await render(), "meu-pedido").props.empresa, empresa);
  }
  const comOrigemPublica = { ...env, AREA_FAMILIA_PUBLIC_ORIGIN: nova };
  assert.deepEqual(destinoMeuPedido(cabecalhos(hostAntigo), "buffet-teste", comOrigemPublica), {
    tipo: "REDIRECIONAR", destino: `${nova}/b/buffet-teste/meu-pedido`,
  });
  assert.deepEqual(destinoMeuPedido(cabecalhos(hostAntigo), null, comOrigemPublica), { tipo: "INDISPONIVEL" });
});

for (const empresa of [null, "buffet-teste"]) {
  const caminho = empresa ? `/b/${empresa}/meu-pedido` : "/meu-pedido";
  test(`ATIVA leva o link de ${caminho} ao formulário com origem aceita no POST`, async (t) => {
    const antiga = "https://kidmais.example.test";
    const nova = "https://iafest.demerzellabs.com.br";
    const env = {
      ENDERECOS_MODO: "ATIVA", ENDERECOS_ORIGEM_ANTIGA: antiga, ENDERECOS_ORIGEM_NOVA: nova,
      ADMIN_AUTH_ORIGIN: nova, AREA_FAMILIA_PUBLIC_ORIGIN: nova,
      SITE_URL: antiga, MARKETING_DOMINIOS_PERSONALIZADOS: "true",
    };
    const wizard = readFileSync(new URL("../fechamento/FechamentoWizard.tsx", import.meta.url), "utf8");
    assert.match(wizard, /\{!origemInterna && <a [^>]*href=\{empresa \? `\/b\/\$\{encodeURIComponent\(empresa\)\}\/meu-pedido` : "\/meu-pedido"\}>Meu pedido<\/a>\}/);
    const fechamento = new URL(rotas.paginaPublica("/fechamento", empresa), empresa ? nova : antiga);
    const decidir = (url: URL, metodo = "GET") => decidirEndereco({ metodo, host: url.host, pathname: url.pathname, search: url.search }, env);
    assert.deepEqual(decidir(fechamento), { tipo: "PASSAR" });
    assert.deepEqual(rotear(fechamento.host, fechamento.pathname, env), { tipo: "PLATAFORMA" });

    const link = new URL(caminho, fechamento);
    const redirecionamento = decidir(link);
    assert.deepEqual(redirecionamento, empresa ? { tipo: "PASSAR" } : { tipo: "REDIRECIONAR", destino: `${nova}${caminho}` });
    const destino = redirecionamento.tipo === "REDIRECIONAR" ? new URL(redirecionamento.destino) : link;
    assert.deepEqual(decidir(destino), { tipo: "PASSAR" });
    assert.deepEqual(rotear(destino.host, destino.pathname, env), { tipo: "PLATAFORMA" });
    const pagina = carregarPagina(empresa, () => new Headers({ host: destino.host, "x-forwarded-proto": "https" }), env);
    const props = achar(await pagina(), "meu-pedido").props;
    assert.equal(props.empresa, empresa);

    const tela = carregarTela();
    const entrada = carregarTela();
    const posts: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ ok: false, codigo: "SESSAO_ENCERRADA" }, { status: 401 });
      const api = new URL(url, destino);
      posts.push(api.href);
      assert.deepEqual(decidir(api, "POST"), { tipo: "PASSAR" });
      assert.deepEqual(rotear(api.host, api.pathname, env), { tipo: "PLATAFORMA" });
      assert.equal(init.referrerPolicy, "same-origin");
      const request = new Request(api, { ...init, headers: { origin: destino.origin, "sec-fetch-site": "same-origin" } });
      assert.equal(origemPublicaValida(request, env), true);
      return Response.json({ ok: true, data: { desafio: "opaco", expiraEm: ate } }, { status: 202 });
    });
    tela.render("default", props);
    tela.efeitos();
    await tique();
    const propsEntrada = achar(tela.render("default", props), tela.modulo.Entrada).props;
    const renderEntrada = () => entrada.render("Entrada", propsEntrada);
    alterar(renderEntrada(), { value: "12345678909" });
    await submeter(renderEntrada());
    assert.ok(achar(renderEntrada(), "button", "Entrar"));
    assert.deepEqual(posts, [`${nova}/api/meu-pedido/entrada/iniciar${empresa ? `?empresa=${empresa}` : ""}`]);
  });
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

test("Meus pedidos ordena a resposta por data, início e protocolo, preservando empates completos", async (t) => {
  const entrada = [
    { ...pedido, id: "1", data: "2026-12-04", inicio: "08:00:00", protocolo: "KM-A" },
    { ...pedido, id: "2", inicio: "10:00:00", protocolo: "KM-A" },
    { ...pedido, id: "3", inicio: "09:00:00.5", protocolo: "KM-B" },
    { ...pedido, id: "4", inicio: "09:00:00", protocolo: "KM-C" },
    { ...pedido, id: "5", inicio: "09:00:00", protocolo: "KM-B" },
    { ...pedido, id: "6", inicio: "09:00:00", protocolo: "KM-B" },
  ];
  t.mock.method(globalThis, "fetch", async () => respostaDaSessao(entrada));
  const tela = carregarTela();
  const render = () => tela.render("default", { empresa: null });
  render();
  tela.efeitos();
  await tique();
  const ids = elementos(render()).filter(e => e.type === tela.modulo.CartaoPedido).map(e => (e.props.pedido as Pedido).id);
  assert.deepEqual(ids, ["5", "6", "4", "3", "2", "1"]);
});

test("cada sinal a devolver ou em devolução mostra o prazo da política junto ao valor", () => {
  const tela = carregarTela();
  const situacoes = ["A_DEVOLVER", "EM_DEVOLUCAO", "DEVOLVIDO", "CREDITO_CONTRATO", "EM_GARANTIA"];
  const arvore = tela.render("CartaoPedido", {
    agora: instanteServidor, ocupado: false, erro: "", pix: null, gravar: async () => {}, verPix: async () => {},
    pedido: { ...garantia, preReserva: { ...garantia.preReserva, dinheiro: situacoes.map(situacao => ({
      situacao, valorCentavos: oferta.sinalCentavos, devolverDesde: ate,
    })) } },
  });
  const linhas = elementos(arvore).filter(e => e.type === "div" && elementos(e).some(filho => filho.type === "dt"));
  for (const situacao of situacoes) {
    const rotulo = modelo.rotuloDinheiro(situacao);
    const linha = linhas.find(e => texto(e).startsWith(rotulo));
    assert.ok(linha, rotulo);
    assert.equal(texto(linha).includes(`Prazo de devolução ${politica.POLITICA_PRE_RESERVA.prazoDevolucao}.`),
      situacao === "A_DEVOLVER" || situacao === "EM_DEVOLUCAO", rotulo);
    assert.equal(texto(achar(linha, "dd")), formato.reais(oferta.sinalCentavos));
  }
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

for (const acao of ["desistencia", "aceite"] as const) {
  test(`uma releitura pelo prazo de outro pedido avisa que ${acao} não foi registrado e exige nova confirmação`, async (t) => {
    const { passar } = controlarTempo(t, 0);
    const tela = carregarTela();
    const confirmacao = Promise.withResolvers<boolean>();
    let confirmacoes = 0;
    const cartao = carregarTela(() => ++confirmacoes === 1 ? confirmacao.promise : Promise.resolve(true));
    const formulario = carregarTela();
    const releitura = Promise.withResolvers<Response>();
    const cliente: Pedido = {
      ...(acao === "aceite" ? pedido : garantia),
      id: "22222222-2222-4222-8222-222222222222", protocolo: "KM-22222222",
      ...(acao === "desistencia" && { preReserva: { ...garantia.preReserva,
        garantia: { situacao: "ATIVA", ate: new Date(instanteServidor + 90_000).toISOString() },
      } }),
    };
    const vencido = { ...garantia, preReserva: { ...garantia.preReserva, garantia: { situacao: "EXPIRADA", ate } } } as const;
    const expiraEm = instanteServidor + 120_000;
    const atualizada = () => respostaDaSessao([vencido, cliente], Date.parse(ate), expiraEm);
    const posts: { url: string; corpo: unknown }[] = [];
    let leituras = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, corpo: JSON.parse(String(init.body)) });
        return Response.json({ ok: true });
      }
      if (++leituras === 1) return respostaDaSessao([garantia, cliente], instanteServidor, expiraEm);
      return leituras === 2 ? releitura.promise : atualizada();
    });
    const render = () => tela.render("default", { empresa: null });
    const renderCartao = (id = cliente.id) => {
      const props = elementos(render()).find(e => e.type === tela.modulo.CartaoPedido && (e.props.pedido as Pedido).id === id)?.props;
      assert.ok(props);
      return cartao.render("CartaoPedido", props);
    };
    const renderFormulario = () => formulario.render("AceitarOferta", achar(renderCartao(), cartao.modulo.AceitarOferta).props);
    const aviso = acao === "aceite" ? /O aceite não foi registrado.*confirme novamente/ : /A desistência não foi registrada.*confirme novamente/;
    const rotulo = acao === "aceite" ? "Aceitar pré-reserva" : "Desistir da garantia";
    render();
    tela.efeitos();
    await tique();
    render();
    tela.efeitos();
    let formularioConfirmado: unknown;
    if (acao === "desistencia") clicar(renderCartao(), rotulo);
    else {
      alterar(renderFormulario(), { checked: true });
      formularioConfirmado = renderFormulario();
      assert.equal(achar(formularioConfirmado, "button", rotulo).props.disabled, false);
    }
    passar(14_000);
    assert.equal(leituras, 2);
    assert.match(texto(renderCartao(garantia.id)), /Atualizando a situação da garantia/);
    if (acao === "desistencia") confirmacao.resolve(true);
    else submeter(formularioConfirmado);
    await tique();
    assert.deepEqual(posts, []);
    assert.equal(achar(renderCartao(), "p", aviso).props.role, "alert");
    assert.doesNotMatch(texto(renderCartao(garantia.id)), aviso);
    assert.equal(achar(acao === "aceite" ? renderFormulario() : renderCartao(), "button", rotulo).props.disabled, true);

    passar(16_000);
    releitura.resolve(atualizada());
    await tique();
    assert.match(texto(renderCartao()), aviso);
    assert.deepEqual(posts, []);
    if (acao === "desistencia") {
      assert.equal(achar(renderCartao(), "button", rotulo).props.disabled, false);
      clicar(renderCartao(), rotulo);
      assert.equal(confirmacoes, 2);
    } else {
      const formularioAtual = renderFormulario();
      assert.equal(achar(formularioAtual, "input").props.checked, false);
      assert.equal(achar(formularioAtual, "button", rotulo).props.disabled, true);
      alterar(formularioAtual, { checked: true });
      submeter(renderFormulario());
    }
    await tique();
    assert.deepEqual(posts, [{
      url: `/api/meu-pedido/${cliente.id}/${acao}`,
      corpo: acao === "aceite" ? modelo.corpoAceite(oferta) : modelo.corpoDesistencia(true),
    }]);
  });
}

test("o vencimento da primeira garantia bloqueia a confirmação em aberto e atualiza o destino pela releitura", async (t) => {
  const { passar } = controlarTempo(t, -20 * 60_000);
  const tela = carregarTela();
  const confirmacao = Promise.withResolvers<boolean>();
  const cartao = carregarTela(() => confirmacao.promise);
  const releitura = Promise.withResolvers<Response>();
  const expirado: Pedido = { ...garantia, preReserva: { ...garantia.preReserva,
    garantia: { situacao: "EXPIRADA", ate }, dinheiro: [{ situacao: "A_DEVOLVER", valorCentavos: 10000, devolverDesde: ate }],
  } };
  const outro: Pedido = { ...garantia, id: "22222222-2222-4222-8222-222222222222", preReserva: { ...garantia.preReserva,
    garantia: { situacao: "ATIVA", ate: new Date(instanteServidor + 60_000).toISOString() },
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
  passar(13_999);
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

test("o diálogo real confirma após a remoção do botão e o cartão avisa que a desistência não foi registrada", async (t) => {
  const { passar } = controlarTempo(t, 0);
  const focados: ElementoDoDialogo[] = [];
  class ElementoDoDialogo {
    filhos: ElementoDoDialogo[] = [];
    isConnected = true;
    open = false;
    value = "";
    textContent = "";
    onclick?: () => Promise<void>;
    append(...filhos: ElementoDoDialogo[]) { this.filhos.push(...filhos); }
    setAttribute() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.isConnected = false; }
    focus() { focados.push(this); }
  }
  const gatilho = new ElementoDoDialogo();
  const titulo = new ElementoDoDialogo();
  const body = new ElementoDoDialogo();
  gatilho.focus();
  const globais = {
    HTMLElement: ElementoDoDialogo,
    document: { body, get activeElement() { return focados.at(-1); }, createElement: () => new ElementoDoDialogo() },
    location: { href: "https://buffet.example.test/meu-pedido" },
    window: new EventTarget(),
  };
  for (const [nome, value] of Object.entries(globais)) {
    const anterior = Object.getOwnPropertyDescriptor(globalThis, nome);
    Object.defineProperty(globalThis, nome, { configurable: true, value });
    t.after(() => { if (anterior) Object.defineProperty(globalThis, nome, anterior); else Reflect.deleteProperty(globalThis, nome); });
  }

  const tela = carregarTela();
  const cartao = carregarTela(dialogo.confirmar);
  const releitura = Promise.withResolvers<Response>();
  let leituras = 0;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts++; return Response.json({ ok: true }); }
    return ++leituras === 1 ? respostaDaSessao([garantia]) : releitura.promise;
  });
  const render = () => tela.render("default", { empresa: null });
  const renderCartao = () => cartao.render("CartaoPedido", achar(render(), tela.modulo.CartaoPedido).props);
  render();
  tela.efeitos();
  await tique();
  const antes = renderCartao();
  tela.efeitos();
  const cabecalho = achar(antes, "h2", garantia.protocolo);
  const ref = cabecalho.props.ref as { current: ElementoDoDialogo | null } | undefined;
  if (ref) ref.current = titulo; // O renderizador de testes não monta os elementos no DOM.
  const botao = achar(antes, "button", "Desistir da garantia");
  (botao.props.onClick as (e: object) => void)({ currentTarget: gatilho });
  const janela = body.filhos[0];
  const confirmar = janela.filhos.flatMap(e => e.filhos).find(e => e.textContent === "Confirmar desistência da garantia");
  assert.ok(janela.open && confirmar?.onclick);

  passar(14_000);
  assert.equal(leituras, 2);
  assert.equal(talvez(renderCartao(), "button", "Desistir da garantia"), undefined);
  gatilho.isConnected = false;
  await confirmar.onclick();
  await tique();
  const aviso = /A desistência não foi registrada.*confirme novamente/;
  assert.equal(achar(renderCartao(), "p", aviso).props.role, "alert");
  assert.equal(janela.open, false);
  assert.equal(focados.at(-1), titulo);
  assert.equal(cabecalho.props.tabIndex, -1);
  assert.equal(posts, 0);

  const expirado: Pedido = { ...garantia, preReserva: { ...garantia.preReserva, garantia: { situacao: "EXPIRADA", ate } } };
  releitura.resolve(respostaDaSessao([expirado], Date.parse(ate)));
  await tique();
  assert.match(texto(renderCartao()), /A garantia venceu/);
  assert.match(texto(renderCartao()), aviso);
  assert.equal(posts, 0);
});

test("cada garantia atualiza ao vencer, mesmo com o GET da garantia anterior pendente", async (t) => {
  const { passar } = controlarTempo(t, 20 * 60_000);
  const tela = carregarTela();
  const cartao = carregarTela();
  const primeiraLeitura = Promise.withResolvers<Response>();
  const segundaLeitura = Promise.withResolvers<Response>();
  const outraGarantia: Pedido = {
    ...garantia, id: "22222222-2222-4222-8222-222222222222",
    preReserva: { ...garantia.preReserva, garantia: { situacao: "ATIVA", ate: new Date(instanteServidor + 45_000).toISOString() } },
  };
  let leituras = 0;
  t.mock.method(globalThis, "fetch", async () => {
    leituras++;
    if (leituras === 1) return respostaDaSessao([garantia, outraGarantia]);
    return leituras === 2 ? primeiraLeitura.promise : segundaLeitura.promise;
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
  render();
  tela.efeitos();

  passar(14_000);
  assert.equal(leituras, 2);
  assert.match(texto(renderCartao(garantia.id)), /Atualizando a situação da garantia/);
  assert.match(texto(renderCartao(outraGarantia.id)), /Horário garantido.*Vinculado à garantia/);
  passar(15_000);
  assert.equal(leituras, 3);
  for (const id of [garantia.id, outraGarantia.id]) {
    const vencido = renderCartao(id);
    assert.match(texto(vencido), /Atualizando a situação da garantia/);
    assert.doesNotMatch(texto(vencido), /Horário garantido|Vinculado à garantia/);
    assert.equal(talvez(vencido, "button", "Desistir da garantia"), undefined);
  }

  const expiraram = [garantia, outraGarantia].map(p => ({ ...p, preReserva: { ...p.preReserva,
    garantia: { situacao: "EXPIRADA", ate: p.preReserva.garantia?.ate ?? null }, dinheiro: [],
  } }));
  segundaLeitura.resolve(respostaDaSessao(expiraram, instanteServidor + 45_000, instanteServidor + 120_000));
  await tique();
  primeiraLeitura.resolve(respostaDaSessao([garantia, outraGarantia], instanteServidor + 30_000));
  await tique();
  for (const p of expiraram) assert.match(texto(renderCartao(p.id)), /A garantia venceu/);
});

test("uma confirmação aberta confere a margem usando o relógio da leitura mais recente", async (t) => {
  const { passar } = controlarTempo(t, 0);
  const tela = carregarTela();
  const cartao = carregarTela();
  const releitura = Promise.withResolvers<Response>();
  let leituras = 0;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts++;
    if (++leituras === 1) return respostaDaSessao([garantia]);
    return releitura.promise;
  });
  const render = () => tela.render("default", { empresa: null });
  render();
  tela.efeitos();
  await tique();
  const gravar = achar(render(), tela.modulo.CartaoPedido).props.gravar as (acao: object) => Promise<void>;
  clicar(render(), "Atualizar pedidos");
  passar(8_000);
  releitura.resolve(respostaDaSessao([garantia], instanteServidor + 8_000));
  await tique();
  const atual = cartao.render("CartaoPedido", achar(render(), tela.modulo.CartaoPedido).props);
  assert.match(texto(atual), /Atualizando a situação da garantia/);
  await gravar({ tipo: "desistencia", confirmado: true });
  assert.equal(posts, 0);
  assert.equal(leituras, 3);
});

for (const diferenca of [20, -20]) {
  test(`a sessão é relida no prazo do servidor com aparelho ${diferenca > 0 ? "adiantado" : "atrasado"}`, async (t) => {
    const { passar } = controlarTempo(t, diferenca * 60_000);
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
    passar(43_999);
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

test("a sessão dentro da margem aguarda o servidor sem exibir pedidos ou iniciar GETs em sequência", async (t) => {
  const { passar } = controlarTempo(t, 0);
  const tela = carregarTela();
  const expiraEm = instanteServidor + 60_000;
  let leituras = 0;
  t.mock.method(globalThis, "fetch", async () => {
    leituras++;
    const agora = instanteServidor + performance.now();
    return agora < expiraEm ? respostaDaSessao([pedido], agora, expiraEm)
      : Response.json({ ok: false, codigo: "SESSAO_ENCERRADA" }, { status: 401 });
  });
  const render = () => tela.render("default", { empresa: null });
  const efeitos = () => { render(); tela.efeitos(); };
  efeitos();
  await tique();
  efeitos();
  passar(44_000);
  await tique();
  efeitos();
  assert.equal(leituras, 2);
  assert.match(texto(render()), /Carregando pedidos/);
  assert.ok(!elementos(render()).some(e => [tela.modulo.CartaoPedido, tela.modulo.Entrada].includes(e.type)));
  passar(14_999);
  assert.equal(leituras, 2);
  passar(1_001);
  await tique();
  assert.equal(leituras, 3);
  assert.equal(achar(render(), tela.modulo.Entrada).props.aviso, modelo.SESSAO_ENCERRADA);
});

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

test("os termos integrais começam recolhidos e a oferta e o aceite permanecem visíveis", () => {
  const tela = carregarTela();
  const arvore = tela.render("AceitarOferta", { oferta, ocupado: false, aceitar: async () => {} });
  const detalhes = achar(arvore, "details");
  assert.ok(!detalhes.props.open);
  assert.ok(achar(detalhes, "summary", "Ler os termos da pré-reserva"));
  assert.ok(achar(detalhes, "p", termos.TERMOS_PRE_RESERVA));
  for (const [tipo, rotulo] of [
    ["dd", formato.reais(oferta.sinalCentavos)], ["dd", `${oferta.recebedor.nome} · ${oferta.recebedor.cidade}`],
    ["p", termos.TEXTO_CONFERENCIA_PIX], ["label", "Li e aceito os termos da pré-reserva"], ["button", "Aceitar pré-reserva"],
  ]) {
    assert.ok(achar(arvore, tipo, rotulo));
    assert.equal(talvez(detalhes, tipo, rotulo), undefined);
  }
  assert.equal(achar(arvore, "input").props.required, true);
});

test("termos marcados antes das 24 horas não permitem enviar o aceite depois do limite", async (t) => {
  const { adiantarRelogio, dispararTimers } = controlarTempo(t, -20 * 60_000);
  const tela = carregarTela();
  const cartao = carregarTela();
  const formulario = carregarTela();
  const releitura = Promise.withResolvers<Response>();
  const antesDoLimite = Date.parse("2026-12-02T18:59:00.000Z");
  const expiraEm = antesDoLimite + 15 * 60_000;
  let leituras = 0;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++;
      return Response.json({ ok: true });
    }
    return ++leituras === 1 ? respostaDaSessao([pedido], antesDoLimite, expiraEm) : releitura.promise;
  });
  const render = () => tela.render("default", { empresa: null });
  const renderCartao = () => cartao.render("CartaoPedido", achar(render(), tela.modulo.CartaoPedido).props);
  const renderFormulario = () => formulario.render("AceitarOferta", achar(renderCartao(), cartao.modulo.AceitarOferta).props);
  render();
  tela.efeitos();
  await tique();
  const antes = renderFormulario();
  tela.efeitos();
  alterar(antes, { checked: true });
  const marcado = renderFormulario();
  assert.equal(achar(marcado, "button", "Aceitar pré-reserva").props.disabled, false);
  adiantarRelogio(120_000);
  // O clique pode chegar antes do temporizador, por exemplo ao voltar para esta aba.
  submeter(marcado);
  assert.equal(posts, 0);
  assert.equal(leituras, 2);

  dispararTimers(60_001);
  assert.equal(leituras, 2);
  const durante = renderCartao();
  assert.match(texto(durante), /Atualizando a situação da oferta/);
  assert.ok(!elementos(durante).some(e => e.type === cartao.modulo.AceitarOferta));

  const semOferta: Pedido = { ...pedido, oferta: { disponivel: false, motivo: "MENOS_DE_24_HORAS" } };
  releitura.resolve(respostaDaSessao([semOferta], antesDoLimite + 120_000, expiraEm));
  await tique();
  const depois = renderCartao();
  assert.match(texto(depois), /Faltam menos de 24 horas para a festa/);
  assert.doesNotMatch(texto(depois), /Atualizando a situação da oferta/);
  assert.ok(!elementos(depois).some(e => e.type === cartao.modulo.AceitarOferta));
  assert.equal(posts, 0);
});

test("primeiro GET entregue depois do limite do aceite bloqueia a oferta e dispara releitura", async (t) => {
  const { passar } = controlarTempo(t, 20 * 60_000);
  const tela = carregarTela();
  const cartao = carregarTela();
  const primeira = Promise.withResolvers<Response>();
  const segunda = Promise.withResolvers<Response>();
  const limite = Date.parse("2026-12-02T19:00:00.000Z");
  const expiraEm = limite + 60_000;
  let leituras = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    assert.equal(init?.method, undefined);
    return ++leituras === 1 ? primeira.promise : segunda.promise;
  });
  const render = () => tela.render("default", { empresa: null });
  const renderCartao = () => cartao.render("CartaoPedido", achar(render(), tela.modulo.CartaoPedido).props);
  render();
  tela.efeitos();
  passar(5_000);
  primeira.resolve(respostaDaSessao([pedido], limite - 2_000, expiraEm));
  await tique();
  const durante = renderCartao();
  assert.match(texto(durante), /Atualizando a situação da oferta/);
  assert.ok(!elementos(durante).some(e => e.type === cartao.modulo.AceitarOferta));
  tela.efeitos();
  passar(1);
  assert.equal(leituras, 2);
  segunda.resolve(respostaDaSessao([{ ...pedido, oferta: { disponivel: false, motivo: "MENOS_DE_24_HORAS" } }], limite + 3_000, expiraEm));
  await tique();
  assert.match(texto(renderCartao()), /Faltam menos de 24 horas para a festa/);
});

test("depois do aceite, o GET mais recente libera ações com a primeira releitura ainda pendente", async (t) => {
  const { passar } = controlarTempo(t, -20 * 60_000);
  const tela = carregarTela();
  const cartao = carregarTela();
  const primeiraReleitura = Promise.withResolvers<Response>();
  const segundaReleitura = Promise.withResolvers<Response>();
  const outro = { ...garantia, id: "22222222-2222-4222-8222-222222222222" };
  const expirado: Pedido = { ...outro, preReserva: { ...outro.preReserva, garantia: { situacao: "EXPIRADA", ate } } };
  let leituras = 0;
  let pix = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      assert.equal(url, `/api/meu-pedido/${pedido.id}/aceite`);
      return Response.json({ ok: true });
    }
    if (url.endsWith("/pix")) {
      pix++;
      return Response.json({ ok: true, data: { aceiteSequencia: 1 } });
    }
    leituras++;
    if (leituras === 1) return respostaDaSessao([pedido, outro], instanteServidor, instanteServidor + 120_000);
    return leituras === 2 ? primeiraReleitura.promise : segundaReleitura.promise;
  });
  const render = () => tela.render("default", { empresa: null });
  const props = () => achar(render(), tela.modulo.CartaoPedido).props;
  render();
  tela.efeitos();
  await tique();
  const gravar = props().gravar as (acao: object) => Promise<void>;
  tela.efeitos();
  void gravar({ tipo: "aceite", oferta });
  await tique();
  assert.equal(leituras, 2);
  assert.equal(props().ocupado, true);
  passar(14_000);
  assert.equal(leituras, 3);
  passar(16_000);
  segundaReleitura.resolve(respostaDaSessao([aguardando, expirado], Date.parse(ate), instanteServidor + 120_000));
  await tique();
  const atual = props();
  assert.equal(achar(cartao.render("CartaoPedido", atual), "button", "Ver Pix do sinal").props.disabled, false);
  await (atual.verPix as () => Promise<void>)();
  assert.equal(pix, 1);
  primeiraReleitura.resolve(respostaDaSessao([pedido, outro]));
  await tique();
  assert.equal((props().pedido as Pedido).preReserva.aguardandoConferencia, true);
});

test("WhatsApp é o padrão, e-mail é opcional e a mensagem independe de cadastro e canal", async (t) => {
  const cpfComWhatsApp = "12345678909";
  const cpfSemWhatsApp = "52998224725";
  const cpfSemCadastro = "11144477735";
  const pedidosDeCodigo: unknown[] = [];
  let confirmacoes = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const corpo = JSON.parse(String(init?.body));
    if (url === "/api/meu-pedido/entrada/iniciar?empresa=buffet") {
      pedidosDeCodigo.push(corpo);
      const desafio = corpo.cpf === cpfSemWhatsApp && corpo.canal === "EMAIL" ? "desafio-email" : "outro-desafio";
      return Response.json({ ok: true, data: { desafio, expiraEm: ate } }, { status: 202 });
    }
    assert.equal(url, "/api/meu-pedido/entrada/confirmar?empresa=buffet");
    assert.deepEqual(corpo, { desafio: "desafio-email", codigo: "012345" });
    confirmacoes++;
    return Response.json({ ok: true });
  });

  const cenarios = [cpfComWhatsApp, cpfSemWhatsApp, cpfSemCadastro]
    .flatMap(cpf => ["WHATSAPP", "EMAIL"].map(canal => ({ cpf, canal })));
  const mensagens: string[] = [];
  let entradas = 0;
  for (const { cpf, canal } of cenarios) {
    const tela = carregarTela();
    const render = () => tela.render("Entrada", { empresa: "buffet", aviso: "", aoEntrar: async () => { entradas++; } });
    alterar(render(), { value: cpf });
    assert.equal(achar(render(), "button", "Receber código por WhatsApp").props.disabled, false);
    assert.equal(achar(render(), "button", "Prefiro receber por e-mail").props.type, "button");
    if (canal === "EMAIL") {
      clicar(render(), "Prefiro receber por e-mail");
      assert.equal(achar(render(), "button", "Receber código por e-mail").props.disabled, false);
      clicar(render(), "Prefiro receber por WhatsApp");
      assert.equal(achar(render(), "button", "Receber código por WhatsApp").props.disabled, false);
      clicar(render(), "Prefiro receber por e-mail");
    }
    await submeter(render());
    const etapaCodigo = render();
    mensagens.push(texto(etapaCodigo));
    assert.equal(talvez(etapaCodigo, "button", "Prefiro receber por e-mail"), undefined);

    if (cpf === cpfSemWhatsApp && canal === "EMAIL") {
      alterar(render(), { value: "012345" });
      await submeter(render());
    }
  }
  assert.deepEqual(pedidosDeCodigo, cenarios);
  assert.deepEqual([...new Set(mensagens)], [
    "Se for possível enviar o código para este CPF, ele chegará pelo canal escolhido. Se o envio pelo WhatsApp falhar, o código poderá chegar por e-mail." +
      "Código de seis númerosEntrarPedir outro código",
  ]);
  assert.equal(confirmacoes, 1);
  assert.equal(entradas, 1);
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
