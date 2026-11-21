import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import { FUNCOES_COMBINADOS, HASHES_COMBINADOS } from "../agenda/estado-combinados.ts";
import type { DbExecutor } from "../db/contracts.ts";
import type { HorarioCandidatoPublico } from "./services/models.ts";

const empresaId = "11111111-1111-4111-8111-111111111111";
const unidadeId = "22222222-2222-4222-8222-222222222222";
const turnoId = "33333333-3333-4333-8333-333333333333";
const salaoId = "44444444-4444-4444-8444-444444444444";
const inicio = "2026-11-01";
const fim = "2026-12-31";
const sabado = "2026-11-07";
const convidados = 30;
const override = { data: sabado, horario: "noite", pacote: "pocket", status: "consulta" };
const desconto = { data: sabado, horario: "noite", pacote: "pocket", percentual: 10, titulo: "Oferta" };

function executorInstrumentado(comCapacidade: boolean, antesDeResponder?: (sql: string) => Promise<void> | undefined) {
  const consultas: Array<{ sql: string; params: readonly unknown[] }> = [];
  const respostas: Array<[RegExp, object[]]> = [
    [/kidmais062_ocupacoes_escopo.*AS instalada$/, [{ instalada: true }]],
    [/kidmais094_conflito_ocupacao.*AS ok$/, [{ ok: true }]],
    [/AS marcador114$/, [{ funcoes: Object.keys(FUNCOES_COMBINADOS).length, funcoes_qualquer: Object.keys(FUNCOES_COMBINADOS).length,
      combinado: true, membros: true, check_ok: true, gatilhos_ok: 6, gatilhos_qualquer: 6,
      conflito: HASHES_COMBINADOS.conflito108, contrato: HASHES_COMBINADOS.contrato,
      revisao: HASHES_COMBINADOS.revisao114, marcador: true, marcador114: true }]],
    [/FROM public\.empresas WHERE id = .*status = 'ATIVA'/, [{ ok: true }]],
    [/FROM public\.empresas WHERE codigo = .*status = 'ATIVA'/, [{ id: empresaId }]],
    [/kidmais062_unidade_agendavel/, [{ id: unidadeId, codigo: "unidade", nome: "Unidade" }]],
    [/AS instalado074$/, [{ instalado074: comCapacidade }]],
    [/FROM assinatura_isencoes WHERE/, [{ isenta: false }]],
    [/JOIN assinatura_contratacoes/, [{ plano: "premium" }]],
    [/to_char\(clock_timestamp\(\)/, [{ agora: "2026-11-01T12:00:00.000Z" }]],
    [/to_regclass\('public\.empresa_assinaturas'\)/, [{ ok: comCapacidade }]],
    [/FROM empresa_assinaturas WHERE/, []],
    [/FROM empresa_excecoes_comerciais WHERE/, []],
    [/WITH candidatas AS/, [{ id: turnoId, codigo: "TURNO_2", nome: "Noite", horario_inicio_padrao: "17:00:00",
      horario_fim_padrao: "21:00:00", tolerancia_inicio_minutos: 0, passo_inicio_minutos: 30, ordem_exibicao: 1, ativo: true }]],
    [/FROM bloqueios_agenda/, []],
    [/FROM kidmais094_ocupacoes/, [{ fechamento_id: "ocupacao", data: fim, horario_inicio: "17:00:00",
      horario_fim: "21:00:00", configuracao_agenda_id: turnoId, salao_id: salaoId }]],
    [/FROM agenda_escopo_config/, comCapacidade
      ? [{ modo: "FIXO", capacidade_tipo: "POR_SALAO", limite_festas_dia: null, intervalo_minimo_minutos: 0 }] : []],
    [/LEFT JOIN configuracao_agenda_saloes/, [{ id: turnoId, capacidade: 1, saloes: [salaoId] }]],
    [/attname = 'convidados_minimo'/, [{ ok: true }]],
    [/FROM agenda_saloes\s+WHERE/, [{ id: salaoId, ativo: true, combinado: false, membros: null,
      ordem: 1, nome: "Salão", capacidade_convidados: 50, convidados_minimo: 20 }]],
    [/to_regclass\('public\.disponibilidade_config_legada'\)/, [{ ok: true }]],
    [/FROM disponibilidade_config_legada WHERE/, [{ conteudo: { pacoteOverrides: [{ ...override, motivo: "interno" }], descontos: [desconto] } }]],
    [/SELECT codigo FROM public\.empresas/, [{ codigo: "buffet-a" }]],
    [/FROM public\.regras_desconto_pacote/, [{ pacote: "POCKET", dia_semana: 6, percentual: "15", titulo: "Sábado",
      vigencia_inicio: inicio, vigencia_fim: null, configuracao_agenda_id: null, prioridade: 1 }]],
    [/LEFT JOIN regras_disponibilidade_pacote/, [{ pacote: "POCKET", minimo: 35, maximo: 50, codigo: "TURNO_2",
      configuracao_id: turnoId, datas_com_preco: [sabado], saloes: [salaoId],
      dia_semana: 6, estado: "DISPONIVEL", vigencia_inicio: inicio, vigencia_fim: null }]],
  ];
  const db: DbExecutor = {
    async query<Row extends object>(sql: string, params: readonly unknown[] = []) {
      consultas.push({ sql, params });
      const resposta = respostas.find(([padrao]) => padrao.test(sql));
      assert.ok(resposta, `Consulta não prevista: ${sql}`);
      await antesDeResponder?.(sql);
      return { rows: structuredClone(resposta[1]) as Row[], rowCount: resposta[1].length };
    },
  };
  return { db: () => db, consultas };
}

async function provarParalelismo<T>(executar: (antesDeResponder: (sql: string) => Promise<void> | undefined) => Promise<T>) {
  const leituras = [
    /^WITH candidatas AS/,
    /FROM bloqueios_agenda/,
    /FROM kidmais094_ocupacoes/,
  ];
  const iniciadas = new Set<RegExp>();
  const liberar = Promise.withResolvers<void>();
  const resultado = executar(sql => {
    const leitura = leituras.find(padrao => padrao.test(sql));
    if (!leitura) return;
    iniciadas.add(leitura);
    return liberar.promise;
  });
  // O executor resolve as sondagens em microtarefas. Mantemos as três leituras
  // pendentes até o próximo turno, quando todas já devem ter sido chamadas.
  await setImmediate();
  const antesDeLiberar = new Set(iniciadas);
  liberar.resolve();
  const resposta = await resultado;
  assert.deepEqual(antesDeLiberar, new Set(leituras), "configurações, bloqueios e ocupações devem iniciar em paralelo");
  return resposta;
}

function carregar(db: () => DbExecutor) {
  const dubles = {
    "lib/db/postgres": { db },
    "lib/http/limite-publico": { limitarPublico: async () => null },
    "next/server": { NextResponse: Response },
  };
  const cache = new Map();
  return (arquivo: string) => carregarModulo(arquivo, dubles, cache);
}

// Fluxo anterior para GET com intervalo e convidados: os resolvedores e o serviço recebem o executor normal.
async function respostaAnterior(db: () => DbExecutor, codigo: string | null) {
  const modulo = carregar(db);
  const { escopoPublico } = modulo("lib/disponibilidade/escopo.ts") as typeof import("./escopo.ts");
  const { escopoCotacaoPublica } = modulo("lib/comercial/cotacao-publica.ts") as typeof import("../comercial/cotacao-publica.ts");
  const { combinadosPublicos } = modulo("lib/agenda/combinados-publicos.ts") as typeof import("../agenda/combinados-publicos.ts");
  const { consultarDisponibilidadePeriodo, duracaoAceita } = modulo("lib/disponibilidade/services/index.ts") as typeof import("./services/index.ts");
  const { lerConfigLegada } = modulo("lib/disponibilidade/config-legada-armazem.ts") as typeof import("./config-legada-armazem.ts");
  const { descontosPublicosDaEmpresa } = modulo("lib/comercial/descontos-dia-publico.ts") as typeof import("../comercial/descontos-dia-publico.ts");
  const { descontosPorIdV1 } = modulo("lib/comercial/descontos-dia.ts") as typeof import("../comercial/descontos-dia.ts");
  const { ofertasDoIntervalo, aplicarOferta } = modulo("lib/comercial/oferta-intervalo.ts") as typeof import("../comercial/oferta-intervalo.ts");
  const kidmais = codigo === null;
  const incluirCombinados = await combinadosPublicos(db());
  const escopo = kidmais ? await escopoPublico(db) : await escopoCotacaoPublica(db, codigo);
  assert.ok(escopo.empresaId);
  const saloesLivres = new Map<HorarioCandidatoPublico, string[]>();
  const [dias, legado, descontosEmpresa] = await Promise.all([
    consultarDisponibilidadePeriodo(inicio, fim, undefined, undefined, escopo,
      { convidados, saloesLivres, incluirCombinados, duracaoMinutos: duracaoAceita(null) }),
    kidmais ? lerConfigLegada(db()) : null,
    descontosPublicosDaEmpresa(db(), escopo.empresaId),
  ]);
  assert.ok(descontosEmpresa);
  const ofertas = await ofertasDoIntervalo(db(), escopo.empresaId, kidmais, inicio, fim, convidados, saloesLivres.size > 0);
  return Response.json({ ok: true, data: dias.map(dia => aplicarOferta(dia, ofertas, kidmais, convidados, saloesLivres)), comercial: {
    pacoteOverrides: legado?.pacoteOverrides.map(({ data, horario, pacote, status }) => ({ data, horario, pacote, status })) ?? [],
    descontos: legado?.descontos.map(({ data, horario, pacote, percentual, titulo }) => ({ data, horario, pacote, percentual, titulo })) ?? [],
    descontosEmpresa: kidmais ? descontosPorIdV1(descontosEmpresa) : descontosEmpresa,
  } }).json();
}

for (const { codigo, comCapacidade, antes, depois } of [
  { codigo: null, comCapacidade: false, antes: 19, depois: 14 },
  { codigo: "buffet-a", comCapacidade: false, antes: 19, depois: 14 },
  // Com configuração de capacidade e combinados. Em /b também passa por plano e assinatura instalados.
  { codigo: null, comCapacidade: true, antes: 23, depois: 17 },
  { codigo: "buffet-a", comCapacidade: true, antes: 31, depois: 23 },
]) {
  test(`disponibilidade em 61 dias, ${codigo ?? "Kidmais"}: ${antes} → ${depois} consultas`, async t => {
    for (const [chave, valor] of Object.entries({
      AGENDA_PUBLICA_EMPRESA_ID: empresaId, AGENDA_PUBLICA_UNIDADE_ID: unidadeId,
      SALOES_PUBLICOS: "true", SALOES_COMBINADOS_PUBLICOS: String(comCapacidade || codigo === null),
      COTACAO_PUBLICA_POR_EMPRESA: "true",
    })) {
      const anterior = process.env[chave];
      process.env[chave] = valor;
      t.after(() => {
        if (anterior === undefined) delete process.env[chave];
        else process.env[chave] = anterior;
      });
    }
    const anterior = executorInstrumentado(comCapacidade);
    const esperado = await respostaAnterior(anterior.db, codigo);
    assert.equal(anterior.consultas.length, antes);

    let antesDeResponder: ((sql: string) => Promise<void> | undefined) | undefined;
    const atual = executorInstrumentado(comCapacidade, sql => antesDeResponder?.(sql));
    const { GET } = carregar(atual.db)("app/api/disponibilidade/route.ts") as { GET(req: { url: string; nextUrl: URL }): Promise<Response> };
    const url = new URL(`http://localhost/api/disponibilidade?inicio=${inicio}&fim=${fim}&convidados=${convidados}`);
    if (codigo !== null) url.searchParams.set("empresa", codigo);
    for (let chamada = 1; chamada <= 2; chamada++) {
      const resposta = await provarParalelismo(pausar => {
        antesDeResponder = pausar;
        return GET({ url: url.href, nextUrl: url });
      });
      assert.equal(resposta.status, 200);
      assert.equal(resposta.headers.get("Cache-Control"), "no-store");
      const json = await resposta.json();
      assert.equal(json.data.length, 61);
      assert.deepEqual(json.data[6].periodos[0].horarios[0].pacotesVendaveis, ["POCKET"]);
      assert.deepEqual(json, esperado);
      assert.equal(atual.consultas.length, depois * chamada);
    }
    const umaChamada = atual.consultas.slice(0, depois);
    assert.deepEqual(new Set(umaChamada.map(item => JSON.stringify(item))),
      new Set(anterior.consultas.map(item => JSON.stringify(item))));
    if (codigo !== null && comCapacidade) {
      assert.equal(umaChamada.filter(item => item.sql.includes("FROM assinatura_isencoes WHERE")).length, 2);
    }

    url.searchParams.delete("inicio");
    url.searchParams.delete("fim");
    url.searchParams.set("data", fim);
    const respostaDaData = await provarParalelismo(pausar => {
      antesDeResponder = pausar;
      return GET({ url: url.href, nextUrl: url });
    });
    assert.equal(respostaDaData.status, 200);
    assert.deepEqual(await respostaDaData.json(), { ...esperado, data: esperado.data[60] });
    assert.equal(atual.consultas.length, depois * 3);
  });
}
