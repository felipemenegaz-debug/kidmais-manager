import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import {
  ambienteAssinatura, carregar, cenario, ctxIntegracao, decisoes, dia, executor, importacao, PARCIAL, poolNaTransacao, type Cenario, type Servico,
} from "../../scripts/integracao-importados-test-support.ts";
import {
  cancelarDesativacao, criarSalaoCombinado, definirSaloesPacote, desativarHorarioAPartirDe, desativarSalao, lerAgendaEscopo, salvarAgendaEscopo,
  type SalvarAgenda,
} from "./configuracao-unidade.ts";
import { pacoteSemSalaoNaAgendaPorSalao } from "./salao-do-pacote.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 7, bateria D''), no PostgreSQL DESCARTÁVEL (modelo 114): cada entrada
 * que toma a configuração da agenda é chamada pelo serviço real e o SQL que ELA emite é gravado na conexão (o executor do
 * serviço, o pool dublado e o carregador de testes passam todos por `a.query`). Regra: a primeira trava da configuração
 * (CONFIG) vem antes do primeiro comando AGENDA/LINHA da entrada, com a classificação da guarda dinâmica
 * (`classificarComando`, a mesma do preload). A guarda da regressão completa só atribui parte das entradas (a pilha passa
 * pelo carregador de testes e as fixtures abrem a transação com a trava); esta suíte cobre as restantes uma a uma.
 * Recusas depois da trava valem: o que importa é a ordem do que a entrada chegou a emitir.
 */
const req = createRequire(import.meta.url);
const { classificarComando } = req("../../scripts/guarda-salao-harness.cjs") as { classificarComando: (texto: string) => "CONFIG" | "AGENDA" | "LINHA" | null };

let a: Client;
const TODOS = [1, 2, 3, 4, 5, 6, 7];
const LIBERADA = { maisDeUmSalaoLiberada: true };
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() });

type Gravado = { classe: "CONFIG" | "AGENDA" | "LINHA"; texto: string };
/** Executa `corpo` gravando as classes de cada comando emitido na conexão; devolve a gravação e o desfecho. */
async function gravando(corpo: () => Promise<unknown>) {
  const original = a.query;
  const gravados: Gravado[] = [];
  a.query = function (this: Client, ...args: unknown[]) {
    const texto = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
    const classe = classificarComando(texto);
    if (classe) gravados.push({ classe, texto: texto.replace(/\s+/g, " ").slice(0, 140) });
    return (original as (...x: unknown[]) => unknown).apply(this, args);
  } as typeof a.query;
  let erro: unknown = null;
  try {
    await a.query("SAVEPOINT entrada_d2");
    await corpo();
    await a.query("RELEASE SAVEPOINT entrada_d2");
  } catch (e) {
    erro = e;
    await (original as (...x: unknown[]) => Promise<unknown>).call(a, "ROLLBACK TO SAVEPOINT entrada_d2");
  } finally {
    a.query = original;
  }
  return { gravados, erro };
}

/** D'': CONFIG presente e antes do primeiro AGENDA/LINHA; `exigirTrava` = a entrada precisa ter chegado a travar agenda/linha. */
async function ordem(nome: string, corpo: () => Promise<unknown>, opcoes: { exigirTrava?: boolean; aceitarErro?: RegExp } = {}) {
  const { gravados, erro } = await gravando(corpo);
  if (erro && !(opcoes.aceitarErro && opcoes.aceitarErro.test(erro instanceof Error ? erro.message : String(erro)))) throw erro;
  const config = gravados.findIndex((g) => g.classe === "CONFIG");
  const primeira = gravados.findIndex((g) => g.classe !== "CONFIG");
  assert.ok(config >= 0, `${nome}: sem a trava da configuração (${JSON.stringify(gravados.slice(0, 3))})`);
  if (primeira >= 0) assert.ok(config < primeira, `${nome}: ${gravados[primeira]!.classe} antes da configuração: ${gravados[primeira]!.texto}`);
  if (opcoes.exigirTrava) assert.ok(primeira >= 0, `${nome}: a entrada não chegou a travar agenda/linha; a prova não exercita a ordem`);
  return { travou: primeira >= 0, erro };
}

async function emTransacao<T>(corpo: () => Promise<T>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    return await corpo();
  } finally {
    await a.query("ROLLBACK");
    restaurarAmbiente();
    restaurarPool();
  }
}

const porSalao = (horarios: SalvarAgenda["horarios"]): SalvarAgenda => ({
  versaoEsperada: null, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_SALAO", limiteFestasDia: null, intervaloMinimoMinutos: 0,
  saloes: [{ nome: "S1", capacidadeConvidados: 50 }, { nome: "S2", capacidadeConvidados: 80 }], horarios,
});

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("D'': cadastro da agenda (save da ida, pacote, salão combinado, desativações): configuração antes de agenda/linha em cada entrada", { timeout: 300_000 }, async () => {
  await emTransacao(async () => {
    const c = await cenario(a, 0);
    const tx: DbExecutor = executor(a);
    let agenda!: Awaited<ReturnType<typeof salvarAgendaEscopo>>;
    await ordem("salvarAgendaEscopo (ida para por salão)", async () => {
      const versaoEsperada = (await lerAgendaEscopo(tx, c.empresa, null)).versaoAgenda;
      agenda = await salvarAgendaEscopo(tx, { ...porSalao([{ nome: "Tarde", inicio: "15:00", fim: "19:00", dias: TODOS, capacidade: 2, saloes: ["S1", "S2"] }]), versaoEsperada },
        ctx(c), "CONFIGURACOES", LIBERADA);
    }, { exigirTrava: true });
    const salao = Object.fromEntries(agenda.saloes.map((s) => [s.nome, s.id!]));
    const horario = agenda.horarios.find((h) => !h.herdado && h.nome === "Tarde")!.id;
    await ordem("pacoteSemSalaoNaAgendaPorSalao", () => pacoteSemSalaoNaAgendaPorSalao(tx, c.empresa, c.pacote));
    // Escritor de pacote: só a configuração (pacote_saloes não é trava de agenda; desvio declarado em salao-do-pacote.ts).
    await ordem("definirSaloesPacote", () => definirSaloesPacote(tx, c.empresa, c.pacote, [salao.S1!]));
    let combinado = "";
    await ordem("criarSalaoCombinado", async () => {
      const r = await criarSalaoCombinado(tx, ctx(c), { estabelecimentoId: null, nome: "Salão inteiro", capacidadeConvidados: 130, membros: [salao.S1!, salao.S2!] });
      combinado = (r as { id: string }).id;
    }, { exigirTrava: true });
    // Horário: só a linha de configuracao_agenda (cadastro, não trava de agenda/linha da guarda); a ordem vale se houver.
    await ordem("desativarHorarioAPartirDe", () => desativarHorarioAPartirDe(tx, ctx(c), horario, "2099-12-31"));
    await ordem("cancelarDesativacao", () => cancelarDesativacao(tx, ctx(c), horario));
    assert.ok(combinado);
    await ordem("desativarSalao (combinado)", () => desativarSalao(tx, ctx(c), combinado), { exigirTrava: true });
  });
});

test("D'': importação (confirmar integração e conferir financeiro) e emissão do contrato: configuração antes de agenda/linha", { timeout: 300_000 }, async () => {
  await emTransacao(async () => {
    const c = await cenario(a, 0);
    const tx = executor(a);
    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const core = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts").coreNativo;
    const ev = { data: dia(120), inicio: "14:00", fim: "18:00" };

    // confirmarIntegracao: festa futura que ocupa a agenda (POR_HORARIO, o caminho de hoje).
    const imp = await importacao(a, c, ev);
    const d = decisoes(c, ev, PARCIAL());
    const sim = await s.simularIntegracao(tx, c.tenant as never, imp.id, d, dia(0));
    assert.ok(sim.pronto, JSON.stringify(sim.bloqueios));
    let contratoId = "";
    await ordem("confirmarIntegracao", async () => {
      const r = await s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), imp.id, { decisoes: d, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), core);
      contratoId = (r as { contratoId: string }).contratoId;
    }, { exigirTrava: true });
    assert.ok(contratoId);

    // conferirFinanceiro: integrada sem conferir o financeiro, depois conferida (como integracao.postgres.test.ts).
    const imp2 = await importacao(a, c, { ...ev, data: dia(121) });
    const d2 = decisoes(c, { ...ev, data: dia(121) }, { situacao: "NAO_CONFERIDO" });
    const sim2 = await s.simularIntegracao(tx, c.tenant as never, imp2.id, d2, dia(0));
    await s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), imp2.id, { decisoes: d2, resumoHash: sim2.resumoHash!, chave: randomUUID() }, dia(0), core);
    const simF = await s.simularFinanceiro(tx, c.tenant as never, imp2.id, PARCIAL(), dia(0));
    await ordem("conferirFinanceiro", () => s.conferirFinanceiro(tx, c.tenant as never, ctxIntegracao(c), imp2.id,
      { financeiro: PARCIAL(), resumoHash: (simF as { resumoHash: string }).resumoHash, chave: randomUUID() }, dia(0), core as never), { exigirTrava: true });

    // gerarContrato (executor do contexto): o fechamento da importação já tem contrato → a recusa vem depois da trava.
    const fechamento = (await a.query<{ f: string }>(`SELECT fechamento_id::text f FROM contratos WHERE id = $1::uuid`, [contratoId])).rows[0]!.f;
    const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
    await ordem("gerarContrato", () => contratos.gerarContrato({ fechamentoId: fechamento } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: tx } as never),
      { aceitarErro: /./ });
  });
});
