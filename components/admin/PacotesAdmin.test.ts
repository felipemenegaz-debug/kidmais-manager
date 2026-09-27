import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Pacotes é uma área nova e o PDF continua Tabela de pacotes", () => {
  const pacotes = readFileSync("components/admin/PacotesAdmin.tsx", "utf8");
  const configuracoes = readFileSync("app/admin/configuracoes/page.tsx", "utf8");
  const pdf = readFileSync("components/admin/TabelaPacotesPdf.tsx", "utf8");
  assert.match(pacotes, /Criar revisão/);
  assert.match(pacotes, /Arquivar/);
  assert.equal(pacotes.includes(">Excluir<"), false);
  assert.match(configuracoes, /PDF de Pacotes e Preços/);
  assert.match(configuracoes, /route:'pacotes'/);
  assert.match(pdf, /Tabela de pacotes/);
});

test('criação não pede código, motivo nem empresa; preserva controles de edição', () => {
  const tela=readFileSync('components/admin/PacotesAdmin.tsx','utf8');
  assert.doesNotMatch(tela,/htmlFor="codigo"|setEmpresaId|Duração em minutos/);
  assert.match(tela,/atual && <label htmlFor="pacote-motivo"/);
  assert.match(tela,/DurationField/);
  assert.match(tela,/formatarDuracao\(p.duracaoMinutos\)/);
});
