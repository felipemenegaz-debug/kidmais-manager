import assert from "node:assert/strict";
import test from "node:test";
import { CNPJ_CONTRATADA, importacaoPj, PF } from "../../importacao-contrato/apoio-entrega-a.test.ts";
import { referenciaDoModeloPublicado } from "../../importacao-contrato/modelo-referencia.ts";
import { extrairDocumento } from "../documentos/extrair.ts";
import { classificar } from "../gateway.ts";
import { InteligenciaError } from "../politica.ts";
import { criarAcaoImportacao, type PortaImportacao } from "./acao.ts";

/** Entrega A na camada de IA: o modelo da empresa vai ao provedor só como cláusulas; contratante PJ é recusado com 409 antes de gravar. */
test("modelo da empresa vai ao provedor só como cláusulas (sem PDF original, sem dado pessoal do modelo)", async () => {
  const enviados: unknown[] = [];
  const roteador = {
    disponivelPara: () => true,
    async executar(pedido: { mensagens: Array<{ papel: string; conteudo: string }> }) {
      enviados.push(...pedido.mensagens);
      return { ok: false as const, causa: "TESTE", usos: [] };
    },
  };
  const bytes = new TextEncoder().encode("%PDF-1.4");
  const r = await extrairDocumento({
    arquivo: { contentType: "application/pdf", bytes, nomeSeguro: "c.pdf", tamanhoBytes: bytes.length } as never,
    roteador: roteador as never, envioExterno: true, alvo: {} as never,
    modelo: { id: "m1", versao: 3, textos: ["CONTRATANTE: {{contratante.nome}}, CPF {{contratante.cpf}}."] },
    lerPdf: async () => ({ paginas: PF, avisos: [], interrompido: null }),
  });
  const usuario = JSON.parse((enviados.find((m) => (m as { papel: string }).papel === "user") as { conteudo: string }).conteudo);
  assert.deepEqual(usuario.modeloDaEmpresa, { clausulas: ["CONTRATANTE: {{contratante.nome}}, CPF {{contratante.cpf}}."] });
  assert.equal(JSON.stringify(usuario).includes("%PDF"), false);
  assert.deepEqual(r.modeloReferencia, { id: "m1", versao: 3 });
});

test("PJ_INDISPONIVEL nas duas confirmações (registro e conclusão integrada): 409 com motivo, nada é gravado", async () => {
  const gravados: string[] = [];
  const importacao = importacaoPj();
  const porta = {
    async lerImportacao() { return structuredClone(importacao); },
    async analisarCliente() { return { cpfExistente: null, possiveisDuplicidades: [] }; },
    async executar() { gravados.push("cliente"); return { clienteId: "c", clienteAcao: "CRIAR" as const, pendencias: [] }; },
    completa: {
      async opcoes() { return {}; },
      async simular() { gravados.push("simular"); throw new Error("não deveria simular"); },
      async confirmar() { gravados.push("integrar"); return { contratoId: "k" }; },
    },
  } as unknown as PortaImportacao;
  const acao = criarAcaoImportacao(porta);
  const tenant = { empresaComprovada: "e" } as never;
  for (const payload of [
    { importacaoId: importacao.id, versaoImportacao: 4, decisaoCliente: null },
    { importacaoId: importacao.id, versaoImportacao: 4, decisaoCliente: null, integracao: { conferenciaDeclarada: true }, integracaoHash: "a".repeat(64), planoHash: "b".repeat(64) },
  ]) {
    for (const etapa of ["verificar", "executar"] as const) {
      const erro = await (etapa === "verificar" ? acao.verificar!({} as never, tenant, payload as never, { usuarioId: "u", operacaoId: "o" } as never) : acao.executar({} as never, tenant, { ...payload, planoHash: "b".repeat(64) } as never, { usuarioId: "u", operacaoId: "o" } as never)).catch((e: unknown) => e);
      assert.ok(erro instanceof InteligenciaError, `${etapa}: ${String(erro)}`);
      assert.equal(erro.code, "PJ_INDISPONIVEL");
      assert.equal(erro.httpStatus, 409);
      assert.equal(erro.motivo, "ENTREGA_A");
      const falha = classificar(erro);
      assert.deepEqual([falha.status, falha.codigo, falha.motivo], [409, "PJ_INDISPONIVEL", "ENTREGA_A"]);
    }
  }
  assert.deepEqual(gravados, [], "nenhum cadastro, simulação ou integração com contratante PJ");
});


test("rodada 2, P2-5: do modelo publicado ao provedor, só as cláusulas sem dado literal (título, preâmbulo e observações nunca saem)", async () => {
  const conteudo = {
    titulo: "SENTINELA-TITULO", preambulo: ["SENTINELA-PREAMBULO paula@example.com"], observacoes: ["SENTINELA-OBS 999.888.777-66"],
    contratada: { nome: "Buffet Alegria", documento: CNPJ_CONTRATADA },
    clausulas: [{ titulo: "Das partes", texto: "CONTRATANTE: {{contratante.nome}}, CPF {{contratante.cpf}}. Contato do buffet: (61) 3333-4444." }],
  };
  const { modelo } = referenciaDoModeloPublicado({ id: "m1", versao: 4, conteudo });
  const enviados: Array<{ papel: string; conteudo: string }> = [];
  const roteador = { disponivelPara: () => true, async executar(pedido: { mensagens: Array<{ papel: string; conteudo: string }> }) { enviados.push(...pedido.mensagens); return { ok: false as const, causa: "TESTE", usos: [] }; } };
  const bytes = new TextEncoder().encode("%PDF-1.4");
  await extrairDocumento({
    arquivo: { contentType: "application/pdf", bytes, nomeSeguro: "c.pdf", tamanhoBytes: bytes.length } as never,
    roteador: roteador as never, envioExterno: true, alvo: {} as never, modelo,
    lerPdf: async () => ({ paginas: PF, avisos: [], interrompido: null }),
  });
  const usuario = JSON.parse(enviados.find((m) => m.papel === "user")!.conteudo);
  assert.deepEqual(usuario.modeloDaEmpresa, { clausulas: ["Das partes", "CONTRATANTE: {{contratante.nome}}, CPF {{contratante.cpf}}. Contato do buffet: [dado]."] });
  assert.equal(/SENTINELA|999.888|paula@/.test(JSON.stringify(usuario.modeloDaEmpresa)), false);
});

test("rodada 3, P2: CNPJ alfanumérico com e sem máscara não chega ao provedor", async () => {
  const conteudo = { contratada: { documento: CNPJ_CONTRATADA }, clausulas: [{ titulo: null, texto: "Contratada CNPJ 12ABC34501DE35 (ou 12.ABC.345/01DE-35), contratante {{contratante.nome}}." }] };
  const { modelo } = referenciaDoModeloPublicado({ id: "m1", versao: 1, conteudo });
  const enviados: Array<{ papel: string; conteudo: string }> = [];
  const roteador = { disponivelPara: () => true, async executar(pedido: { mensagens: Array<{ papel: string; conteudo: string }> }) { enviados.push(...pedido.mensagens); return { ok: false as const, causa: "TESTE", usos: [] }; } };
  const bytes = new TextEncoder().encode("%PDF-1.4");
  await extrairDocumento({
    arquivo: { contentType: "application/pdf", bytes, nomeSeguro: "c.pdf", tamanhoBytes: bytes.length } as never,
    roteador: roteador as never, envioExterno: true, alvo: {} as never, modelo,
    lerPdf: async () => ({ paginas: PF, avisos: [], interrompido: null }),
  });
  const clausulas = JSON.stringify(JSON.parse(enviados.find((m) => m.papel === "user")!.conteudo).modeloDaEmpresa);
  assert.equal(/12ABC34501DE35|12\.ABC\.345/i.test(clausulas), false, clausulas);
  assert.match(clausulas, /Contratada CNPJ \[dado\] \(ou \[dado\]\), contratante \{\{contratante\.nome\}\}\./);
});
