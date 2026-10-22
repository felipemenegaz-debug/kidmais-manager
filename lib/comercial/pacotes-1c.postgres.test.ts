import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { salvarPacoteComercial } from "./pacote-comercial.ts";
import { pacotesDaAgendaDaEmpresa } from "./disponibilidade-pacote-publica.ts";
import { listarPacotesContrataveisDaEmpresa } from "./repositories/comercial.repository.ts";
import { pacotesDisponiveis } from "../marketing/site/servico.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";

/**
 * Fase 1c (pacotes com código livre) no PostgreSQL DESCARTÁVEL (modelo 089). A = buffet comum; a dona da agenda pública é
 * a empresa `kidmais` (046), pela ordem de `empresaDonaDaConfigLegada` sem AGENDA_PUBLICA_EMPRESA_ID.
 *
 *  C1 fechamento ADMINISTRATIVO de A com o pacote criado em "Novo pacote" (P_…): gravado com a linha vigente; id V1 de
 *     pacote que A não tem → 404; formato inválido → PACOTE_FORA_ESCOPO_V1; convidados só pelos limites de A;
 *  C2 regras fixas da Kidmais por código no PREÇO (D2): PIZZA_PARTY e COMPACTA de A não recebem as regras da Kidmais;
 *     os da dona continuam com elas;
 *  C3 site de Marketing: o editor oferece todos os pacotes ativos de A, inclusive o P_;
 *  C4 agenda da administração: cada pacote traz os limites de convidados (o wizard valida com eles).
 *
 * Só pelo check:v1:postgres com opt-in. Dados sintéticos; nenhuma rede.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const sufixo = randomBytes(3).toString("hex");
const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;
let client: Client;
let tx: DbExecutor;
let turnos: string[];
let A: { empresa: string; usuario: string };
let kidmais: string;
let livre: { id: string; codigo: string };
let usuarioAtual = "";
let empresaAtual = "";

type Servicos = {
  precificarPacote: (input: Record<string, unknown>, db: DbExecutor) => Promise<unknown>;
  calcularResumoComercial: (input: Record<string, unknown>, db: DbExecutor) => Promise<{ pacote: { valorTabelaAplicado: unknown } }>;
  criarFechamentoPublicoComIdentidade: (input: Record<string, unknown>, db: DbExecutor) => Promise<{ fechamento: { id: string; clienteId: string; aniversarianteId: string } }>;
  criarFechamentoAdministrativo: (id: string, raw: unknown, contexto: { token: string; empresaSolicitada?: string | null }) => Promise<{ fechamentoId: string; status: string }>;
};
let servicos: Servicos;

function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (base.every((d) => d === base[0])) base[8] = (base[0] + 1) % 10;
  const dv = (n: number[]) => { const s = n.reduce((t, d, i) => t + d * (n.length + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join("");
}

async function emTransacao<T>(fn: () => Promise<T>) {
  await client.query("BEGIN");
  try { const r = await fn(); await client.query("COMMIT"); return r; } catch (erro) { await client.query("ROLLBACK"); throw erro; }
}

async function empresa(nome: string) {
  const id = async (sql: string, v: unknown[]) => (await client.query<{ id: string }>(sql, v)).rows[0].id;
  const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [`p1c${nome}${sufixo}`.toLowerCase(), `Buffet 1c ${nome}`]);
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 1c', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@example.test`, SENHA]);
  const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id::text AS id`, [e, u]);
  await client.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return { empresa: e, usuario: u };
}

const ctx = (dono: { empresa: string; usuario: string }) => ({ empresaId: dono.empresa, usuarioId: dono.usuario, requestId: randomUUID(), motivo: "Criação administrativa" });
const todosOsDias = () => [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((horarioId) => ({ dia, horarioId })));

async function novoPacote(dono: { empresa: string; usuario: string }, nome: string, valor: string, min = 30, max = 80) {
  return emTransacao(() => salvarPacoteComercial(tx, {
    nome, descricao: "Pacote 1c", duracaoMinutos: 240, convidadosMinimos: min, convidadosMaximos: max,
    disponibilidade: todosOsDias(), faixas: [{ convidadosMin: min, convidadosMax: max, valor }], categorias: [],
  }, ctx(dono)));
}

/** Pacote com código fixo (como o importado pela tabela), sem faixa de preço, com limites opcionais e todos os dias liberados. */
async function pacoteComCodigo(empresaId: string, codigo: string, min: number | null, max: number | null) {
  const id = (await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
     VALUES ($1::uuid, $2, $3, 50, true, true, $4, $5) RETURNING id::text AS id`, [empresaId, codigo, `Pacote ${codigo}`, min, max])).rows[0].id;
  for (const dia of [1, 2, 3, 4, 5, 6, 7]) for (const turno of turnos) {
    await client.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio)
       VALUES ($1::uuid, $2, $3::uuid, 'DISPONIVEL', CURRENT_DATE - 1)`, [id, dia, turno]);
  }
  return id;
}

/** Pacote vigente da empresa com o código; sem ele, cria um (sem limites cadastrados). */
async function pacoteComCodigoSeLivre(empresaId: string, codigo: string) {
  const existente = (await client.query<{ id: string }>(
    `SELECT id::text AS id FROM pacotes WHERE empresa_id = $1::uuid AND codigo = $2 AND vigente AND ativo AND arquivado_em IS NULL`, [empresaId, codigo])).rows[0]?.id;
  return existente ?? pacoteComCodigo(empresaId, codigo, null, null);
}

const pular = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel";

test.before(async () => {
  if (pular()) return;
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
  // Sessão e tenant dublados (a empresa comprovada é a do cenário); todo o resto é o código real contra o banco descartável.
  const dubles = {
    "db/postgres": { db: () => tx, withTransaction: async <T>(fn: (t: DbExecutor) => Promise<T>) => fn(tx) },
    "autenticacao/service": {
      consultarSessao: async () => ({ usuario_id: usuarioAtual, papel: "REPRESENTANTE_AUTORIZADO" }),
      authError: (m = "Sessão inválida.") => new Error(m),
    },
    "saas/provar-tenant": {
      executarNoTenant: async <T>(t: DbExecutor, _s: unknown, _e: unknown, work: (t: DbExecutor, tenant: unknown) => Promise<T>) =>
        work(t, { empresaComprovada: empresaAtual, papelAtual: "REPRESENTANTE_AUTORIZADO", usuarioId: usuarioAtual }),
    },
  };
  const cache = new Map();
  servicos = {
    ...(carregarModulo("lib/comercial/services/pricing.service.ts", dubles, cache) as Pick<Servicos, "calcularResumoComercial" | "precificarPacote">),
    ...(carregarModulo("lib/fechamentos/services/fechamento-publico.service.ts", dubles, cache) as Pick<Servicos, "criarFechamentoPublicoComIdentidade">),
    ...(carregarModulo("lib/fechamentos/services/fechamento-administrativo.service.ts", dubles, cache) as Pick<Servicos, "criarFechamentoAdministrativo">),
  };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("C1/C3/C4: fechamento administrativo, site e agenda com o pacote P_ do buffet comum", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  turnos = (await client.query<{ id: string }>(`SELECT id::text AS id FROM configuracao_agenda WHERE codigo IN ('TURNO_1', 'TURNO_2') AND ativo ORDER BY codigo`)).rows.map((r) => r.id);
  kidmais = (await client.query<{ id: string }>(`SELECT id::text AS id FROM empresas WHERE codigo = 'kidmais'`)).rows[0]?.id;
  assert.ok(kidmais, "dona da agenda pública (046)");
  A = await empresa("A");
  const criado = await novoPacote(A, "Festa Jardim", "4500.00");
  livre = { id: criado.pacote.id, codigo: criado.pacote.codigo };
  assert.match(livre.codigo, /^P_[0-9A-F]{32}$/);

  // C4: a agenda da administração traz os limites de convidados de cada pacote.
  const agenda = await pacotesDaAgendaDaEmpresa(tx, A.empresa, listarPacotesContrataveisDaEmpresa);
  assert.deepEqual(agenda.pacotes, [{ id: livre.codigo, nome: "Festa Jardim", convidadosMinimos: 30, convidadosMaximos: 80 }]);

  // C3: o editor do site oferece o pacote P_ (antes: só os sete códigos V1).
  const doSite = await pacotesDisponiveis(tx, A.empresa);
  assert.deepEqual(doSite.map((p) => p.codigo), [livre.codigo]);
  assert.equal(doSite[0].nome, "Festa Jardim");

  // Cliente completo de A pelo fluxo público (cria cadastro e aniversariante na empresa).
  const data = "2098-09-12";
  const cpf = cpfValido();
  const publico = await emTransacao(() => servicos.criarFechamentoPublicoComIdentidade({
    dataEvento: data, horarioInicio: "11:00", horarioFim: "15:00", configuracaoAgendaId: turnos[0], pacoteId: livre.id,
    convidados: 40, adicionais: [], valorProposto: 4500, buffetStatus: "PENDENTE", empresaEsperada: A.empresa,
    identidade: { tipo: "NOVO_CLIENTE" },
    cliente: { nomeCompleto: "Cliente Sintético 1c", cpf, telefone: "00000000002", whatsapp: "00000000003",
      email: `pacote.1c.${cpf}@example.invalid`, cep: "00000000", logradouro: "Avenida Sintética", numero: "100", complemento: null,
      bairro: "Bairro Sintético", cidade: "Cidade de Homologação", uf: "SP" },
    aniversariante: { nome: "Aniversariante 1c", temaPadrao: "Teste" },
    cpfSemRevelarCadastro: true,
  }, tx));
  const clienteId = publico.fechamento.clienteId;
  const aniversarianteId = publico.fechamento.aniversarianteId;

  // C1: fechamento ADMINISTRATIVO de A com o código P_ (antes: enum dos sete → recusado).
  usuarioAtual = A.usuario; empresaAtual = A.empresa;
  const base = {
    dataFesta: "2098-09-19", horarioBase: "almoco", ajusteHorario: "0", horarioInicio: "11:00", horarioFim: "15:00",
    statusDisponibilidade: "disponivel", convidadosPagantes: 40, buffetDefinicao: "depois", adicionaisSelecionados: [],
    valorCombinado: "4500,00", formaPagamento: "pix_avista", aniversarianteId, idadeAniversariante: 6,
  };
  const admin = await emTransacao(() => servicos.criarFechamentoAdministrativo(clienteId, { ...base, pacote: livre.codigo }, { token: "sintetico" }));
  const gravado = (await client.query<{ pacote_id: string; empresa_id: string }>(
    `SELECT pacote_id::text AS pacote_id, empresa_id::text AS empresa_id FROM fechamentos WHERE id = $1::uuid`, [admin.fechamentoId])).rows[0];
  assert.equal(gravado.pacote_id, livre.id, "C1: gravado com a linha vigente do pacote P_");
  assert.equal(gravado.empresa_id, A.empresa);

  await assert.rejects(emTransacao(() => servicos.criarFechamentoAdministrativo(clienteId, { ...base, dataFesta: "2098-09-26", pacote: "pocket" }, { token: "sintetico" })),
    /Pacote não disponível/, "C1: id V1 de pacote que A não tem → 404");
  await assert.rejects(emTransacao(() => servicos.criarFechamentoAdministrativo(clienteId, { ...base, dataFesta: "2098-09-26", pacote: "p_minusculo" }, { token: "sintetico" })),
    /fora do escopo/i, "C1: formato inválido");
  await assert.rejects(emTransacao(() => servicos.criarFechamentoAdministrativo(clienteId, { ...base, dataFesta: "2098-09-26", pacote: livre.codigo, convidadosPagantes: 81 }, { token: "sintetico" })),
    /Festa Jardim atende até 80/, "C1: limite do pacote da empresa, redação neutra");
  const semKidmais = await emTransacao(() => servicos.criarFechamentoAdministrativo(clienteId, { ...base, dataFesta: "2098-09-26", pacote: livre.codigo, convidadosPagantes: 30 }, { token: "sintetico" }));
  assert.ok(semKidmais.fechamentoId, "C1: 30 convidados (mínimo de A) aceito");
});

test("C2: regras fixas da Kidmais no preço só para a dona (D2)", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente"); return; }
  assert.ok(A, "depende do cenário C1");
  // precificarPacote confere as regras do pacote ANTES da tabela de preço (a dona não tem tabela em 2098 no modelo).
  const precificar = (pacoteId: string, convidados: number) =>
    servicos.precificarPacote({ data: "2098-09-12", configuracaoAgendaId: turnos[0], pacoteId, convidados }, tx);
  const mensagem = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (erro) { return String((erro as Error).message); } };

  // PIZZA_PARTY de A SEM limites cadastrados: antes, a regra 20–100 da Kidmais recusava 10 convidados pelo código.
  const pizzaA = await pacoteComCodigo(A.empresa, "PIZZA_PARTY", null, null);
  assert.doesNotMatch(await mensagem(precificar(pizzaA, 10)), /Pizza Party atende/, "C2: Pizza Party de A sem a regra da Kidmais");
  // COMPACTA de A sem preço: erro genérico de preço, não o "sob consulta" da Kidmais.
  const compactaA = await pacoteComCodigo(A.empresa, "COMPACTA", 10, 100);
  await assert.rejects(servicos.calcularResumoComercial({ data: "2098-09-12", configuracaoAgendaId: turnos[0], pacoteId: compactaA, convidados: 40, adicionais: [], empresaEsperada: A.empresa }, tx),
    (erro: { code?: string }) => { assert.equal(erro.code, "PRECO_PACOTE_NAO_CONFIGURADO", "C2: Compacta de A sem preço chega ao ramo do preço e recebe o erro genérico, não o sob consulta da Kidmais"); return true; });

  // Dona (kidmais): a regra do Pizza Party continua (pacote PIZZA_PARTY da dona sem limites cadastrados).
  const pizzaK = await pacoteComCodigoSeLivre(kidmais, "PIZZA_PARTY");
  assert.match(await mensagem(precificar(pizzaK, 10)), /Pizza Party atende de 20 a 100/, "C2: dona mantém a regra do Pizza Party");
});
