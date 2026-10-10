import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { painelPacoteAdmin, salvarPacoteComercial } from "@/lib/comercial/pacote-comercial";
import { gravarFaixasPacote } from "@/lib/comercial/pacote-precos";
import { alterarSituacaoPacoteAdmin, criarRevisaoPacoteAdmin, editarPacoteNaoUtilizado, listarPacotesAdmin } from "@/lib/comercial/pacotes-admin";
import { repositorioOperacoesPostgres } from "@/lib/ia-persistencia/operacoes";
import { buscarClientesCrm } from "@/lib/clientes/services";
import { calcularResumoComercial } from "@/lib/comercial/services";
import { consultarDisponibilidadeData } from "@/lib/disponibilidade/services";
import { escopoDaEmpresa } from "@/lib/disponibilidade/escopo";
import { erroConvidadosFechamento } from "@/lib/fechamentos/convidados";
import { clienteParaPreparacao, criarFechamentoAdministrativo, obterContextoFechamentoAdministrativo } from "@/lib/fechamentos/services/fechamento-administrativo.service";
import { exigirApiAdminCrmDisponivel, tokenAdmin } from "@/lib/http/admin-crm-api";
import type { DependenciasPreparacao } from "@/lib/inteligencia/acoes/preparacoes";
import { InteligenciaError } from "@/lib/inteligencia/politica";
import { hojeBrasilia } from "@/lib/financeiro/calculos";
import { criarAcaoContratacao, type PortaContratacao } from "@/lib/inteligencia/acoes/contratacao";
import { criarAcaoContaPagar, type PortaContaPagar } from "@/lib/inteligencia/acoes/conta-pagar";
import { criarContaPagar, listarCategoriasDespesa } from "@/lib/financeiro/servico";
import { exigirRecursoPlano } from "@/lib/assinatura/recursos-plano";
import { criarAcaoParametroConsumo, type PortaParametrosAcao } from "@/lib/inteligencia/acoes/parametros-consumo";
import { operacionalAtivo } from "@/lib/inteligencia/flags";
import { fonteParametrosDisponivel, parametroVigente, registrarParametroConsumo } from "@/lib/operacional/parametros-consumo";
import type { DependenciasHumanGate } from "@/lib/inteligencia/acoes/human-gate";
import { CHAVE_ACOES, CHAVE_HUMAN_GATE, CHAVE_MODULO_COMPLETO, criarModuloAcoes } from "@/lib/inteligencia/acoes/modulo";
import type { DependenciasOperacao } from "@/lib/inteligencia/acoes/operacoes";
import { criarAcoesPacote, type PortaPacotes } from "@/lib/inteligencia/acoes/pacotes";
import { acoesNegadas } from "@/lib/inteligencia/acoes/registro";
import { CHAVE_MODULO_ACOES, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { dependenciasGateway } from "../dependencias";
import { montarExtensoes } from "../extensoes";

/**
 * Composição da feature ACTIONS (Human Gate + ações de Pacote).
 *
 * A porta de pacotes liga cada operação ao serviço comercial exato: criar pacote novo usa
 * `salvarPacoteComercial` (nada a preservar); editar NUNCA usa, porque ele regrava disponibilidade,
 * buffet e itens a partir do retrato recebido. Edição usa `editarPacoteNaoUtilizado`,
 * `criarRevisaoPacoteAdmin` (copia o agregado inteiro) e `gravarFaixasPacote`.
 */
export const portaPacotes: PortaPacotes = {
  listar: (tx, empresaId) => listarPacotesAdmin(tx, empresaId),
  painel: (tx, empresaId, id) => painelPacoteAdmin(tx, empresaId, id),
  criar: (tx, dados, ctx) => salvarPacoteComercial(tx, { ...dados, disponibilidade: [], categorias: [], itens: [] }, ctx),
  editarNaoUtilizado: (tx, id, dados, ctx) => editarPacoteNaoUtilizado(tx, id, dados, ctx),
  // A revisão preserva a situação (ativo/inativo) da origem: nenhuma ativação invisível.
  revisar: (tx, id, dados, ctx) => criarRevisaoPacoteAdmin(tx, id, dados, ctx, { preservarSituacao: true }),
  gravarFaixas: (tx, empresaId, id, faixas, limites, ctx) => gravarFaixasPacote(tx, empresaId, id, faixas, limites, ctx),
  alterarSituacao: (tx, id, situacao, ctx) => alterarSituacaoPacoteAdmin(tx, id, situacao, ctx),
};

/**
 * IA operacional: contratação preparada só com serviços OFICIAIS de leitura (CRM no tenant, contexto do Fechamento
 * administrativo, pacote vigente da empresa, disponibilidade e valor de tabela). Nada aqui grava: a criação é o envio do
 * formulário oficial (rota de Fechamentos), que consome a preparação.
 */
export const portaContratacao: PortaContratacao = {
  async buscarClientes(tx, empresaId, termo) {
    const encontrados = await buscarClientesCrm(termo, empresaId, 6, false, tx);
    return encontrados.map(({ cliente }) => ({ id: cliente.id, nome: cliente.nomeCompleto, ativo: String(cliente.status) === "ATIVO" }));
  },
  cliente: (tx, empresaId, clienteId) => clienteParaPreparacao(clienteId, empresaId, tx),
  async pacote(tx, empresaId, codigo) {
    const pacote = (await listarPacotesAdmin(tx, empresaId)).find((p) => p.codigo === codigo && p.vigente && p.ativo && !p.arquivadoEm);
    return pacote ? { id: pacote.id, nome: pacote.nome, minimo: pacote.convidadosMinimos, maximo: pacote.convidadosMaximos } : null;
  },
  erroConvidados: (codigo, pacote, convidados) => erroConvidadosFechamento(convidados, { id: codigo, nome: pacote.nome, minPagantes: pacote.minimo ?? 1, maxPagantes: pacote.maximo ?? 150 }),
  async horarios(tx, empresaId, data, turno) {
    try {
      // Agenda da empresa comprovada (062); várias unidades = visão conservadora da empresa inteira.
      const dia = await consultarDisponibilidadeData(data, tx, undefined, await escopoDaEmpresa(tx, empresaId));
      const periodo = dia.periodos.find((p) => p.codigo === (turno === "almoco" ? "TURNO_1" : "TURNO_2"));
      return periodo ? { configuracaoId: periodo.configuracaoId, horarios: periodo.horarios.filter((h) => h.status === "DISPONIVEL").map((h) => ({ inicio: h.inicio, fim: h.fim })) } : null;
    } catch {
      return null;
    }
  },
  async precoTabela(tx, empresaId, entrada) {
    try {
      const resumo = await calcularResumoComercial({ ...entrada, adicionais: [], empresaEsperada: empresaId }, tx);
      return Math.round(resumo.valorTabelaPacoteAplicado * 100);
    } catch {
      return null;
    }
  },
};

/** Parâmetros de consumo: serviço de domínio da 059 (sem a tabela: indisponível, nada é gravado). */
export const portaParametros: PortaParametrosAcao = {
  disponivel: (tx) => fonteParametrosDisponivel(tx),
  vigente: (tx, empresaId, categoria) => parametroVigente(tx, empresaId, categoria),
  registrar: (tx, entrada) => registrarParametroConsumo(tx, entrada),
};

// Mesma barreira de plano das rotas de Contas a pagar: na revisão (categorias) e de novo na execução.
export const portaContaPagar: PortaContaPagar = {
  categorias: async (tx, empresaId) => {
    await exigirRecursoPlano(tx, empresaId, "FINANCEIRO_COMPLETO");
    return listarCategoriasDespesa(tx, empresaId);
  },
  criar: async (tx, empresaId, usuarioId, input) => {
    await exigirRecursoPlano(tx, empresaId, "FINANCEIRO_COMPLETO");
    return criarContaPagar(tx, empresaId, usuarioId, input);
  },
};

function ttlConfirmacao() {
  const n = Number(process.env.AI_CONFIRMACAO_TTL_SEGUNDOS);
  return Number.isInteger(n) && n >= 60 && n <= 3600 ? n : 600;
}

export function gateDoAmbiente(): DependenciasHumanGate {
  return { repositorio: repositorioOperacoesPostgres, agora: () => new Date(), novoId: randomUUID, ttlConfirmacaoSegundos: ttlConfirmacao() };
}

/** Registra o módulo de ações. Outras features acrescentam ações à lista `CHAVE_ACOES`. */
export function registrarAcoes(registro: RegistroExtensoes) {
  const lista = registro.lista(CHAVE_ACOES);
  lista.push(...criarAcoesPacote(portaPacotes), ...acoesNegadas());
  lista.push(criarAcaoContaPagar(portaContaPagar));
  // IA operacional só com AI_OPERACIONAL_ENABLED=true: desligada, as ações nem existem (rollback por flag).
  if (operacionalAtivo(process.env)) lista.push(criarAcaoContratacao(portaContratacao, () => hojeBrasilia(new Date())), criarAcaoParametroConsumo(portaParametros));
  registro.definir(CHAVE_HUMAN_GATE, gateDoAmbiente);
  registro.definir(CHAVE_MODULO_COMPLETO, () => criarModuloAcoes(registro.lista(CHAVE_ACOES), registro.obter(CHAVE_HUMAN_GATE)!));
  registro.definir(CHAVE_MODULO_ACOES, () => registro.obter(CHAVE_MODULO_COMPLETO));
}

/** Recusa de domínio do Core (4xx com código e mensagem humana) ⇒ mesma recusa na resposta, sem vazar detalhes. */
function recusaDoCore(erro: unknown): never {
  const e = erro as { httpStatus?: unknown; status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof e?.httpStatus === "number" ? e.httpStatus : typeof e?.status === "number" ? e.status : null;
  if (status !== null && status >= 400 && status < 500 && typeof e?.message === "string") {
    throw new InteligenciaError(typeof e.code === "string" ? e.code : "RECUSADO", e.message, status);
  }
  throw erro;
}

/**
 * Revisão oficial da contratação preparada: o Fechamento administrativo do Core prova sessão, tenant e papel e lê a
 * preparação no MESMO tenant (abrir); a criação oficial recebe o vínculo e consome a preparação na mesma transação.
 */
export function dependenciasPreparacao(request: NextRequest, empresaSolicitada: string | null): DependenciasPreparacao {
  const credencial = () => ({ token: tokenAdmin(request), requestId: randomUUID(), userAgent: request.headers.get("user-agent")?.slice(0, 1000) ?? null, empresaSolicitada });
  const base = dependenciasGateway(request);
  return {
    env: process.env,
    requestId: randomUUID,
    registrar: base.registrar,
    agora: () => new Date(),
    repositorio: repositorioOperacoesPostgres,
    porta: portaContratacao,
    async noEscopo(clienteId, ler) {
      await exigirApiAdminCrmDisponivel(request);
      try {
        // Mesma prova do Fechamento administrativo (sessão, tenant, papel, cliente); a leitura roda no tenant comprovado.
        const contexto = await obterContextoFechamentoAdministrativo(clienteId, credencial(), ler);
        if (!("preparacao" in contexto)) throw new InteligenciaError("PREPARACAO_INVALIDA", "Preparação não encontrada.", 404);
        return contexto.preparacao as Awaited<ReturnType<typeof ler>>;
      } catch (erro) {
        return recusaDoCore(erro);
      }
    },
    async concluir(clienteId, formulario, vinculo) {
      await exigirApiAdminCrmDisponivel(request);
      try {
        return await criarFechamentoAdministrativo(clienteId, formulario, credencial(), vinculo);
      } catch (erro) {
        return recusaDoCore(erro);
      }
    },
  };
}

export function dependenciasOperacao(request: NextRequest): DependenciasOperacao {
  return { ...dependenciasGateway(request), acoes: montarExtensoes(request).obter(CHAVE_MODULO_COMPLETO) };
}
