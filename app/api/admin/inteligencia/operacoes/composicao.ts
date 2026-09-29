import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { painelPacoteAdmin, salvarPacoteComercial } from "@/lib/comercial/pacote-comercial";
import { gravarFaixasPacote } from "@/lib/comercial/pacote-precos";
import { alterarSituacaoPacoteAdmin, criarRevisaoPacoteAdmin, editarPacoteNaoUtilizado, listarPacotesAdmin } from "@/lib/comercial/pacotes-admin";
import { repositorioOperacoesPostgres } from "@/lib/ia-persistencia/operacoes";
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
  registro.definir(CHAVE_HUMAN_GATE, gateDoAmbiente);
  registro.definir(CHAVE_MODULO_COMPLETO, () => criarModuloAcoes(registro.lista(CHAVE_ACOES), registro.obter(CHAVE_HUMAN_GATE)!));
  registro.definir(CHAVE_MODULO_ACOES, () => registro.obter(CHAVE_MODULO_COMPLETO));
}

export function dependenciasOperacao(request: NextRequest): DependenciasOperacao {
  return { ...dependenciasGateway(request), acoes: montarExtensoes(request).obter(CHAVE_MODULO_COMPLETO) };
}
