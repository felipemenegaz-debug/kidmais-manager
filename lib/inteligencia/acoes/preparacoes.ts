import { ZodError, z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { grupoAtivo, inteligenciaAtiva, operacionalAtivo, type Ambiente } from "../flags.ts";
import { InteligenciaError } from "../politica.ts";
import { novoRastreio, type RastreioInteligencia } from "../rastreio.ts";
import { CAPACIDADE_CONTRATACAO, type PortaContratacao } from "./contratacao.ts";
import { criarVinculo, lerPreparacao, situacaoPreparacao, type ResultadoCriacao, type VinculoPreparacao } from "./contratacao-revisao.ts";
import type { RepositorioOperacoes } from "./tipos.ts";

/**
 * Revisão OFICIAL de uma contratação preparada pelo Kidmais (IA operacional, marco C): abrir (somente leitura) e
 * concluir (o envio do formulário oficial, consumindo a preparação na MESMA transação da criação).
 *
 * O formulário oficial continua sendo do Core (Fechamento administrativo): sessão, CSRF, prova de tenant, papel da
 * empresa, cadastro, aniversariante, pacote, convidados, disponibilidade, preço e auditoria são do serviço de domínio.
 * Aqui só entra a referência opaca (operação + versão + hash), revalidada no servidor. Sem a flag: indisponível, e o
 * formulário segue sem a preparação (a IA nunca é dependência crítica do Core).
 */
const referencia = z.object({ operacaoId: z.string().uuid(), versao: z.number().int().min(1).max(10_000), payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const pedidoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("abrir"), clienteId: z.string().uuid(), operacaoId: z.string().uuid() }).strict(),
  /** Reconciliação depois de um envio com resultado incerto: só leitura. */
  z.object({ acao: z.literal("situacao"), clienteId: z.string().uuid(), operacaoId: z.string().uuid() }).strict(),
  z.object({ acao: z.literal("concluir"), clienteId: z.string().uuid(), referencia, formulario: z.record(z.string(), z.unknown()) }).strict(),
  /** "Enviar sem a preparação": formulário oficial sem as conferências da prévia, mesma operação como âncora. */
  z.object({ acao: z.literal("concluir_sem_preparacao"), clienteId: z.string().uuid(), operacaoId: z.string().uuid(), formulario: z.record(z.string(), z.unknown()) }).strict(),
]);

export type DependenciasPreparacao = {
  env: Ambiente;
  requestId(): string;
  registrar(rastreio: RastreioInteligencia): void;
  agora(): Date;
  repositorio: RepositorioOperacoes;
  porta: Pick<PortaContratacao, "pacote" | "horarios" | "precoTabela">;
  /** Sessão, tenant, papel e cliente provados pelo Core (Fechamento administrativo); a leitura roda no mesmo tenant. */
  noEscopo<T>(clienteId: string, ler: (tx: DbExecutor, escopo: { empresaId: string; usuarioId: string; clienteId: string }) => Promise<T>): Promise<T>;
  /** Criação OFICIAL do Fechamento administrativo com o vínculo (mesma transação). */
  concluir(clienteId: string, formulario: Record<string, unknown>, vinculo: VinculoPreparacao): Promise<ResultadoCriacao>;
};

export type RespostaPreparacao = { status: number; corpo: { ok: true; data: unknown } | { ok: false; erro: string; codigo: string } };

const MENSAGEM_FALLBACK = "Não foi possível concluir com a preparação do Kidmais. Nenhuma alteração foi feita; você pode enviar sem ela.";

export async function atenderPreparacao(lerCorpo: () => Promise<unknown>, deps: DependenciasPreparacao): Promise<RespostaPreparacao> {
  const rastreio = novoRastreio("inteligencia.operacao", deps.requestId());
  rastreio.intencao = "HUMAN_GATE";
  rastreio.capacidade = CAPACIDADE_CONTRATACAO;
  rastreio.ferramenta = "comercial.preparar_contratacao";
  const inicio = Date.now();
  try {
    if (!inteligenciaAtiva(deps.env) || !operacionalAtivo(deps.env) || !grupoAtivo(deps.env, "ADMIN_ACTIONS")) {
      throw new InteligenciaError("PREPARACAO_INDISPONIVEL", "A preparação do Kidmais está indisponível. Envie o formulário sem ela.", 503);
    }
    let pedido: z.infer<typeof pedidoSchema>;
    try {
      pedido = pedidoSchema.parse(await lerCorpo());
    } catch {
      throw new InteligenciaError("DADOS_INVALIDOS", "Pedido inválido.", 400);
    }
    if (pedido.acao === "abrir") {
      const operacaoId = pedido.operacaoId.toLowerCase();
      const data = await deps.noEscopo(pedido.clienteId.toLowerCase(), (tx, escopo) => lerPreparacao(deps.repositorio, tx, operacaoId, { ...escopo, agora: deps.agora() }));
      rastreio.estado = data.disponivel ? "preparacao_aberta" : "preparacao_indisponivel";
      rastreio.humanGate = "PREVIEW";
      return { status: 200, corpo: { ok: true, data } };
    }
    if (pedido.acao === "situacao") {
      const operacaoId = pedido.operacaoId.toLowerCase();
      const data = await deps.noEscopo(pedido.clienteId.toLowerCase(), (tx, escopo) => situacaoPreparacao(deps.repositorio, tx, operacaoId, { ...escopo, agora: deps.agora() }));
      rastreio.estado = `reconciliacao_${data.estado.toLowerCase()}`;
      return { status: 200, corpo: { ok: true, data } };
    }
    const vinculo = pedido.acao === "concluir"
      ? criarVinculo(deps.repositorio, deps.porta, { ...pedido.referencia, operacaoId: pedido.referencia.operacaoId.toLowerCase() }, deps.agora, "PREPARACAO")
      : criarVinculo(deps.repositorio, deps.porta, { operacaoId: pedido.operacaoId.toLowerCase() }, deps.agora, "SEM_PREPARACAO");
    const data = await deps.concluir(pedido.clienteId.toLowerCase(), pedido.formulario, vinculo);
    rastreio.humanGate = "CONFIRMADO";
    rastreio.estado = "executada";
    rastreio.ferramentasExecutadas = ["comercial.preparar_contratacao"];
    return { status: 201, corpo: { ok: true, data } };
  } catch (erro) {
    rastreio.humanGate = "RECUSADO";
    rastreio.resultado = "negado";
    if (erro instanceof InteligenciaError) {
      rastreio.codigo = erro.code;
      return { status: erro.httpStatus, corpo: { ok: false, erro: erro.message, codigo: erro.code } };
    }
    if (erro instanceof ZodError) return { status: 400, corpo: { ok: false, erro: "Confira os campos obrigatórios do formulário.", codigo: "DADOS_INVALIDOS" } };
    rastreio.resultado = "fallback";
    rastreio.fallback = true;
    return { status: 503, corpo: { ok: false, erro: MENSAGEM_FALLBACK, codigo: "PREPARACAO_FALHOU" } };
  } finally {
    rastreio.duracaoMs = Math.max(0, Date.now() - inicio);
    try {
      deps.registrar(rastreio);
    } catch {
      // O trace nunca derruba a resposta.
    }
  }
}
