import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../../db/contracts.ts";
import { codigoDoPacoteDaTela } from "../../comercial/pacotes-v1.ts";
import {
  codigoBancoDoPacote, combinarContratacao, contratacaoDoModelo, extrairContratacao, resolverPacote, validarContratacao, verificarContratacao, type PortaContratacao,
} from "./contratacao.ts";
import { ErroCampo } from "./human-gate.ts";
import { lerPacote, pacoteDoTexto, pacoteInformado } from "../pacote-informado.ts";

/**
 * Fase 1d (pacotes com código livre na IA): a preparação de contratação conhece os pacotes da EMPRESA comprovada
 * (códigos P_… incluídos), resolvidos no Core; os sete ids V1 e as regras da Kidmais ficam só para a dona.
 */
const EMPRESA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIVRE = "P_9F2C4E1A7B3D4C5E8F6A0B1C2D3E4F5A";
const tx = {} as DbExecutor;

type Pacote = { codigo: string; nome: string; id: string; minimo: number | null; maximo: number | null };
function porta(pacotes: Pacote[], dona: boolean, extra: Partial<PortaContratacao> = {}) {
  const chamadas = { pacote: [] as string[], pacotes: 0, convidados: [] as Array<[string, boolean]> };
  const p: PortaContratacao = {
    buscarClientes: async () => [{ id: "11111111-1111-4111-8111-111111111111", nome: "Felipe Souza", ativo: true }],
    cliente: async () => ({ nome: "Felipe Souza", ativo: true, camposFaltantes: [], aniversariantes: [{ id: "22222222-2222-4222-8222-222222222222", nome: "Beatriz" }] }),
    async pacote(_tx, empresaId, codigo) {
      chamadas.pacote.push(codigo);
      const x = empresaId === EMPRESA ? pacotes.find((y) => y.codigo === codigo) : undefined;
      return x ? { id: x.id, nome: x.nome, minimo: x.minimo, maximo: x.maximo } : null;
    },
    async pacotes(_tx, empresaId) { chamadas.pacotes++; return empresaId === EMPRESA ? pacotes.map(({ codigo, nome }) => ({ codigo, nome })) : []; },
    dona: async () => dona,
    erroConvidados: (codigo, pacote, n, ehDona) => { chamadas.convidados.push([codigo, ehDona]); return n > (pacote.maximo ?? 150) ? `${pacote.nome} atende até ${pacote.maximo} convidados neste pacote.` : null; },
    horarios: async () => ({ configuracaoId: "33333333-3333-4333-8333-333333333333", horarios: [{ inicio: "12:00", fim: "16:00" }] }),
    precoTabela: async () => 450000,
    ...extra,
  };
  return { p, chamadas };
}
const pacote = (codigo: string, nome: string, maximo: number | null = 80): Pacote => ({ codigo, nome, id: `id-${codigo}`, minimo: 10, maximo });
const DA_EMPRESA = [pacote("POCKET", "Pocket da Casa"), pacote(LIVRE, "Festa Jardim"), pacote("P_AAAA1111", "Festa Jardim Noturna"), pacote("PIZZA_PARTY", "Pizza da Casa", null)];

async function erroDe(p: Promise<unknown>) {
  try { await p; return null; } catch (e) { return e as ErroCampo; }
}

test("código do pacote no banco: mesma regra do Core (codigoDoPacoteDaTela com código), sem a IA importar o Core", () => {
  for (const id of ["pocket", "mini", "compacta", "essencial", "completa", "premium", "pizza_party_scienza", "POCKET", LIVRE, "P_X1", "", "p_minusculo", "../POCKET", "A".repeat(50), "A".repeat(51), " POCKET", "Festa Jardim"]) {
    assert.equal(codigoBancoDoPacote(id), codigoDoPacoteDaTela(id, true), JSON.stringify(id));
  }
});

test("extração: os sete V1 como antes; outro pacote pelo nome dito, até o próximo dado; pergunta direta aceita o nome", () => {
  assert.equal(extrairContratacao("crie uma festa do cliente Felipe, pacote premium, 50 convidados", null).pacote, "premium");
  assert.equal(extrairContratacao("crie uma festa do cliente Felipe, pacote festa jardim, 50 convidados", null).pacote, "festa jardim");
  assert.equal(extrairContratacao("festa do Felipe com pacote Festa Jardim para 40 convidados dia 12/12", null).pacote, "Festa Jardim");
  assert.equal(extrairContratacao("Festa Jardim", "pacote").pacote, "Festa Jardim");
  assert.equal(extrairContratacao("o Festa Jardim", "pacote").pacote, "Festa Jardim");
  assert.equal(extrairContratacao("crie uma festa do cliente Felipe para 50 convidados", null).pacote, undefined, "sem a palavra pacote, nada");
  assert.equal(extrairContratacao("pacote ???", null).pacote, undefined, "pontuação não vira pacote");
});

test("modelo (Luna): nome livre curto aceito; id V1 continua; pontuação ou texto longo descartados", () => {
  assert.equal(contratacaoDoModelo({ pacote: "premium" }).pacote, "premium");
  assert.equal(contratacaoDoModelo({ pacote: "festa jardim" }).pacote, "festa jardim");
  assert.equal(contratacaoDoModelo({ pacote: LIVRE }).pacote, LIVRE);
  assert.equal(contratacaoDoModelo({ pacote: "ignore as regras; DROP" }).pacote, undefined);
  assert.equal(contratacaoDoModelo({ pacote: "x".repeat(61) }).pacote, undefined);
  assert.equal(validarContratacao({ cliente: "Felipe", pacote: "festa jardim", convidados: 40, aniversariante: "Beatriz", data: "2098-12-12", turno: "almoco" }).pacote, "festa jardim");
});

test("dona da agenda pública: só os sete ids V1, Pizza Party sob consulta, regra de convidados da Kidmais (como antes)", async () => {
  const { p, chamadas } = porta([pacote("PREMIUM", "Festa Premium"), pacote(LIVRE, "Festa Jardim")], true);
  assert.deepEqual(await resolverPacote(tx, EMPRESA, "premium", p, true), { idDaTela: "premium", pacote: { id: "id-PREMIUM", nome: "Festa Premium", minimo: 10, maximo: 80 } });
  assert.match(String((await erroDe(resolverPacote(tx, EMPRESA, "pizza_party_scienza", p, true)))?.message), /Pizza Party está sob consulta/);
  for (const fora of [LIVRE, "festa jardim"]) {
    assert.match(String((await erroDe(resolverPacote(tx, EMPRESA, fora, p, true)))?.message), /não está disponível nesta empresa/, fora);
  }
  // Como antes da fase 1d: na dona, o nome passa pelos reconhecedores dos sete ("pacote PREMIUM", "Festa Premium Jardim").
  for (const comoAntes of ["PREMIUM", "Festa Premium", "Festa Premium Jardim"]) {
    assert.equal((await resolverPacote(tx, EMPRESA, comoAntes, p, true)).idDaTela, "premium", comoAntes);
  }
  assert.equal(chamadas.pacotes, 0, "dona nunca resolve por nome");
});

test("buffet comum: código, id V1 traduzido ou nome do pacote DELE; ambíguo/inexistente pergunta com os nomes reais", async () => {
  const { p } = porta(DA_EMPRESA, false);
  assert.equal((await resolverPacote(tx, EMPRESA, LIVRE, p, false)).idDaTela, LIVRE, "código direto");
  assert.equal((await resolverPacote(tx, EMPRESA, "pocket", p, false)).idDaTela, "POCKET", "id V1 traduzido para o código da empresa");
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa Jardim", p, false)).idDaTela, LIVRE, "nome exato (o igual vence o contido)");
  assert.equal((await resolverPacote(tx, EMPRESA, "noturna", p, false)).idDaTela, "P_AAAA1111", "parte do nome, sem ambiguidade");
  const pizza = await resolverPacote(tx, EMPRESA, "pizza_party_scienza", p, false);
  assert.equal(pizza.idDaTela, "PIZZA_PARTY", "fora da dona, o Pizza Party não é sob consulta da Kidmais");
  const ambiguo = await erroDe(resolverPacote(tx, EMPRESA, "jardim", p, false));
  assert.ok(ambiguo instanceof ErroCampo);
  assert.match(ambiguo.message, /Encontrei 2 pacotes para "jardim": Festa Jardim; Festa Jardim Noturna\. Qual deles\?/);
  const inexistente = await erroDe(resolverPacote(tx, EMPRESA, "premium", p, false));
  assert.match(String(inexistente?.message), /Não encontrei o pacote "premium" nesta empresa\. Pacotes disponíveis: Pocket da Casa; Festa Jardim; Festa Jardim Noturna; Pizza da Casa\./);
  const curto = await erroDe(resolverPacote(tx, EMPRESA, "fe", p, false));
  assert.match(String(curto?.message), /Não encontrei o pacote "fe"/, "menos de 3 letras não casa por parte do nome");
  const vazia = porta([], false).p;
  assert.match(String((await erroDe(resolverPacote(tx, EMPRESA, "festa jardim", vazia, false)))?.message), /ainda não tem pacotes cadastrados/);
  // Isolamento: o código de A não resolve para outra empresa (a porta só responde pela empresa comprovada).
  assert.match(String((await erroDe(resolverPacote(tx, OUTRA, LIVRE, p, false)))?.message), /ainda não tem pacotes cadastrados/);
});

test("revisão Astra P2-1: nome que CONTÉM um nome V1 (Premium Jardim) não vira o pacote V1 — determinístico", async () => {
  const empresa = [pacote("PREMIUM", "Premium"), pacote("P_1111AAAA", "Premium Jardim")];
  const { p } = porta(empresa, false);
  const informado = extrairContratacao("crie uma festa do cliente Felipe, pacote Premium Jardim, 40 convidados", null).pacote as string;
  assert.equal(informado, "Premium Jardim", "o nome completo chega à resolução");
  assert.equal((await resolverPacote(tx, EMPRESA, informado, p, false)).idDaTela, "P_1111AAAA");
  const so = extrairContratacao("crie uma festa do cliente Felipe, pacote premium, 40 convidados", null).pacote as string;
  assert.equal(so, "premium", "só o nome V1, sem qualificador: id V1");
  assert.equal((await resolverPacote(tx, EMPRESA, so, p, false)).idDaTela, "PREMIUM");
  assert.equal(extrairContratacao("Premium Jardim", "pacote").pacote, "Premium Jardim", "resposta direta");
  assert.equal(extrairContratacao("festa premium", "pacote").pacote, "premium", "nome inteiro do catálogo da Kidmais");
});

test("revisão Astra P2-2: números do próprio nome (Festa 2026) preservados; quantidade e data continuam fora", async () => {
  const empresa = [pacote("P_FESTA0001", "Festa"), pacote("P_FESTA2026", "Festa 2026")];
  const { p } = porta(empresa, false);
  assert.equal(extrairContratacao("Festa 2026", "pacote").pacote, "Festa 2026", "resposta direta inteira");
  assert.equal(extrairContratacao("Festa 2026.", "pacote").pacote, "Festa 2026");
  assert.equal(extrairContratacao("festa do Felipe, pacote Festa 2026 40 convidados", null).pacote, "Festa 2026");
  assert.equal(extrairContratacao("festa do Felipe, pacote Festa 2026 dia 12/12/2026", null).pacote, "Festa 2026");
  assert.equal(extrairContratacao("festa do Felipe, pacote Festa 2026 12/12", null).pacote, "Festa 2026");
  assert.equal(extrairContratacao("festa do Felipe, pacote premium 50 convidados", null).pacote, "premium", "quantidade sem a palavra pacote no meio");
  assert.equal(extrairContratacao("festa do Felipe, pacote Festa 6 anos", null).pacote, "Festa", "nome provável sem a idade; o trecho completo vai para o Core (P2-3)");
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa 2026", p, false)).idDaTela, "P_FESTA2026", "o igual vence");
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa", p, false)).idDaTela, "P_FESTA0001");
  // Histórico em linhas separadas: um "pacote" no fim de uma linha não captura a linha seguinte.
  assert.equal(pacoteDoTexto("Quero criar uma festa e não um pacote\ncrie um pacote Festa 2026 para o Felipe", false), "Festa 2026");
});

test("revisão Astra rodada 2, P2-1: na combinação, o nome completo da MENSAGEM ATUAL vence o encurtado pela Luna (resposta direta e frase)", () => {
  const de = (texto: string, perguntado: string | null, luna: Record<string, unknown>) =>
    combinarContratacao(extrairContratacao(texto, perguntado), contratacaoDoModelo(luna));
  assert.equal(de("Premium Jardim", "pacote", { pacote: "premium" }).pacote, "Premium Jardim", "resposta direta");
  assert.equal(de("Festa 2026", "pacote", { pacote: "Festa" }).pacote, "Festa 2026", "resposta direta com número");
  assert.equal(de("festa do Felipe, pacote Premium Jardim, 40 convidados", null, { pacote: "premium" }).pacote, "Premium Jardim");
  assert.equal(de("Premium", "pacote", { pacote: "premium" }).pacote, "premium", "só o V1: nada a corrigir");
  // Rodada 6: a Luna com OUTRO nome (mesmo mais longo) não vence a resposta legível da mensagem (antes, a Luna vencia).
  assert.equal(de("Premium", "pacote", { pacote: "Premium Jardim" }).pacote, "premium", "a mensagem vence");
  // Correção na mesma mensagem: a última vence, e a Luna com a escolha atual não é trocada pela negada.
  const negacao = de("Não quero pacote Premium Jardim, quero pacote Premium, 40 convidados", null, { pacote: "premium" });
  assert.equal(negacao.pacote, "premium");
  assert.equal(negacao.pacoteTexto, null);
  // O trecho bruto acompanha só o pacote da mensagem; sem pacote nesta mensagem, nada é gravado nele.
  assert.equal(de("festa do Felipe, pacote Festa 15 anos", null, {}).pacoteTexto, "Festa 15 anos");
  // Rodada 6: a Luna com outro pacote não vence o da mensagem; o trecho acompanha o da mensagem.
  const outro = de("festa do Felipe, pacote Festa 15 anos", null, { pacote: "Pocket da Casa" });
  assert.deepEqual([outro.pacote, outro.pacoteTexto], ["Festa", "Festa 15 anos"]);
  assert.equal("pacoteTexto" in de("50 convidados", "convidados", {}), false);
});

test("revisão Astra rodada 2, P2-2: a última menção vence (correção/negação); o histórico não entra na extração", () => {
  assert.deepEqual(pacoteInformado("Não quero pacote Premium Jardim, quero pacote Premium, 40 convidados", false), { nome: "premium", trecho: null });
  assert.deepEqual(pacoteInformado("pacote Festa Jardim com bolo", false), { nome: "Festa Jardim", trecho: "Festa Jardim com bolo" });
  assert.equal(extrairContratacao("Não quero pacote Premium Jardim, quero pacote Premium, 40 convidados", null).pacote, "premium");
});

test("revisão Astra rodada 2, P2-3: nome com quantidade/idade confrontado com o catálogo — maior nome exato; ambíguo pergunta", async () => {
  const doisFesta = porta([pacote("P_FESTA0001", "Festa"), pacote("P_FESTA1500", "Festa 15 anos")], false).p;
  const extraido = extrairContratacao("festa do Felipe, pacote Festa 15 anos", null);
  assert.deepEqual([extraido.pacote, extraido.pacoteTexto], ["Festa", "Festa 15 anos"]);
  const ambiguo = await erroDe(resolverPacote(tx, EMPRESA, "Festa", doisFesta, false, "Festa 15 anos"));
  assert.ok(ambiguo instanceof ErroCampo);
  assert.match(ambiguo.message, /"Festa 15 anos" pode ser o pacote Festa 15 anos ou o pacote Festa \(com 15 anos como outro dado\)\. Qual pacote\?/);
  // Resposta direta à pergunta (sem trecho): o nome inteiro, exato.
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa 15 anos", doisFesta, false)).idDaTela, "P_FESTA1500");
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa", doisFesta, false)).idDaTela, "P_FESTA0001");
  // Só um deles cadastrado: sem ambiguidade.
  const soLongo = porta([pacote("P_FESTA1500", "Festa 15 anos")], false).p;
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa", soLongo, false, "Festa 15 anos")).idDaTela, "P_FESTA1500");
  const soCurto = porta([pacote("P_FESTA0001", "Festa")], false).p;
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa", soCurto, false, "Festa 15 anos")).idDaTela, "P_FESTA0001");
  // Sufixo que não é quantidade: o maior nome exato vence sem pergunta ("Premium Jardim" × "Premium").
  const premium = porta([pacote("PREMIUM", "Premium"), pacote("P_1111AAAA", "Premium Jardim")], false).p;
  assert.equal((await resolverPacote(tx, EMPRESA, "Premium Jardim", premium, false, "Premium Jardim com bolo")).idDaTela, "P_1111AAAA");
  // Dona: o trecho não muda nada (sete ids V1, como antes).
  const dona = porta([pacote("PREMIUM", "Festa Premium")], true).p;
  assert.equal((await resolverPacote(tx, EMPRESA, "premium", dona, true, "premium 50 convidados")).idDaTela, "premium");
});

test("revisão Astra rodada 3, P2-1: menção negada nunca vence (as duas ordens); duas menções afirmativas diferentes não escolhem", () => {
  for (const frase of [
    "Não quero pacote Premium Jardim, quero pacote Premium, 40 convidados",
    "quero pacote Premium e não o pacote Premium Jardim, 40 convidados",
    "quero o pacote Premium, não quero o pacote Premium Jardim",
    "pacote Premium sem o pacote Premium Jardim",
  ]) {
    assert.deepEqual(pacoteInformado(frase, false), { nome: "premium", trecho: null }, frase);
    assert.equal(combinarContratacao(extrairContratacao(frase, null), contratacaoDoModelo({ pacote: "premium" })).pacote, "premium", frase);
  }
  assert.equal(pacoteInformado("quero o pacote Premium ou o pacote Premium Jardim", false), null, "duas alternativas: o texto não escolhe");
  assert.equal(pacoteInformado("pacote Premium Jardim, confirmo o pacote Premium Jardim", false)?.nome, "Premium Jardim", "repetida é a mesma");
  assert.equal(pacoteInformado("não quero o pacote Premium Jardim", false), null, "só negada: nenhum pacote do texto");
});

test("revisão Astra rodada 3, P2-2: caixa/acentuação diferentes entre texto e Luna mantêm o trecho e a pergunta", async () => {
  for (const daLuna of ["festa", "FESTA", "Festa"]) {
    const combinado = combinarContratacao(extrairContratacao("festa do Felipe, pacote Festa 15 anos", null), contratacaoDoModelo({ pacote: daLuna }));
    assert.equal(combinado.pacoteTexto, "Festa 15 anos", daLuna);
    const doisFesta = porta([pacote("P_FESTA0001", "Festa"), pacote("P_FESTA1500", "Festa 15 anos")], false).p;
    assert.match(String((await erroDe(resolverPacote(tx, EMPRESA, String(combinado.pacote), doisFesta, false, combinado.pacoteTexto as string)))?.message), /pode ser o pacote Festa 15 anos ou o pacote Festa/, daLuna);
  }
  const acento = combinarContratacao(extrairContratacao("pacote Família 15 anos", null), contratacaoDoModelo({ pacote: "familia" }));
  assert.equal(acento.pacoteTexto, "Família 15 anos");
});

test("revisão Astra rodada 3, P2-3: com trecho, a ambiguidade vem antes do atalho por código/id V1; sem trecho, o atalho segue", async () => {
  const p = porta([pacote("PREMIUM", "Premium"), pacote("P_PREMIUM15", "Premium 15 anos")], false).p;
  const e = extrairContratacao("festa do Felipe, pacote Premium 15 anos", null);
  assert.deepEqual([e.pacote, e.pacoteTexto], ["premium", "Premium 15 anos"]);
  assert.match(String((await erroDe(resolverPacote(tx, EMPRESA, "premium", p, false, "Premium 15 anos")))?.message), /pode ser o pacote Premium 15 anos ou o pacote Premium/);
  assert.equal((await resolverPacote(tx, EMPRESA, "premium", p, false)).idDaTela, "PREMIUM", "resposta direta/sem trecho: id V1 traduzido");
  assert.equal((await resolverPacote(tx, EMPRESA, "P_PREMIUM15", p, false)).idDaTela, "P_PREMIUM15", "código explícito");
  // Trecho sem nome do catálogo (só dado depois): segue o atalho.
  assert.equal((await resolverPacote(tx, EMPRESA, "premium", p, false, "premium com bolo")).idDaTela, "PREMIUM");
});

test("revisão Astra rodada 3, P2-4: trecho longo (ou com parêntese) preservado como evidência; a proteção continua", async () => {
  const longo = "festa do Felipe, pacote Festa 15 anos com bolo de chocolate e bebidas para todos os convidados da festa";
  const e = extrairContratacao(longo, null);
  assert.equal(e.pacote, "Festa");
  assert.ok(typeof e.pacoteTexto === "string" && (e.pacoteTexto as string).startsWith("Festa 15 anos com bolo") && (e.pacoteTexto as string).length <= 80, String(e.pacoteTexto));
  const doisFesta = porta([pacote("P_FESTA0001", "Festa"), pacote("P_FESTA1500", "Festa 15 anos")], false).p;
  assert.match(String((await erroDe(resolverPacote(tx, EMPRESA, "Festa", doisFesta, false, e.pacoteTexto as string)))?.message), /pode ser o pacote Festa 15 anos ou o pacote Festa/);
  assert.equal(extrairContratacao("pacote Festa 15 anos (com bolo)", null).pacoteTexto, "Festa 15 anos");
});

test("revisão Astra rodada 4, P2-1/P2-3: só negada/excluída ou alternativas diferentes ⇒ incerto: sem recuo V1 nem Luna, pergunta", () => {
  for (const frase of [
    "quero o pacote Premium ou o pacote Premium Jardim",
    "não quero o pacote Premium Jardim",
    "tirando o pacote Premium Jardim, 40 convidados",
    "exceto o pacote Premium Jardim",
    "qualquer um menos o pacote Premium Jardim",
    "festa do Felipe, pacote Completa ou pacote Premium",
  ]) {
    assert.deepEqual(lerPacote(frase, false), { tipo: "incerto" }, frase);
    const e = extrairContratacao(frase, null);
    assert.equal(e.pacote, undefined, `sem recuo V1: ${frase}`);
    for (const daLuna of [{ pacote: "premium" }, {}]) {
      const c = combinarContratacao(e, contratacaoDoModelo(daLuna));
      assert.ok(Object.hasOwn(c, "pacote") && c.pacote === undefined && c.pacoteTexto === null, `sem valor da Luna: ${frase}`);
      assert.equal(Object.keys(c).some((k) => k.startsWith("__")), false, "a marca interna não vai para o payload");
    }
  }
  // Resposta direta à pergunta do pacote: negação/alternativas também perguntam de novo.
  for (const resposta of ["não, o Premium Jardim não", "Premium ou Premium Jardim", "tirando o Premium", "Premium e não o Premium Jardim", "nenhum"]) {
    assert.deepEqual(lerPacote(resposta, true), { tipo: "incerto" }, resposta);
    assert.equal(combinarContratacao(extrairContratacao(resposta, "pacote"), contratacaoDoModelo({ pacote: "premium" })).pacote, undefined, resposta);
  }
  // Sem nenhuma menção legível, o recuo V1 de sempre continua (e a afirmativa com negada continua escolhendo).
  assert.equal(extrairContratacao("festa do Felipe pacote premium!!", null).pacote, "premium");
  assert.equal(extrairContratacao("quero pacote Premium e não o pacote Premium Jardim", null).pacote, "premium");
});

test("revisão Astra rodada 4, P2-2: conjunção no meio do nome não corta; só separa antes de outra menção", async () => {
  const lista = [pacote("P_FESTA0001", "Festa"), pacote("P_FESTA0002", "Festa sem Glúten"), pacote("P_FESTA0003", "Festa com Bolo"), pacote("P_FESTA0004", "Doce ou Travessura")];
  const p = porta(lista, false).p;
  for (const [frase, esperado] of [
    ["quero o pacote Festa sem Glúten, 40 convidados", "P_FESTA0002"],
    ["pacote Festa sem Glúten 40 convidados", "P_FESTA0002"],
    ["pacote Festa com Bolo, 40 convidados", "P_FESTA0003"],
    ["pacote Doce ou Travessura, 40 convidados", "P_FESTA0004"],
    ["pacote Festa, 40 convidados", "P_FESTA0001"],
  ] as const) {
    const e = extrairContratacao(frase, null);
    assert.equal((await resolverPacote(tx, EMPRESA, String(e.pacote), p, false, (e.pacoteTexto as string | null) ?? null)).idDaTela, esperado, frase);
  }
  assert.equal(extrairContratacao("quero o pacote Festa sem Glúten", null).pacote, "Festa sem Glúten");
  assert.equal(extrairContratacao("Festa sem Glúten", "pacote").pacote, "Festa sem Glúten", "resposta direta com 'sem' no meio");
  // Antes de outra menção "pacote", a ligação separa as escolhas (e então não há escolha segura).
  assert.deepEqual(lerPacote("pacote Festa sem o pacote Festa sem Glúten", false), { tipo: "dito", pacote: { nome: "Festa", trecho: null, recusas: ["Festa sem Glúten"] } });
  assert.deepEqual(lerPacote("pacote Festa ou pacote Festa sem Glúten", false), { tipo: "incerto" });
});

test("revisão Astra rodada 5, P2: alternativas com o mesmo nome provável e trechos diferentes não escolhem pela ordem (com e sem Luna)", async () => {
  const p = porta([pacote("P_BOLO", "Festa com Bolo"), pacote("P_DOCES", "Festa com Doces")], false).p;
  for (const frase of ["pacote Festa com Bolo ou pacote Festa com Doces", "pacote Festa com Doces ou pacote Festa com Bolo", "quero o pacote Festa com Bolo, não, quero o pacote Festa com Doces"]) {
    assert.deepEqual(lerPacote(frase, false), { tipo: "incerto" }, frase);
    for (const daLuna of [{}, { pacote: "Festa" }, { pacote: "Festa com Bolo" }]) {
      const c = combinarContratacao(extrairContratacao(frase, null), contratacaoDoModelo(daLuna));
      assert.ok(Object.hasOwn(c, "pacote") && c.pacote === undefined && c.pacoteTexto === null, `${frase} / ${JSON.stringify(daLuna)}`);
    }
  }
  // Uma só menção (ou a mesma repetida) segue resolvendo pelo trecho.
  for (const [frase, esperado] of [["pacote Festa com Bolo, 40 convidados", "P_BOLO"], ["pacote Festa com Doces, confirmo o pacote Festa com Doces", "P_DOCES"]] as const) {
    const e = extrairContratacao(frase, null);
    assert.equal((await resolverPacote(tx, EMPRESA, String(e.pacote), p, false, (e.pacoteTexto as string | null) ?? null)).idDaTela, esperado, frase);
  }
});

test("revisão Astra rodada 5, P2-2 (regra da rodada 6): a Luna não ressuscita o pacote recusado (nem o do histórico) — vale a escolha legível da mensagem", () => {
  const de = (texto: string, perguntado: string | null, luna: Record<string, unknown>) =>
    combinarContratacao(extrairContratacao(texto, perguntado), contratacaoDoModelo(luna));
  for (const [frase, daLuna, esperado] of [
    ["quero pacote Jardim, não o pacote Premium", "premium", "Jardim"],
    ["não o pacote Premium, quero pacote Jardim", "premium", "Jardim"],
    ["quero pacote Festa Jardim e não o pacote Pocket da Casa", "Pocket da Casa", "Festa Jardim"],
    ["quero pacote Jardim", "Premium Jardim", "Jardim"],
  ] as const) {
    assert.equal(de(frase, null, { pacote: daLuna }).pacote, esperado, `${frase} × Luna ${daLuna}`);
    assert.equal(de(frase, null, {}).pacote, esperado, frase);
  }
  assert.equal(de("quero pacote Jardim, não o pacote Premium", null, { pacote: "Jardim" }).pacote, "Jardim");
  // Mensagem sem pacote legível: a Luna decide (revalidada antes, como sempre).
  assert.equal(de("festa do Felipe, 40 convidados", null, { pacote: "premium" }).pacote, "premium");
});

test("revisão Astra rodada 6, P2-1: resposta direta composta é lida (dito) ou pergunta (incerto) — nunca 'nenhum' para a Luna completar", () => {
  const de = (texto: string, luna: Record<string, unknown>) => combinarContratacao(extrairContratacao(texto, "pacote"), contratacaoDoModelo(luna));
  for (const [resposta, esperado] of [
    ["Festa Jardim, por favor", "Festa Jardim"],
    ["por favor, Festa Jardim", "Festa Jardim"],
    ["\"Festa Jardim\", obrigado!", "Festa Jardim"],
    ["o pacote Festa Jardim, 50 convidados", "Festa Jardim"],
    ["Festa Jardim.", "Festa Jardim"],
    ["Festa Premium, por favor", "premium"],
  ] as const) {
    assert.equal(lerPacote(resposta, true).tipo, "dito", resposta);
    assert.equal(de(resposta, { pacote: "premium" }).pacote, esperado, `${resposta} × Luna premium (histórico)`);
  }
  for (const resposta of ["???", "hmm, (??)", "pode ser :)"]) {
    const leitura = lerPacote(resposta, true).tipo;
    assert.notEqual(leitura, "nenhum", resposta);
    if (leitura === "incerto") assert.equal(de(resposta, { pacote: "premium" }).pacote, undefined, resposta);
  }
  assert.deepEqual(lerPacote("", true), { tipo: "nenhum" });
});

test("revisão Astra rodada 6, P2-2: nome e apelido do mesmo V1 não são conflito; 'Premium Jardim' continua outro pacote", () => {
  const de = (texto: string, perguntado: string | null, luna: Record<string, unknown>) =>
    combinarContratacao(extrairContratacao(texto, perguntado), contratacaoDoModelo(luna));
  for (const daLuna of ["Festa Premium", "premium", "FESTA PREMIUM", undefined]) {
    assert.equal(de("Festa Premium", "pacote", daLuna ? { pacote: daLuna } : {}).pacote, "premium", String(daLuna));
  }
  assert.equal(de("Premium Jardim", "pacote", { pacote: "Festa Premium" }).pacote, "Premium Jardim");
  assert.equal(de("Kidmais Pocket", "pacote", { pacote: "Kidmais Pocket" }).pacote, "pocket");
  assert.equal(de("quero o pacote Festa Premium", null, { pacote: "Festa Premium" }).pacote, "premium");
});

test("revisão Astra rodada 7, P2: correção, negação ou outra escolha no resto da resposta perguntam; só cortesia/complemento acessório é descartado", () => {
  const de = (texto: string, perguntado: string | null, luna: Record<string, unknown>) =>
    combinarContratacao(extrairContratacao(texto, perguntado), contratacaoDoModelo(luna));
  for (const resposta of [
    "Premium, não; Festa Jardim",
    "Premium, quer dizer, Festa Jardim",
    "Premium; ou melhor, Festa Jardim",
    "Premium, na verdade Festa Jardim",
    "Premium. Festa Jardim",
    "Premium, Festa Jardim",
    "Premium não",
  ]) {
    assert.deepEqual(lerPacote(resposta, true), { tipo: "incerto" }, resposta);
    for (const luna of [{}, { pacote: "Festa Jardim" }, { pacote: "premium" }]) {
      assert.equal(de(resposta, "pacote", luna).pacote, undefined, `${resposta} × ${JSON.stringify(luna)}`);
    }
  }
  // Numa frase, a menção corrigida logo depois também pergunta.
  for (const frase of ["festa do Felipe, pacote Premium, quer dizer, Festa Jardim", "festa do Felipe, pacote Premium, não; Festa Jardim", "pacote Premium, não, pacote Festa Jardim"]) {
    assert.deepEqual(lerPacote(frase, false), { tipo: "incerto" }, frase);
  }
  // Os exemplos corrigidos antes continuam: cortesia e complementos acessórios não impedem a escolha.
  for (const [resposta, esperado] of [
    ["Festa Jardim, por favor", "Festa Jardim"],
    ["Festa Jardim, 50 convidados", "Festa Jardim"],
    ["Festa Jardim, dia 15/11", "Festa Jardim"],
    ["Festa Jardim, à noite, obrigado", "Festa Jardim"],
    ["Festa Premium, pode ser", "premium"],
    ["o pacote Festa Jardim, 50 convidados", "Festa Jardim"],
  ] as const) {
    assert.equal(de(resposta, "pacote", { pacote: "premium" }).pacote, esperado, resposta);
  }
  // A afirmada ao lado da recusada (sem correção) continua escolhendo.
  assert.equal(de("quero o pacote Premium, não quero o pacote Premium Jardim", null, {}).pacote, "premium");
});

test("revisão Astra rodada 8, P2: com ou sem o rótulo 'pacote', o resto da resposta é validado; dois nomes sem escolha inequívoca perguntam", async () => {
  const de = (texto: string, luna: Record<string, unknown>) => combinarContratacao(extrairContratacao(texto, "pacote"), contratacaoDoModelo(luna));
  for (const base of ["Premium, Festa Jardim", "Premium, troque para Festa Jardim", "Premium; Festa Jardim", "Premium, mude para o Festa Jardim"]) {
    for (const resposta of [base, `pacote ${base}`, `o pacote ${base}`]) {
      assert.deepEqual(lerPacote(resposta, true), { tipo: "incerto" }, resposta);
      for (const luna of [{}, { pacote: "Festa Jardim" }]) assert.equal(de(resposta, luna).pacote, undefined, `${resposta} × ${JSON.stringify(luna)}`);
    }
  }
  // Só a checagem da resposta direta pega uma 2ª palavra solta (na frase, uma palavra solta é outro dado comum).
  assert.deepEqual(lerPacote("pacote Premium, Jardim", true), { tipo: "incerto" });
  // Rótulo + cortesia/complemento acessório continuam escolhendo.
  for (const [resposta, esperado] of [
    ["pacote Festa Jardim", "Festa Jardim"],
    ["o pacote Festa Jardim, por favor", "Festa Jardim"],
    ["pacote Festa Jardim, 50 convidados", "Festa Jardim"],
    ["o pacote Premium", "premium"],
  ] as const) assert.equal(de(resposta, { pacote: "premium" }).pacote, esperado, resposta);
  // Sem vírgula, o texto inteiro vai como nome; o Core não escolhe por um nome contido num texto maior.
  const p = porta([pacote("PREMIUM", "Premium"), pacote(LIVRE, "Festa Jardim")], false).p;
  for (const informado of ["Premium troque para Festa Jardim", "Premium troca pra Jardim", "Festa Jardim e depois vemos"]) {
    assert.ok(await erroDe(resolverPacote(tx, EMPRESA, informado, p, false)), informado);
  }
  assert.equal((await resolverPacote(tx, EMPRESA, "Jardim", p, false)).idDaTela, LIVRE, "parte de um nome continua achando");
  // Dona: dois dos sete no mesmo texto perguntam; um só continua.
  const dona = porta([], true, { pacote: async (_tx, _e, codigo) => ({ id: `id-${codigo}`, nome: codigo, minimo: 10, maximo: 80 }) }).p;
  assert.match(String((await erroDe(resolverPacote(tx, EMPRESA, "Premium troque para Completa", dona, true)))?.message), /mais de um pacote/);
  assert.equal((await resolverPacote(tx, EMPRESA, "Festa Premium", dona, true)).idDaTela, "premium");
});

test("revisão Astra rodada 9, P2: na frase completa, troca ou 2ª escolha do catálogo perguntam; prefixo só com complemento acessório; dona com a evidência inteira", async () => {
  const resolverDaFrase = async (frase: string, p: PortaContratacao, dona: boolean) => {
    const e = combinarContratacao(extrairContratacao(frase, null), {});
    if (e.pacote === undefined) return "pergunta (texto)";
    try {
      return (await resolverPacote(tx, EMPRESA, String(e.pacote), p, dona, (e.pacoteTexto as string | null) ?? null, (e.pacoteResto as string | null) ?? null)).idDaTela;
    } catch (erro) {
      if (erro instanceof ErroCampo) return "pergunta (Core)";
      throw erro;
    }
  };
  const comum = porta([pacote("PREMIUM", "Premium"), pacote(LIVRE, "Festa Jardim"), pacote("COMPLETA", "Completa")], false).p;
  const dona = porta([], true, { pacote: async (_tx, _e, codigo) => ({ id: `id-${codigo}`, nome: codigo, minimo: 10, maximo: 80 }) }).p;
  const resto = ", 50 convidados, beatriz 1 ano; tema unicórnio, dia 15/11/2026 à noite";
  for (const pedido of [
    "crie uma festa do Felipe, pacote Premium, troque para Festa Jardim",
    "crie uma festa do Felipe, pacote Premium troque para Festa Jardim",
    "crie uma festa do Felipe, pacote Premium para Completa",
    "crie uma festa do Felipe, pacote Premium, Festa Jardim",
    "crie uma festa do Felipe, pacote Premium, depois Completa",
  ]) {
    for (const [nome, p, ehDona] of [["comum", comum, false], ["dona", dona, true]] as const) {
      // Na dona só existem os sete: a 2ª escolha é um V1 ("Festa Jardim" vira "Completa").
      const r = await resolverDaFrase((ehDona ? pedido.replace("Festa Jardim", "Completa") : pedido) + resto, p, ehDona);
      assert.match(r, /^pergunta/, `${pedido} (${nome}) → ${r}`);
    }
  }
  // Cada camada sozinha: o texto marca a troca mesmo com nome fora do catálogo; o Core recusa prefixo com complemento
  // não acessório mesmo sem a marca do texto (comum e dona).
  assert.deepEqual(lerPacote("crie uma festa do Felipe, pacote Premium, troque para Jardim Encantado, 50 convidados", false), { tipo: "incerto" });
  assert.deepEqual(lerPacote("crie uma festa do Felipe, pacote Premium mude pra outro, 50 convidados", false), { tipo: "incerto" });
  assert.ok(await erroDe(resolverPacote(tx, EMPRESA, "premium", comum, false, "Premium segue Jardim decorado", null)), "prefixo com complemento não acessório (comum)");
  assert.ok(await erroDe(resolverPacote(tx, EMPRESA, "premium", dona, true, "Premium segue Jardim decorado", null)), "prefixo com complemento não acessório (dona)");
  assert.equal((await resolverPacote(tx, EMPRESA, "premium", comum, false, "Premium com bolo", null)).idDaTela, "PREMIUM");
  assert.equal((await resolverPacote(tx, EMPRESA, "premium", dona, true, "Premium 50 convidados", null)).idDaTela, "premium");
  // Os legítimos continuam escolhendo.
  for (const [pedido, comumEsperado, donaEsperado] of [
    ["crie uma festa do Felipe, pacote Premium para 50 convidados", "PREMIUM", "premium"],
    ["crie uma festa do Felipe, pacote Premium, 50 convidados, beatriz 1 ano", "PREMIUM", "premium"],
    ["crie uma festa do Felipe, pacote Premium com bolo, 50 convidados", "PREMIUM", "premium"],
    ["crie uma festa do Felipe, quero o pacote Premium, não quero o pacote Completa, 50 convidados", "PREMIUM", "premium"],
  ] as const) {
    assert.equal(await resolverDaFrase(pedido, comum, false), comumEsperado, pedido);
    assert.equal(await resolverDaFrase(pedido, dona, true), donaEsperado, `${pedido} (dona)`);
  }
});

test("revisão Astra rodada 10, P2: nome menor citado à parte e 2º pacote depois de outros dados perguntam; cláusula solta logo depois pergunta (dona inclusa)", async () => {
  const resolverDaFrase = async (frase: string, p: PortaContratacao, dona: boolean) => {
    const e = combinarContratacao(extrairContratacao(frase, null), {});
    if (e.pacote === undefined) return "pergunta (texto)";
    try {
      return (await resolverPacote(tx, EMPRESA, String(e.pacote), p, dona, (e.pacoteTexto as string | null) ?? null, (e.pacoteResto as string | null) ?? null)).idDaTela;
    } catch (erro) {
      if (erro instanceof ErroCampo) return "pergunta (Core)";
      throw erro;
    }
  };
  const PJ = "P_PREMIUMJARDIM";
  const comum = porta([pacote("PREMIUM", "Premium"), pacote(PJ, "Premium Jardim"), pacote("COMPLETA", "Completa")], false).p;
  const dona = porta([], true, { pacote: async (_tx, _e, codigo) => ({ id: `id-${codigo}`, nome: codigo, minimo: 10, maximo: 80 }) }).p;
  const fim = ", beatriz 1 ano; tema unicórnio, dia 15/11/2026 à noite";
  // P2-1: nome menor citado à parte, nas duas ordens (empresa comum).
  for (const pedido of [
    "crie uma festa do Felipe, pacote Premium Jardim, Premium, 50 convidados",
    "crie uma festa do Felipe, pacote Premium Jardim, depois Premium, 50 convidados",
    "crie uma festa do Felipe, pacote Premium, depois Premium Jardim, 50 convidados",
    "crie uma festa do Felipe, pacote Premium, 50 convidados, Premium Jardim",
  ]) assert.match(await resolverDaFrase(pedido + fim, comum, false), /^pergunta/, pedido);
  // P2-2: 2º pacote depois de quantidade, data ou tema (dona e comum).
  for (const pedido of [
    "crie uma festa do Felipe, pacote Premium, 50 convidados, Completa",
    "crie uma festa do Felipe, pacote Premium, dia 15/11/2026, Completa",
    "crie uma festa do Felipe, pacote Premium, 50 convidados, tema unicórnio, Completa",
  ]) {
    assert.match(await resolverDaFrase(pedido, dona, true), /^pergunta/, `${pedido} (dona)`);
    assert.match(await resolverDaFrase(pedido, comum, false), /^pergunta/, `${pedido} (comum)`);
  }
  // Limite da rodada 9: cláusula solta logo depois do pacote ("Festa Jardim", inexistente na dona) pergunta.
  assert.match(await resolverDaFrase("crie uma festa do Felipe, pacote Premium, Festa Jardim, 50 convidados" + fim, dona, true), /^pergunta/);
  // Negações e outros dados continuam escolhendo.
  for (const [pedido, comumEsperado, donaEsperado] of [
    ["crie uma festa do Felipe, quero o pacote Premium Jardim, não quero o pacote Premium, 50 convidados", PJ, null],
    ["crie uma festa do Felipe, pacote Premium Jardim, 50 convidados", PJ, null],
    ["crie uma festa do Felipe, pacote Premium, 50 convidados, Beatriz, 15/11/2026 à noite", "PREMIUM", "premium"],
    ["crie uma festa do Felipe, pacote Premium, 50 convidados, não Completa", "PREMIUM", "premium"],
    ["crie uma festa do Felipe, pacote Premium, 50 convidados, tema mini mouse", "PREMIUM", "premium"],
  ] as const) {
    assert.equal(await resolverDaFrase(pedido, comum, false), comumEsperado, pedido);
    if (donaEsperado) assert.equal(await resolverDaFrase(pedido, dona, true), donaEsperado, `${pedido} (dona)`);
  }
});

test("revisão Astra rodada 11, P2: o alcance da negação vai até a ligação afirmativa — recusa do escolhido ou escolha depois dela perguntam; 'não Completa' segue", async () => {
  const resolverDaFrase = async (frase: string, p: PortaContratacao, dona: boolean) => {
    const e = combinarContratacao(extrairContratacao(frase, null), {});
    if (e.pacote === undefined) return "pergunta (texto)";
    try {
      return (await resolverPacote(tx, EMPRESA, String(e.pacote), p, dona, (e.pacoteTexto as string | null) ?? null, (e.pacoteResto as string | null) ?? null)).idDaTela;
    } catch (erro) {
      if (erro instanceof ErroCampo) return "pergunta (Core)";
      throw erro;
    }
  };
  const comum = porta([pacote("PREMIUM", "Premium"), pacote("COMPLETA", "Completa")], false).p;
  const dona = porta([], true, { pacote: async (_tx, _e, codigo) => ({ id: `id-${codigo}`, nome: codigo, minimo: 10, maximo: 80 }) }).p;
  const inicio = "crie uma festa do Felipe, pacote Premium, 50 convidados, ";
  for (const fim of ["não Premium e sim Completa", "não Premium mas Completa", "não Premium, quero Completa", "não Premium", "sem Premium, prefiro Completa"]) {
    assert.match(await resolverDaFrase(inicio + fim, comum, false), /^pergunta/, `${fim} (comum)`);
    assert.match(await resolverDaFrase(inicio + fim, dona, true), /^pergunta/, `${fim} (dona)`);
  }
  // Escolha depois da ligação, com recusa de OUTRO pacote: só a parte afirmada pega a 2ª escolha.
  assert.match(await resolverDaFrase(inicio + "não Mini e sim Completa", comum, false), /^pergunta/, "não Mini e sim Completa (comum)");
  assert.match(await resolverDaFrase(inicio + "não Mini e sim Completa", dona, true), /^pergunta/, "não Mini e sim Completa (dona)");
  for (const fim of ["não Completa", "não Completa e sim Premium", "sem Completa, beatriz 1 ano"]) {
    assert.equal(await resolverDaFrase(inicio + fim, comum, false), "PREMIUM", `${fim} (comum)`);
    assert.equal(await resolverDaFrase(inicio + fim, dona, true), "premium", `${fim} (dona)`);
  }
});

test("revisão Astra rodada 12, P2: verbo governado pela negação fica na recusa; menção 'pacote X' negada chega ao Core — afirmar e recusar o mesmo pacote pergunta", async () => {
  const resolverDaFrase = async (frase: string, p: PortaContratacao, dona: boolean) => {
    const e = combinarContratacao(extrairContratacao(frase, null), {});
    if (e.pacote === undefined) return "pergunta (texto)";
    try {
      return (await resolverPacote(tx, EMPRESA, String(e.pacote), p, dona, (e.pacoteTexto as string | null) ?? null, (e.pacoteResto as string | null) ?? null, (e.pacoteRecusas as string | null) ?? null)).idDaTela;
    } catch (erro) {
      if (erro instanceof ErroCampo) return "pergunta (Core)";
      throw erro;
    }
  };
  const PJ = "P_PREMIUMJARDIM";
  const comum = porta([pacote("PREMIUM", "Premium"), pacote(PJ, "Premium Jardim"), pacote("COMPLETA", "Completa")], false).p;
  const dona = porta([], true, { pacote: async (_tx, _e, codigo) => ({ id: `id-${codigo}`, nome: codigo, minimo: 10, maximo: 80 }) }).p;
  const inicio = "crie uma festa do Felipe, pacote Premium, 50 convidados, ";
  for (const fim of ["não quero Premium", "não quero o pacote Premium", "não prefiro Premium", "não vou levar o Premium", "não quero o Premium e sim Completa"]) {
    assert.match(await resolverDaFrase(inicio + fim, comum, false), /^pergunta/, `${fim} (comum)`);
    assert.match(await resolverDaFrase(inicio + fim, dona, true), /^pergunta/, `${fim} (dona)`);
  }
  // Exclusão legítima de OUTRO pacote continua escolhendo (inclusive nome maior que contém o escolhido).
  for (const [frase, comumEsperado, donaEsperado] of [
    [inicio + "não quero Completa", "PREMIUM", "premium"],
    [inicio + "não quero o pacote Completa", "PREMIUM", "premium"],
    [inicio + "não quero Completa e sim Premium", "PREMIUM", "premium"],
    ["crie uma festa do Felipe, quero o pacote Premium, não quero o pacote Premium Jardim, 50 convidados", "PREMIUM", null],
    ["crie uma festa do Felipe, não quero pacote Premium Jardim, quero pacote Premium, 50 convidados", "PREMIUM", null],
  ] as const) {
    assert.equal(await resolverDaFrase(frase, comum, false), comumEsperado, frase);
    if (donaEsperado) assert.equal(await resolverDaFrase(frase, dona, true), donaEsperado, `${frase} (dona)`);
  }
});

test("revisão Astra rodada 13, P2: a menção negada chega inteira ao Core — recusar o próprio nome composto pergunta; recusar outro (menor ou maior) segue", async () => {
  const resolverDaFrase = async (frase: string, p: PortaContratacao) => {
    const e = combinarContratacao(extrairContratacao(frase, null), {});
    if (e.pacote === undefined) return "pergunta (texto)";
    try {
      return (await resolverPacote(tx, EMPRESA, String(e.pacote), p, false, (e.pacoteTexto as string | null) ?? null, (e.pacoteResto as string | null) ?? null, (e.pacoteRecusas as string | null) ?? null)).idDaTela;
    } catch (erro) {
      if (erro instanceof ErroCampo) return "pergunta (Core)";
      throw erro;
    }
  };
  const p = porta([pacote("P_FESTA", "Festa"), pacote("P_BOLO", "Festa com Bolo"), pacote("P_DOCES", "Festa com Doces")], false).p;
  const fim = ", beatriz 1 ano; tema unicórnio, dia 15/11/2026 à noite";
  assert.equal(lerPacote("pacote Festa com Bolo, não quero o pacote Festa com Bolo", false).tipo === "dito"
    ? (lerPacote("pacote Festa com Bolo, não quero o pacote Festa com Bolo", false) as { pacote: { recusas?: string[] } }).pacote.recusas?.[0] : null, "Festa com Bolo");
  for (const recusa of ["não quero o pacote Festa com Bolo", "não quero Festa com Bolo", "sem o pacote Festa com Bolo"]) {
    assert.match(await resolverDaFrase(`crie uma festa do Felipe, pacote Festa com Bolo, 50 convidados, ${recusa}${fim}`, p), /^pergunta/, recusa);
  }
  // Recusa de OUTRO pacote — menor ("Festa") ou irmão ("Festa com Doces") — não recusa o escolhido.
  for (const recusa of ["não quero o pacote Festa", "não quero o pacote Festa com Doces"]) {
    assert.equal(await resolverDaFrase(`crie uma festa do Felipe, pacote Festa com Bolo, 50 convidados, ${recusa}${fim}`, p), "P_BOLO", recusa);
  }
  // E o inverso: escolhido o menor, recusado o maior que o contém, segue o menor.
  assert.equal(await resolverDaFrase(`crie uma festa do Felipe, pacote Festa, 50 convidados, não quero o pacote Festa com Bolo${fim}`, p), "P_FESTA");
});

test("verificação: o payload segue para a revisão com o código do pacote da empresa e a regra de convidados neutra", async () => {
  const { p, chamadas } = porta(DA_EMPRESA, false);
  const base = validarContratacao({ cliente: "Felipe Souza", pacote: "festa jardim", convidados: 40, aniversariante: "Beatriz", data: "2098-12-12", turno: "almoco" });
  const { payload } = await verificarContratacao(tx, EMPRESA, base, p, "2026-10-22");
  assert.equal(payload.pacote, LIVRE);
  assert.equal(payload.pacoteNome, "Festa Jardim");
  assert.equal(payload.precoTabelaCentavos, 450000);
  assert.deepEqual(chamadas.convidados, [[LIVRE, false]], "erroConvidados chamado com dona=false (erroConvidadosEmpresa)");
  const acima = await erroDe(verificarContratacao(tx, EMPRESA, { ...base, convidados: 81 }, p, "2026-10-22"));
  assert.match(String(acima?.message), /Festa Jardim atende até 80/);
  // Dona: id V1 continua e a regra de convidados é a da Kidmais.
  const dona = porta([pacote("PREMIUM", "Festa Premium")], true);
  const v1 = await verificarContratacao(tx, EMPRESA, { ...base, pacote: "premium" }, dona.p, "2026-10-22");
  assert.equal(v1.payload.pacote, "premium");
  assert.deepEqual(dona.chamadas.convidados, [["premium", true]]);
});

test("horário livre (092–094): a porta de horários recebe o código do pacote resolvido, V1 traduzido ou P_… da empresa", async () => {
  const pedidos: Array<string | undefined> = [];
  const horarios: PortaContratacao["horarios"] = async (_tx, _e, _d, _t, codigo) => {
    pedidos.push(codigo);
    return { configuracaoId: "33333333-3333-4333-8333-333333333333", horarios: [{ inicio: "12:00", fim: "16:00" }] };
  };
  const base = validarContratacao({ cliente: "Felipe Souza", pacote: "festa jardim", convidados: 40, aniversariante: "Beatriz", data: "2098-12-12", turno: "almoco" });
  await verificarContratacao(tx, EMPRESA, base, porta(DA_EMPRESA, false, { horarios }).p, "2026-10-22");
  await verificarContratacao(tx, EMPRESA, { ...base, pacote: "premium" }, porta([pacote("PREMIUM", "Festa Premium")], true, { horarios }).p, "2026-10-22");
  assert.deepEqual(pedidos, [LIVRE, "PREMIUM"]);
});
