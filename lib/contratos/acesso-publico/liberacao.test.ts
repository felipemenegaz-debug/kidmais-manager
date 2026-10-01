import assert from "node:assert/strict";
import test from "node:test";
import { MAXIMO_ENVIOS_DIA, chaveIdempotencia, decidirEnvio, linkAcesso, parametrosMensagem, registrarEnvio, type LiberacaoAcesso } from "./liberacao.ts";

const contrato = "44444444-4444-4444-8444-444444444444";
const base: LiberacaoAcesso = { contratoId: contrato, versaoId: "v2", empresaId: "e", liberadoPor: "u", liberadoEm: "2026-09-28T15:00:00Z", revogadoEm: null, envios: [] };
const agora = new Date("2026-09-28T15:00:00Z");

test("link só HTTPS, só /contrato/<uuid>, sem token; mensagem sem OTP, CPF ou valores", () => {
  assert.equal(linkAcesso("https://app.kidmais.com.br", contrato), `https://app.kidmais.com.br/contrato/${contrato}`);
  assert.throws(() => linkAcesso("http://app.kidmais.com.br", contrato));
  assert.throws(() => linkAcesso("https://app.kidmais.com.br/?t=1", contrato));
  assert.throws(() => linkAcesso("https://app.kidmais.com.br", "../../admin"));
  const parametros = parametrosMensagem({ primeiroNome: "Mariana Souza", empresa: "Kidmais Festas", link: linkAcesso("https://app.kidmais.com.br", contrato) });
  assert.deepEqual(parametros, ["Mariana", "Kidmais Festas", `https://app.kidmais.com.br/contrato/${contrato}`]);
  assert.throws(() => parametrosMensagem({ primeiroNome: "M", empresa: "K", link: `https://app/contrato/${contrato}?otp=123456` }));
  // Parâmetros livres sem OTP, CPF ou valor; o link tem formato fixo (só o UUID do contrato).
  assert.equal(parametros.slice(0, 2).join(" ").match(/\d{6}|\d{3}\.\d{3}\.\d{3}-\d{2}|R\$/), null);
  assert.match(parametros[2], /^https:\/\/[^/?#]+\/contrato\/[0-9a-f-]{36}$/);
});

test("idempotência: clique repetido devolve o resultado; retry da mesma tentativa usa a mesma chave", () => {
  const primeira = decidirEnvio(base, { reenviar: false }, agora);
  assert.equal(primeira.acao, "ENVIAR");
  if (primeira.acao !== "ENVIAR") return;
  assert.equal(primeira.chaveIdempotencia, chaveIdempotencia(contrato, "v2", 1));
  const depois = registrarEnvio(base, { ...primeira, ok: true }, agora);
  const repetido = decidirEnvio(depois, { reenviar: false }, new Date(agora.getTime() + 5_000));
  assert.equal(repetido.acao, "REPETIR_RESULTADO");
  assert.equal(decidirEnvio(depois, { reenviar: true, chaveCliente: primeira.chaveIdempotencia }, agora).acao, "REPETIR_RESULTADO");
});

test("falha do WhatsApp mantém o acesso liberado e permite reenviar depois do intervalo; limite diário", () => {
  const falhou = registrarEnvio(base, { tentativa: 1, chaveIdempotencia: chaveIdempotencia(contrato, "v2", 1), ok: false }, agora);
  assert.equal(falhou.revogadoEm, null);
  assert.equal(falhou.envios[0].status, "FALHOU");
  assert.equal(decidirEnvio(falhou, { reenviar: true }, new Date(agora.getTime() + 10_000)).acao, "RECUSAR");
  const reenvio = decidirEnvio(falhou, { reenviar: true }, new Date(agora.getTime() + 61_000));
  assert.equal(reenvio.acao === "ENVIAR" && reenvio.tentativa, 2);
  let l = base;
  for (let i = 1; i <= MAXIMO_ENVIOS_DIA; i += 1) l = registrarEnvio(l, { tentativa: i, chaveIdempotencia: chaveIdempotencia(contrato, "v2", i), ok: true }, new Date(agora.getTime() + i * 120_000));
  assert.equal(decidirEnvio(l, { reenviar: true }, new Date(agora.getTime() + 20 * 60_000)).acao, "RECUSAR");
  assert.equal(decidirEnvio({ ...base, revogadoEm: agora.toISOString() }, { reenviar: false }, agora).acao, "RECUSAR");
});
