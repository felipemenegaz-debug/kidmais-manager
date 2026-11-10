import { empresaNoPilotoMcp, mcpAtivo, urlsMcp, type AmbienteMcp } from "../mcp/config.ts";
import { consultaLiberadaNoAmbiente } from "../mcp/ferramentas.ts";
import type { ConcessaoResumo, RepositorioOAuth } from "./repositorio.ts";
import type { EvidenciasConexao, FalhaRegistrada } from "./situacao-conexao.ts";

/**
 * Tela "Assistentes conectados" (revisão P2-7): a lista de conexões é informação de SEGURANÇA e sai SEMPRE, inclusive com
 * o canal desligado ou a URL ausente — senão a pessoa perde o botão de desconectar e, ao religar o canal, concessões
 * não revogadas voltariam a valer sem que ela as tivesse visto. O estado do canal vem à parte.
 * Sem schema (105 ausente) ⇒ SchemaMcpAusente propaga (a rota responde 503 explícito, nunca lista vazia).
 * As falhas registradas vêm à parte, depois da lista: se a leitura falhar ou vencer o prazo, a lista sai igual e
 * falhasDisponiveis = false. Ausência de falha na tela só significa "nenhuma falha" quando falhasDisponiveis = true.
 */
/** `consultaDaAjudaLiberada`: a pergunta pronta do guia (busca na ajuda) passaria pelas portas de ambiente agora. */
export type ConexaoNaTela = Omit<ConcessaoResumo, "evidencias"> & { evidencias: EvidenciasConexao; empresaNoPiloto: boolean; consultaDaAjudaLiberada: boolean };
export type EstadoConexoes = { canal: { ativo: boolean; urlServidor: string | null }; conexoes: readonly ConexaoNaTela[]; falhasDisponiveis: boolean };

/**
 * Categoria fechada para o log, para decidir sobre índice ou prazo: nunca mensagem, SQL, parâmetro ou identificador.
 * 57014 inclui statement_timeout; 55P03 inclui lock_timeout (só SQLSTATE conhecido, sem repassar valor vindo do erro).
 */
export function categoriaDaFalhaDeLeitura(e: unknown): "PRAZO_DA_APLICACAO" | "VAGA_OCUPADA" | "SCHEMA_AUSENTE" | "CONSULTA_CANCELADA" | "TRAVA_INDISPONIVEL" | "OUTRA" {
  const { name, code } = (e ?? {}) as { name?: unknown; code?: unknown };
  if (name === "PrazoDaTransacaoVencido") return "PRAZO_DA_APLICACAO";
  if (name === "CanalOcupado") return "VAGA_OCUPADA";
  if (name === "SchemaMcpAusente") return "SCHEMA_AUSENTE";
  if (code === "57014") return "CONSULTA_CANCELADA";
  if (code === "55P03") return "TRAVA_INDISPONIVEL";
  return "OUTRA";
}

async function falhasOuNulo(leitor: Pick<RepositorioOAuth, "lerUltimasFalhas">, usuarioId: string): Promise<ReadonlyMap<string, FalhaRegistrada> | null> {
  try {
    return await leitor.lerUltimasFalhas(usuarioId);
  } catch (e) {
    console.warn(`[Kidmais MCP] falhas registradas indisponíveis: ${categoriaDaFalhaDeLeitura(e)}`);
    return null;
  }
}

export async function conexoesDaPessoa(env: AmbienteMcp, repo: RepositorioOAuth, usuarioId: string, leitorDeFalhas: Pick<RepositorioOAuth, "lerUltimasFalhas"> = repo): Promise<EstadoConexoes> {
  const urls = urlsMcp(env);
  const ativo = mcpAtivo(env) && urls !== null;
  const lista = await repo.listarConcessoes(usuarioId);
  // Sem conexão ativa, não há o que enriquecer: evita varrer a auditoria à toa.
  const falhas = lista.some((c) => !c.revogadaEm) ? await falhasOuNulo(leitorDeFalhas, usuarioId) : new Map<string, FalhaRegistrada>();
  return {
    canal: { ativo, urlServidor: ativo ? urls!.recurso : null },
    falhasDisponiveis: falhas !== null,
    conexoes: lista.map((c) => ({ ...c, empresaNoPiloto: empresaNoPilotoMcp(env, c.empresaId), consultaDaAjudaLiberada: consultaLiberadaNoAmbiente(env, "kidmais_buscar_conhecimento", c.empresaId), evidencias: { ...c.evidencias, ultimaFalha: falhas?.get(c.id) ?? null } })),
  };
}
