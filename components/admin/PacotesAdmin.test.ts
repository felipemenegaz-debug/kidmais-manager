import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Pacotes concentra o cadastro e o PDF continua separado", () => {
  const pacotes = readFileSync("components/admin/PacotesAdmin.tsx", "utf8");
  const configuracoes = readFileSync("app/admin/configuracoes/page.tsx", "utf8");
  const navegacao = readFileSync("lib/admin/navegacao.ts", "utf8");
  const catalogo = readFileSync("components/admin/CatalogoEditor.tsx", "utf8");
  const precos = readFileSync("app/admin/configuracoes/tabelas-preco/page.tsx", "utf8");
  assert.match(pacotes, /Salvar pacote/);
  assert.match(pacotes, /Salvar alterações/);
  assert.match(pacotes, /Arquivados/);
  assert.match(pacotes, /Excluir definitivamente/);
  assert.match(pacotes, /DurationField/);
  assert.match(pacotes, /Convidados mínimos/);
  assert.match(pacotes, /O que está incluído/);
  assert.match(pacotes, /\+ Adicionar/);
  assert.match(pacotes, /Itens específicos/);
  assert.doesNotMatch(pacotes, /Cliente escolhe/);
  assert.doesNotMatch(pacotes, /Salvar rascunho|Revisar e aplicar|Motivo da alteração|empresaId|htmlFor="codigo"/);
  assert.doesNotMatch(navegacao, /Tabelas de Preços|tabelas-preco|Recolher menu/);
  assert.match(navegacao, /Itens do Buffet/);
  assert.doesNotMatch(configuracoes, /Tabelas de Preços|tabelas-preco/);
  assert.match(configuracoes, /Itens do Buffet/);
  assert.match(catalogo, /Categorias/);
  assert.match(catalogo, />Itens</);
  assert.match(catalogo, /\+ Nova categoria/);
  assert.match(catalogo, /\+ Novo item/);
  assert.match(catalogo, /Sem categoria/);
  const css = readFileSync("components/admin/catalogo-editor.module.css", "utf8");
  assert.match(css, /max-height: min\(70vh, 520px\)/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.tabela \{[\s\S]*display: none/);
  assert.match(css, /\.cards \{[\s\S]*display: grid/);
  assert.doesNotMatch(catalogo, /Motivo da composição|>Buffet<|>Adicionais</);
  assert.match(precos, /redirect\('\/admin\/configuracoes\/pacotes'\)/);
  assert.doesNotMatch(precos, /TabelasPrecoAdmin/);
});

test("exclusão de pacote usado falha fechada e a cópia leva o sufixo Cópia", async () => {
  const { excluirPacoteArquivadoAdmin, duplicarPacoteAdmin } = await import("../../lib/comercial/pacotes-admin.ts");
  const empresa = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const ctx = { empresaId: empresa, usuarioId: "usuario-1", requestId: "req-1", motivo: "PACOTE_EXCLUIDO" };
  const linha = {
    id, empresa_id: empresa, codigo: "P_TESTE", nome: "Festa", descricao: null, duracao_minutos: 180,
    convidados_minimos: 20, convidados_maximos: 40, ativo: false, vigente: false, arquivado_em: "2026-09-27",
    revisao_anterior_id: null, utilizado: true,
  };
  const usado: { query: (text: string) => Promise<{ rows: object[]; rowCount: number }> } = {
    async query(text: string) {
      if (text.includes("AS utilizado")) return { rows: [linha], rowCount: 1 };
      if (text.includes("pg_constraint")) return { rows: [{ tabela: "fechamentos", coluna: "pacote_id", composto: false }], rowCount: 1 };
      if (text.includes("FROM fechamentos")) return { rows: [{ n: 1 }], rowCount: 1 };
      throw new Error(text);
    },
  };
  await assert.rejects(() => excluirPacoteArquivadoAdmin(usado as never, id, ctx), /festa ou contrato/);

  const copias: string[] = [];
  const livre: { query: (text: string, values?: readonly unknown[]) => Promise<{ rows: object[]; rowCount: number }> } = {
    async query(text: string, values?: readonly unknown[]) {
      if (text.includes("AS utilizado")) return { rows: [{ ...linha, nome: "Festa", arquivado_em: null, vigente: true, utilizado: false }], rowCount: 1 };
      if (text.startsWith("SELECT id FROM empresas")) return { rows: [{ id: empresa }], rowCount: 1 };
      if (text.startsWith("INSERT INTO pacotes")) {
        copias.push(String(values?.[2]));
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
      }
      if (text.includes("to_regclass")) return { rows: [{ ok: false }], rowCount: 1 };
      if (text.startsWith("INSERT INTO auditoria") || text.startsWith("INSERT INTO pacote_") || text.startsWith("INSERT INTO regras_")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(text);
    },
  };
  await duplicarPacoteAdmin(livre as never, id, undefined, { ...ctx, motivo: "PACOTE_DUPLICADO" });
  assert.equal(copias[0], "Festa Cópia");
});
