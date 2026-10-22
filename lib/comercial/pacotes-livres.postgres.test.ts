import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { salvarPacoteComercial } from "./pacote-comercial.ts";
import { pacotesDaAgendaDaEmpresa } from "./disponibilidade-pacote-publica.ts";
import { codigoDoPacoteDaTela } from "./pacotes-v1.ts";
import { buscarPacoteVigenteDaEmpresaPorCodigo, listarPacotesContrataveisDaEmpresa } from "./repositories/comercial.repository.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";

/**
 * Pacote criado do zero em Configurações → Pacotes ("Novo pacote", código P_…) no PostgreSQL DESCARTÁVEL (modelo 089):
 *
 *  L1 o código nasce P_<32 hex>, a ordem de exibição conta só os pacotes da empresa e a lista da empresa o inclui;
 *  L2 agenda da administração (pacotesDaAgendaDaEmpresa) = lista da cotação pública: id = código, regras do pacote;
 *  L3 isolamento: a outra empresa não lista nem encontra o código; arquivado/inativo saem da lista e da busca;
 *  L4 cotação (calcularResumoComercial) e fechamento público gravam com o pacote P_ (antes: PACOTE_FORA_ESCOPO_V1);
 *  L5 revisão do pacote já usado: o mesmo código resolve para a nova linha vigente (o uuid muda, o código não).
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
let B: { empresa: string; usuario: string };
let livre: { id: string; codigo: string };

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
  const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [`livre${nome}${sufixo}`.toLowerCase(), `Buffet livre ${nome}`]);
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness pacotes livres', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@example.test`, SENHA]);
  const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id::text AS id`, [e, u]);
  await client.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return { empresa: e, usuario: u };
}

const ctx = (dono: { empresa: string; usuario: string }) => ({ empresaId: dono.empresa, usuarioId: dono.usuario, requestId: randomUUID(), motivo: "Criação administrativa" });

async function novoPacote(dono: { empresa: string; usuario: string }, nome: string, valor: string) {
  return emTransacao(() => salvarPacoteComercial(tx, {
    nome, descricao: "Pacote criado do zero", duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade: [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((horarioId) => ({ dia, horarioId }))),
    faixas: [{ convidadosMin: 30, convidadosMax: 80, valor }], categorias: [],
  }, ctx(dono)));
}

// Serviços com imports no estilo do bundler (sem extensão): carregados pelo carregador de testes, com o banco descartável.
type Servicos = {
  calcularResumoComercial: (input: Record<string, unknown>, db: DbExecutor) => Promise<{ pacote: { valorTabelaAplicado: unknown } }>;
  criarFechamentoPublicoComIdentidade: (input: Record<string, unknown>, db: DbExecutor) => Promise<{ fechamento: { id: string } }>;
};
let servicos: Servicos;

const pular = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel";

test.before(async () => {
  if (pular()) return;
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
  const dubles = { "db/postgres": { db: () => tx, withTransaction: async <T>(fn: (t: DbExecutor) => Promise<T>) => fn(tx) } };
  const cache = new Map();
  servicos = {
    ...(carregarModulo("lib/comercial/services/pricing.service.ts", dubles, cache) as Pick<Servicos, "calcularResumoComercial">),
    ...(carregarModulo("lib/fechamentos/services/fechamento-publico.service.ts", dubles, cache) as Pick<Servicos, "criarFechamentoPublicoComIdentidade">),
  };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("L1–L3: Novo pacote (P_…) entra na lista e na agenda da empresa, na ordem dela, sem vazar para outra", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  turnos = (await client.query<{ id: string }>(`SELECT id::text AS id FROM configuracao_agenda WHERE codigo IN ('TURNO_1', 'TURNO_2') AND ativo ORDER BY codigo`)).rows.map((r) => r.id);
  assert.equal(turnos.length, 2);
  A = await empresa("A"); B = await empresa("B");
  const maxGlobal = Number((await client.query(`SELECT COALESCE(MAX(ordem_exibicao), 0) AS m FROM pacotes`)).rows[0].m);

  const criado = await novoPacote(A, "Festa Jardim", "4500.00");
  livre = { id: criado.pacote.id, codigo: criado.pacote.codigo };
  assert.match(livre.codigo, /^P_[0-9A-F]{32}$/, "L1: código técnico gerado na criação");
  assert.equal(codigoDoPacoteDaTela(livre.codigo, true), livre.codigo, "L1: o código é aceito como id da tela em /b");
  assert.equal(codigoDoPacoteDaTela(livre.codigo, false), null, "L1: endereço atual (dona) continua só com os sete");
  const ordem = (await client.query<{ o: number }>(`SELECT ordem_exibicao AS o FROM pacotes WHERE id = $1::uuid`, [livre.id])).rows[0].o;
  assert.equal(Number(ordem), 1, `L1: primeiro pacote da empresa = ordem 1 (antes: MAX global + 1 = ${maxGlobal + 1})`);
  const segundo = await novoPacote(A, "Festa Noturna", "5200.00");
  assert.equal(Number((await client.query<{ o: number }>(`SELECT ordem_exibicao AS o FROM pacotes WHERE id = $1::uuid`, [segundo.pacote.id])).rows[0].o), 2);
  const deB = await novoPacote(B, "Festa B", "3000.00");
  assert.equal(Number((await client.query<{ o: number }>(`SELECT ordem_exibicao AS o FROM pacotes WHERE id = $1::uuid`, [deB.pacote.id])).rows[0].o), 1, "L1: ordem de B independe de A");

  const listaA = await listarPacotesContrataveisDaEmpresa(A.empresa, tx);
  assert.deepEqual(listaA.map((p) => p.nome), ["Festa Jardim", "Festa Noturna"], "L1: na ordem da tela de Pacotes");
  const agendaA = await pacotesDaAgendaDaEmpresa(tx, A.empresa, listarPacotesContrataveisDaEmpresa);
  assert.deepEqual(agendaA.pacotes, [{ id: livre.codigo, nome: "Festa Jardim", convidadosMinimos: 30, convidadosMaximos: 80 }, { id: segundo.pacote.codigo, nome: "Festa Noturna", convidadosMinimos: 30, convidadosMaximos: 80 }], "L2");
  assert.equal(agendaA.regras[livre.codigo].length, 14, "L2: 7 dias × 2 períodos configurados no Novo pacote");
  assert.ok(agendaA.regras[livre.codigo].every((r) => r.estado === "DISPONIVEL"));

  const listaB = await listarPacotesContrataveisDaEmpresa(B.empresa, tx);
  assert.deepEqual(listaB.map((p) => p.nome), ["Festa B"], "L3: B só vê o dele");
  assert.equal(await buscarPacoteVigenteDaEmpresaPorCodigo(B.empresa, livre.codigo, tx), null, "L3: código de A não resolve em B");
  assert.equal((await buscarPacoteVigenteDaEmpresaPorCodigo(A.empresa, livre.codigo, tx))?.id, livre.id);

  await client.query(`UPDATE pacotes SET ativo = false WHERE id = $1::uuid`, [segundo.pacote.id]);
  assert.deepEqual((await listarPacotesContrataveisDaEmpresa(A.empresa, tx)).map((p) => p.nome), ["Festa Jardim"], "L3: inativo sai da lista");
  assert.equal(await buscarPacoteVigenteDaEmpresaPorCodigo(A.empresa, segundo.pacote.codigo, tx), null, "L3: e da busca");
  const vazia = await empresa("C");
  assert.deepEqual(await listarPacotesContrataveisDaEmpresa(vazia.empresa, tx), [], "buffet novo: nenhum pacote");
});

test("L4–L5: cotação e fechamento público com o pacote P_; revisão mantém o código", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  assert.ok(livre, "depende do cenário L1–L3");
  const turno = turnos[0];
  const data = "2098-09-12";
  const resumo = await servicos.calcularResumoComercial({ data, configuracaoAgendaId: turno, pacoteId: livre.id, convidados: 40, adicionais: [], empresaEsperada: A.empresa }, tx);
  assert.equal(Number(resumo.pacote.valorTabelaAplicado), 4500, "L4: preço da faixa do Novo pacote");
  await assert.rejects(
    servicos.calcularResumoComercial({ data, configuracaoAgendaId: turno, pacoteId: livre.id, convidados: 40, adicionais: [], empresaEsperada: B.empresa }, tx),
    /PACOTE_NAO_ENCONTRADO|não existe/, "L4: cotação pela outra empresa recusa",
  );

  const cpf = cpfValido();
  const dadosFechamento = (cpfDoCliente: string, empresaEsperada: string) => ({
    dataEvento: data, horarioInicio: "11:00", horarioFim: "15:00", configuracaoAgendaId: turno, pacoteId: livre.id,
    convidados: 40, adicionais: [], valorProposto: 4500, buffetStatus: "PENDENTE", empresaEsperada,
    identidade: { tipo: "NOVO_CLIENTE" },
    cliente: { nomeCompleto: "Cliente Sintético Pacote Livre", cpf: cpfDoCliente, telefone: "00000000002", whatsapp: "00000000003",
      email: `pacote.livre.${cpfDoCliente}@example.invalid`, cep: "00000000", logradouro: "Avenida Sintética", numero: "100", complemento: null,
      bairro: "Bairro Sintético", cidade: "Cidade de Homologação", uf: "SP" },
    aniversariante: { nome: "Aniversariante Teste", temaPadrao: "Teste" },
    cpfSemRevelarCadastro: true,
  });
  await assert.rejects(emTransacao(() => servicos.criarFechamentoPublicoComIdentidade(dadosFechamento(cpfValido(), B.empresa), tx)),
    /PACOTE_FORA_ESCOPO_V1|não está disponível/, "L4: segunda barreira — pacote de A com a empresa do endereço B é recusado");
  const criado = await emTransacao(() => servicos.criarFechamentoPublicoComIdentidade(dadosFechamento(cpf, A.empresa), tx));
  assert.ok(criado.fechamento.id, "L4: fechamento gravado (antes: PACOTE_FORA_ESCOPO_V1)");
  const gravado = (await client.query<{ pacote_id: string; codigo: string | null }>(
    `SELECT f.pacote_id::text AS pacote_id,
            (SELECT s.codigo_aplicado FROM fechamento_pacote_snapshots s WHERE s.fechamento_id = f.id LIMIT 1) AS codigo
       FROM fechamentos f WHERE f.id = $1::uuid`, [criado.fechamento.id])).rows[0];
  assert.equal(gravado.pacote_id, livre.id, "L4: FK para a linha vigente do pacote");
  assert.equal(gravado.codigo, livre.codigo, "L4: snapshot com o código P_");

  // L5 — o pacote agora está em uso: editar cria uma revisão (nova linha vigente, mesmo código), mantendo os mesmos dias
  // e horários (possível desde a correção da vigência sobreposta, PR #204).
  const revisado = await emTransacao(() => salvarPacoteComercial(tx, {
    id: livre.id, nome: "Festa Jardim 2", descricao: "Revisado", duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade: [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => turnos.map((horarioId) => ({ dia, horarioId }))),
    faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4800.00" }], categorias: [],
  }, ctx(A)));
  const vigente = await buscarPacoteVigenteDaEmpresaPorCodigo(A.empresa, livre.codigo, tx);
  assert.ok(vigente, "L5: o código continua resolvendo");
  assert.equal(vigente.codigo, livre.codigo);
  assert.equal(vigente.nome, "Festa Jardim 2");
  assert.notEqual(vigente.id, livre.id, "L5: pacote usado → revisão com uuid novo");
  assert.equal(revisado.pacote.codigo, livre.codigo, "L5: revisão com o mesmo código");
  const agenda = await pacotesDaAgendaDaEmpresa(tx, A.empresa, listarPacotesContrataveisDaEmpresa);
  assert.deepEqual(agenda.pacotes, [{ id: livre.codigo, nome: "Festa Jardim 2", convidadosMinimos: 30, convidadosMaximos: 80 }], "L5: a agenda segue pelo código");
  assert.equal(agenda.regras[livre.codigo].length, 14, "L5: a revisão mantém os 7 dias × 2 períodos");
});
