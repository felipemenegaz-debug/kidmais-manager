import test from "node:test";
import assert from "node:assert/strict";
import { carregarModulo } from "../acessos/teste-carregador.ts";

/**
 * S-C (convidados primeiro): o parâmetro `convidados` das leituras públicas. Ausente = resposta de antes; inválido = 400
 * sem consultar nada; válido chega ao serviço (disponibilidade) ou vira `comporta` por pacote (lista, sem filtrar).
 */
const EMPRESA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KIDMAIS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INVALIDOS = ["0", "1001", "abc", "8.5", "-1", ""];

type Resposta = { body: Record<string, unknown>; status: number };

function disponibilidade(combinados = false) {
  const consultas: Array<{ tipo: string; opcoes: Record<string, unknown> }> = [];
  const resultado = { data: "2026-11-14", periodos: [{ configuracaoId: "c", codigo: "TURNO_1", nome: "Tarde", horarioInicioPadrao: "15:00", horarioFimPadrao: "19:00", status: "DISPONIVEL", horarios: [], capacidade: { opcoes: 1, motivo: "OK" } }] };
  const dubles = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    "lib/db/postgres": { db: () => ({ query: async () => ({ rows: [] }) }) },
    "lib/http/limite-publico": { limitarPublico: async () => null },
    "lib/disponibilidade/escopo": { escopoPublico: async () => ({ empresaId: KIDMAIS, estabelecimentoId: null }) },
    "lib/agenda/combinados-publicos": { combinadosPublicos: async () => combinados },
    "lib/comercial/cotacao-publica": {
      codigoEmpresaDoPedido: (url: URL) => url.searchParams.get("empresa") || null,
      escopoCotacaoPublica: async () => ({ empresaId: EMPRESA_A, estabelecimentoId: null }),
    },
    "lib/disponibilidade/services": {
      duracaoAceita: () => null,
      isAvailabilityServiceError: () => false,
      consultarDisponibilidadeData: async (_d: string, _db: unknown, _x: unknown, _e: unknown, opcoes: Record<string, unknown>) => (consultas.push({ tipo: "data", opcoes }), resultado),
      consultarDisponibilidadePeriodo: async (_i: string, _f: string, _db: unknown, _x: unknown, _e: unknown, opcoes: Record<string, unknown>) => (consultas.push({ tipo: "periodo", opcoes }), [resultado]),
    },
  };
  const { GET } = carregarModulo("app/api/disponibilidade/route.ts", dubles, new Map()) as { GET: (r: unknown) => Promise<Resposta> };
  const chamar = (consulta: string) => GET({ url: `http://localhost/api/disponibilidade${consulta}`, nextUrl: new URL(`http://localhost/api/disponibilidade${consulta}`) });
  return { chamar, consultas };
}

test("S-C: /api/disponibilidade — convidados ausente = de antes; válido chega às duas consultas; inválido = 400 sem consulta", async () => {
  const r = disponibilidade();
  const antes = await r.chamar("?data=2026-11-14");
  assert.equal(antes.status, 200);
  assert.equal("convidados" in r.consultas[0].opcoes, false, "sem o parâmetro, nada novo vai ao serviço");
  assert.equal((await r.chamar("?data=2026-11-14&convidados=80")).status, 200);
  assert.equal(r.consultas.at(-1)!.opcoes.convidados, 80);
  assert.equal((await r.chamar("?inicio=2026-11-01&fim=2026-11-30&convidados=1000&empresa=buffet-a")).status, 200);
  assert.deepEqual([r.consultas.at(-1)!.tipo, r.consultas.at(-1)!.opcoes.convidados], ["periodo", 1000]);
  const total = r.consultas.length;
  for (const invalido of INVALIDOS) {
    const resposta = await r.chamar(`?data=2026-11-14&convidados=${encodeURIComponent(invalido)}`);
    assert.equal(resposta.status, 400, invalido);
    assert.equal(resposta.body.codigo, "PARAMETROS_INVALIDOS");
  }
  assert.equal(r.consultas.length, total, "nenhuma consulta com parâmetro inválido");
});

test("E2b: /api/disponibilidade — com combinadosPublicos as duas consultas levam incluirCombinados; desligado, as opções de antes", async () => {
  const ligado = disponibilidade(true);
  await ligado.chamar("?data=2026-11-14&convidados=80");
  await ligado.chamar("?inicio=2026-11-01&fim=2026-11-30");
  assert.deepEqual(ligado.consultas.map((c) => [c.tipo, c.opcoes.incluirCombinados]), [["data", true], ["periodo", true]]);
  const desligado = disponibilidade(false);
  await desligado.chamar("?data=2026-11-14&convidados=80");
  assert.equal("incluirCombinados" in desligado.consultas[0].opcoes, false);
});

test("S-C: a disponibilidade pública não leva ids nem nomes de salão (só contagens e motivo)", async () => {
  const fonte = (await import("node:fs")).readFileSync("lib/disponibilidade/services/availability.service.ts", "utf8");
  const tipo = (await import("node:fs")).readFileSync("lib/disponibilidade/services/models.ts", "utf8");
  assert.match(tipo, /export type CapacidadeConvidadosPublica = \{ opcoes: number; motivo: MotivoCapacidade \}/);
  // O que sai por candidato/período/dia é só o retorno de capacidadeDoCandidato/motivoAgregado (números e motivo).
  assert.match(fonte, /\.\.\.\(capacidade \? \{ capacidade \} : \{\}\)/);
  assert.doesNotMatch(fonte, /capacidade: \{[^}]*salao/i);
});

function pacotes() {
  const pocket = (empresaId: string) => ({ id: `p-${empresaId}`, codigo: "POCKET", nome: "Pocket", descricao: null, duracaoMinutos: 180, convidadosMinimos: 20, convidadosMaximos: 60 });
  const livre = { id: "p-livre", codigo: "P_LIVRE", nome: "Livre", descricao: null, duracaoMinutos: null, convidadosMinimos: null, convidadosMaximos: null };
  let escopos = 0;
  const repositorios = {
    buscarPacoteVigenteDaEmpresaPorCodigo: async (empresaId: string, codigo: string) => (codigo === "POCKET" ? pocket(empresaId) : null),
    listarPacotesContrataveisDaEmpresa: async (empresaId: string) => [pocket(empresaId), livre],
  };
  const dubles = {
    // E2b: o catálogo efetivo do endereço vem de lib/comercial/oferta-publica, que importa o repositório pelo arquivo.
    "lib/comercial/repositories/comercial.repository": repositorios,
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    "lib/db/postgres": { db: () => ({ query: async () => ({ rows: [] }) }) },
    "lib/http/limite-publico": { limitarPublico: async () => null },
    "lib/http/api-response": { apiErrorResponse: () => ({ body: {}, status: 500 }) },
    "lib/comercial/cotacao-publica": {
      codigoEmpresaDoPedido: (url: URL) => url.searchParams.get("empresa") || null,
      escopoCotacaoPublica: async (_db: unknown, codigo: string | null) => (escopos++, { empresaId: codigo ? EMPRESA_A : KIDMAIS }),
    },
    "lib/comercial/repositories": repositorios,
    "lib/comercial/pacote-precos": { lerPrecosCorrentes: async () => ({ pacotes: [] }) },
    "lib/comercial/regras-pagamento": { lerRegrasPagamento: async () => null },
    "lib/comercial/disponibilidade-pacote-publica": { lerRegrasDisponibilidadePacote: async () => [] },
  };
  const { GET } = carregarModulo("app/api/fechamentos/pacotes/route.ts", dubles, new Map()) as { GET: (r: unknown) => Promise<Resposta> };
  const chamar = (consulta: string) => GET({ nextUrl: new URL(`http://localhost/api/fechamentos/pacotes${consulta}`) });
  return { chamar, escopos: () => escopos };
}

test("S-C: /api/fechamentos/pacotes — comporta por pacote, sem filtrar; ausente = sem o campo; inválido = 400", async () => {
  const r = pacotes();
  type Lista = Array<Record<string, unknown>>;
  const antes = (await r.chamar("?empresa=buffet-a")).body.pacotes as Lista;
  assert.equal(antes.length, 2);
  assert.equal(antes.some((p) => "comporta" in p), false, "sem convidados, a resposta de antes");
  const com = (await r.chamar("?empresa=buffet-a&convidados=80")).body.pacotes as Lista;
  assert.deepEqual(com.map((p) => [p.codigo, p.comporta]), [["POCKET", false], ["P_LIVRE", true]], "lista inteira; limites nulos abertos");
  const dentro = (await r.chamar("?empresa=buffet-a&convidados=60")).body.pacotes as Lista;
  assert.equal(dentro[0].comporta, true, "igual ao máximo comporta");
  const dona = (await r.chamar("?convidados=10")).body.pacotes as Lista;
  assert.deepEqual(dona.map((p) => p.comporta), [false], "endereço atual: abaixo do mínimo");
  const escoposAntes = r.escopos();
  for (const invalido of INVALIDOS) {
    const resposta = await r.chamar(`?empresa=buffet-a&convidados=${encodeURIComponent(invalido)}`);
    assert.equal(resposta.status, 400, invalido);
  }
  assert.equal(r.escopos(), escoposAntes, "inválido recusa antes do escopo (sem banco)");
});
