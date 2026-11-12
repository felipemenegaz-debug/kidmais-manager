import test from "node:test";
import assert from "node:assert/strict";
import { codificarCursor, lerCursor } from "./cursor.ts";
import { anexada, anexar, inicial, nova, podeRepetir, primeira } from "../../components/admin/satisfacao/geracao.ts";

test("PS-4 cursor: microssegundos preservados como texto, ida e volta; formato, tamanho e uuid inválidos → 400", () => {
  const instante = "2026-10-31T12:34:56.123457Z", id = "0b7f2a8e-3c1d-4f5e-9a6b-7c8d9e0f1a2b";
  const c = codificarCursor(instante, id);
  assert.deepEqual(lerCursor(c), { instante, id }, "ida e volta sem Date");
  assert.equal(lerCursor(null), null);
  assert.equal(lerCursor(""), null);
  const invalido = (x: string) => assert.throws(() => lerCursor(x), (e: unknown) => (e as { code?: string; httpStatus?: number }).code === "DADOS_INVALIDOS" && (e as { httpStatus?: number }).httpStatus === 400, x.slice(0, 40));
  invalido("x".repeat(121));
  invalido("abc$def");
  invalido(Buffer.from(`2026-10-31T12:34:56.123Z|${id}`).toString("base64url"));
  invalido(Buffer.from(`2026-10-31T12:34:56.123457Z|nao-uuid`).toString("base64url"));
  invalido(Buffer.from(`2026-10-31 12:34:56.123457Z|${id}`).toString("base64url"));
});

test("PS-4 C1: gerações A → B → A descartam o \"Ver mais\" e o erro tardios da geração antiga", () => {
  type P = { pagina: string };
  const ok = (pagina: string) => ({ ok: true as const, data: { pagina } });
  const erro = (status: number) => ({ ok: false as const, falha: { status, codigo: null, mensagem: "x" } });
  // A carregada; "Ver mais" de A pedido e RETIDO.
  let g = primeira(inicial<P>("A"), 0, ok("A1"));
  g = anexar(g, 0);
  const nA = g.n;
  // Troca para B e volta para A: duas gerações novas; a nova página 1 de A chega.
  g = nova(g, "B");
  g = nova(g, "A");
  assert.equal(g.n, nA + 2, "voltar ao filtro original abre geração nova (número diferente)");
  assert.deepEqual([g.paginas, g.carregada, g.anexando], [[], false, false], "nada da geração anterior");
  const nNova = g.n;
  g = primeira(g, nNova, ok("A1'"));
  // O "Ver mais" antigo termina agora: sucesso tardio é descartado.
  const depoisDoSucesso = anexada(g, nA, ok("A2-antiga"));
  assert.deepEqual(depoisDoSucesso.paginas, [{ pagina: "A1'" }], "página antiga não é anexada à nova leitura");
  // Erro/recusa tardios da geração antiga também não apagam a leitura nova.
  for (const status of [0, 403, 500]) assert.deepEqual(anexada(g, nA, erro(status)), g, `erro ${status} tardio descartado`);
  // A página 1 de B, chegando depois, também é descartada.
  assert.deepEqual(primeira(g, nA + 1, ok("B1")), g, "página 1 de B tardia descartada");
  // Na geração vigente, recusa SUBSTITUI tudo; "Tentar novamente" abre outra geração na mesma URL.
  const recusada = anexada(anexar(g, nNova), nNova, erro(403));
  assert.deepEqual([recusada.paginas, recusada.falha?.status], [[], 403], "recusa vigente limpa os dados anteriores");
  const repetida = nova(recusada, recusada.base);
  assert.deepEqual([repetida.n, repetida.base, repetida.falha, repetida.paginas], [nNova + 1, "A", null, []]);
  assert.deepEqual([0, 500, 502, 503, 400, 403, 404].map((s) => podeRepetir({ status: s, codigo: null, mensagem: "" })), [true, true, true, false, false, false, false], "Tentar novamente só nas falhas recuperáveis");
});
