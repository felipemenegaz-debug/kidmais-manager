import test from "node:test";
import assert from "node:assert/strict";
import type { DbExecutor } from "../db/contracts.ts";
import { estadoDocumental, estadoNaoServe, type EstadoDocumental } from "./estado-documental.ts";
import type { CaminhoSalao } from "./escrever-salao.ts";

/**
 * Plano "liberar agenda com mais de um salão" (D-LIB-4, rev. 4/5): classificação do leitor sem banco (C''16 em forma
 * unitária). Os negativos da conferência em papel por SQL (vínculo de outra versão, contrato ou empresa) e a leitura sob
 * as travas reais ficam na bateria PG.
 */
type Cena = {
  contrato?: boolean; status?: string; vigente?: string | null; preparacao?: string | null;
  versao?: { numero?: number; status: string; schema?: number; salao?: string | null; aceite?: string | null; contrato?: string };
  partes?: string[]; vinculo?: boolean; edicao?: string | null;
  revisao?: { versao: string; base: string; salaoBase: string | null; destino: string | null } | null;
  festa?: { data: string; inicio: string; fim: string; cfg: string };
};
const EVENTO = { data: "2026-12-05", horarioInicio: "15:00", horarioFim: "19:00", configuracaoAgendaId: "cfg" };
const snapshot = (schema: number, salao: string | null) => ({ schemaVersao: schema, evento: { ...EVENTO, salao: salao ? { id: salao, nome: salao } : null } });

function banco(c: Cena) {
  const sqls: Array<{ sql: string; valores: readonly unknown[] }> = [];
  const tx = {
    async query(sql: string, valores: readonly unknown[] = []) {
      sqls.push({ sql, valores });
      const r = (rows: object[]) => ({ rows, rowCount: rows.length });
      if (sql.includes("AS contrato_id, c.status")) return r(c.contrato === false ? [] : [{ contrato_id: "c", status: c.status ?? "ASSINADO", vigente: c.vigente ?? null, preparacao: c.preparacao ?? null, empresa: "e" }]);
      if (sql.includes("status = 'ATIVA' ORDER BY numero_versao")) return r(c.versao?.status === "ATIVA" ? [{ id: "v" }] : []);
      if (sql.includes("FROM fechamento_revisoes r LEFT JOIN contrato_versoes b")) {
        const rv = c.revisao;
        return r(rv ? [{ salao_id: rv.destino, versao: rv.versao, base_id: rv.base, base: snapshot(3, rv.salaoBase) }] : []);
      }
      if (sql.includes("FROM contrato_versoes WHERE id = $1::uuid")) {
        const v = c.versao;
        return r(v ? [{ id: valores[0], numero: v.numero ?? 1, status: v.status, schema: v.schema ?? 3, snapshot: snapshot(v.schema ?? 3, v.salao ?? null), aceite: v.aceite ?? null, contrato: v.contrato ?? "c" }] : []);
      }
      if (sql.includes("FROM contrato_assinaturas")) return r((c.partes ?? []).map((parte) => ({ parte })));
      if (sql.includes("FROM contrato_importacoes i")) return r([{ ok: c.vinculo === true }]);
      if (sql.includes("FROM contrato_edicoes")) return r(c.edicao ? [{ estado: c.edicao }] : []);
      if (sql.includes("FROM fechamentos WHERE id = $1::uuid")) return r([c.festa ?? { data: "2026-12-05", inicio: "15:00:00", fim: "19:00:00", cfg: "cfg" }]);
      throw new Error("consulta inesperada: " + sql);
    },
  } as unknown as DbExecutor;
  return { tx, sqls };
}
const ler = (c: Cena, versaoId?: string) => estadoDocumental(banco(c).tx, { fechamentoId: "f", versaoId });
const papel = (e: EstadoDocumental) => (e.contrato === "COM_CONTRATO" ? e.versao?.papel : e.contrato);
const DUPLA = ["CLIENTE", "KIDMAIS"];

test("papéis: vigente, assinada em aplicação, em preparação, emitida aguardando; sem contrato", async () => {
  assert.equal(papel(await ler({ contrato: false })), "SEM_CONTRATO");
  const vigente = await ler({ vigente: "v", versao: { status: "ASSINADA" }, partes: DUPLA });
  assert.equal(papel(vigente), "VIGENTE");
  assert.equal(vigente.contrato === "COM_CONTRATO" && vigente.versao?.assinatura, "NATIVA_DUPLA");
  assert.equal(papel(await ler({ preparacao: "v", versao: { status: "ASSINADA" }, partes: DUPLA })), "ASSINADA_EM_APLICACAO");
  assert.equal(papel(await ler({ vigente: "antiga", preparacao: "v", versao: { status: "ASSINADA" }, partes: DUPLA }, "v")), "ASSINADA_EM_APLICACAO");
  const prep = await ler({ preparacao: "v", versao: { status: "ATIVA" }, partes: ["KIDMAIS"], edicao: "AGUARDANDO_CLIENTE" });
  assert.equal(papel(prep), "EM_PREPARACAO", "a prova KIDMAIS pode existir");
  assert.equal(prep.contrato === "COM_CONTRATO" && prep.versao?.edicaoAguardandoCliente, true);
  assert.equal(papel(await ler({ versao: { status: "ATIVA" } })), "EMITIDA_AGUARDANDO");
});

test("consistência primeiro: ASSINADA sem prova válida é INCONSISTENTE em qualquer ponteiro; prova CLIENTE sem ASSINADA também", async () => {
  for (const ponteiro of [{ vigente: "v" }, { preparacao: "v" }, {}]) {
    assert.equal(papel(await ler({ ...ponteiro, versao: { status: "ASSINADA" }, partes: ["KIDMAIS"] }, "v")), "INCONSISTENTE", JSON.stringify(ponteiro));
    assert.equal(papel(await ler({ ...ponteiro, versao: { status: "ASSINADA" }, partes: [] }, "v")), "INCONSISTENTE", "sem prova nenhuma");
  }
  assert.equal(papel(await ler({ preparacao: "v", versao: { status: "ATIVA" }, partes: ["CLIENTE"] })), "INCONSISTENTE");
  assert.equal(papel(await ler({ vigente: "v", versao: { status: "ASSINADA", contrato: "outro" }, partes: DUPLA })), "INCONSISTENTE", "versão de outro contrato");
  assert.equal(papel(await ler({ preparacao: "outra", versao: { status: "SUBSTITUIDA" } }, "v")), "INCONSISTENTE", "nenhum papel");
});

test("rodada 2 (P3): versão terminal (CANCELADA/SUBSTITUIDA) é INCONSISTENTE com ou sem cada ponteiro e com qualquer prova; nenhum caminho a aceita", async () => {
  const provas: Array<[string, Partial<Cena>, Partial<NonNullable<Cena["versao"]>>]> = [
    ["nativa", { partes: DUPLA }, {}], ["só KIDMAIS", { partes: ["KIDMAIS"] }, {}], ["sem prova", { partes: [] }, {}],
    ["papel", { partes: [], vinculo: true }, { aceite: "CONFERENCIA_PAPEL", numero: 1 }],
  ];
  const caminhos: CaminhoSalao[] = ["CONFIRMACAO_PAGAMENTO", "FORMALIZACAO_PRE_ASSINATURA", "FORMALIZACAO_POS_ASSINATURA", "APLICACAO_REVISAO_INICIAL", "INTEGRACAO_IMPORTADO"];
  let n = 0;
  for (const status of ["CANCELADA", "SUBSTITUIDA"]) for (const ponteiro of [{ vigente: "v" }, { preparacao: "v" }, { vigente: "v", preparacao: "v" }, {}])
  for (const [nome, cena, versao] of provas) {
    const e = await ler({ ...ponteiro, ...cena, versao: { status, salao: "S1", ...versao } }, "v");
    const rotulo = `${status} ${JSON.stringify(ponteiro)} ${nome}`;
    assert.equal(papel(e), "INCONSISTENTE", rotulo);
    for (const caminho of caminhos) assert.notEqual(estadoNaoServe(e, caminho), null, `${rotulo} ${caminho}`);
    n++;
  }
  assert.equal(n, 32);
  // Controle: a mesma versão ASSINADA nativa e vigente segue VIGENTE (a regra nova só pega os terminais).
  assert.equal(papel(await ler({ vigente: "v", versao: { status: "ASSINADA" }, partes: DUPLA }, "v")), "VIGENTE");
});

test("conferência em papel: positiva só com ASSINADA, aceite CONFERENCIA_PAPEL, versão 1, sem assinaturas e com vínculo", async () => {
  const papelOk = { vigente: "v", versao: { status: "ASSINADA", aceite: "CONFERENCIA_PAPEL", numero: 1 }, partes: [], vinculo: true };
  const ok = await ler(papelOk);
  assert.equal(ok.contrato === "COM_CONTRATO" && ok.versao?.assinatura, "CONFERENCIA_PAPEL");
  assert.equal(papel(ok), "VIGENTE");
  const b = banco(papelOk);
  await estadoDocumental(b.tx, { fechamentoId: "f" });
  assert.deepEqual(b.sqls.find((q) => q.sql.includes("FROM contrato_importacoes i"))!.valores, ["c", "v", "e", "f"], "vínculo do mesmo contrato, versão, empresa e festa");
  const negativos: Array<[string, Cena]> = [
    ["aceite diferente", { ...papelOk, versao: { ...papelOk.versao, aceite: "OTP" } }],
    ["versão 2", { ...papelOk, versao: { ...papelOk.versao, numero: 2 } }],
    ["com linha em contrato_assinaturas", { ...papelOk, partes: ["KIDMAIS"] }],
    ["vínculo ausente (ou de outra versão, contrato ou empresa)", { ...papelOk, vinculo: false }],
  ];
  for (const [caso, cena] of negativos) assert.equal(papel(await ler(cena)), "INCONSISTENTE", caso);
});

test("referência: base da revisão operacional aberta (salão da base) e conferência contra a festa", async () => {
  const base = await ler({ vigente: "b", preparacao: "v", versao: { status: "ATIVA", salao: "B" }, edicao: "AGUARDANDO_CLIENTE",
    revisao: { versao: "v", base: "b", salaoBase: "A", destino: "B" } }, "v");
  assert.deepEqual(base.contrato === "COM_CONTRATO" && base.referencia, { tipo: "BASE_REVISAO_OPERACIONAL", baseId: "b", salaoBase: "A" });
  assert.equal(base.contrato === "COM_CONTRATO" && base.destinoRevisao, "B");
  const propria = await ler({ vigente: "v", versao: { status: "ASSINADA", salao: "A" }, partes: DUPLA });
  assert.deepEqual(propria.contrato === "COM_CONTRATO" && propria.referencia, { tipo: "PROPRIA", salaoId: "A" });
  assert.equal(propria.contrato === "COM_CONTRATO" && propria.conferencia, "CONFERE");
  const mudou = await ler({ vigente: "v", versao: { status: "ASSINADA", salao: "A" }, partes: DUPLA, festa: { data: "2026-12-06", inicio: "15:00:00", fim: "19:00:00", cfg: "cfg" } });
  assert.equal(mudou.contrato === "COM_CONTRATO" && mudou.conferencia, "DESATUALIZADA");
  const v1 = await ler({ vigente: "v", versao: { status: "ASSINADA", schema: 1 }, partes: DUPLA, festa: { data: "2026-12-06", inicio: "15:00:00", fim: "19:00:00", cfg: "cfg" } });
  assert.equal(v1.contrato === "COM_CONTRATO" && v1.conferencia, "CONFERE", "documento sem salão não fica desatualizado");
});

test("estado exigido por caminho (mapa fechado)", async () => {
  const sem = await ler({ contrato: false });
  const vigenteNativa = await ler({ vigente: "v", versao: { status: "ASSINADA" }, partes: DUPLA });
  const vigentePapel = await ler({ vigente: "v", versao: { status: "ASSINADA", aceite: "CONFERENCIA_PAPEL" }, partes: [], vinculo: true });
  const emAplicacao = await ler({ preparacao: "v", versao: { status: "ASSINADA" }, partes: DUPLA });
  const aplicacaoComVigente = await ler({ vigente: "antiga", preparacao: "v", versao: { status: "ASSINADA" }, partes: DUPLA }, "v");
  const preparacao = await ler({ preparacao: "v", versao: { status: "ATIVA" }, edicao: "AGUARDANDO_CLIENTE" });
  const preparacaoSemEdicao = await ler({ preparacao: "v", versao: { status: "ATIVA" }, edicao: "EM_REVISAO" });
  const inconsistente = await ler({ vigente: "v", versao: { status: "ASSINADA" }, partes: ["KIDMAIS"] });
  const serve = (e: EstadoDocumental, c: CaminhoSalao) => estadoNaoServe(e, c) === null;
  assert.equal(serve(emAplicacao, "APLICACAO_REVISAO_INICIAL"), true);
  assert.equal(serve(aplicacaoComVigente, "APLICACAO_REVISAO_INICIAL"), false, "revisão inicial exige nenhuma vigente");
  assert.equal(serve(vigenteNativa, "APLICACAO_REVISAO_INICIAL"), false, "mutante: revisão inicial exigir VIGENTE");
  assert.equal(serve(aplicacaoComVigente, "APLICACAO_REVISAO_OPERACIONAL"), true);
  assert.equal(serve(preparacao, "FORMALIZACAO_PRE_ASSINATURA"), true);
  assert.equal(serve(preparacaoSemEdicao, "FORMALIZACAO_PRE_ASSINATURA"), false);
  assert.equal(serve(emAplicacao, "FORMALIZACAO_PRE_ASSINATURA"), false, "mutante: 4a exigir ASSINADA_EM_APLICACAO");
  assert.equal(serve(vigenteNativa, "FORMALIZACAO_POS_ASSINATURA"), true);
  assert.equal(serve(vigentePapel, "FORMALIZACAO_POS_ASSINATURA"), false, "pós-assinatura exige dupla prova nativa");
  assert.equal(serve(vigentePapel, "INTEGRACAO_IMPORTADO"), true);
  assert.equal(serve(vigenteNativa, "INTEGRACAO_IMPORTADO"), false);
  assert.equal(serve(sem, "CONFIRMACAO_PAGAMENTO"), true);
  assert.equal(serve(vigentePapel, "CONFIRMACAO_PAGAMENTO"), true, "vigente com qualquer prova válida");
  assert.equal(serve(sem, "FORMALIZACAO_POS_ASSINATURA"), false);
  for (const c of ["EMISSAO", "PREPARACAO_REVISAO", "CONFIRMACAO_PAGAMENTO", "FORMALIZACAO_POS_ASSINATURA", "INTEGRACAO_IMPORTADO"] as const)
    assert.equal(estadoNaoServe(inconsistente, c), "INCONSISTENTE", c);
});
