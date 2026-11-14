// Reserva por e-mail no aceite do contrato (12/11/2026): o canal do código que provou a identidade fica na trilha.
// Teste de estrutura: o fluxo completo do aceite só roda com PostgreSQL descartável.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fonte = readFileSync(new URL("./contrato-publico.service.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function trecho(inicio: string, fim: string) {
  const i = fonte.indexOf(inicio);
  assert.ok(i >= 0, inicio);
  const j = fonte.indexOf(fim, i);
  assert.ok(j > i, fim);
  return fonte.slice(i, j);
}

test("aceite: canal vem da prova consumida e entra no evento e na auditoria", () => {
  assert.match(fonte, /const aceiteCanal = prova\.canal \?\? null;/);
  assert.match(fonte, /const reservaEmail = aceiteCanal === "EMAIL";/);
  const evento = trecho('tipoEvento: "CONTRATO_ASSINADO"', "critico: true");
  assert.match(evento, /aceito eletronicamente por código enviado por e-mail/);
  assert.match(evento, /metodo: "OTP",\n\s+aceiteCanal,\n\s+reservaEmail,/);
  const auditoria = trecho('acao: "CONTRATO_ACEITO_CLIENTE"', 'origem: "CONTRATO_PUBLICO"');
  assert.match(auditoria, /validacaoId: prova\.validacaoId,\n\s+aceiteCanal,\n\s+reservaEmail,/);
  // Método do aceite continua OTP (a coluna e o comprovante não mudam).
  assert.match(auditoria, /aceiteMetodo: "OTP"/);
});

test("receber por e-mail no contrato: valida o acesso do desafio antes de qualquer envio e devolve acesso novo", () => {
  const corpo = trecho("export async function receberCodigoContratoPorEmail", "\n}\n");
  const valida = corpo.indexOf("validarContratoAcessoToken(input.acessoToken");
  const envia = corpo.indexOf("identity.receberCodigoPorEmail(acesso.validacaoId)");
  assert.ok(valida > 0 && envia > valida);
  assert.match(corpo, /criarContratoAcessoToken\(\{\n\s+contratoId: contrato\.id,\n\s+versaoId: versao\.id,\n\s+validacaoId: desafio\.validacaoId,/);
});

test("iniciar no contrato: EMAIL fora dos canais do cadastro é CANAL_INDISPONIVEL (como no fechamento), não acesso negado", () => {
  const corpo = trecho("export async function iniciarDesafioContrato", "\n}\n");
  const situacao = corpo.indexOf('if (acesso.situacao !== "CLIENTE_EXISTENTE") acessoNegado();');
  const canal = corpo.indexOf('if (input.canal === "EMAIL") {');
  assert.ok(situacao > 0 && canal > situacao, "situação do acesso é conferida antes do canal");
  assert.match(corpo.slice(canal), /new IdentityServiceError\(\n\s+"CANAL_INDISPONIVEL",/);
  // WhatsApp ausente continua como antes (acesso negado), e nenhum desafio é iniciado antes da recusa.
  assert.ok(corpo.indexOf("identity.iniciarDesafio(") > canal);
});
