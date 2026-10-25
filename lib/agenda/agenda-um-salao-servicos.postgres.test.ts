import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import * as pacotesAdmin from "../comercial/pacotes-admin.ts";
import { duplicarPacoteAdmin } from "../comercial/pacotes-admin.ts";
import * as pacotePrecos from "../comercial/pacote-precos.ts";
import * as pacoteComercial from "../comercial/pacote-comercial.ts";
import * as configuracaoUnidade from "./configuracao-unidade.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import { duplicarPacoteComercial, salvarPacoteComercial } from "../comercial/pacote-comercial.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { definirSaloesPacote, lerAgendaEscopo, saloesDaEmpresa, salvarAgendaEscopo, type SalvarAgenda } from "./configuracao-unidade.ts";

/**
 * Parecer do Astra de 25/10/2026 (agenda com um salão), pelos serviços reais no PostgreSQL DESCARTÁVEL (modelo 097):
 * - a agenda por salão não pode ser escolhida enquanto não for liberada (só com a opção das provas);
 * - voltar de por salão para um salão fica bloqueado por ora (com ou sem festas sobrepostas);
 * - na agenda por salão o pacote exige salão; com um salão, salão cadastrado não obriga;
 * - duplicar o pacote copia os salões; pacote antigo sem salão não é duplicado nem alterado sem salão; a IA não cria sem;
 * - a edição e a revisão pela IA (porta REAL da composition root) conferem o salão efetivo; vínculo com salão desativado
 *   é preservado; empresa com unidades mistas exige salão (conservador).
 */
let a: Client;
let tx: DbExecutor;
const D = dia(50);
const LIBERADA = { maisDeUmSalaoLiberada: true };

async function recusa(promessa: Promise<unknown>, trecho: RegExp) {
  await assert.rejects(promessa, (e: unknown) => trecho.test(e instanceof Error ? e.message : String(e)));
}

async function emTransacao<T>(fn: () => Promise<T>) {
  await a.query("BEGIN");
  try {
    const r = await fn();
    await a.query("COMMIT");
    return r;
  } catch (error) {
    await a.query("ROLLBACK");
    throw error;
  }
}

const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() });
const porSalao = (horarios: SalvarAgenda["horarios"]): SalvarAgenda => ({
  estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 0,
  saloes: [{ nome: "S1", capacidadeConvidados: null }, { nome: "S2", capacidadeConvidados: null }], horarios,
});

async function confirmada(c: Cenario, cfg: string, inicio: string, fim: string, salao: string) {
  return emTransacao(async () => {
    const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status, salao_id)
        SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO', $7::uuid FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
      [D, inicio, fim, cfg, c.empresa, c.pacote, salao]);
    await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
    return f;
  });
}

/** Agenda por salão (liberada só aqui) com os horários dados; devolve ids dos horários (pelo nome) e dos salões. */
async function agendaPorSalao(c: Cenario, horarios: SalvarAgenda["horarios"]) {
  const agenda = await emTransacao(() => salvarAgendaEscopo(tx, porSalao(horarios), ctx(c), "CONFIGURACOES", LIBERADA));
  const salao = Object.fromEntries(agenda.saloes.map((s) => [s.nome, s.id!]));
  const horario = Object.fromEntries(agenda.horarios.filter((h) => !h.herdado).map((h) => [h.nome, h.id]));
  return { agenda, salao, horario };
}

const paraUmSalao = (agenda: Awaited<ReturnType<typeof lerAgendaEscopo>>): SalvarAgenda => ({
  estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: null, intervaloMinimoMinutos: 0, saloes: [],
  horarios: agenda.horarios.filter((h) => !h.herdado).map((h) => ({ id: h.id, nome: h.nome, inicio: h.inicio, fim: h.fim, dias: h.dias, capacidade: 1, saloes: [] })),
});

test.before(async () => {
  a = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await a.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; } };
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

const TODOS = [1, 2, 3, 4, 5, 6, 7];

test("agenda por salão: recusada sem liberação (primeira configuração e troca); com a opção das provas, criada", async () => {
  const c = await cenario(a, 0);
  const horarios = [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] }];
  await recusa(emTransacao(() => salvarAgendaEscopo(tx, porSalao(horarios), ctx(c), "CONFIGURACOES")), /ainda não está disponível/);
  assert.equal((await lerAgendaEscopo(tx, c.empresa, null)).config, null, "nada gravado");
  const um = await emTransacao(() => salvarAgendaEscopo(tx, { ...porSalao([]), capacidadeTipo: "POR_HORARIO", saloes: [],
    horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] }, ctx(c), "CONFIGURACOES"));
  assert.equal(um.config?.capacidadeTipo, "POR_HORARIO");
  await recusa(emTransacao(() => salvarAgendaEscopo(tx, porSalao(horarios), ctx(c), "CONFIGURACOES")), /ainda não está disponível/);
  const d = await cenario(a, 0);
  const { agenda } = await agendaPorSalao(d, horarios);
  assert.equal(agenda.config?.capacidadeTipo, "POR_SALAO");
});

test("volta para um salão: bloqueada por ora, com festas sobrepostas ou não (parecer do Astra, P2); nada muda", async () => {
  for (const sobrepostas of [true, false]) {
    const c = await cenario(a, 0);
    const { salao, horario } = await agendaPorSalao(c, [
      { nome: "Manhã", inicio: "09:00", fim: "12:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] },
      { nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] },
    ]);
    await confirmada(c, horario.Tarde, "15:00", "19:00", salao.S1);
    await confirmada(c, sobrepostas ? horario.Tarde : horario["Manhã"], sobrepostas ? "15:00" : "09:00", sobrepostas ? "19:00" : "12:00", salao.S2);
    const agenda = await lerAgendaEscopo(tx, c.empresa, null);
    await recusa(emTransacao(() => salvarAgendaEscopo(tx, paraUmSalao(agenda), ctx(c), "CONFIGURACOES")), /ainda não está disponível pela tela/);
    await recusa(emTransacao(() => salvarAgendaEscopo(tx, paraUmSalao(agenda), ctx(c), "CONFIGURACOES", LIBERADA)), /ainda não está disponível pela tela/);
    assert.equal((await lerAgendaEscopo(tx, c.empresa, null)).config?.capacidadeTipo, "POR_SALAO", "configuração intacta");
  }
});

test("salão do pacote: por salão exige; com um salão (mesmo com salão cadastrado) não; duplicar copia os salões", async () => {
  const c = await cenario(a, 0);
  const { salao } = await agendaPorSalao(c, [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] }]);
  await recusa(emTransacao(() => definirSaloesPacote(tx, c.empresa, c.pacote, [])), /Escolha o salão ou os salões deste pacote\./);
  await emTransacao(() => definirSaloesPacote(tx, c.empresa, c.pacote, [salao.S1]));
  const copia = await emTransacao(() => duplicarPacoteAdmin(tx, c.pacote, undefined, { ...ctx(c), motivo: "prova 100" }));
  const salaoDaCopia = await a.query<{ salao_id: string }>(`SELECT salao_id::text FROM pacote_saloes WHERE pacote_id = $1::uuid`, [copia.id]);
  assert.deepEqual(salaoDaCopia.rows.map((r) => r.salao_id), [salao.S1]);

  const u = await cenario(a, 0);
  await emTransacao(() => salvarAgendaEscopo(tx, { ...porSalao([]), capacidadeTipo: "POR_HORARIO", saloes: [],
    horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] }, ctx(u), "CONFIGURACOES"));
  await a.query(`INSERT INTO agenda_saloes (empresa_id, nome, ordem) VALUES ($1::uuid, 'Salão antigo', 1)`, [u.empresa]);
  await emTransacao(() => definirSaloesPacote(tx, u.empresa, u.pacote, []));
});

test("pacote antigo sem salão na agenda por salão: duplicar e alterar sem informar salões são recusados; a IA não cria sem salão", async () => {
  const c = await cenario(a, 0);
  const { salao } = await agendaPorSalao(c, [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] }]);
  const vinculos = async (pacote: string) => Number((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pacote_saloes WHERE pacote_id = $1::uuid`, [pacote])).rows[0].n);
  const pacotes = async () => Number((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pacotes WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0].n);
  assert.equal(await vinculos(c.pacote), 0, "legado: sem salão");
  const antes = await pacotes();
  await recusa(emTransacao(() => duplicarPacoteComercial(tx, c.pacote, { ...ctx(c), motivo: "prova 100" })), /Este pacote ainda não tem salão./);
  assert.equal(await pacotes(), antes, "duplicação desfeita");
  // Alterar (caminho da IA e da API com o campo omitido) também confere o vínculo efetivo.
  const base = { nome: "Festa antiga", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade: [], faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4500.00" }], categorias: [] };
  await recusa(emTransacao(() => salvarPacoteComercial(tx, { ...base, id: c.pacote }, { ...ctx(c), motivo: "prova 100" })), /Este pacote ainda não tem salão./);
  // Criação pela IA (salvar sem id e sem salões) conta como nenhum salão escolhido.
  await recusa(emTransacao(() => salvarPacoteComercial(tx, { ...base, nome: "Festa da IA" }, { ...ctx(c), motivo: "Criação administrativa" })), /Escolha o salão ou os salões deste pacote./);
  assert.equal(await pacotes(), antes, "criação desfeita");
  // Com o salão escolhido, duplicar segue e a cópia leva o salão.
  await emTransacao(() => definirSaloesPacote(tx, c.empresa, c.pacote, [salao.S2]));
  const copia = await emTransacao(() => duplicarPacoteComercial(tx, c.pacote, { ...ctx(c), motivo: "prova 100" }));
  assert.equal(await vinculos(copia.pacote.id), 1);

  // Agenda com um salão: a IA cria sem salão normalmente.
  const u = await cenario(a, 0);
  await emTransacao(() => salvarAgendaEscopo(tx, { ...porSalao([]), capacidadeTipo: "POR_HORARIO", saloes: [],
    horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] }, ctx(u), "CONFIGURACOES"));
  const criado = await emTransacao(() => salvarPacoteComercial(tx, { ...base, nome: "Festa da IA" }, { ...ctx(u), motivo: "Criação administrativa" }));
  assert.equal(await vinculos(criado.pacote.id), 0);
});

/**
 * Porta REAL de pacotes da IA (app/api/admin/inteligencia/operacoes/composicao.ts), carregada com os serviços de pacote e
 * de agenda reais; os demais imports da composition root não participam destas chamadas e entram como módulos vazios.
 */
type PortaIa = {
  editarNaoUtilizado: (t: DbExecutor, id: string, dados: Record<string, unknown>, c: ReturnType<typeof ctx> & { motivo?: string }) => Promise<{ id: string }>;
  revisar: (t: DbExecutor, id: string, dados: Record<string, unknown>, c: ReturnType<typeof ctx> & { motivo?: string }) => Promise<{ id: string }>;
};
function portaIa(): PortaIa {
  const arquivo = "app/api/admin/inteligencia/operacoes/composicao.ts";
  const reais: Record<string, unknown> = { "lib/agenda/configuracao-unidade": configuracaoUnidade, "lib/comercial/pacote-comercial": pacoteComercial,
    "lib/comercial/pacote-precos": pacotePrecos, "lib/comercial/pacotes-admin": pacotesAdmin };
  const dubles: Record<string, unknown> = { ...reais };
  for (const [, origem] of readFileSync(arquivo, "utf8").matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)) {
    const chave = origem.startsWith("@/") ? origem.slice(2) : origem.replace(/^(\.\.\/)+/, "");
    if (!(chave in dubles) && !origem.startsWith("node:")) dubles[chave] = {};
  }
  return (carregarModulo(arquivo, dubles) as { portaPacotes: PortaIa }).portaPacotes;
}
const dadosIa = { nome: "Festa antiga (IA)", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80 };

test("IA: editar e revisar pacote antigo sem salão na agenda por salão são recusados; com salão seguem e a sucessora herda", async () => {
  const porta = portaIa();
  const base = await cenario(a, 0);
  // Pacote antigo de verdade: criado pelo serviço comercial (com preço) ANTES de a agenda virar por salão, sem salão.
  const legado = await emTransacao(() => salvarPacoteComercial(tx, { nome: "Festa antiga", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade: [], faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4500.00" }], categorias: [] }, { ...ctx(base), motivo: "Criação administrativa" }));
  const c = { ...base, pacote: legado.pacote.id };
  const { salao, horario } = await agendaPorSalao(c, [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] }]);
  const pacotes = async () => Number((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pacotes WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0].n);
  const nome = async (id: string) => (await a.query<{ nome: string }>(`SELECT nome FROM pacotes WHERE id = $1::uuid`, [id])).rows[0].nome;
  const vinculos = async (id: string) => (await a.query<{ salao_id: string }>(`SELECT salao_id::text FROM pacote_saloes WHERE pacote_id = $1::uuid`, [id])).rows.map((r) => r.salao_id);
  // Editar (pacote ainda não usado) sem salão: recusado, nada muda.
  const nomeAntes = await nome(c.pacote);
  await recusa(emTransacao(() => porta.editarNaoUtilizado(tx, c.pacote, dadosIa, { ...ctx(c), motivo: "prova 100" })), /Este pacote ainda não tem salão./);
  assert.equal(await nome(c.pacote), nomeAntes, "edição desfeita");
  // Revisar (pacote já usado numa festa) sem salão: recusado, nenhuma sucessora.
  await confirmada(c, horario.Tarde, "15:00", "19:00", salao.S1);
  const antes = await pacotes();
  await recusa(emTransacao(() => porta.revisar(tx, c.pacote, dadosIa, { ...ctx(c), motivo: "prova 100" })), /Este pacote ainda não tem salão./);
  assert.equal(await pacotes(), antes, "nenhuma sucessora sem salão");
  // Com salão: a revisão cria a sucessora com o mesmo salão.
  await emTransacao(() => definirSaloesPacote(tx, c.empresa, c.pacote, [salao.S1]));
  const sucessora = await emTransacao(() => porta.revisar(tx, c.pacote, { ...dadosIa, nome: "Festa revisada (IA)" }, { ...ctx(c), motivo: "prova 100" }));
  assert.equal(await pacotes(), antes + 1);
  assert.deepEqual(await vinculos(sucessora.id), [salao.S1]);
  // Controle: vínculo com salão desativado depois é preservado; editar com o campo omitido não apaga nem recusa.
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [salao.S1]);
  await emTransacao(() => porta.editarNaoUtilizado(tx, sucessora.id, { ...dadosIa, nome: "Festa revisada 2 (IA)" }, { ...ctx(c), motivo: "prova 100" }));
  assert.equal(await nome(sucessora.id), "Festa revisada 2 (IA)");
  assert.deepEqual(await vinculos(sucessora.id), [salao.S1]);

  // Controle: agenda com um salão — a IA edita pacote antigo sem salão normalmente.
  const u = await cenario(a, 0);
  await emTransacao(() => salvarAgendaEscopo(tx, { ...porSalao([]), capacidadeTipo: "POR_HORARIO", saloes: [],
    horarios: [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 1, saloes: [] }] }, ctx(u), "CONFIGURACOES"));
  await emTransacao(() => porta.editarNaoUtilizado(tx, u.pacote, dadosIa, { ...ctx(u), motivo: "prova 100" }));
  assert.equal(await nome(u.pacote), dadosIa.nome);
});

test("unidades mistas (uma por salão, outra com um salão): pacote da empresa sem salão é recusado; só os salões da unidade por salão contam", async () => {
  const c = await cenario(a, 2);
  const [porSalaoU, umSalaoU] = c.unidades;
  for (const [unidade, tipo] of [[porSalaoU, "POR_SALAO"], [umSalaoU, "POR_HORARIO"]] as const) {
    await a.query(`INSERT INTO agenda_escopo_config (empresa_id, estabelecimento_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                   VALUES ($1::uuid, $2::uuid, 'FIXO', $3, NULL, 0, $4::uuid)`, [c.empresa, unidade, tipo, c.usuario]);
  }
  const salaoPorSalao = (await a.query<{ id: string }>(`INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, ordem) VALUES ($1::uuid, $2::uuid, 'Salão A', 1) RETURNING id::text AS id`, [c.empresa, porSalaoU])).rows[0].id;
  const salaoUmSalao = (await a.query<{ id: string }>(`INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, ordem) VALUES ($1::uuid, $2::uuid, 'Salão antigo', 1) RETURNING id::text AS id`, [c.empresa, umSalaoU])).rows[0].id;
  const lista = await saloesDaEmpresa(tx, c.empresa);
  assert.deepEqual(lista.map((s) => s.id), [salaoPorSalao], "a tela do pacote mostra só o salão da unidade por salão");
  await recusa(emTransacao(() => definirSaloesPacote(tx, c.empresa, c.pacote, [])), /Escolha o salão ou os salões deste pacote./);
  await recusa(emTransacao(() => definirSaloesPacote(tx, c.empresa, c.pacote, undefined)), /Este pacote ainda não tem salão./);
  await emTransacao(() => definirSaloesPacote(tx, c.empresa, c.pacote, [salaoPorSalao]));
  assert.ok(salaoUmSalao);
});

test("domínio de pacotes (tela/IA/importação): ativar e revisar legado sem salão recusados com rollback; desativar e arquivar livres; corrigir no mesmo salvar", async () => {
  const base = await cenario(a, 0);
  const criar = (nome: string) => emTransacao(() => salvarPacoteComercial(tx, { nome, descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade: [], faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4500.00" }], categorias: [] }, { ...ctx(base), motivo: "Criação administrativa" }));
  // Legados criados ANTES de a agenda virar por salão (sem salão).
  const usado = (await criar("Legado usado")).pacote.id;
  const inativo = (await criar("Legado inativo")).pacote.id;
  const corrigir = (await criar("Legado a corrigir")).pacote.id;
  const c = { ...base, pacote: usado };
  const { salao, horario } = await agendaPorSalao(c, [{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] }]);
  const contexto = { ...ctx(c), motivo: "prova 100" };
  const situacao = async (id: string) => (await a.query<{ ativo: boolean; arquivado: boolean }>(`SELECT ativo, arquivado_em IS NOT NULL AS arquivado FROM pacotes WHERE id = $1::uuid`, [id])).rows[0];
  const total = async () => Number((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM pacotes WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0].n);

  // Desativar é livre; ativar sem salão é recusado e nada muda.
  await emTransacao(() => pacotesAdmin.alterarSituacaoPacoteAdmin(tx, inativo, "desativar", contexto));
  assert.equal((await situacao(inativo)).ativo, false);
  await recusa(emTransacao(() => pacotesAdmin.alterarSituacaoPacoteAdmin(tx, inativo, "ativar", contexto)), /Este pacote ainda não tem salão./);
  assert.equal((await situacao(inativo)).ativo, false, "ativação desfeita");
  // Com o salão, ativar segue; arquivar é livre mesmo sem salão.
  await emTransacao(() => definirSaloesPacote(tx, c.empresa, inativo, [salao.S2]));
  await emTransacao(() => pacotesAdmin.alterarSituacaoPacoteAdmin(tx, inativo, "ativar", contexto));
  assert.equal((await situacao(inativo)).ativo, true);

  // Revisar pela tela (criarRevisaoPacoteAdmin direto, sem a porta da IA) um legado já usado e sem salão: recusado, sem sucessora.
  await confirmada(c, horario.Tarde, "15:00", "19:00", salao.S1);
  const antes = await total();
  await recusa(emTransacao(() => pacotesAdmin.criarRevisaoPacoteAdmin(tx, usado, { nome: "Legado usado v2", descricao: null, duracaoMinutos: 240 }, contexto)), /Este pacote ainda não tem salão./);
  assert.equal(await total(), antes, "sucessora desfeita");
  // Origem usada cujo salão foi DESATIVADO antes da revisão: o vínculo conta, a sucessora herda.
  await emTransacao(() => definirSaloesPacote(tx, c.empresa, usado, [salao.S1]));
  await a.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [salao.S1]);
  const v2 = await emTransacao(() => pacotesAdmin.criarRevisaoPacoteAdmin(tx, usado, { nome: "Legado usado v2", descricao: null, duracaoMinutos: 240 }, contexto));
  const herdados = await a.query<{ salao_id: string }>(`SELECT salao_id::text FROM pacote_saloes WHERE pacote_id = $1::uuid`, [v2.id]);
  assert.deepEqual(herdados.rows.map((r) => r.salao_id), [salao.S1]);
  await a.query(`UPDATE agenda_saloes SET ativo = true WHERE id = $1::uuid`, [salao.S1]);

  // Corrigir um legado (não usado) informando o salão no mesmo salvar: aceito.
  await emTransacao(() => salvarPacoteComercial(tx, { id: corrigir, nome: "Legado corrigido", descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade: [], faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4500.00" }], categorias: [], saloes: [salao.S2] }, contexto));
  const corrigidos = await a.query<{ salao_id: string }>(`SELECT salao_id::text FROM pacote_saloes WHERE pacote_id = $1::uuid`, [corrigir]);
  assert.deepEqual(corrigidos.rows.map((r) => r.salao_id), [salao.S2]);
  // Arquivar é livre mesmo para pacote sem salão (cria um legado novo e arquiva).
  const sem = await a.query<{ id: string }>(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Sem salão', 9, false, true) RETURNING id::text AS id`, [c.empresa, `SEM${Date.now()}`]);
  await emTransacao(() => pacotesAdmin.alterarSituacaoPacoteAdmin(tx, sem.rows[0].id, "arquivar", contexto));
  assert.equal((await situacao(sem.rows[0].id)).arquivado, true);
});

