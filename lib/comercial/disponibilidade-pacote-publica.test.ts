import test from "node:test";
import assert from "node:assert/strict";
import { lerRegrasDisponibilidadePacote, pacotesDaAgendaDaEmpresa, regrasDosPacotesDaEmpresa, regrasPublicasDoPacote } from "./disponibilidade-pacote-publica.ts";
import { PACOTES_CONTRATAVEIS_V1 } from "./pacotes-v1.ts";
import { regrasDisponibilidadeDaTela, type FatosPacote } from "../../components/fechamento/pacotes-tela.ts";
import { CONFIG_VAZIA, regraPadraoPacote, statusDataPacote } from "../agenda/disponibilidade.ts";
import { carregarModulo, executorFalso } from "../acessos/teste-carregador.ts";
import type { DbExecutor } from "../db/contracts.ts";

const EMPRESA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMPRESA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KIDMAIS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const POCKET_A = "11111111-1111-4111-8111-111111111111";
const POCKET_B = "22222222-2222-4222-8222-222222222222";
const POCKET_K = "33333333-3333-4333-8333-333333333333";
const LIVRE_A = "44444444-4444-4444-8444-444444444444";
const CODIGO_LIVRE = "P_9F2C4E1A7B3D4C5E8F6A0B1C2D3E4F5A";

const linha = (dia_semana: number, codigo: string, estado = "DISPONIVEL", vigencia_inicio = "2026-01-01", vigencia_fim: string | null = null) =>
  ({ dia_semana, codigo, estado: estado as "DISPONIVEL", vigencia_inicio, vigencia_fim });

test("regras públicas: TURNO_1 = almoço, TURNO_2 = noite; período desconhecido fica de fora (sem regra = indisponível)", () => {
  assert.deepEqual(regrasPublicasDoPacote([linha(6, "TURNO_1"), linha(6, "TURNO_2", "SOB_CONSULTA", "2026-02-01", "2026-12-31"), linha(6, "TURNO_X")]), [
    { dia: 6, horario: "almoco", estado: "DISPONIVEL", vigenciaInicio: "2026-01-01", vigenciaFim: null },
    { dia: 6, horario: "noite", estado: "SOB_CONSULTA", vigenciaInicio: "2026-02-01", vigenciaFim: "2026-12-31" },
  ]);
});

test("2c-1: com o id do horário configurado, HORARIO_n entra (legado vazio) e a tela casa pelo configuracaoId", () => {
  const T1 = "44444444-4444-4444-8444-444444444444";
  const H3 = "55555555-5555-4555-8555-555555555555";
  const regras = regrasPublicasDoPacote([
    { ...linha(6, "TURNO_1"), configuracao_id: T1 },
    { ...linha(6, "HORARIO_3", "SOB_CONSULTA"), configuracao_id: H3 },
  ]);
  assert.deepEqual(regras, [
    { dia: 6, horario: "almoco", configuracaoId: T1, estado: "DISPONIVEL", vigenciaInicio: "2026-01-01", vigenciaFim: null },
    { dia: 6, horario: "", configuracaoId: H3, estado: "SOB_CONSULTA", vigenciaInicio: "2026-01-01", vigenciaFim: null },
  ]);
  const SABADO = "2026-11-14";
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "", regras, H3).status, "consulta");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "almoco", regras, T1).status, "disponivel");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "almoco", regras).status, "disponivel", "sem id: legado almoco");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "", regras).status, "indisponivel", "sem id e sem legado: nada casa");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "", regras, "66666666-6666-4666-8666-666666666666").status, "indisponivel");
});

test("leitura das regras: só o pacote pedido, só regras ativas e não expiradas; nenhum dado além de dia/período/estado/vigência", async () => {
  const banco = executorFalso([[/FROM regras_disponibilidade_pacote/, () => [linha(6, "TURNO_1")]]]);
  const regras = await lerRegrasDisponibilidadePacote(banco as unknown as DbExecutor, POCKET_A);
  assert.equal(regras.length, 1);
  const [{ sql, params }] = banco.executados;
  assert.deepEqual(params, [POCKET_A]);
  assert.match(sql, /WHERE r\.pacote_id = \$1::uuid/);
  assert.match(sql, /AND r\.ativo/);
  assert.match(sql, /vigencia_fim IS NULL OR r\.vigencia_fim >= CURRENT_DATE/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.deepEqual(Object.keys(regras[0]).sort(), ["dia", "estado", "horario", "vigenciaFim", "vigenciaInicio"]);
});

test("tela: Kidmais = null (regra legada); empresa = só as regras do próprio pacote dela, pelo código; pacote não oferecido = []", () => {
  const fatos: FatosPacote = {
    POCKET: { nome: "Pocket A", descricao: null, duracaoMinutos: null, convidadosMinimos: 20, convidadosMaximos: 30, precoMinimo: "1500.00",
      disponibilidade: regrasPublicasDoPacote([linha(6, "TURNO_1")]) },
  };
  assert.equal(regrasDisponibilidadeDaTela(true, fatos, "pocket"), null);
  assert.deepEqual(regrasDisponibilidadeDaTela(false, fatos, "POCKET"), fatos.POCKET.disponibilidade);
  assert.deepEqual(regrasDisponibilidadeDaTela(false, fatos, "MINI_FESTA"), [], "pacote que a empresa não oferece");
  assert.deepEqual(regrasDisponibilidadeDaTela(false, fatos, "pocket"), [], "em /b o id da tela é o código; id V1 não é traduzido");
  assert.deepEqual(regrasDisponibilidadeDaTela(false, null, "POCKET"), [], "antes da resposta: nada liberado pela regra");
  assert.deepEqual(regrasDisponibilidadeDaTela(false, { POCKET: { ...fatos.POCKET, disponibilidade: undefined } }, "POCKET"), []);
});

// ---- Rota /api/fechamentos/pacotes com dublês: escopo, repositórios e banco falsos; a leitura das regras é a real.
function rota(empresas: Record<string, string>, pacotes: Record<string, string>, regras: Record<string, ReturnType<typeof linha>[]>, livres: Record<string, Array<{ id: string; codigo: string; nome: string }>> = {}) {
  const pedidosDeRegra: unknown[][] = [];
  const pacotesPedidos: Array<[string, string]> = [];
  const listasPedidas: string[] = [];
  const pocketDe = (empresaId: string) => {
    const id = pacotes[empresaId];
    return id ? { id, codigo: "POCKET", nome: `Pocket ${empresaId.slice(0, 1)}`, descricao: null, duracaoMinutos: null, convidadosMinimos: 20, convidadosMaximos: 30 } : null;
  };
  const banco = {
    async query(sql: string, params: unknown[] = []) {
      if (/FROM regras_disponibilidade_pacote/.test(sql)) { pedidosDeRegra.push(params); return { rows: regras[String(params[0])] ?? [], rowCount: 0 }; }
      return { rows: [], rowCount: 0 };
    },
  };
  const dubles = {
    "next/server": { NextResponse: { json: (body: unknown) => ({ body }) } },
    "lib/db/postgres": { db: () => banco },
    "lib/http/limite-publico": { limitarPublico: () => null },
    "lib/http/api-response": { apiErrorResponse: (error: unknown) => { throw error; } },
    "lib/comercial/cotacao-publica": {
      codigoEmpresaDoPedido: (url: URL) => url.searchParams.get("empresa") || null,
      escopoCotacaoPublica: async (_db: unknown, codigo: string | null) => ({ empresaId: codigo ? empresas[codigo] : KIDMAIS }),
    },
    "lib/comercial/repositories": {
      buscarPacoteVigenteDaEmpresaPorCodigo: async (empresaId: string, codigo: string) => {
        pacotesPedidos.push([empresaId, codigo]);
        return codigo === "POCKET" ? pocketDe(empresaId) : null;
      },
      listarPacotesContrataveisDaEmpresa: async (empresaId: string) => {
        listasPedidas.push(empresaId);
        const pocket = pocketDe(empresaId);
        const extras = (livres[empresaId] ?? []).map((p) => ({ ...p, descricao: null, duracaoMinutos: null, convidadosMinimos: null, convidadosMaximos: null }));
        return [...(pocket ? [pocket] : []), ...extras];
      },
    },
    "lib/comercial/pacote-precos": { lerPrecosCorrentes: async () => ({ pacotes: [] }) },
    "lib/comercial/regras-pagamento": { lerRegrasPagamento: async () => null },
  };
  const { GET } = carregarModulo("app/api/fechamentos/pacotes/route.ts", dubles, new Map()) as { GET: (r: unknown) => Promise<{ body: { pacotes: Array<Record<string, unknown>> } }> };
  const chamar = (consulta: string) => GET({ nextUrl: new URL(`http://localhost/api/fechamentos/pacotes${consulta}`) });
  return { chamar, pedidosDeRegra, pacotesPedidos, listasPedidas };
}

test("rota: cada empresa recebe só as regras do POCKET dela; o mesmo código em duas empresas não se mistura", async () => {
  const r = rota({ "buffet-a": EMPRESA_A, "buffet-b": EMPRESA_B }, { [EMPRESA_A]: POCKET_A, [EMPRESA_B]: POCKET_B, [KIDMAIS]: POCKET_K },
    { [POCKET_A]: [1, 2, 3, 4, 5, 6, 7].map((dia) => linha(dia, "TURNO_1")), [POCKET_B]: [linha(3, "TURNO_1")] });
  const a = (await r.chamar("?empresa=buffet-a")).body.pacotes;
  const b = (await r.chamar("?empresa=buffet-b")).body.pacotes;
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal((a[0].disponibilidade as unknown[]).length, 7);
  assert.deepEqual(b[0].disponibilidade, regrasPublicasDoPacote([linha(3, "TURNO_1")]));
  assert.deepEqual(r.pedidosDeRegra, [[POCKET_A], [POCKET_B]], "regras lidas só pelo id do pacote da empresa do endereço");
  assert.deepEqual(r.listasPedidas, [EMPRESA_A, EMPRESA_B], "lista só da empresa do endereço");
  assert.deepEqual(r.pacotesPedidos, [], "endereço da empresa: lista dela, não a busca dos sete códigos");
  // O caso encontrado, de ponta a ponta na tela: sábado no almoço. Em /b o id da tela é o código do pacote.
  const fatos = (pacotes: Array<Record<string, unknown>>) => Object.fromEntries(pacotes.map((p) => [p.codigo, p])) as FatosPacote;
  assert.equal(statusDataPacote(CONFIG_VAZIA, "POCKET", "2026-11-14", "almoco", regrasDisponibilidadeDaTela(false, fatos(a), "POCKET")).status, "disponivel");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "POCKET", "2026-11-14", "almoco", regrasDisponibilidadeDaTela(false, fatos(b), "POCKET")).status, "indisponivel",
    "B só liberou quarta: o sábado de A não vale para B");
});

test("rota: pacote criado em Novo pacote (P_…) aparece em /b com as regras dele, na ordem da empresa; não vaza para outra", async () => {
  const r = rota({ "buffet-a": EMPRESA_A, "buffet-b": EMPRESA_B }, { [EMPRESA_A]: POCKET_A }, {
    [POCKET_A]: [linha(1, "TURNO_1")], [LIVRE_A]: [linha(6, "TURNO_2")],
  }, { [EMPRESA_A]: [{ id: LIVRE_A, codigo: CODIGO_LIVRE, nome: "Festa Jardim" }] });
  const a = (await r.chamar("?empresa=buffet-a")).body.pacotes;
  assert.deepEqual(a.map((p) => p.codigo), ["POCKET", CODIGO_LIVRE]);
  assert.equal(a[1].nome, "Festa Jardim");
  const fatos = Object.fromEntries(a.map((p) => [p.codigo, p])) as FatosPacote;
  assert.equal(statusDataPacote(CONFIG_VAZIA, CODIGO_LIVRE, "2026-11-14", "noite", regrasDisponibilidadeDaTela(false, fatos, CODIGO_LIVRE)).status, "disponivel");
  assert.equal(statusDataPacote(CONFIG_VAZIA, CODIGO_LIVRE, "2026-11-14", "almoco", regrasDisponibilidadeDaTela(false, fatos, CODIGO_LIVRE)).status, "indisponivel");
  const b = (await r.chamar("?empresa=buffet-b")).body.pacotes;
  assert.deepEqual(b, [], "buffet B não vê o pacote de A");
});

test("rota: endereço atual da Kidmais sem o campo e sem ler regras (comportamento legado)", async () => {
  const r = rota({}, { [KIDMAIS]: POCKET_K }, { [POCKET_K]: [linha(6, "TURNO_1")] });
  const legado = (await r.chamar("")).body.pacotes;
  assert.equal(legado.length, 1);
  assert.equal("disponibilidade" in legado[0], false);
  assert.deepEqual(r.pedidosDeRegra, []);
  assert.ok(r.pacotesPedidos.every(([empresa]) => empresa === KIDMAIS));
  assert.deepEqual(r.pacotesPedidos.map(([, codigo]) => codigo), PACOTES_CONTRATAVEIS_V1.map((p) => p.codigo), "dona: os sete, na ordem do catálogo");
  assert.deepEqual(r.listasPedidas, [], "dona: nunca a lista livre");
});

test("tela: toda decisão de disponibilidade do pacote no fechamento passa as regras da empresa (nenhuma chamada sem elas)", async () => {
  const { readFileSync } = await import("node:fs");
  const wizard = readFileSync("components/fechamento/FechamentoWizard.tsx", "utf8");
  const calendario = readFileSync("components/fechamento/CalendarioDisponibilidade.tsx", "utf8");
  const chamadas = (fonte: string) => [...fonte.matchAll(/statusDataPacote\(([^;]*?)\)[;,\s]/g)].map((m) => m[1].replace(/\s+/g, " "));
  const doWizard = chamadas(wizard);
  assert.equal(doWizard.length, 2);
  assert.ok(doWizard.every((c) => /, regrasDisponibilidadeDaTela\(marca\.kidmais, fatosPacote, (form\.pacote|novoPacote)$/.test(c.trim())), doWizard.join(" | "));
  assert.match(wizard, /regrasPacote=\{regrasDisponibilidadeDaTela\(marca\.kidmais, fatosPacote, form\.pacote\)\}/);
  const doCalendario = chamadas(calendario);
  assert.equal(doCalendario.length, 3);
  // 2c-1: depois das regras vem só o horário configurado (configuracaoId) da própria agenda.
  assert.ok(doCalendario.every((c) => /regrasPacote(, [\w.]+\.configuracaoId)?\s*$/.test(c.trim())), doCalendario.join(" | "));
});

// ---- Administração (AdminDisponibilidade): mesmas regras da cotação pública, só da empresa ativa; dona da agenda = legado.

function bancoDeRegras(regras: Record<string, ReturnType<typeof linha>[]>) {
  const pedidos: unknown[] = [];
  return { pedidos, banco: { async query(sql: string, params: unknown[] = []) {
    if (/FROM regras_disponibilidade_pacote/.test(sql)) { pedidos.push(params[0]); return { rows: regras[String(params[0])] ?? [], rowCount: 0 }; }
    return { rows: [], rowCount: 0 };
  } } as unknown as DbExecutor };
}

test("administração: regras de todos os pacotes da empresa ativa, pela mesma leitura; pacote que ela não oferece = []", async () => {
  const { banco, pedidos } = bancoDeRegras({ [POCKET_A]: [1, 2, 3, 4, 5, 6, 7].map((d) => linha(d, "TURNO_1")), [POCKET_B]: [linha(3, "TURNO_1")] });
  const listas: string[] = [];
  const listar = async (empresaId: string) => {
    listas.push(empresaId);
    return [{ id: empresaId === EMPRESA_A ? POCKET_A : POCKET_B, codigo: "POCKET" }];
  };
  const deA = await regrasDosPacotesDaEmpresa(banco, EMPRESA_A, listar);
  assert.deepEqual(Object.keys(deA), ["POCKET"], "por código do pacote, só os que a empresa tem");
  assert.equal(deA.POCKET.length, 7);
  assert.deepEqual(listas, [EMPRESA_A], "só a empresa informada (comprovada pela sessão)");
  assert.deepEqual(pedidos, [POCKET_A]);
  const deB = await regrasDosPacotesDaEmpresa(banco, EMPRESA_B, listar);
  assert.deepEqual(deB.POCKET, regrasPublicasDoPacote([linha(3, "TURNO_1")]), "mesmo código, regras da outra empresa não vazam");
});

test("administração: empresa nova sem pacote não herda o catálogo Kidmais no seletor; lista só os pacotes dela, com o nome dela", async () => {
  const { banco } = bancoDeRegras({ [POCKET_A]: [linha(1, "TURNO_1")] });
  const nova = await pacotesDaAgendaDaEmpresa(banco, EMPRESA_B, async () => []);
  assert.deepEqual(nova.pacotes, [], "buffet novo: nenhum pacote");
  assert.deepEqual(nova.regras, {});
  const comPocket = await pacotesDaAgendaDaEmpresa(banco, EMPRESA_A, async () => [{ id: POCKET_A, codigo: "POCKET", nome: "Festinha do Buffet A" }]);
  assert.deepEqual(comPocket.pacotes, [{ id: "POCKET", nome: "Festinha do Buffet A", convidadosMinimos: null, convidadosMaximos: null }]);
  assert.equal(comPocket.regras.POCKET.length, 1);
  const semNome = await pacotesDaAgendaDaEmpresa(banco, EMPRESA_A, async () => [{ id: POCKET_A, codigo: "POCKET" }]);
  assert.deepEqual(semNome.pacotes, [{ id: "POCKET", nome: "POCKET", convidadosMinimos: null, convidadosMaximos: null }], "sem nome: o código, nunca o nome do catálogo Kidmais");
  // Pacote criado do zero ("Novo pacote", P_…): entra no seletor e nas regras, na ordem da lista da empresa.
  const { banco: bancoLivre } = bancoDeRegras({ [LIVRE_A]: [linha(6, "TURNO_2")] });
  const comLivre = await pacotesDaAgendaDaEmpresa(bancoLivre, EMPRESA_A, async () => [
    { id: POCKET_A, codigo: "POCKET", nome: "Pocket" }, { id: LIVRE_A, codigo: CODIGO_LIVRE, nome: "Festa Jardim", convidadosMinimos: 30, convidadosMaximos: 80 }]);
  assert.deepEqual(comLivre.pacotes, [{ id: "POCKET", nome: "Pocket", convidadosMinimos: null, convidadosMaximos: null }, { id: CODIGO_LIVRE, nome: "Festa Jardim", convidadosMinimos: 30, convidadosMaximos: 80 }], "limites de convidados de cada pacote (wizard do fechamento administrativo)");
  assert.deepEqual(comLivre.regras[CODIGO_LIVRE], regrasPublicasDoPacote([linha(6, "TURNO_2")]));
  const tela = (await import("node:fs")).readFileSync("components/admin/AdminDisponibilidade.tsx", "utf8");
  assert.match(tela, /pacotes: admin\.regrasPacotes \? \(admin\.pacotes \?\? \[\]\) : null/);
  assert.match(tela, /const opcoesPacote = pacotesEmpresa \?\? PACOTES;/);
  assert.match(tela, /opcoesPacote\.map\(\(p\) => <option/);
  assert.doesNotMatch(tela, /\{PACOTES\.map\(/, "o seletor não lista o catálogo fixo diretamente");
  assert.equal((tela.match(/aplicarPacotesEmpresa\(dados\.pacotes\);/g) ?? []).length, 2, "carga inicial e recarga");
});

test("coerência administração = cotação pública: mesmas regras e mesmo status em 5 semanas × 2 períodos × 7 pacotes", async () => {
  const regrasA = { [POCKET_A]: [1, 2, 3, 4, 5].map((d) => linha(d, "TURNO_1")).concat([linha(6, "TURNO_2", "SOB_CONSULTA")]) };
  const r = rota({ "buffet-a": EMPRESA_A }, { [EMPRESA_A]: POCKET_A }, regrasA);
  const publico = Object.fromEntries((await r.chamar("?empresa=buffet-a")).body.pacotes.map((p) => [p.codigo, p])) as FatosPacote;
  const { banco } = bancoDeRegras(regrasA);
  const admin = await regrasDosPacotesDaEmpresa(banco, EMPRESA_A, async () => [{ id: POCKET_A, codigo: "POCKET" }]);
  const divergencias: string[] = [];
  // Mesmo id (código) dos dois lados; códigos que a empresa não tem: [] dos dois lados.
  for (const id of ["POCKET", ...PACOTES_CONTRATAVEIS_V1.map((p) => p.codigo).filter((c) => c !== "POCKET"), CODIGO_LIVRE]) {
    const daTela = regrasDisponibilidadeDaTela(false, publico, id);
    assert.deepEqual(admin[id] ?? [], daTela, id);
    for (let i = 0; i < 35; i++) {
      const data = new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
      for (const h of ["almoco", "noite"] as const) {
        const a = statusDataPacote(CONFIG_VAZIA, id, data, h, admin[id] ?? []).status;
        const p = statusDataPacote(CONFIG_VAZIA, id, data, h, daTela).status;
        if (a !== p) divergencias.push(`${id} ${data} ${h}`);
      }
    }
  }
  assert.deepEqual(divergencias, []);
});

test("administração: dona da agenda pública mantém a regra legada (null); demais empresas recebem as regras delas", async () => {
  const { readFileSync } = await import("node:fs");
  const rota = readFileSync("app/api/admin/disponibilidade/route.ts", "utf8");
  assert.match(rota, /const daEmpresa = configuracaoComercial\s*\?\s*null\s*:\s*await pacotesDaAgendaDaEmpresa\(tx, empresaComprovada, listarPacotesContrataveisDaEmpresa\);/);
  assert.match(rota, /const regrasPacotes = daEmpresa \? daEmpresa\.regras : null;/);
  assert.match(rota, /const pacotes = daEmpresa \? daEmpresa\.pacotes : null;/);
  assert.match(rota, /configuracaoComercial,\s*regrasPacotes,\s*pacotes,[\s\S]{0,260}?telaDoCliente:[^\n]*\n\s*bloqueios,/);
  assert.doesNotMatch(rota, /(regrasDosPacotesDaEmpresa|pacotesDaAgendaDaEmpresa)\(tx, (q\.|body|alvo|request)/, "empresa só da sessão comprovada");
  const tela = readFileSync("components/admin/AdminDisponibilidade.tsx", "utf8");
  assert.match(tela, /regrasPacotes: admin\.regrasPacotes \?\? null/);
  assert.match(tela, /const regrasDoPacote = regrasPacotes \? \(regrasPacotes\[pacote\] \?\? \[\]\) : null;/);
  const chamadas = [...tela.matchAll(/statusDataPacote\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(chamadas.length, 2);
  // 2c-1: depois das regras vem só o horário configurado em foco (idHorario).
  assert.ok(chamadas.every((c) => /, regrasDoPacote(, idHorario)?$/.test(c.trim())), chamadas.join(" | "));
  assert.equal((tela.match(/setRegrasPacotes\(dados\.regrasPacotes\);/g) ?? []).length, 2, "carga inicial e recarga");
  // Com null, o status é exatamente o legado (mesmos casos da regra fixa).
  for (const [id, data, h] of [["pocket", "2026-11-14", "almoco"], ["compacta", "2026-11-14", "noite"], ["mini", "2026-11-13", "noite"], ["pizza_party_scienza", "2026-11-18", "almoco"]] as const)
    assert.equal(statusDataPacote(CONFIG_VAZIA, id, data, h, null).status, regraPadraoPacote(id, data, h));
});

test("servidor e leitura pública usam a mesma regra de escolha (ativa, dia ISO, período, maior início de vigência)", async () => {
  const { readFileSync } = await import("node:fs");
  const repo = readFileSync("lib/comercial/repositories/comercial.repository.ts", "utf8");
  const servidor = repo.slice(repo.indexOf("export async function buscarElegibilidadePacoteAplicavel"), repo.indexOf("export async function listarPacotesAtivosComElegibilidade"));
  assert.match(servidor, /WHERE ativo = true/);
  assert.match(servidor, /dia_semana = EXTRACT\(ISODOW FROM \$2::date\)/);
  assert.match(servidor, /ORDER BY vigencia_inicio DESC\s+LIMIT 1/);
  const leitura = readFileSync("lib/comercial/disponibilidade-pacote-publica.ts", "utf8");
  assert.match(leitura, /AND r\.ativo/);
  const tela = readFileSync("lib/agenda/disponibilidade.ts", "utf8");
  assert.match(tela, /diaSemanaUTC\(dataIso\) \|\| 7/, "dia ISO (domingo = 7)");
  assert.match(tela, /sort\(\(a, b\) => b\.vigenciaInicio\.localeCompare\(a\.vigenciaInicio\)\)\[0\]/, "maior início de vigência");
});
