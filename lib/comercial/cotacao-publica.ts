import type { DbExecutor } from "../db/contracts.ts";
import { lerEstadoComercial } from "../assinatura/estado.ts";
import { recursoIncluido } from "../assinatura/recursos-plano.ts";
import { agendaPorEscopoInstalada, escopoDaEmpresa } from "../disponibilidade/escopo.ts";
import { AvailabilityServiceError } from "../disponibilidade/services/errors.ts";
import { escopoCatalogoPublico } from "./catalogo-publico.ts";

/**
 * Cotação/fechamento públicos por empresa (Etapa 3). Dois caminhos:
 *
 *   sem código  → /fechamento e /disponibilidade atuais: empresa SÓ da configuração do servidor
 *                 (AGENDA_PUBLICA_EMPRESA_ID). Nada muda para a Kidmais.
 *   com código  → /b/<código>/...: empresa pelo `empresas.codigo` exato (único, formato restrito pela 031), ATIVA,
 *                 com ORCAMENTO_ONLINE no plano, situação comercial que permita o pedido e agenda por empresa (062).
 *
 * O código só ESCOLHE qual empresa pública mostrar; não comprova nenhuma sessão nem libera dado administrativo.
 * Toda recusa do caminho por código tem a mesma resposta (404), para não revelar se a empresa existe, qual é o plano
 * ou a situação da assinatura. Desligado por padrão: só COTACAO_PUBLICA_POR_EMPRESA=true habilita (Em breve até homologar).
 */
export const CODIGO_EMPRESA_PUBLICA = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

export type AmbienteCotacaoPublica = { COTACAO_PUBLICA_POR_EMPRESA?: string; AGENDA_PUBLICA_EMPRESA_ID?: string; AGENDA_PUBLICA_UNIDADE_ID?: string };
export type EscopoCotacaoPublica = { empresaId: string; estabelecimentoId: string | null; porCodigo: boolean };

export function cotacaoPorEmpresaHabilitada(env: AmbienteCotacaoPublica = process.env as AmbienteCotacaoPublica) {
  return env.COTACAO_PUBLICA_POR_EMPRESA?.trim() === "true";
}

export function indisponivel(): AvailabilityServiceError {
  return new AvailabilityServiceError("COTACAO_PUBLICA_INDISPONIVEL", "Este endereço de orçamento não está disponível.", 404);
}

/** `?empresa=` do pedido: ausente/vazio = caminho atual; formato inválido = 404 (sem consultar o banco). */
export function codigoEmpresaDoPedido(url: string | URL): string | null {
  const valor = new URL(url).searchParams.get("empresa");
  if (valor === null || valor === "") return null;
  if (!CODIGO_EMPRESA_PUBLICA.test(valor)) throw indisponivel();
  return valor;
}

export type DependenciasCotacao = {
  recursoIncluido: typeof recursoIncluido;
  lerEstadoComercial: typeof lerEstadoComercial;
  escopoCatalogoPublico: typeof escopoCatalogoPublico;
};
const PADRAO: DependenciasCotacao = { recursoIncluido, lerEstadoComercial, escopoCatalogoPublico };

/**
 * Resolve a empresa da cotação pública. `escrita` (envio do fechamento) exige situação comercial COMPLETA;
 * consulta aceita também SOMENTE_LEITURA. BLOQUEADO nunca atende.
 */
export async function escopoCotacaoPublica(
  conexao: () => DbExecutor,
  codigo: string | null,
  opcoes: { escrita?: boolean } = {},
  env: AmbienteCotacaoPublica = process.env as AmbienteCotacaoPublica,
  deps: DependenciasCotacao = PADRAO,
): Promise<EscopoCotacaoPublica> {
  if (codigo === null) {
    const escopo = await deps.escopoCatalogoPublico(conexao, env);
    return { ...escopo, porCodigo: false };
  }
  if (!cotacaoPorEmpresaHabilitada(env) || !CODIGO_EMPRESA_PUBLICA.test(codigo)) throw indisponivel();
  const db = conexao();
  // Sem a 062 a agenda é global: abrir um segundo buffet público misturaria ocupações. Fail-closed.
  if (!(await agendaPorEscopoInstalada(db))) throw indisponivel();
  const empresa = (await db.query<{ id: string }>(
    "SELECT id::text AS id FROM public.empresas WHERE codigo = $1 AND status = 'ATIVA'",
    [codigo],
  )).rows;
  if (empresa.length !== 1) throw indisponivel();
  const empresaId = empresa[0].id;
  try {
    if (!(await deps.recursoIncluido(db, empresaId, "ORCAMENTO_ONLINE"))) throw indisponivel();
    const { acesso } = await deps.lerEstadoComercial(db, empresaId);
    if (acesso.nivel === "BLOQUEADO" || (opcoes.escrita && acesso.nivel !== "COMPLETO")) throw indisponivel();
    // Escopo V1: uma unidade. Zero unidade = agenda da empresa; uma = ela; mais de uma = recusa (UNIDADE_OBRIGATORIA →
    // 404). Nunca escolhe uma unidade por conta própria: a escolha pública de unidade ainda não existe.
    const unidade = await escopoDaEmpresa(db, empresaId, null, { exigirUnidade: true });
    return { empresaId, estabelecimentoId: unidade.estabelecimentoId, porCodigo: true };
  } catch {
    // Plano ilegível, estado comercial ou unidade: mesma resposta, sem detalhe da empresa.
    throw indisponivel();
  }
}
