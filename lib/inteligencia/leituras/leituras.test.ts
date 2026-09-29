import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import type { RespostaLeitura } from "../contratos.ts";
import type { ClienteDominio, ContextoFerramenta, PortasDominio } from "../ferramentas.ts";
import { atenderInteligencia, type DependenciasGateway } from "../gateway.ts";
import type { RastreioInteligencia } from "../rastreio.ts";
import { montarAnalisePagamentos, periodosComparaveis } from "./analisar-pagamentos.ts";
import { montarAnaliseRecebiveis } from "./analisar-recebiveis.ts";
import { avaliarRisco, montarRiscoFesta } from "./festa.ts";
import { montarResumoCliente } from "./resumir-cliente.ts";

const empresaA = "11111111-1111-4111-8111-111111111111";
const empresaB = "22222222-2222-4222-8222-222222222222";
const usuario = "aaaaaaaa-0000-4000-8000-000000000001";
const membershipA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", empresa_id: empresaA };
const festaA = "33333333-3333-4333-8333-333333333333";
const contratoA = "44444444-4444-4444-8444-444444444444";
const contratoB = "55555555-5555-4555-8555-555555555555";
const agora = new Date("2026-09-28T15:00:00Z");
const sessao: SessaoParaTenant = { usuario_id: usuario, papel: "ADMINISTRATIVO" };
const contexto = (hoje = "2026-09-28"): ContextoFerramenta => ({ hoje, geradoEm: agora.toISOString(), portas: { festas: null, clientes: null } });

type Consulta = { sql: string; values: readonly unknown[] };

/** Banco falso: responde por empresa. Nunca devolve dado de B para uma consulta de A. */
function bancoFalso(memberships = [membershipA]) {
  const consultas: Consulta[] = [];
  const porEmpresa = (values: readonly unknown[], idx: number, a: object[], b: object[]) => (values[idx] === empresaA ? a : values[idx] === empresaB ? b : []);
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push({ sql, values });
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes("contrato.status = 'AGUARDANDO_ASSINATURA'") && sql.includes("count(*)")) return r(porEmpresa(values, 0, [{ n: 2 }], [{ n: 9 }]));
      if (sql.includes("contrato.status = 'AGUARDANDO_ASSINATURA'")) {
        return r(porEmpresa(values, 0, [
          { id: contratoA, data: "2026-10-02", pacote: "Festa Completa", cliente: "Cliente Alfa", criado_em: "2026-09-01" },
          { id: "c2", data: "2026-12-10", pacote: "Essencial", cliente: "Cliente Gama", criado_em: "2026-09-02" },
        ], [{ id: contratoB, data: "2026-10-01", pacote: "Beta", cliente: "Cliente Beta", criado_em: "2026-09-01" }]));
      }
      if (sql.includes("fech.data_evento BETWEEN")) {
        return r(porEmpresa(values, 0, [{ id: festaA, data: "2026-09-28", hora: "11:00:00", hora_fim: "15:00:00", cliente: "Cliente Alfa", pacote: "Festa Completa", convidados: 60, status: "ASSINADO" }], [{ id: "fb", data: "2026-09-28", hora: "10:00:00", hora_fim: null, cliente: "Cliente Beta", pacote: "Beta", convidados: 999, status: "ASSINADO" }]));
      }
      if (sql.includes("WHERE contrato.id = $1::uuid")) {
        // Predicado de tenant na SQL: contrato de B com empresa A ⇒ vazio.
        const dono = values[0] === contratoA ? empresaA : values[0] === contratoB ? empresaB : null;
        if (dono !== values[1]) return r([]);
        return r([{ id: values[0], status: "AGUARDANDO_ASSINATURA", cancelado_em: null, numero_versao: 2, versao_id: "v2", em_preparacao: false, snapshot: { evento: { data: "2026-10-02", horarioInicio: "11:00:00", convidados: 60, pacote: { nome: "Festa Completa" } }, comercial: { valorFinalContrato: 8811, formaPagamentoPretendida: "PIX_AVISTA" }, contratacao: { buffet: { status: "PENDENTE" } }, contratante: { cpf: "123.456.789-09" } } }]);
      }
      if (sql.includes("FROM contrato_assinaturas")) return r([{ parte: "KIDMAIS" }]);
      if (sql.includes("m.status AS membership")) return r(memberships.some((m) => m.id === values[0]) ? [{ membership: "ATIVA" }] : []);
      if (sql.includes("SELECT DISTINCT m.empresa_id")) return r(memberships.map((m) => ({ id: m.empresa_id })));
      if (sql.includes("FROM memberships m") && sql.includes("JOIN empresas")) return r(memberships.map((m) => ({ papel: "ADMINISTRATIVO", ...m })));
      if (sql.includes("SELECT status FROM empresas")) return r([{ status: "ATIVA" }]);
      if (sql.includes("FROM empresas")) return r([{ id: values[0] }]);
      if (sql.includes("SELECT ativo")) return r([{ ativo: true }]);
      if (sql.includes("FROM usuarios_administrativos")) return r([{ id: values[0] }]);
      throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
    },
  };
  return { tx, consultas };
}

function montar(env: Record<string, string> = { INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true" }, portas?: PortasDominio, banco = bancoFalso()) {
  const rastros: RastreioInteligencia[] = [];
  let emTransacao = false;
  const eventos: string[] = [];
  const deps: DependenciasGateway = {
    env,
    autenticar: async () => sessao,
    withTenantTransaction: async (s, empresa, work) => {
      emTransacao = true;
      eventos.push("tx:inicio");
      try {
        return await executarNoTenant(banco.tx, s, empresa, work);
      } finally {
        emTransacao = false;
        eventos.push("tx:fim");
      }
    },
    agora: () => agora,
    requestId: () => "req-1",
    registrar: (r) => rastros.push({ ...r }),
    relogio: () => 0,
    portas,
  };
  return { deps, banco, rastros, eventos, emTransacao: () => emTransacao };
}

const pedir = (corpo: unknown, empresa: string | null = null) => ({ lerCorpo: async () => corpo, empresaSolicitada: empresa });
const dados = (r: { corpo: unknown }) => (r.corpo as { data: RespostaLeitura }).data;

test("flag de grupo: sem AI_READ_ENABLED as novas leituras ficam desativadas e atencao_hoje continua", async () => {
  const { deps, banco } = montar({ INTELIGENCIA_ENABLED: "true" });
  const resposta = await atenderInteligencia(pedir({ capacidade: "contratos_pendentes" }), deps);
  assert.equal(resposta.status, 503);
  assert.equal((resposta.corpo as { codigo: string }).codigo, "INTELIGENCIA_DESATIVADA");
  assert.equal(banco.consultas.length, 0);
});

test("allowlist por empresa: empresa fora da lista não lê nada (fail closed); lista inválida bloqueia todas", async () => {
  for (const lista of [empresaB, "nao-e-uuid", `${empresaA},lixo`]) {
    const { deps, banco } = montar({ INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", AI_TENANT_ALLOWLIST: lista });
    const resposta = await atenderInteligencia(pedir({ capacidade: "contratos_pendentes" }), deps);
    assert.equal(resposta.status, 503, lista);
    assert.equal(banco.consultas.some((c) => c.sql.includes("AGUARDANDO_ASSINATURA")), false);
  }
  const { deps } = montar({ INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", AI_TENANT_ALLOWLIST: ` ${empresaA.toUpperCase()} ` });
  assert.equal((await atenderInteligencia(pedir({ capacidade: "contratos_pendentes" }), deps)).status, 200);
});

test("contratos_pendentes: só a empresa comprovada é consultada; A não vê B", async () => {
  const { deps, banco, rastros } = montar();
  const resposta = await atenderInteligencia(pedir({ capacidade: "contratos_pendentes" }), deps);
  assert.equal(resposta.status, 200);
  const d = dados(resposta);
  assert.match(d.resumo, /^2 contratos aguardam assinatura; 1 tem festa nos próximos 15 dias\.$/);
  assert.deepEqual(d.itens.map((i) => i.prioridade), ["alta", "baixa"]);
  const texto = JSON.stringify(d);
  assert.equal(texto.includes("Cliente Beta") || texto.includes(contratoB), false);
  const doDominio = banco.consultas.filter((c) => c.sql.includes("AGUARDANDO_ASSINATURA"));
  assert.ok(doDominio.length === 2 && doDominio.every((c) => c.values[0] === empresaA && /pac\.empresa_id = \$1::uuid/.test(c.sql)));
  assert.deepEqual(d.fatos.map((f) => f.natureza), ["FATO", "FATO"]);
  assert.equal(rastros[0].ferramenta, "contratos.pendentes.listar");
});

test("empresa B pedida por quem só tem A: recusa antes de ler contratos", async () => {
  const { deps, banco } = montar();
  const resposta = await atenderInteligencia(pedir({ capacidade: "contratos_pendentes" }, empresaB), deps);
  assert.equal(resposta.status, 403);
  assert.equal(banco.consultas.some((c) => c.sql.includes("AGUARDANDO_ASSINATURA")), false);
});

test("agenda_do_dia: festas da empresa comprovada, com link e soma de convidados como cálculo", async () => {
  const { deps, banco } = montar();
  const d = dados(await atenderInteligencia(pedir({ capacidade: "agenda_do_dia" }), deps));
  assert.equal(d.resumo, "1 festa hoje, 60 convidados no total.");
  assert.equal(d.itens[0].destino, `/admin/festas/${festaA}`);
  assert.ok(d.fatos.some((f) => f.natureza === "CALCULO" && f.texto.includes("60")));
  assert.equal(JSON.stringify(d).includes("999"), false);
  const agenda = banco.consultas.find((c) => c.sql.includes("BETWEEN"))!;
  assert.deepEqual(agenda.values.slice(0, 3), [empresaA, "2026-09-28", "2026-09-28"]);
  const amanha = dados(await atenderInteligencia(pedir({ capacidade: "agenda_do_dia", parametros: { dia: "amanha" } }), montar().deps));
  assert.equal(amanha.referencia.hoje, "2026-09-28");
  const invalido = await atenderInteligencia(pedir({ capacidade: "agenda_do_dia", parametros: { dia: "ontem", empresaId: empresaB } }), montar().deps);
  assert.equal(invalido.status, 400);
});

test("resumir_contrato: contrato de outra empresa responde como inexistente; nada de CPF; valor é o do snapshot", async () => {
  const { deps } = montar();
  const outro = await atenderInteligencia(pedir({ capacidade: "resumir_contrato", parametros: { id: contratoB } }), deps);
  assert.equal(outro.status, 404);
  assert.deepEqual(outro.corpo, { ok: false, erro: "Contrato não encontrado.", codigo: "NAO_ENCONTRADO" });
  const inexistente = await atenderInteligencia(pedir({ capacidade: "resumir_contrato", parametros: { id: "66666666-6666-4666-8666-666666666666" } }), montar().deps);
  assert.deepEqual(inexistente.corpo, outro.corpo);
  const d = dados(await atenderInteligencia(pedir({ capacidade: "resumir_contrato", parametros: { id: contratoA } }), montar().deps));
  assert.match(d.resumo, /R\$\s?8\.811,00/);
  assert.ok(d.fatos.some((f) => f.texto.includes("sem recálculo")));
  assert.ok(d.fatos.some((f) => f.texto === "Falta assinatura: cliente."));
  assert.equal(JSON.stringify(d).includes("123.456.789-09"), false);
  const semId = await atenderInteligencia(pedir({ capacidade: "resumir_contrato" }), montar().deps);
  assert.equal(semId.status, 400);
});

test("resumir_cliente: minimização — CPF, contato e endereço do domínio nunca chegam à resposta", async () => {
  const dominio = {
    cliente: { nomeCompleto: "Maria Teste", status: "ATIVO", criadoEm: "2026-01-10T12:00:00Z", cpf: "123.456.789-09", email: "maria@example.com", telefone: "(11) 99999-0000", logradouro: "Rua Secreta" },
    aniversariantes: [{ nome: "Lia", dataNascimento: "2019-10-05", ativo: true }, { nome: "Inativo", dataNascimento: "2018-01-01", ativo: false }],
    responsaveis: [{ cpf: "987.654.321-00" }],
    cadastro: { completoParaContrato: false, camposFaltantes: [{ campo: "cpf", label: "CPF" }, { campo: "logradouro", label: "Endereço" }] },
  } as unknown as ClienteDominio;
  const clienteId = "77777777-7777-4777-8777-777777777777";
  let recebido: unknown[] = [];
  const portas: PortasDominio = { festas: null, clientes: { obter: async (_tx, empresa, id) => { recebido = [empresa, id]; return dominio; } } };
  const { deps } = montar(undefined, portas);
  const resposta = await atenderInteligencia(pedir({ capacidade: "resumir_cliente", parametros: { id: clienteId } }), deps);
  assert.equal(resposta.status, 200);
  assert.deepEqual(recebido, [empresaA, clienteId]);
  const texto = JSON.stringify(resposta.corpo);
  for (const proibido of ["123.456.789-09", "maria@example.com", "99999", "Rua Secreta", "987.654.321-00"]) assert.equal(texto.includes(proibido), false, proibido);
  const d = dados(resposta);
  assert.ok(d.fatos.some((f) => f.texto === "Cadastro incompleto para contrato: falta CPF, Endereço."));
  assert.ok(d.fatos.some((f) => f.natureza === "CALCULO" && f.texto.includes("Lia") && f.texto.includes("05/10/2026")));
  assert.equal(montarResumoCliente(dominio, clienteId, contexto()).itens[0].titulo, "Completar cadastro");
});

test("festas: rodam fora da transação do gateway (sem autoimpasse) e recebem só o id validado", async () => {
  const detalhe = {
    festa: { id: festaA, estado: "PROXIMA" },
    contrato: { status: "AGUARDANDO_ASSINATURA", numero_versao: 1, snapshot: { evento: { data: "2026-10-01", horarioInicio: "11:00:00", convidados: 60, pacote: { nome: "Festa Completa" } }, contratante: { cpf: "123.456.789-09" } } },
    itens: {
      pendencias: [{ estado: "ABERTA", prioridade: "CRITICA", descricao: "Confirmar alergia", prazo: null }, { estado: "RESOLVIDA", prioridade: "CRITICA", descricao: "Antiga", prazo: null }],
      tarefas: [{ estado: "PENDENTE", prioridade: "NORMAL", titulo: "Montar mesa", prazo: "2026-09-20T12:00:00Z" }],
      solicitacoes: [],
    },
    buffet: { campos: ["salgados", "bolo"], valores: { salgados: "Assados", bolo: null } },
    financeiroPendente: false,
    financeiro: { saldo: "481100" },
    excedentes: 0,
  };
  let pedidoDeId: string | null = null;
  let chamadaDentroDaTransacao: boolean | null = null;
  const ctx = montar(undefined, { clientes: null, festas: { consultarDetalhe: async (id) => { pedidoDeId = id; chamadaDentroDaTransacao = ctx.emTransacao(); return detalhe; } } });
  const resposta = await atenderInteligencia(pedir({ capacidade: "festa_em_risco", parametros: { id: festaA } }), ctx.deps);
  assert.equal(resposta.status, 200);
  assert.equal(pedidoDeId, festaA);
  assert.equal(chamadaDentroDaTransacao, false);
  assert.deepEqual(ctx.eventos, ["tx:inicio", "tx:fim"]);
  const d = dados(resposta);
  assert.equal(d.resumo, "Risco alto: 5 motivos.");
  assert.equal(JSON.stringify(d).includes("123.456.789-09"), false);
  assert.ok(d.fatos.some((f) => f.texto.includes("Contrato ainda não assinado")));
  assert.ok(d.fatos.some((f) => f.texto.includes("Buffet sem definição (bolo)")));

  const pendencias = dados(await atenderInteligencia(pedir({ capacidade: "pendencias_da_festa", parametros: { id: festaA } }), ctx.deps));
  assert.deepEqual(pendencias.itens.map((i) => i.titulo), ["Confirmar alergia", "Montar mesa", "Definir buffet"]);
  const resumo = dados(await atenderInteligencia(pedir({ capacidade: "resumir_festa", parametros: { id: festaA } }), ctx.deps));
  assert.match(resumo.resumo, /^Festa em 3 dias: 1 pendência, 1 tarefa, buffet a definir\.$/);
});

test("festas: detalhe incompleto ou porta ausente ⇒ ausência de dados, nunca invenção", async () => {
  const semPorta = dados(await atenderInteligencia(pedir({ capacidade: "resumir_festa", parametros: { id: festaA } }), montar().deps));
  assert.equal(semPorta.estado, "sem_dados");
  assert.equal(semPorta.fatos[0].natureza, "AUSENCIA");
  const incompleto = dados(await atenderInteligencia(pedir({ capacidade: "resumir_festa", parametros: { id: festaA } }), montar(undefined, { clientes: null, festas: { consultarDetalhe: async () => ({ festa: { id: festaA } }) } }).deps));
  assert.equal(incompleto.estado, "sem_dados");
});

test("festa_em_risco: festa passada ou cancelada não recebe classificação de risco", () => {
  const base = { festa: { id: festaA, estado: "CANCELADA" }, contrato: { status: "CANCELADO", snapshot: { evento: { data: "2026-10-01" } } }, itens: { pendencias: [], tarefas: [], solicitacoes: [] } };
  assert.deepEqual(avaliarRisco(base as never, "2026-09-28"), []);
  const r = montarRiscoFesta(base as never, contexto());
  assert.match(r.resumo, /não se aplica/);
});

test("analisar_recebiveis: aging determinístico, vencidos e a vencer como cálculo", () => {
  const item = (id: string, status: string, saldo: number, vencimento: string, diasAtraso = 0) => ({ id, pagamentoId: id, cliente: "X", festaId: null, pacote: "P", data: vencimento, parcela: 1, vencimento, valorCentavos: saldo, recebidoCentavos: 0, saldoCentavos: saldo, forma: "PIX", status, diasAtraso }) as never;
  const r = montarAnaliseRecebiveis([
    item("a", "Vencido", 10000, "2026-09-18", 10),
    item("b", "Vencido", 20000, "2026-07-01", 89),
    item("c", "A receber", 5000, "2026-10-01"),
    item("d", "Pago", 99900, "2026-09-01"),
  ], contexto());
  assert.equal(r.resumo, "R$ 350,00 em aberto, dos quais R$ 300,00 estão vencidos.");
  assert.deepEqual(r.itens.map((i) => i.id), ["vencidos_ate_30", "vencidos_mais_60", "proximos_7_dias"]);
  assert.equal(montarAnaliseRecebiveis([], contexto()).estado, "sem_dados");
});

test("analisar_pagamentos: compara o mesmo intervalo; sem base não calcula percentual", () => {
  assert.deepEqual(periodosComparaveis("2026-03-31"), {
    atual: { inicio: "2026-03-01", fim: "2026-03-31" },
    anterior: { inicio: "2026-02-01", fim: "2026-02-28" },
    anteriorCheio: { inicio: "2026-02-01", fim: "2026-02-28" },
  });
  const p = periodosComparaveis("2026-09-28");
  const alta = montarAnalisePagamentos({ atualCentavos: 150000, anteriorCentavos: 100000, anteriorCheioCentavos: 120000 }, p, contexto());
  assert.match(alta.resumo, /50% acima/);
  assert.ok(alta.fatos.some((f) => f.natureza === "CALCULO"));
  const semBase = montarAnalisePagamentos({ atualCentavos: 150000, anteriorCentavos: 0, anteriorCheioCentavos: 10 }, p, contexto());
  assert.ok(semBase.fatos.some((f) => f.natureza === "AUSENCIA"));
  assert.doesNotMatch(semBase.resumo, /%/);
});

test("o caminho de leitura nunca escreve", async () => {
  const banco = bancoFalso();
  for (const capacidade of ["contratos_pendentes", "agenda_do_dia"]) {
    await atenderInteligencia(pedir({ capacidade }), montar(undefined, undefined, banco).deps);
  }
  await atenderInteligencia(pedir({ capacidade: "resumir_contrato", parametros: { id: contratoA } }), montar(undefined, undefined, banco).deps);
  assert.equal(banco.consultas.some((c) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(c.sql)), false);
});
