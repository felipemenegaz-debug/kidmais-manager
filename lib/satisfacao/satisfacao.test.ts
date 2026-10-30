import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { assinarToken, hashDoToken, lerAnel, TAMANHO_TOKEN, verificarToken, type AnelChaves } from "./token.ts";
import { lerFragmento, linkDaPesquisa } from "./fragmento.ts";
import { calcularNps, esquemaResposta, faixaNps, precisaDeTarefa, primeiroNome } from "./questionario.ts";
import { comRepeticao, TravaOcupada } from "./travas.ts";
import type { DepsPublico } from "./publico.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
// Erro vindo da cópia carregada (outra classe): conferido pelos campos, não por instanceof.
const erroDe = (code: string, status: number) => (e: unknown) => (e as { code?: string }).code === code && (e as { httpStatus?: number }).httpStatus === status;

/** Pesquisa de satisfação (PS-1): partes puras e a recusa sem banco. As provas com banco estão em satisfacao.postgres.test.ts. */
const k1 = randomBytes(32).toString("base64"), k2 = randomBytes(48).toString("base64url");
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${k1},2:${k2}`, SATISFACAO_LINK_CHAVE_ATUAL: "2" }) as AnelChaves;

test("anel de chaves: válido, e qualquer defeito falha fechado (null)", () => {
  assert.ok(anel);
  assert.equal(anel.atual, 2);
  const curta = randomBytes(31).toString("base64");
  for (const env of [
    {}, { SATISFACAO_LINK_CHAVES: `1:${k1}` }, { SATISFACAO_LINK_CHAVE_ATUAL: "1" },
    { SATISFACAO_LINK_CHAVES: `1:${k1}`, SATISFACAO_LINK_CHAVE_ATUAL: "2" },
    { SATISFACAO_LINK_CHAVES: `1:${curta}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" },
    { SATISFACAO_LINK_CHAVES: `1:${k1},1:${k2}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" },
    { SATISFACAO_LINK_CHAVES: `0:${k1}`, SATISFACAO_LINK_CHAVE_ATUAL: "0" },
    { SATISFACAO_LINK_CHAVES: `256:${k1}`, SATISFACAO_LINK_CHAVE_ATUAL: "256" },
    { SATISFACAO_LINK_CHAVES: `1=${k1}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" },
    { SATISFACAO_LINK_CHAVES: `1:${k1}`, SATISFACAO_LINK_CHAVE_ATUAL: "um" },
  ]) assert.equal(lerAnel(env), null, JSON.stringify(Object.keys(env)));
});

test("token: 72 caracteres, verificado em memória; cada campo adulterado é recusado", () => {
  const envio = randomUUID();
  const token = assinarToken(anel, envio, 3, 1);
  assert.equal(token.length, TAMANHO_TOKEN);
  const v = verificarToken(anel, token);
  assert.deepEqual(v && { envioId: v.envioId, geracao: v.geracao, chaveVersao: v.chaveVersao }, { envioId: envio, geracao: 3, chaveVersao: 1 });
  assert.deepEqual(v?.hash, hashDoToken(token));
  const bytes = Buffer.from(token, "base64url");
  const mexer = (pos: number) => { const b = Buffer.from(bytes); b[pos] ^= 0x01; return b.toString("base64url"); };
  assert.equal(verificarToken(anel, mexer(0)), null, "versão do formato");
  assert.equal(verificarToken(anel, mexer(5)), null, "envio_id");
  assert.equal(verificarToken(anel, mexer(20)), null, "geração");
  assert.equal(verificarToken(anel, mexer(21)), null, "chave_versao");
  assert.equal(verificarToken(anel, mexer(40)), null, "HMAC");
  assert.equal(verificarToken(anel, token.slice(0, 71)), null, "truncado");
  assert.equal(verificarToken(anel, `${token}A`), null, "comprido");
  assert.equal(verificarToken(anel, token.replace(/.$/, "=")), null, "caractere fora do alfabeto");
  assert.equal(verificarToken(anel, 12345), null);
  // Geração dentro do material assinado: trocar a geração e manter o HMAC é recusado.
  const outraGeracao = Buffer.from(bytes); outraGeracao.writeUInt32BE(4, 17);
  assert.equal(verificarToken(anel, outraGeracao.toString("base64url")), null);
});

test("rotação: chave anterior no anel continua valendo; retirada do anel, o link deixa de valer", () => {
  const envio = randomUUID();
  const antigo = assinarToken(anel, envio, 1, 1);
  assert.ok(verificarToken(anel, antigo), "anel com a 1 e a 2 (atual): link da 1 vale");
  const semUm = lerAnel({ SATISFACAO_LINK_CHAVES: `2:${k2}`, SATISFACAO_LINK_CHAVE_ATUAL: "2" })!;
  assert.equal(verificarToken(semUm, antigo), null, "chave 1 retirada");
  const outroSegredo = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" })!;
  assert.equal(verificarToken(outroSegredo, antigo), null, "mesma versão, outro segredo");
});

test("fragmento: token e pré-marcação separados; a nota nunca entra no token", () => {
  const token = assinarToken(anel, randomUUID(), 1, 2);
  assert.deepEqual(lerFragmento(`#${token}`), { token, preMarcada: null });
  assert.deepEqual(lerFragmento(`#${token}.n0`), { token, preMarcada: 0 });
  assert.deepEqual(lerFragmento(`#${token}.n10`), { token, preMarcada: 10 });
  for (const ruim of [`#${token}.n11`, `#${token}.n`, `#${token}x`, "#", "", `#t=${token}`]) assert.deepEqual(lerFragmento(ruim), { token: null, preMarcada: null }, ruim);
  assert.equal(linkDaPesquisa("https://app.test/", token, 7), `https://app.test/p/satisfacao#${token}.n7`);
});

test("questionário v1: limites das notas, comentário e faixas do NPS", () => {
  const token = "x".repeat(72);
  assert.equal(esquemaResposta.parse({ token, notaIndicacao: 0 }).notaComida, null);
  assert.equal(esquemaResposta.parse({ token, notaIndicacao: 10, comentario: "  ótima  " }).comentario, "ótima");
  assert.equal(esquemaResposta.parse({ token, notaIndicacao: 10, comentario: "   " }).comentario, null);
  for (const ruim of [{ token }, { token, notaIndicacao: null }, { token, notaIndicacao: 11 }, { token, notaIndicacao: -1 }, { token, notaIndicacao: 7.5 },
    { token, notaIndicacao: 8, notaComida: 0 }, { token, notaIndicacao: 8, notaEspaco: 6 }, { token, notaIndicacao: 8, comentario: "a".repeat(2001) },
    { token, notaIndicacao: 8, empresaId: randomUUID() }]) {
    assert.equal(esquemaResposta.safeParse(ruim).success, false, JSON.stringify(ruim).slice(0, 80));
  }
  assert.deepEqual([0, 6, 7, 8, 9, 10].map(faixaNps), ["DETRATOR", "DETRATOR", "NEUTRO", "NEUTRO", "PROMOTOR", "PROMOTOR"]);
  assert.deepEqual([6, 7].map(precisaDeTarefa), [true, false]);
  assert.equal(calcularNps([]), null);
  assert.equal(calcularNps([10, 9, 8, 6]), 25);
  assert.equal(primeiroNome("  Mariana  Souza "), "Mariana");
});

test("repetição: 55P03 até 5 tentativas com 50/100/200/400 ms (+ até 50%); 40P01 só uma vez; outro erro sobe na hora", async () => {
  const esperas: number[] = [];
  let n = 0;
  const ocupado = Object.assign(new Error("lock"), { code: "55P03" });
  await assert.rejects(comRepeticao(async () => { n++; throw ocupado; }, { esperar: async (ms) => { esperas.push(ms); }, aleatorio: () => 1 }),
    (e: unknown) => e instanceof TravaOcupada && e.tentativas === 5);
  assert.equal(n, 5);
  assert.deepEqual(esperas, [75, 150, 300, 600]);
  n = 0;
  assert.equal(await comRepeticao(async () => { if (++n < 3) throw ocupado; return "ok"; }, { esperar: async () => {}, aleatorio: () => 0 }), "ok");
  assert.equal(n, 3);
  n = 0;
  const deadlock = Object.assign(new Error("dl"), { code: "40P01" });
  await assert.rejects(comRepeticao(async () => { n++; throw deadlock; }, { esperar: async () => {} }), (e: unknown) => (e as { code?: string }).code === "40P01");
  assert.equal(n, 2, "deadlock repete uma única vez");
  n = 0;
  await assert.rejects(comRepeticao(async () => { n++; throw Object.assign(new Error("x"), { code: "23514" }); }, { esperar: async () => {} }));
  assert.equal(n, 1);
});

test("token inventado, adulterado ou sem anel: nenhuma transação aberta (nem limite de tentativas)", async () => {
  // publico.ts importa o pool real; aqui ele é dublado e qualquer acesso ao banco falha o teste.
  const proibido = () => { throw new Error("banco não deveria ser tocado"); };
  const { abrirPesquisa, responderPesquisa, sairDasPesquisas } = carregarModulo("lib/satisfacao/publico.ts", {
    "db/postgres": { withTransaction: proibido, query: proibido },
    "autenticacao/service": { consumirLimite: proibido, prazoDoLimite: proibido },
  }) as Record<string, (corpo: unknown, origem: { ip: string | null }, deps: DepsPublico) => Promise<unknown>>;
  let transacoes = 0;
  const deps = (anelAtual: AnelChaves | null): DepsPublico => ({ withTransaction: async () => { transacoes++; throw new Error("não deveria abrir"); }, anel: () => anelAtual });
  const valido = assinarToken(anel, randomUUID(), 1, 2);
  const adulterado = (() => { const b = Buffer.from(valido, "base64url"); b[30] ^= 1; return b.toString("base64url"); })();
  for (const token of ["inventado", "A".repeat(72), adulterado, valido.slice(0, 71), null]) {
    for (const chamar of [() => abrirPesquisa({ token }, { ip: null }, deps(anel)), () => responderPesquisa({ token, notaIndicacao: 9 }, { ip: "203.0.113.9" }, deps(anel)),
      () => sairDasPesquisas({ token }, { ip: null }, deps(anel))]) {
      await assert.rejects(chamar(), erroDe("LINK_INDISPONIVEL", 404));
    }
  }
  await assert.rejects(abrirPesquisa({ token: valido }, { ip: null }, deps(null)), erroDe("PESQUISA_INDISPONIVEL", 503));
  assert.equal(transacoes, 0);
});
