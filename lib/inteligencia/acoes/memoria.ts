import type { HumanGateDraft } from "../contratos.ts";
import type { RepositorioOperacoes } from "./tipos.ts";

/**
 * Repositório em memória com a mesma semântica do PostgreSQL (filtro por empresa+usuário e CAS).
 * Usado pelos testes. Não é usado em produção: sem a tabela `ia_operacoes`, a rota desliga as ações.
 */
export function criarRepositorioOperacoesEmMemoria(): RepositorioOperacoes & { linhas: Map<string, HumanGateDraft> } {
  const linhas = new Map<string, HumanGateDraft>();
  const copia = (r: HumanGateDraft): HumanGateDraft => structuredClone(r);
  return {
    linhas,
    async disponivel() { return true; },
    async criar(_tx, rascunho) {
      if (linhas.has(rascunho.operacaoId)) throw Object.assign(new Error("duplicada"), { code: "23505" });
      linhas.set(rascunho.operacaoId, copia(rascunho));
    },
    async buscar(_tx, filtro) {
      const linha = linhas.get(filtro.operacaoId);
      if (!linha || linha.empresaId !== filtro.empresaId || linha.usuarioId !== filtro.usuarioId) return null;
      return copia(linha);
    },
    async atualizar(_tx, rascunho, esperado) {
      const atual = linhas.get(rascunho.operacaoId);
      if (!atual || atual.versao !== esperado.versao || atual.estado !== esperado.estado || atual.empresaId !== rascunho.empresaId || atual.usuarioId !== rascunho.usuarioId) return false;
      linhas.set(rascunho.operacaoId, copia(rascunho));
      return true;
    },
  };
}
