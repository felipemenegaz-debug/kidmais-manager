// Rotas do botão "Não recebeu? Receber por e-mail" (fechamento e contrato). Sem serviço, banco ou provedor reais.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

const requireLocal = createRequire(import.meta.url);
const next = requireLocal("next/server");
const validacaoId = "00000000-0000-4000-8000-0000000000aa";
const contratoId = "00000000-0000-4000-8000-000000000001";

class ErroIdentidade extends Error {
  code: string;
  httpStatus: number;
  details?: Record<string, unknown>;
  constructor(code: string, httpStatus: number, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function carregar(file: URL, dependencies: Record<string, unknown>, logs: unknown[][]) {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const console = Object.fromEntries(["debug", "info", "warn", "error", "log"].map((m) => [m, (...a: unknown[]) => logs.push(a)]));
  new Function("require", "exports", "console", code)((name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `dependência inesperada: ${name}`);
    return dependencies[name];
  }, exports, console);
  return exports;
}

const pedido = (body: string, url = "https://local.example/api/identidade/receber-por-email?empresa=buffet") =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });

function rotaIdentidade(opcoes: { limite?: Response | null; erro?: ErroIdentidade } = {}) {
  const logs: unknown[][] = [];
  const chamadas: unknown[] = [];
  const sender = async () => {};
  const route = carregar(new URL("./route.ts", import.meta.url), {
    "next/server": next,
    zod: { z },
    "@/lib/identidade/delivery": { enviarOtpComAmbiente: sender },
    "@/lib/identidade/services": {
      isIdentityServiceError: (e: unknown) => e instanceof ErroIdentidade,
      criarIdentityServiceComAmbiente: (s: unknown) => {
        assert.equal(s, sender);
        return {
          receberCodigoPorEmail: async (id: string) => {
            chamadas.push(id);
            if (opcoes.erro) throw opcoes.erro;
            return { validacaoId: "novo", canal: "EMAIL", destinoMascarado: "c***@e***.test", expiraEm: "2026-11-12T12:10:00.000Z", reserva: "PEDIDO_CLIENTE" };
          },
        };
      },
    },
    "@/lib/http/limite-publico": { limitarPublico: async () => opcoes.limite ?? null },
  }, logs);
  return { post: route.POST as (r: Request) => Promise<Response>, logs, chamadas };
}

test("fechamento: troca pelo e-mail devolve só dados mascarados, no-store, 201", async () => {
  const a = rotaIdentidade();
  const resposta = await a.post(pedido(JSON.stringify({ validacaoId })));
  assert.equal(resposta.status, 201);
  assert.equal(resposta.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await resposta.json(), {
    ok: true, validacaoId: "novo", canal: "EMAIL", destinoMascarado: "c***@e***.test",
    expiraEm: "2026-11-12T12:10:00.000Z", reserva: "PEDIDO_CLIENTE",
  });
  assert.deepEqual(a.chamadas, [validacaoId]);
  assert.deepEqual(a.logs, []);
});

test("fechamento: destino nunca vem do pedido; campos extras, id inválido e JSON quebrado são recusados", async () => {
  for (const body of [
    JSON.stringify({ validacaoId, email: "outro@exemplo.test" }),
    JSON.stringify({ validacaoId: "nao-e-uuid" }),
    "{",
  ]) {
    const a = rotaIdentidade();
    const resposta = await a.post(pedido(body));
    assert.equal(resposta.status, 400);
    assert.equal(resposta.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(a.chamadas, []);
  }
});

test("fechamento: limite público e erros do serviço (aguarde/indisponível) com status e detalhes seguros", async () => {
  const limitado = rotaIdentidade({ limite: new Response("{}", { status: 429 }) });
  assert.equal((await limitado.post(pedido(JSON.stringify({ validacaoId })))).status, 429);
  assert.deepEqual(limitado.chamadas, []);

  const aguarde = rotaIdentidade({ erro: new ErroIdentidade("RESERVA_EMAIL_AGUARDE", 429, { liberaEm: "2026-11-12T12:01:00.000Z" }) });
  const r1 = await aguarde.post(pedido(JSON.stringify({ validacaoId })));
  assert.equal(r1.status, 429);
  assert.deepEqual((await r1.json()).detalhes, { liberaEm: "2026-11-12T12:01:00.000Z" });

  const falha = rotaIdentidade({ erro: new ErroIdentidade("FALHA_ENVIO_OTP", 503, { causa: "segredo do provedor" }) });
  const r2 = await falha.post(pedido(JSON.stringify({ validacaoId })));
  assert.equal(r2.status, 503);
  assert.equal((await r2.json()).detalhes, undefined);
});

test("contrato: exige o acesso do desafio e devolve o novo acesso; limite e schema estrito", async () => {
  const logs: unknown[][] = [];
  const chamadas: unknown[][] = [];
  const sender = async () => {};
  const noStoreContrato = (r: Response) => { r.headers.set("Cache-Control", "no-store"); return r; };
  const route = carregar(new URL("../../contratos/[contratoId]/identidade/receber-por-email/route.ts", import.meta.url), {
    "next/server": next,
    zod: { z },
    "@/lib/contratos/services": {
      receberCodigoContratoPorEmail: async (...args: unknown[]) => {
        chamadas.push(args);
        return { validacaoId: "novo", canal: "EMAIL", destinoMascarado: "c***@e***.test", acessoToken: "acesso-novo" };
      },
    },
    "@/lib/identidade/delivery": { enviarOtpComAmbiente: sender },
    "@/lib/http/limite-publico": { limitarPublico: async () => null },
    "../../../route-utils": {
      contratoIdDaRota: async (c: { params: Promise<{ contratoId: string }> }) => (await c.params).contratoId,
      erroContratoPublico: () => noStoreContrato(new Response("{}", { status: 500 })),
      noStoreContrato,
    },
  }, logs);
  const post = route.POST as (r: Request, c: unknown) => Promise<Response>;
  const contexto = { params: Promise.resolve({ contratoId }) };

  const ok = await post(pedido(JSON.stringify({ acessoToken: "acesso-antigo" })), contexto);
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.equal((await ok.json()).data.acessoToken, "acesso-novo");
  assert.deepEqual(chamadas, [[{ contratoId, acessoToken: "acesso-antigo" }, sender]]);

  for (const body of [JSON.stringify({}), JSON.stringify({ acessoToken: "x", email: "outro@exemplo.test" })]) {
    const recusa = await post(pedido(body), { params: Promise.resolve({ contratoId }) });
    assert.equal(recusa.status, 400);
  }
  assert.equal(chamadas.length, 1);
  assert.deepEqual(logs, []);
});
