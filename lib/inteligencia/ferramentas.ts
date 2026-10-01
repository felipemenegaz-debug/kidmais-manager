import type { z } from "zod";
import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import type { ClasseAcao, GrupoFlag } from "./contratos.ts";
import { atencaoHoje } from "./atencao-hoje.ts";
import { agendaDoDia } from "./leituras/agenda-do-dia.ts";
import { analisarPagamentos } from "./leituras/analisar-pagamentos.ts";
import { analisarRecebiveis } from "./leituras/analisar-recebiveis.ts";
import { contratosPendentes } from "./leituras/contratos-pendentes.ts";
import { festaEmRisco, pendenciasDaFesta, resumirFesta } from "./leituras/festa.ts";
import { resumirCliente } from "./leituras/resumir-cliente.ts";
import { resumirContrato } from "./leituras/resumir-contrato.ts";
import { abrirFesta, abrirTela } from "./leituras/abrir-tela.ts";
import { buscarCatalogo, buscarClientes } from "./leituras/buscas.ts";
import { proximasFestas, relacoesContrato, relacoesFesta } from "./leituras/festas-relacoes.ts";
import { proximaParcela, saldoContrato, ultimoContrato } from "./leituras/pagamentos.ts";
import { ondeEncontrar } from "./leituras/navegacao.ts";
import { pacotesDisponiveis } from "./leituras/pacotes.ts";
import { compararVersoesContrato } from "./leituras/versoes-contrato.ts";
import { calcularConsumo, contextoOperacionalFesta } from "./leituras/operacional.ts";

/** Reexportado por conveniência de tipo: a classe é a mesma dos contratos estáveis. */
export type ClasseFerramenta = ClasseAcao;

/**
 * Portas de domínio, montadas na rota (composition root) com os serviços reais.
 *
 * - `festas.consultarDetalhe` é `consultarFestas`: abre a própria transação, prova o tenant e exige a
 *   capacidade FESTA_CONSULTAR. Não pode rodar dentro da transação do gateway: o `provarTenant` dele
 *   trava a mesma linha de usuário e ficaria esperando a transação externa.
 * - `clientes.obter` é `obterClienteBase` (tenant comprovado; outra empresa responde como inexistente).
 *
 * Portas ausentes (null) fazem a ferramenta responder com ausência de dados, nunca com invenção.
 */
export type PortaFestas = { consultarDetalhe(festaId: string): Promise<unknown> };

/** Subconjunto de `obterClienteBase` usado pela IA. CPF, contato e endereço não são lidos daqui. */
export type ClienteDominio = {
  cliente: { nomeCompleto: string; status: string; criadoEm: string };
  aniversariantes: ReadonlyArray<{ nome: string; dataNascimento: string | null; ativo: boolean }>;
  responsaveis: readonly unknown[];
  cadastro: { completoParaContrato: boolean; camposFaltantes: ReadonlyArray<{ campo: string; label: string }> };
};
/** Resultado de busca de cliente para a IA (PR 4): só id, nome e status — nunca CPF, contato ou endereço. */
export type ClienteEncontrado = { id: string; nomeCompleto: string; status: string };
export type PortaClientes = {
  obter(tx: DbExecutor, empresaId: string, clienteId: string): Promise<ClienteDominio>;
  /** `buscarClientesCrm` no tenant comprovado (escopo dentro da consulta). Ausente ⇒ busca indisponível. */
  buscar?(tx: DbExecutor, empresaId: string, termo: string, limite: number): Promise<readonly ClienteEncontrado[]>;
};

/** Subconjunto de `listarPacotesAdmin` (empresa comprovada no WHERE). Preço NÃO vem daqui: segue a tabela vigente. */
export type PacoteDominio = {
  nome: string; descricao: string | null; duracaoMinutos: number | null; convidadosMinimos: number | null; convidadosMaximos: number | null;
  diasPermitidos: readonly number[]; ativo: boolean; vigente: boolean; arquivadoEm: string | null;
};
export type PortaPacotes = { listar(tx: DbExecutor, empresaId: string): Promise<readonly PacoteDominio[]> };

/** Versão de contrato (snapshot congelado). null ⇒ contrato inexistente NESTA empresa (outra empresa = mesmo 404). */
export type VersaoContratoDominio = {
  numero: number;
  status: string;
  snapshot: {
    evento?: { data?: string; horarioInicio?: string; horarioFim?: string; pacote?: { nome?: string }; convidados?: number };
    comercial?: { valorFinalContrato?: number; formaPagamentoPretendida?: string | null; condicaoPagamento?: { forma?: string } };
  } | null;
};
export type PortaContratos = { versoes(tx: DbExecutor, empresaId: string, contratoId: string): Promise<readonly VersaoContratoDominio[] | null> };

/**
 * Posição financeira OFICIAL de um contrato (AI V1.1, PR 5.5): `lerPosicaoFinanceira` (obrigação, líquido recebido,
 * saldo, crédito) + `situacaoCobranca` + cronograma em aberto. Valores em centavos (string) vindos do Core; a IA
 * nunca calcula. `null` ⇒ contrato inexistente NESTA empresa; `SEM_OBRIGACAO` ⇒ ainda sem plano financeiro.
 */
export type PosicaoContratoDominio = {
  contratoId: string;
  obrigacaoCentavos: string;
  recebidoLiquidoCentavos: string;
  saldoACobrarCentavos: string;
  creditoCentavos: string;
  encerrada: boolean;
  acertoAdministrativoPendente: boolean;
  parcelasAbertas: ReadonlyArray<{ numero: number; vencimento: string; valorCentavos: string }>;
};
export type PortaFinanceiro = { posicaoContrato(tx: DbExecutor, empresaId: string, contratoId: string): Promise<PosicaoContratoDominio | "SEM_OBRIGACAO" | null> };

/**
 * Regra de consumo VIGENTE da empresa (IA operacional, migration 059): fonte de negócio versionada, nunca skill,
 * memória do modelo ou rascunho. `INDISPONIVEL` ⇒ a fonte ainda não existe neste ambiente (o cálculo pergunta).
 */
export type RegraConsumoDominio = {
  categoria: "DOCES" | "REFRIGERANTES";
  versao: number;
  porConvidado: number | null;
  mlPorConvidado: number | null;
  embalagemMl: number | null;
  margemPercentual: number | null;
  vigenteDesde: string;
};
export type PortaParametrosConsumo = { vigente(empresaId: string, categoria: RegraConsumoDominio["categoria"]): Promise<RegraConsumoDominio | null | "INDISPONIVEL"> };

export type PortasDominio = {
  festas: PortaFestas | null; clientes: PortaClientes | null; pacotes?: PortaPacotes | null; contratos?: PortaContratos | null; financeiro?: PortaFinanceiro | null;
  parametrosConsumo?: PortaParametrosConsumo | null;
};

export const SEM_PORTAS: PortasDominio = Object.freeze({ festas: null, clientes: null, pacotes: null, contratos: null });

export type ContextoFerramenta = {
  /** Data de referência em America/Sao_Paulo, calculada no servidor. */
  hoje: string;
  geradoEm: string;
  portas: PortasDominio;
  /**
   * Unidade COMPROVADA no Tenant Context (null = escopo da empresa). Ferramenta ESTABLISHMENT filtra por ela;
   * a Policy garante que ela existe antes de a ferramenta rodar.
   */
  estabelecimento?: string | null;
};

export type ResultadoFerramenta = { estado: string; itens: readonly unknown[] };

export type ExecucaoFerramenta<R extends ResultadoFerramenta> = (
  tx: DbExecutor,
  tenant: TenantComprovado,
  contexto: ContextoFerramenta,
) => Promise<R>;

/** Execução fora da transação do gateway: o serviço de domínio prova o tenant de novo, sozinho. */
export type ExecucaoServico<R extends ResultadoFerramenta> = (
  tenant: TenantComprovado,
  contexto: ContextoFerramenta,
) => Promise<R>;

type BaseFerramenta = {
  /** Nome estável e auditável da ferramenta (ex.: `festas.resumir`). */
  nome: string;
  /** Capacidade exposta ao operador (ex.: `resumir_festa`). */
  capacidade: string;
  classe: ClasseFerramenta;
  grupo: GrupoFlag;
  /** Papéis que já acessam a mesma informação nas telas atuais. A IA não amplia esse conjunto. */
  papeis: readonly string[];
  descricao: string;
  /** inputSchema estrito, aplicado pelo gateway ANTES de preparar (que valida de novo). Nunca aceita empresa/usuário. */
  entrada: z.ZodType;
  /** Entidade exigida da tela (id revalidado no tenant pelo domínio). */
  entidade?: "festa" | "cliente" | "contrato";
};

/**
 * A ferramenta nunca recebe SQL nem empresa do pedido.
 * `preparar` valida os parâmetros (schema estrito) antes de qualquer transação;
 * a execução só recebe o tenant já comprovado e chama serviços de domínio.
 */
export type Ferramenta<R extends ResultadoFerramenta = ResultadoFerramenta> = BaseFerramenta & (
  | { modo?: "TRANSACAO_TENANT"; preparar(parametros: unknown): ExecucaoFerramenta<R> }
  | { modo: "SERVICO_PROPRIO"; preparar(parametros: unknown): ExecucaoServico<R> }
);

/** Registro fechado de leitura: só o que está aqui pode ser executado pelo gateway. */
export const ferramentas: Readonly<Record<string, Ferramenta>> = Object.freeze({
  atencao_hoje: atencaoHoje,
  analisar_recebiveis: analisarRecebiveis,
  analisar_pagamentos: analisarPagamentos,
  contratos_pendentes: contratosPendentes,
  agenda_do_dia: agendaDoDia,
  resumir_cliente: resumirCliente,
  resumir_contrato: resumirContrato,
  resumir_festa: resumirFesta,
  pendencias_da_festa: pendenciasDaFesta,
  festa_em_risco: festaEmRisco,
  onde_encontrar: ondeEncontrar,
  abrir_tela: abrirTela,
  abrir_festa: abrirFesta,
  proximas_festas: proximasFestas,
  relacoes_festa: relacoesFesta,
  relacoes_contrato: relacoesContrato,
  buscar_clientes: buscarClientes,
  buscar_catalogo: buscarCatalogo,
  saldo_contrato: saldoContrato,
  proxima_parcela: proximaParcela,
  ultimo_contrato: ultimoContrato,
  pacotes_disponiveis: pacotesDisponiveis,
  comparar_versoes_contrato: compararVersoesContrato,
  // IA operacional (AI_OPERACIONAL_ENABLED): fora do catálogo e recusadas pelo gateway com a flag desligada.
  contexto_operacional_festa: contextoOperacionalFesta,
  calcular_consumo: calcularConsumo,
});

/** Leituras da IA operacional: só existem para o operador com AI_OPERACIONAL_ENABLED=true. */
export const CAPACIDADES_OPERACIONAIS: ReadonlySet<string> = new Set(["contexto_operacional_festa", "calcular_consumo"]);

export function ferramentaRegistrada(nome: string): Ferramenta | null {
  return Object.hasOwn(ferramentas, nome) ? ferramentas[nome] : null;
}
