import type { ContextoTela, NaturezaFato, RespostaLeitura } from "../contratos.ts";

/**
 * Context Builder V1 (CORE).
 *
 * Duas formas de contexto, nunca confundidas:
 *
 * 1. `ContextoAutorizado` — interno, montado SÓ a partir da sessão e do Tenant Context comprovado no servidor
 *    (nunca do pedido): usuário, empresa, estabelecimento, papel NA EMPRESA, tela, entidade aberta e as
 *    capacidades que o papel + as flags permitem agora. Carrega ids; nunca vai para um modelo.
 *
 * 2. `ContextoModelo` — o ÚNICO formato que pode chegar a um provedor. Sem ids, sem URLs, sem empresa, sem
 *    usuário, sem dado pessoal, sem dado de criança: só o necessário para a tarefa, rotulado por sensibilidade,
 *    redigido e com tamanho limitado. Construído a partir de blocos de dados de leitura que carregam a empresa
 *    de origem — bloco de outra empresa ou de capacidade não autorizada é recusado (falha fechada).
 */
export const VERSAO_CONTEXTO = "contexto-v1.0.0";

export type EntidadeTela = "festa" | "cliente" | "contrato";

export type ContextoAutorizado = {
  readonly usuarioId: string;
  readonly empresaId: string;
  /** O Tenant Context atual não tem unidade: null até existir estabelecimento comprovado. */
  readonly estabelecimentoId: string | null;
  /** Papel da membership NESTA empresa (056), nunca o papel global da sessão. */
  readonly papel: string;
  readonly tela: ContextoTela["tela"];
  readonly entidade: { tipo: EntidadeTela; id: string } | null;
  /** Capacidades que o operador pode usar agora (papel + flags). */
  readonly capacidades: readonly string[];
};

/** Um bloco de dados vindo de uma leitura já executada pelo gateway, com a empresa em que foi lida. */
export type BlocoDados = {
  empresaId: string;
  /** Unidade em que a leitura foi feita (null/ausente ⇒ leitura da empresa). Outra unidade ⇒ recusa. */
  estabelecimentoId?: string | null;
  capacidade: string;
  resposta: RespostaLeitura;
};

/** Para que o contexto será usado: define o que pode entrar. Nenhuma finalidade libera dado pessoal ou de criança. */
export type FinalidadeContexto = "EXPLICAR_DADOS" | "RESUMIR" | "REDIGIR_TEXTO" | "SUGERIR_PROXIMA_ACAO";

export type Sensibilidade = "INTERNO_AGREGADO" | "FINANCEIRO_DETALHADO" | "PESSOAL" | "CRIANCA" | "IDENTIFICADOR";

export type FatoModelo = { natureza: NaturezaFato; texto: string; fonte: string };
export type EvidenciaModelo = { rotulo: string; valor: string; fonte: string };
export type ItemModelo = { prioridade: "alta" | "media" | "baixa"; titulo: string };

export type DadosModelo = {
  capacidade: string;
  estado: RespostaLeitura["estado"];
  fatos: FatoModelo[];
  evidencias: EvidenciaModelo[];
  itens: ItemModelo[];
};

export type ContextoModelo = {
  versao: typeof VERSAO_CONTEXTO;
  finalidade: FinalidadeContexto;
  tela: ContextoTela["tela"];
  /** Só o TIPO da entidade aberta e se ela existe; o id nunca vai ao modelo. */
  entidade: { tipo: EntidadeTela } | null;
  /** O que o operador pode pedir agora (ids de capacidade, sem descrição interna). */
  capacidadesPermitidas: string[];
  dados: DadosModelo[];
  referencia: { hoje: string | null };
  minimizacao: {
    /** Elementos retirados por sensibilidade (pessoal, criança, identificador) ou por limite. */
    removidos: number;
    truncado: boolean;
    /** Substituições feitas na redação (ex.: "[nome]", "[email]"). */
    redacoes: number;
  };
};

export type LimitesContexto = {
  maxBlocos: number;
  maxFatosPorBloco: number;
  maxEvidenciasPorBloco: number;
  maxItensPorBloco: number;
  maxCaracteresTexto: number;
  /** Tamanho máximo do JSON serializado para o modelo (bytes UTF-8). */
  maxBytes: number;
};

export const LIMITES_CONTEXTO_PADRAO: LimitesContexto = Object.freeze({
  maxBlocos: 3,
  maxFatosPorBloco: 8,
  maxEvidenciasPorBloco: 10,
  maxItensPorBloco: 6,
  maxCaracteresTexto: 200,
  maxBytes: 6_000,
});

/** Recusa do Context Builder: nunca "conserta" um bloco perigoso, descarta e registra o motivo. */
export type MotivoRecusaContexto = "OUTRA_EMPRESA" | "OUTRO_ESTABELECIMENTO" | "CAPACIDADE_NAO_AUTORIZADA" | "LIMITE_BLOCOS" | "IDENTIFICADOR_RESIDUAL";

export class ContextoRecusado extends Error {
  readonly motivo: MotivoRecusaContexto;
  constructor(motivo: MotivoRecusaContexto) {
    super(`Contexto recusado: ${motivo}`);
    this.name = "ContextoRecusado";
    this.motivo = motivo;
  }
}
