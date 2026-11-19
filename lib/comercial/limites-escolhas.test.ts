import { carregarModulo } from '../acessos/teste-carregador.ts';
import test from "node:test";
import assert from "node:assert/strict";
import { erroLimitesEscolhas, faltaEscolha, fraseEscolhas } from "./limites-escolhas.ts";

test("frase do editor e do cliente para as três regras", () => {
  assert.equal(fraseEscolhas(5, 5), "Escolha 5");
  assert.equal(fraseEscolhas(8, 10), "Escolha de 8 a 10");
  assert.equal(fraseEscolhas(0, 3), "Escolha até 3");
  assert.equal(erroLimitesEscolhas(0, 30), null);
  for (const [min, max] of [[0, 0], [3, 2], [0, 31], [0.5, 1], [-1, 3]]) assert.ok(erroLimitesEscolhas(min, max));
});
test("considera também a categoria obrigatória ausente das escolhas", () => {
  const regras = [{ codigo: "DOCES", nome: "Doces", min: 1, max: 2 }];
  assert.equal(faltaEscolha(regras, {}), "Doces: Escolha de 1 a 2.");
  assert.equal(faltaEscolha(regras, { DOCES: ["brigadeiro"] }), null);
});

test("POST do editor encaminha mínimo e máximo pelo salvarPacoteComercial até a composição", async () => {
  const empresa = "11111111-1111-4111-8111-111111111111";
  const categoriaId = "22222222-2222-4222-8222-222222222222";
  const pacote = { id: "33333333-3333-4333-8333-333333333333" };
  const recebidos: unknown[] = [];
  const rota = carregarModulo("app/api/admin/configuracoes/pacotes/route.ts", {
    "lib/http/admin-crm-api": { exigirApiAdminCrmDisponivel: async () => ({ usuario_id: empresa }) },
    "lib/http/api-response": { jsonNoStore: Response.json, apiErrorResponse: (erro: Error) => { throw erro; } },
    "lib/saas/provar-tenant": { exigirGestaoNoTenant() {}, withTenantTransaction: async (_sessao: unknown, _empresa: unknown, executar: (tx: object, tenant: object) => unknown) => executar({}, { empresaComprovada: empresa }) },
    "lib/agenda/configuracao-unidade": { definirSaloesPacote() {} },
    "lib/agenda/trava-configuracao": { travarConfiguracaoAgenda() {} },
    "lib/disponibilidade/repositories/disponibilidade.repository": {},
    "lib/comercial/pacote-precos": { gravarFaixasPacote: () => ({ aviso: null }) },
    "lib/comercial/pacotes-admin": {
      criarPacoteAdmin: () => pacote, definirDisponibilidadePacoteAdmin() {}, definirItensEspecificosPacoteAdmin() {},
      definirCategoriasPacoteAdmin: (_tx: unknown, id: string, categorias: unknown) => { assert.equal(id, pacote.id); recebidos.push(categorias); return pacote; },
    },
  }) as { POST: (request: Request) => Promise<Response> };
  const categorias = [{ categoriaId, escolhas: 8, escolhasMin: 5 }];
  const corpo = { acao: "salvar", empresaId: empresa, nome: "Pacote", descricao: null, duracaoMinutos: 180, convidadosMinimos: 20, convidadosMaximos: 40, disponibilidade: [], faixas: null, categorias };
  const resposta = await rota.POST(new Request("https://buffet.test/api/admin/configuracoes/pacotes", { method: "POST", body: JSON.stringify(corpo) }));
  assert.equal(resposta.status, 201);
  assert.deepEqual(recebidos, [categorias]);
});
