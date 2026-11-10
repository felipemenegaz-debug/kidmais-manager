import { contextoDaSessao, type ContextoSessao } from "../../autenticacao/contexto.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { categoriaDaFalhaDeLeitura } from "./conexoes.ts";

/**
 * Quem está autorizando, para destacar nas telas de conexão com assistentes. Só dados da PRÓPRIA sessão, nunca de outro
 * usuário. Não autoriza nada: quem decide a empresa e o papel é provarTenant, em concluirConsentimento e nas ferramentas.
 */
export type IdentidadeDaSessao = {
  usuario: { nome: string; email: string | null };
  empresaAtual: { id: string; nome: string } | null;
  empresas: ReadonlyArray<{ id: string; nome: string }>;
  selecaoNecessaria: boolean;
};

type SessaoComNome = { usuario_id: string; nome: string; papel: string; empresa_ativa_id?: string | null };

/**
 * Leitura que nunca segura a lista de conexões (informação de segurança: dá acesso a Desconectar). Roda na transação com
 * prazo recebida: vencido o prazo, a conexão é descartada e a tela recebe a lista com identidade nula.
 */
export async function identidadeOuNulo(transacao: <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>, sessao: SessaoComNome): Promise<IdentidadeDaSessao | null> {
  try {
    return await transacao((tx) => identidadeDaSessao(tx, sessao));
  } catch (erro) {
    // Só a categoria fechada (vaga ocupada, prazo, cancelamento...), nunca mensagem, SQL ou dado: mede a taxa de identidade
    // nula em staging separando vaga ocupada de prazo vencido (10º parecer, roteiro).
    console.warn(`[Kidmais MCP] identidade indisponível: ${categoriaDaFalhaDeLeitura(erro)}`);
    return null;
  }
}

export async function identidadeDaSessao(tx: DbExecutor, sessao: SessaoComNome, contextoLido?: ContextoSessao): Promise<IdentidadeDaSessao> {
  const contexto = contextoLido ?? await contextoDaSessao(tx, sessao);
  const email = (await tx.query<{ email: string }>(`SELECT email FROM usuarios_administrativos WHERE id = $1::uuid`, [sessao.usuario_id])).rows[0]?.email ?? null;
  return {
    usuario: { nome: sessao.nome, email },
    empresaAtual: contexto.empresaAtual ? { id: contexto.empresaAtual.id, nome: contexto.empresaAtual.nome } : null,
    empresas: contexto.empresas.map((e) => ({ id: e.id, nome: e.nome })),
    selecaoNecessaria: contexto.selecaoNecessaria,
  };
}
