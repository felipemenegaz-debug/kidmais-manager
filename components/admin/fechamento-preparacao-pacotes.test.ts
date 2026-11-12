import assert from "node:assert/strict";
import test from "node:test";
import { formularioPreparado, preparacaoValida } from "./fechamento-preparacao.ts";

/** Fase 1d: a preparação do Kidmais pode trazer o código do pacote da empresa (P_…); formato fora disso ⇒ sem preparação. */
const referencia = { operacaoId: "11111111-1111-4111-8111-111111111111", versao: 1, payloadHash: "a".repeat(64) };
const recebida = (pacote: unknown) => ({
  disponivel: true, referencia, expiraEm: "2098-01-01T00:00:00Z", pendencias: [],
  campos: { pacote, convidadosPagantes: 40, dataFesta: "2098-12-12", horarioBase: "almoco", aniversarianteId: null, idadeAniversariante: null, temaFesta: null, horarioDesejado: null },
});

test("preparação do Kidmais: id V1 (dona) e código do pacote da empresa (P_…) aceitos; outros formatos descartam a preparação", () => {
  for (const pacote of ["premium", "pizza_party_scienza", "POCKET", "P_9F2C4E1A7B3D4C5E8F6A0B1C2D3E4F5A"]) {
    const p = preparacaoValida(recebida(pacote));
    assert.ok(p && p.disponivel, pacote);
    assert.equal(formularioPreparado({ pacote: "pocket" } as never, p as never).form.pacote, pacote);
  }
  for (const pacote of ["festa jardim", "p_minusculo", "", 42, null, "A".repeat(51)]) assert.equal(preparacaoValida(recebida(pacote)), null, String(pacote));
});
