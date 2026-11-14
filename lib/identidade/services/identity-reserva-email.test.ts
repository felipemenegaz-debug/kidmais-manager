/* eslint-disable @typescript-eslint/no-explicit-any */
// Reserva por e-mail do código (decisão de Felipe, 12/11/2026). Sem banco: o serviço real sobre repositórios em
// memória que seguem os predicados das SQL (PENDENTE → CANCELADA só uma vez; registrar envio só em PENDENTE).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const req = createRequire(import.meta.url);

function carregar(arquivo: string, mocks: Record<string, unknown>) {
  const cache = new Map<string, Record<string, unknown>>();
  const achar = (base: string) => [base, base + ".ts", base + "/index.ts"].find((p) => existsSync(p) && statSync(p).isFile()) ?? base;
  function load(file: string): Record<string, unknown> {
    const abs = achar(resolve(file)).replaceAll("\\", "/");
    for (const [chave, valor] of Object.entries(mocks)) if (abs.endsWith(chave)) return valor as Record<string, unknown>;
    const hit = cache.get(abs);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(abs, exports);
    const code = ts.transpileModule(readFileSync(abs, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function("require", "exports", code)(
      (n: string) => (n.startsWith("@/") ? load(n.slice(2)) : n.startsWith(".") ? load(resolve(dirname(abs), n)) : req(n)),
      exports,
    );
    return exports;
  }
  return load(arquivo);
}

const CPF = "52998224725";
const ESCOPO = { empresaId: "aaaaaaaa-0000-4000-8000-00000000000a" };
const T0 = new Date("2026-11-12T12:00:00.000Z");

type Cliente = { id: string; whatsapp: string | null; telefone: string | null; email: string | null };

function montar(opcoes: {
  cliente?: Partial<Cliente>;
  reservaEmail?: boolean;
  falharWhatsapp?: boolean;
  falharEmail?: boolean;
  falharRegistro?: boolean;
  reservaDisponivelNoAmbiente?: boolean;
} = {}) {
  const cliente: Cliente = {
    id: "cccccccc-0000-4000-8000-00000000000c",
    whatsapp: "11999990000",
    telefone: null,
    email: "cliente@exemplo.test",
    ...opcoes.cliente,
  };
  let agora = T0;
  let seq = 0;
  const validacoes = new Map<string, any>();
  const envios: any[] = [];
  const avisos: string[] = [];

  const repos = {
    criarDesafioIdentidade: async (input: any) => {
      seq += 1;
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
      const registro = {
        id,
        clienteId: input.clienteId,
        finalidade: input.finalidade,
        canal: input.canal,
        status: "PENDENTE",
        codigoHash: input.codigoHash,
        tentativas: input.tentativas ?? 0,
        maxTentativas: input.maxTentativas,
        envios: input.envios ?? 0,
        maxEnvios: input.maxEnvios,
        ultimoEnvioEm: null,
        codigoExpiraEm: input.codigoExpiraEm,
        criadoEm: agora.toISOString(),
      };
      validacoes.set(id, registro);
      return { ...registro };
    },
    registrarEnvioOtp: async (id: string) => {
      const v = validacoes.get(id);
      if (opcoes.falharRegistro || !v || v.status !== "PENDENTE" || v.envios >= v.maxEnvios) return null;
      v.envios += 1;
      v.ultimoEnvioEm = agora.toISOString();
      return { ...v };
    },
    cancelarValidacaoPendente: async (id: string) => {
      const v = validacoes.get(id);
      if (!v || v.status !== "PENDENTE") return null;
      v.status = "CANCELADA";
      return { ...v };
    },
    reabrirValidacaoCancelada: async (id: string) => {
      const v = validacoes.get(id);
      if (!v || v.status !== "CANCELADA" || Date.parse(v.codigoExpiraEm) <= agora.getTime()) return null;
      v.status = "PENDENTE";
      return { ...v };
    },
    buscarValidacaoPorId: async (id: string) => (validacoes.has(id) ? { ...validacoes.get(id) } : null),
    confirmarValidacao: async (input: any) => {
      const v = validacoes.get(input.validacaoId);
      if (!v || v.status !== "PENDENTE") return null;
      Object.assign(v, { status: "CONFIRMADA", codigoHash: null, tokenProvaHash: input.tokenProvaHash });
      return { ...v };
    },
    registrarTentativaInvalida: async (id: string) => {
      const v = validacoes.get(id);
      if (!v || v.status !== "PENDENTE") return null;
      v.tentativas += 1;
      if (v.tentativas >= v.maxTentativas) v.status = "BLOQUEADA";
      return { ...v };
    },
  };

  const mocks = {
    "lib/identidade/repositories/index.ts": repos,
    "lib/clientes/repositories/index.ts": {
      buscarClienteCanonicoPorCpfParaIdentidade: async () => cliente,
      buscarClienteCanonicoPorCnpjParaIdentidade: async () => null,
      buscarClienteCanonicoPorId: async (id: string) => (id === cliente.id ? cliente : null),
      migration112Aplicada: async () => true,
    },
    "lib/identidade/configuracao-otp.ts": {
      otpDesabilitadoNoStaging: () => false,
      reservaEmailOtpDisponivel: () => opcoes.reservaDisponivelNoAmbiente ?? false,
    },
  };
  const mod = carregar("lib/identidade/services/identity.service.ts", mocks) as any;

  const service = mod.criarIdentityService({
    otpPepper: "pepper-de-teste-com-16+",
    reservaEmail: opcoes.reservaEmail ?? true,
    now: () => agora,
    gerarOtp: () => "123456",
    enviarOtp: async (delivery: any) => {
      envios.push(delivery);
      if (delivery.canal === "WHATSAPP" && opcoes.falharWhatsapp) throw new Error("provedor recusou");
      if (delivery.canal === "EMAIL" && opcoes.falharEmail) throw new Error("smtp caiu");
    },
  });

  const avancar = (ms: number) => { agora = new Date(agora.getTime() + ms); };
  return { mod, service, cliente, validacoes, envios, avisos, avancar };
}

async function capturarAvisos(fn: () => Promise<any>): Promise<{ valor: any; linhas: string[] }> {
  const original = console.warn;
  const linhas: string[] = [];
  console.warn = (...args: unknown[]) => { linhas.push(args.map(String).join(" ")); };
  try {
    return { valor: await fn(), linhas };
  } finally {
    console.warn = original;
  }
}

test("WhatsApp enviado: devolve a reserva disponível (e-mail mascarado, liberação em 60 s) sem enviar e-mail", async () => {
  const { service, envios } = montar();
  const desafio = await service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  assert.equal(desafio.canal, "WHATSAPP");
  assert.equal(desafio.reserva, undefined);
  assert.deepEqual(desafio.reservaEmail, {
    destinoMascarado: "c***@e***.test",
    liberaEm: new Date(T0.getTime() + 60_000).toISOString(),
  });
  assert.deepEqual(envios.map((e) => e.canal), ["WHATSAPP"]);
  assert.doesNotMatch(JSON.stringify(desafio), /cliente@exemplo|11999990000|123456/);
});

test("falha do envio pelo WhatsApp: cancela o desafio nunca enviado e manda o código ao e-mail do cadastro", async () => {
  const { service, envios, validacoes } = montar({ falharWhatsapp: true });
  const { valor: desafio, linhas } = await capturarAvisos(() =>
    service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO, finalidade: "CONTRATO_ACEITE" }));

  assert.equal(desafio.canal, "EMAIL");
  assert.equal(desafio.reserva, "FALHA_WHATSAPP");
  assert.equal(desafio.destinoMascarado, "c***@e***.test");
  assert.equal(desafio.reservaEmail, undefined);
  assert.deepEqual(envios.map((e) => [e.canal, e.destino]), [
    ["WHATSAPP", "11999990000"],
    ["EMAIL", "cliente@exemplo.test"],
  ]);
  const [whats, email] = [...validacoes.values()];
  assert.equal(whats.status, "CANCELADA");
  assert.equal(email.status, "PENDENTE");
  assert.equal(email.canal, "EMAIL");
  assert.equal(email.finalidade, "CONTRATO_ACEITE");
  assert.equal(email.id, desafio.validacaoId);
  // HMAC inclui o canal: o mesmo código gerado vira hashes diferentes por canal.
  assert.notEqual(whats.codigoHash, email.codigoHash);
  // Log só diz por que a reserva entrou: sem destino, código, cliente ou validação.
  assert.deepEqual(linhas, ['{"otp":"reserva_email","motivo":"FALHA_WHATSAPP"}']);
});

test("sem reserva automática: falha ao registrar envio já feito, reserva desligada ou cadastro sem e-mail", async () => {
  for (const caso of [
    { falharWhatsapp: false, falharRegistro: true },
    { falharWhatsapp: true, reservaEmail: false },
    { falharWhatsapp: true, cliente: { email: null } },
    { falharWhatsapp: true, cliente: { email: "   " } },
  ]) {
    const { service, envios } = montar(caso);
    await assert.rejects(
      service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO }),
      (erro: any) => erro.code === "FALHA_ENVIO_OTP",
      JSON.stringify(caso),
    );
    assert.deepEqual(envios.map((e) => e.canal), ["WHATSAPP"], JSON.stringify(caso));
  }
});

test("falha também no e-mail: erro genérico de envio, sem segunda reserva", async () => {
  const { service, envios, validacoes } = montar({ falharWhatsapp: true, falharEmail: true });
  await capturarAvisos(async () => {
    await assert.rejects(
      service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO }),
      (erro: any) => erro.code === "FALHA_ENVIO_OTP" && erro.details.etapa === "ENVIO",
    );
  });
  assert.deepEqual(envios.map((e) => e.canal), ["WHATSAPP", "EMAIL"]);
  // Nenhum código fica pendente sem ter sido enviado: o cliente recomeça pelo CPF.
  assert.deepEqual([...validacoes.values()].map((v) => v.status), ["CANCELADA", "CANCELADA"]);
});

test("reserva desligada: nada muda (sem reservaEmail na resposta, EMAIL recusado como canal)", async () => {
  const { service, mod } = montar({ reservaEmail: false });
  const desafio = await service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  assert.equal(desafio.reservaEmail, undefined);
  await assert.rejects(service.iniciarDesafio({ cpf: CPF, canal: "EMAIL", escopo: ESCOPO }), (e: any) => e.code === "CANAL_INDISPONIVEL");
  await assert.rejects(service.receberCodigoPorEmail(desafio.validacaoId), (e: any) => e.code === "RESERVA_EMAIL_INDISPONIVEL");
  // Consulta pública: com a reserva desligada, cliente sem WhatsApp continua sem canal.
  const semWhats = montar({ cliente: { whatsapp: null }, reservaDisponivelNoAmbiente: false });
  assert.deepEqual(await semWhats.mod.consultarCpfPublico(CPF, ESCOPO), { situacao: "CLIENTE_EXISTENTE_SEM_CONTATO", canais: [] });
  assert.ok(mod);
});

test("e-mail como canal inicial só para cliente sem WhatsApp, com a reserva ligada", async () => {
  const semWhats = montar({ cliente: { whatsapp: null }, reservaDisponivelNoAmbiente: true });
  assert.deepEqual(await semWhats.mod.consultarCpfPublico(CPF, ESCOPO), {
    situacao: "CLIENTE_EXISTENTE",
    canais: [{ canal: "EMAIL", destinoMascarado: "c***@e***.test" }],
  });
  const desafio = await semWhats.service.iniciarDesafio({ cpf: CPF, canal: "EMAIL", escopo: ESCOPO });
  assert.equal(desafio.canal, "EMAIL");
  assert.equal(desafio.reserva, undefined);
  assert.deepEqual(semWhats.envios.map((e) => e.destino), ["cliente@exemplo.test"]);

  const comWhats = montar({ reservaDisponivelNoAmbiente: true });
  assert.deepEqual(
    (await comWhats.mod.consultarCpfPublico(CPF, ESCOPO)).canais.map((c: any) => c.canal),
    ["WHATSAPP"],
  );
  await assert.rejects(comWhats.service.iniciarDesafio({ cpf: CPF, canal: "EMAIL", escopo: ESCOPO }), (e: any) => e.code === "CANAL_INDISPONIVEL");
  assert.equal(comWhats.envios.length, 0);
});

test("botão Receber por e-mail: espera 60 s, troca o desafio e o código do WhatsApp deixa de valer", async () => {
  const { service, envios, validacoes, avancar } = montar();
  const whats = await service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO, finalidade: "CONTRATO_ACEITE" });

  avancar(59_000);
  await assert.rejects(service.receberCodigoPorEmail(whats.validacaoId), (e: any) =>
    e.code === "RESERVA_EMAIL_AGUARDE" && e.httpStatus === 429 && e.details.liberaEm === whats.reservaEmail.liberaEm);
  assert.equal(envios.length, 1);

  avancar(1_000);
  const { valor: email, linhas } = await capturarAvisos(() => service.receberCodigoPorEmail(whats.validacaoId));
  assert.equal(email.canal, "EMAIL");
  assert.equal(email.reserva, "PEDIDO_CLIENTE");
  assert.notEqual(email.validacaoId, whats.validacaoId);
  assert.equal(validacoes.get(whats.validacaoId).status, "CANCELADA");
  assert.equal(validacoes.get(email.validacaoId).finalidade, "CONTRATO_ACEITE");
  assert.deepEqual(envios.map((e) => e.canal), ["WHATSAPP", "EMAIL"]);
  assert.deepEqual(linhas, ['{"otp":"reserva_email","motivo":"PEDIDO_CLIENTE"}']);

  // Segundo clique (ou outra aba) com o desafio antigo: já não está pendente.
  await assert.rejects(service.receberCodigoPorEmail(whats.validacaoId), (e: any) => e.code === "VALIDACAO_NAO_PENDENTE");
  // O desafio do e-mail não pode ser trocado de novo por e-mail.
  avancar(60_000);
  await assert.rejects(service.receberCodigoPorEmail(email.validacaoId), (e: any) => e.code === "RESERVA_EMAIL_INDISPONIVEL");
  assert.equal(envios.length, 2);
});

test("botão Receber por e-mail recusa: código expirado, validação inexistente, bloqueada e cadastro sem e-mail", async () => {
  const expirado = montar();
  const d1 = await expirado.service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  expirado.avancar(10 * 60_000);
  await assert.rejects(expirado.service.receberCodigoPorEmail(d1.validacaoId), (e: any) => e.code === "CODIGO_EXPIRADO");

  await assert.rejects(expirado.service.receberCodigoPorEmail("00000000-0000-4000-8000-999999999999"), (e: any) => e.code === "VALIDACAO_NAO_ENCONTRADA");

  const bloqueada = montar();
  const d2 = await bloqueada.service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  bloqueada.validacoes.get(d2.validacaoId).status = "BLOQUEADA";
  bloqueada.avancar(60_000);
  await assert.rejects(bloqueada.service.receberCodigoPorEmail(d2.validacaoId), (e: any) => e.code === "CODIGO_BLOQUEADO");

  const semEmail = montar({ cliente: { email: null } });
  const d3 = await semEmail.service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  assert.equal(d3.reservaEmail, undefined);
  semEmail.avancar(60_000);
  await assert.rejects(semEmail.service.receberCodigoPorEmail(d3.validacaoId), (e: any) => e.code === "RESERVA_EMAIL_INDISPONIVEL");
  assert.equal(semEmail.validacoes.get(d3.validacaoId).status, "PENDENTE");

  for (const s of [expirado, bloqueada, semEmail]) assert.ok(s.envios.every((e) => e.canal === "WHATSAPP"));
});

test("espera da reserva inválida é erro de configuração", () => {
  const { mod } = montar();
  for (const reservaEmailEsperaMs of [0, -1, Number.NaN]) {
    assert.throws(
      () => mod.criarIdentityService({ otpPepper: "pepper-de-teste-com-16+", enviarOtp: async () => {}, reservaEmailEsperaMs }),
      (e: any) => e.code === "CONFIGURACAO_IDENTIDADE_INVALIDA",
    );
  }
});

test("código enviado por e-mail confirma; o código do WhatsApp cancelado não confirma mais", async () => {
  const { service, avancar } = montar();
  const whats = await service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  avancar(60_000);
  const email = await capturarAvisos(() => service.receberCodigoPorEmail(whats.validacaoId));
  await assert.rejects(service.confirmarCodigo({ validacaoId: whats.validacaoId, codigo: "123456" }), (e: any) => e.code === "VALIDACAO_NAO_PENDENTE");
  await assert.rejects(service.confirmarCodigo({ validacaoId: email.valor.validacaoId, codigo: "654321" }), (e: any) => e.code === "CODIGO_INVALIDO");
  const prova = await service.confirmarCodigo({ validacaoId: email.valor.validacaoId, codigo: "123456" });
  assert.ok(prova.provaToken.length >= 32);
});

test("P1: trocar para o e-mail não zera tentativas nem envios do desafio do WhatsApp", async () => {
  const { service, validacoes, avancar } = montar();
  const whats = await service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(service.confirmarCodigo({ validacaoId: whats.validacaoId, codigo: "000000" }), (e: any) => e.code === "CODIGO_INVALIDO");
  }
  avancar(60_000);
  const { valor: email } = await capturarAvisos(() => service.receberCodigoPorEmail(whats.validacaoId));
  const nova = validacoes.get(email.validacaoId);
  assert.equal(nova.tentativas, 4);
  assert.equal(nova.maxTentativas, 5);
  assert.equal(nova.envios, 2, "o envio do WhatsApp conta no orçamento do e-mail");
  // Sobra só a quinta tentativa: o erro seguinte bloqueia.
  await assert.rejects(service.confirmarCodigo({ validacaoId: email.validacaoId, codigo: "000000" }), (e: any) => e.code === "CODIGO_BLOQUEADO");
});

test("P1: com os envios esgotados, o botão recusa sem enviar nem cancelar", async () => {
  const { service, validacoes, envios, avancar } = montar();
  const whats = await service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  validacoes.get(whats.validacaoId).envios = 3;
  avancar(60_000);
  await assert.rejects(service.receberCodigoPorEmail(whats.validacaoId), (e: any) => e.code === "LIMITE_ENVIOS_OTP" && e.httpStatus === 429);
  assert.equal(validacoes.get(whats.validacaoId).status, "PENDENTE");
  assert.deepEqual(envios.map((e) => e.canal), ["WHATSAPP"]);
});

test("P2: falha do e-mail no botão devolve o desafio do WhatsApp (mesmo id) e não deixa código do e-mail pendente", async () => {
  const opcoes = { falharEmail: true };
  const { service, validacoes, envios, avancar } = montar(opcoes);
  const whats = await service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  avancar(60_000);
  await capturarAvisos(async () => {
    await assert.rejects(service.receberCodigoPorEmail(whats.validacaoId), (e: any) => e.code === "FALHA_ENVIO_OTP");
  });
  assert.equal(validacoes.get(whats.validacaoId).status, "PENDENTE");
  assert.deepEqual([...validacoes.values()].map((v) => [v.canal, v.status]), [["WHATSAPP", "PENDENTE"], ["EMAIL", "CANCELADA"]]);

  // Retomada: o cliente pode tentar o e-mail de novo com o mesmo id...
  opcoes.falharEmail = false;
  const { valor: email } = await capturarAvisos(() => service.receberCodigoPorEmail(whats.validacaoId));
  assert.equal(email.canal, "EMAIL");
  assert.deepEqual(envios.map((e) => e.canal), ["WHATSAPP", "EMAIL", "EMAIL"]);

  // ...ou, noutro cenário, confirmar o código do WhatsApp que chegou atrasado.
  const outro = montar({ falharEmail: true });
  const w2 = await outro.service.iniciarDesafio({ cpf: CPF, canal: "WHATSAPP", escopo: ESCOPO });
  outro.avancar(60_000);
  await capturarAvisos(async () => { await assert.rejects(outro.service.receberCodigoPorEmail(w2.validacaoId)); });
  const prova = await outro.service.confirmarCodigo({ validacaoId: w2.validacaoId, codigo: "123456" });
  assert.ok(prova.provaToken.length >= 32);
});
