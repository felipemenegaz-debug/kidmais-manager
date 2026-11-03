import assert from "node:assert/strict";
import test from "node:test";
import { importacaoPj } from "../../importacao-contrato/apoio-entrega-a.test.ts";
import { criarAcaoImportacao, type PortaImportacao } from "./acao.ts";

/** Entrega B (112) na camada de IA: o plano procura a PJ só pelo CNPJ e só com a 112 (conferida pela porta). */
const CNPJ = "11222333000181";

test("ação: a busca da PJ usa só o CNPJ (nunca o CPF do representante) e só com a 112; sem a 112, nem o CNPJ é consultado", async () => {
  const importacao = importacaoPj();
  for (const disponivel of [true, false]) {
    const analises: unknown[] = [];
    const porta = {
      async lerImportacao() { return structuredClone(importacao); },
      async analisarCliente(_tx: unknown, _e: string, dados: unknown) { analises.push(dados); return { cpfExistente: null, cnpjExistente: null, possiveisDuplicidades: [] }; },
      async pessoaJuridicaDisponivel() { return disponivel; },
    } as unknown as PortaImportacao;
    const acao = criarAcaoImportacao(porta);
    const r = await acao.verificar!({} as never, { empresaComprovada: "e" } as never, { importacaoId: importacao.id, versaoImportacao: 4, decisaoCliente: null } as never, { usuarioId: "u", operacaoId: "o" } as never).catch((e: unknown) => e);
    const [dados] = analises as Array<Record<string, unknown>>;
    assert.deepEqual([dados.cpf, dados.cnpj], [null, disponivel ? CNPJ : null]);
    if (disponivel) assert.ok(!(r instanceof Error), String(r));
    else assert.equal((r as { code?: string }).code, "PJ_INDISPONIVEL");
  }
});

