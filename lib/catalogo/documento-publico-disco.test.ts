import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import type { DbExecutor } from "../db/contracts.ts";

/**
 * PDF público SEM a 128 (bytes no disco): o arquivo gravado só é apagado quando a falha foi antes do COMMIT. Se a
 * transação chegou ao COMMIT e ele falhou sem confirmação, a linha ativa pode existir no banco: o arquivo fica.
 */
type Doc = { publicarPdf(b: Buffer, n: string): Promise<unknown>; diretorioDocumentosPublicos(): string };
const pdf = Buffer.from("%PDF-1.4\n% disco\n%%EOF\n", "latin1");

function carregar(falha: "INSERT" | "COMMIT" | null) {
  const tx: DbExecutor = { async query(sql: string) {
    if (sql.includes("pg_attribute")) return { rows: [{ ok: false }], rowCount: 1 } as never;
    if (falha === "INSERT" && sql.includes("INSERT INTO documentos_publicos")) throw new Error("falhou no INSERT");
    return { rows: [{ id: "d1", sha256: "x" }], rowCount: 1 } as never;
  } };
  const withTransaction = async <T>(work: (t: DbExecutor) => Promise<T>) => {
    const r = await work(tx);
    if (falha === "COMMIT") throw new Error("conexão caiu no COMMIT");
    return r;
  };
  const modulo = path.resolve("lib/catalogo/documento-publico.ts");
  return carregarModulo(modulo, { "db/postgres": { db: () => tx, withTransaction } }) as unknown as Doc;
}

test("sem a 128: falha antes do COMMIT apaga o arquivo; COMMIT incerto preserva; sucesso mantém", async (t) => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), "doc-publico-"));
  const original = process.cwd();
  // Isolamento: com NODE_ENV=production o diretório é o do serviço (/opt/render/...), fora do temporário. O teste fixa um
  // ambiente que não é production, confere que o diretório cai na pasta temporária e restaura tudo no fim.
  const env = process.env as Record<string, string | undefined>;
  const nodeEnv = env.NODE_ENV;
  // A limpeza é registrada antes da primeira alteração: se carregar ou chdir lançar, NODE_ENV, cwd e a pasta voltam.
  t.after(() => {
    try {
      process.chdir(original);
    } finally {
      if (nodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = nodeEnv;
      rmSync(pasta, { recursive: true, force: true });
    }
  });
  env.NODE_ENV = "test";
  const docs = { ok: carregar(null), antes: carregar("INSERT"), commit: carregar("COMMIT") };
  process.chdir(pasta);
  const destino = path.join(pasta, "data", "documentos-publicos");
  // Mesmo diretório, pela regra de caminhos da plataforma (sem toLowerCase: no Linux, pasta irmã com outra caixa não passa).
  assert.equal(path.relative(destino, path.resolve(docs.ok.diretorioDocumentosPublicos())), "", "grava só na pasta temporária");
  const arquivos = () => readdirSync(destino);

  await docs.ok.publicarPdf(pdf, "tabela.pdf");
  assert.equal(arquivos().length, 1, "publicado: arquivo no disco");

  await assert.rejects(docs.antes.publicarPdf(pdf, "tabela.pdf"), /falhou no INSERT/);
  assert.equal(arquivos().length, 1, "falha antes do COMMIT: o arquivo novo sai");

  await assert.rejects(docs.commit.publicarPdf(pdf, "tabela.pdf"), /conexão caiu no COMMIT/);
  assert.equal(arquivos().length, 2, "COMMIT incerto: o arquivo fica (a linha ativa pode apontar para ele)");
});
