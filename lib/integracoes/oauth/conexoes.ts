import { mcpAtivo, urlsMcp, type AmbienteMcp } from "../mcp/config.ts";
import type { ConcessaoResumo, RepositorioOAuth } from "./repositorio.ts";

/**
 * Tela "Assistentes conectados" (revisão P2-7): a lista de conexões é informação de SEGURANÇA e sai SEMPRE, inclusive com
 * o canal desligado ou a URL ausente — senão a pessoa perde o botão de desconectar e, ao religar o canal, concessões
 * não revogadas voltariam a valer sem que ela as tivesse visto. O estado do canal vem à parte.
 * Sem schema (105 ausente) ⇒ SchemaMcpAusente propaga (a rota responde 503 explícito, nunca lista vazia).
 */
export type EstadoConexoes = { canal: { ativo: boolean; urlServidor: string | null }; conexoes: readonly ConcessaoResumo[] };

export async function conexoesDaPessoa(env: AmbienteMcp, repo: RepositorioOAuth, usuarioId: string): Promise<EstadoConexoes> {
  const urls = urlsMcp(env);
  const ativo = mcpAtivo(env) && urls !== null;
  return { canal: { ativo, urlServidor: ativo ? urls!.recurso : null }, conexoes: await repo.listarConcessoes(usuarioId) };
}
