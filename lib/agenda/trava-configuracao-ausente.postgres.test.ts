import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { carregar } from "../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "./trava-configuracao.ts";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 2, bateria D'), no PostgreSQL DESCARTÁVEL (estado atual): cada helper
 * protegido chamado numa transação SEM a trava da configuração lança TRAVA_CONFIGURACAO_AUSENTE antes de qualquer outra
 * coisa; com a trava de OUTRA empresa também; com a trava certa, a guarda passa (o erro, se houver, é outro: os ids são
 * sintéticos). `travarSaloesDoEscopo` (privado) só é alcançável pelas entradas exclusivas, que tomam a trava antes.
 */
type Helper = { nome: string; empresa: "PARAMETRO" | "ENTRADA"; chamar: (tx: DbExecutor, empresa: string) => Promise<unknown> };

const salaoFesta = carregar<typeof import("./salao-festa.ts")>("lib/agenda/salao-festa.ts");
const troca = carregar<typeof import("./troca-salao.ts")>("lib/agenda/troca-salao.ts");
const preferencia = carregar<typeof import("./preferencia-salao.ts")>("lib/agenda/preferencia-salao.ts");
const repositorio = carregar<typeof import("../contratos/integracao-importados/repositorio.ts")>("lib/contratos/integracao-importados/repositorio.ts");
const legados = carregar<typeof import("../disponibilidade/bloqueios-legados.ts")>("lib/disponibilidade/bloqueios-legados.ts");
const disponibilidade = carregar<typeof import("../disponibilidade/repositories/disponibilidade.repository.ts")>("lib/disponibilidade/repositories/disponibilidade.repository.ts");
const formalizacao = carregar<typeof import("../festas/formalizacao.ts")>("lib/festas/formalizacao.ts");
const revisao = carregar<typeof import("../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");

const id = () => randomUUID();
const HELPERS: Helper[] = [
  { nome: "escolherSalaoParaEmissao", empresa: "ENTRADA", chamar: (tx) => salaoFesta.escolherSalaoParaEmissao(tx, id()) },
  { nome: "escolherSalao", empresa: "ENTRADA", chamar: (tx) => salaoFesta.escolherSalao(tx, id(), { caminho: "APLICACAO_REVISAO_INICIAL", origem: "ACEITE_PUBLICO", exigido: null }) },
  { nome: "escolherSalaoDestinoRevisao", empresa: "ENTRADA", chamar: (tx) => salaoFesta.escolherSalaoDestinoRevisao(tx, id(), "PREPARACAO_REVISAO", "EQUIPE") },
  { nome: "definirSalaoDestinoRevisao", empresa: "ENTRADA", chamar: (tx) => salaoFesta.definirSalaoDestinoRevisao(tx, id(), id(), "PREPARACAO_REVISAO") },
  { nome: "aplicarSalaoDaRevisao", empresa: "ENTRADA", chamar: (tx) => salaoFesta.aplicarSalaoDaRevisao(tx, id(), "APLICACAO_REVISAO_OPERACIONAL", "ACEITE_PUBLICO") },
  { nome: "trocarSalaoDaFesta", empresa: "PARAMETRO", chamar: (tx, e) => troca.trocarSalaoDaFesta(tx, { empresaId: e, usuarioId: null, requestId: null }, id(), id()) },
  { nome: "travarConferenciaPreferencia", empresa: "PARAMETRO", chamar: (tx, e) => preferencia.travarConferenciaPreferencia(tx, e, "2031-03-10") },
  { nome: "travarData (importação)", empresa: "ENTRADA", chamar: (tx) => repositorio.travarData(tx, "2031-03-10") },
  { nome: "liberarBloqueioLegadoPelaEmpresa", empresa: "PARAMETRO", chamar: (tx, e) => legados.liberarBloqueioLegadoPelaEmpresa(tx, { empresaId: e, estabelecimentoId: id() } as never, id(), id(), "Motivo de teste da guarda") },
  { nome: "adquirirLockConfirmacaoAgenda", empresa: "ENTRADA", chamar: (tx) => disponibilidade.adquirirLockConfirmacaoAgenda("2031-03-10", tx) },
  { nome: "bloquearAgendaFormalizacao", empresa: "ENTRADA", chamar: (tx) => formalizacao.bloquearAgendaFormalizacao(tx, id(), id(), { caminho: "FORMALIZACAO_POS_ASSINATURA", origem: "ACEITE_PUBLICO" }) },
  { nome: "bloquearDatasRevisao", empresa: "ENTRADA", chamar: (tx) => revisao.bloquearDatasRevisao(tx, { fechamento_id: id(), operacao: { dataEvento: "2031-03-10" } } as never) },
];

let db: Client;
test.before(async () => { db = await conectarDescartavel(); });
test.after(async () => { await encerrarDescartavel(db); });

async function naTransacao(fn: (tx: DbExecutor) => Promise<void>) {
  await db.query("BEGIN");
  try { await fn(db as unknown as DbExecutor); } finally { await db.query("ROLLBACK"); }
}
const codigo = (e: unknown) => (e as { code?: string })?.code;

for (const h of HELPERS) {
  test(`D': ${h.nome} sem a trava da configuração lança TRAVA_CONFIGURACAO_AUSENTE`, async () => {
    const empresa = randomUUID();
    await naTransacao(async (tx) => {
      // Sem trava nem empresa da entrada.
      await assert.rejects(h.chamar(tx, empresa), (e) => codigo(e) === "TRAVA_CONFIGURACAO_AUSENTE");
    });
    await naTransacao(async (tx) => {
      // Só a variável da entrada, sem a advisory: a guarda confere pg_locks, não a variável.
      await tx.query(`SELECT set_config('kidmais.agenda_config_empresa', $1::text, true)`, [empresa]);
      await assert.rejects(h.chamar(tx, empresa), (e) => codigo(e) === "TRAVA_CONFIGURACAO_AUSENTE");
    });
    await naTransacao(async (tx) => {
      // Trava de OUTRA empresa: para helpers com empresa por parâmetro, a variável aponta a outra; para os da entrada,
      // a variável aponta esta empresa, cuja advisory não foi tomada.
      const outra = randomUUID();
      await travarConfiguracaoAgenda(tx, outra, { modo: "COMPARTILHADA", linha: "JA_TRAVADA" });
      if (h.empresa === "ENTRADA") await tx.query(`SELECT set_config('kidmais.agenda_config_empresa', $1::text, true)`, [empresa]);
      await assert.rejects(h.chamar(tx, empresa), (e) => codigo(e) === "TRAVA_CONFIGURACAO_AUSENTE");
    });
  });

  test(`D' (controle): ${h.nome} com a trava compartilhada da empresa passa da guarda`, async () => {
    const empresa = randomUUID();
    await naTransacao(async (tx) => {
      await travarConfiguracaoAgenda(tx, empresa, { modo: "COMPARTILHADA", linha: "JA_TRAVADA" });
      try { await h.chamar(tx, empresa); } catch (e) {
        assert.notEqual(codigo(e), "TRAVA_CONFIGURACAO_AUSENTE", `${h.nome}: ${(e as Error).message}`);
      }
    });
  });
}

test("D' (controle): a trava exclusiva também satisfaz a guarda", async () => {
  const empresa = randomUUID();
  await naTransacao(async (tx) => {
    await travarConfiguracaoAgenda(tx, empresa, { modo: "EXCLUSIVA", linha: "JA_TRAVADA" });
    await repositorio.travarData(tx, "2031-03-10");
  });
});
