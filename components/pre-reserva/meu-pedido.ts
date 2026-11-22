import type { StatusFechamento } from "../clientes/types";
import type { listarMeuPedido, pixMeuPedido } from "../../lib/pre-reserva/meu-pedido";
import { TERMOS_PRE_RESERVA, VERSAO_TERMOS_PRE_RESERVA } from "../../lib/pre-reserva/termos.ts";

// Datas que o servidor retorna como Date chegam como ISO no JSON.
type Json<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Json<T[K]> } : T;

type PedidoLido = Json<Awaited<ReturnType<typeof listarMeuPedido>>[number]>;
type OfertaLida = Extract<PedidoLido["oferta"], { disponivel: true }>;
type OfertaIndisponivel = Extract<PedidoLido["oferta"], { disponivel: false }>;

export type Oferta = Omit<OfertaLida, "termos"> & { termos: { versao: string; texto: string } };
export type Pedido = Omit<PedidoLido, "oferta"> & { oferta: Oferta | OfertaIndisponivel };
export type Pix = Awaited<ReturnType<typeof pixMeuPedido>>;
export type PedidosDaSessao = { pedidos: Pedido[]; expiraEm: string };
export type Desafio = { desafio: string; expiraEm: string };

const SITUACOES_PEDIDO = {
  RASCUNHO: "Rascunho",
  AGUARDANDO_APROVACAO: "Aguardando aprovação",
  APROVADO: "Aprovado",
  AGUARDANDO_CONTRATO: "Aguardando contrato",
  CONTRATO_ASSINADO: "Contrato assinado",
  AGUARDANDO_PAGAMENTO: "Aguardando pagamento",
  CONFIRMADO: "Confirmado",
  CANCELADO: "Cancelado",
  RECUSADO: "Recusado",
  EXPIRADO: "Expirado",
} satisfies Record<StatusFechamento, string>;

export const PEDIDO_COMUM = "A pré-reserva é opcional. Você pode seguir com o pedido comum sem pagar o sinal.";
export const PRE_RESERVA_INDISPONIVEL = "A pré-reserva está indisponível no momento. Seu pedido comum segue normalmente.";
export const SESSAO_ENCERRADA = "Sua sessão terminou. Entre novamente com seu CPF e um novo código.";
export const CODIGO_VENCIDO = "O código venceu. Peça outro código para entrar.";

export const MOTIVOS_OFERTA = {
  GARANTIA_EXISTENTE: "Este pedido já teve uma garantia de horário.",
  PEDIDO_INELEGIVEL: "A situação atual do pedido não permite uma pré-reserva.",
  PILOTO_DESLIGADO: PRE_RESERVA_INDISPONIVEL,
  ORCAMENTO_ONLINE_INDISPONIVEL: "O orçamento online deste buffet está indisponível.",
  ACESSO_COMERCIAL_RESTRITO: "O buffet está com a pré-reserva restrita no momento.",
  PRE_RESERVA_SEM_PIX: "O buffet ainda não disponibilizou o Pix do sinal.",
  SINAL_INDISPONIVEL: "O valor do sinal está indisponível para este pedido.",
  MENOS_DE_24_HORAS: "Faltam menos de 24 horas para a festa.",
  HORARIO_INDISPONIVEL: "O horário desejado está indisponível para pré-reserva.",
  PIX_NAO_PENDENTE: "O Pix deste aceite já foi conferido ou o pedido mudou de situação.",
} satisfies Record<OfertaIndisponivel["motivo"], string>;

const SITUACOES_GARANTIA = {
  ATIVA: "Horário garantido",
  SEM_GARANTIA: "Horário sem garantia",
  EXPIRADA: "A garantia venceu",
  DESISTENCIA: "Você desistiu da garantia",
  RECUSA: "A garantia foi encerrada após a recusa do pedido",
  FORMALIZACAO: "A garantia foi encerrada com a formalização do contrato",
  FORMALIZACAO_SEM_CREDITO: "A garantia foi encerrada com a formalização do contrato",
};

const DESTINOS_SINAL = {
  EM_GARANTIA: "Vinculado à garantia",
  A_DEVOLVER: "A devolver",
  EM_DEVOLUCAO: "Em devolução",
  DEVOLVIDO: "Devolvido",
  CREDITO_CONTRATO: "Crédito no contrato",
};

const ERROS_API = {
  ...MOTIVOS_OFERTA,
  PRE_RESERVA_INDISPONIVEL,
  SESSAO_ENCERRADA,
  LIMITE_REQUISICOES: "Muitas tentativas em pouco tempo. Aguarde um pouco e tente novamente.",
  LIMITE_INDISPONIVEL: "Não foi possível continuar agora. Tente novamente em instantes.",
  CODIGO_NAO_CONFIRMADO: "Código incorreto ou vencido. Confira os seis números ou peça outro código.",
  DADOS_INVALIDOS: "Confira os dados informados e tente novamente.",
  ORIGEM_RECUSADA: "Abra Meu pedido pelo site do buffet e tente novamente.",
  PEDIDO_INDISPONIVEL: "Este pedido não está disponível.",
  TERMOS_DESATUALIZADOS: "Os termos mudaram. Leia os termos atualizados e aceite novamente para liberar o Pix.",
  OFERTA_DESATUALIZADA: "A oferta mudou. Confira a oferta atual e aceite novamente para liberar o Pix.",
  ACEITE_NECESSARIO: "Aceite a oferta atual para liberar o Pix.",
  DESTINO_MUDOU: "O horário ou o local mudou. O Pix do aceite anterior está indisponível.",
  PIX_INDISPONIVEL: "O Pix deste aceite está indisponível.",
  CONFIRMACAO_NECESSARIA: "Confirme que entendeu que o horário será liberado.",
  COTACAO_PUBLICA_INDISPONIVEL: "O acompanhamento de pedidos está indisponível neste endereço.",
  CATALOGO_PUBLICO_INDETERMINADO: "O acompanhamento de pedidos está indisponível no momento.",
  AGENDA_PUBLICA_INDISPONIVEL: "A agenda pública está indisponível no momento.",
};

function rotulo(rotulos: Readonly<Record<string, string>>, codigo: string, padrao: string) {
  return Object.hasOwn(rotulos, codigo) ? rotulos[codigo] : padrao;
}

export const rotuloPedido = (codigo: string) => rotulo(SITUACOES_PEDIDO, codigo, "Situação do pedido indisponível");
export const rotuloGarantia = (codigo: string) => rotulo(SITUACOES_GARANTIA, codigo, "Situação da garantia indisponível");
export const rotuloDinheiro = (codigo: string) => rotulo(DESTINOS_SINAL, codigo, "Destino do sinal indisponível");
export const rotuloErro = (codigo: string) => rotulo(ERROS_API, codigo, "Não foi possível continuar agora. Tente novamente.");

const dataHoraSP = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short",
});

export function formatarValidade(instante: string) {
  const data = new Date(instante);
  return Number.isFinite(data.getTime()) ? dataHoraSP.format(data) : null;
}

export function acoesDoPedido({ status, oferta, preReserva }: Pedido) {
  const { aguardandoConferencia, garantia, aceite, novoAceiteNecessario } = preReserva;
  return {
    aceitar: oferta.disponivel && status === "AGUARDANDO_CONTRATO"
      && !garantia?.ate && !aguardandoConferencia && (novoAceiteNecessario || !aceite),
    pix: status === "AGUARDANDO_CONTRATO" && !garantia?.ate && !novoAceiteNecessario
      && aguardandoConferencia && Boolean(aceite?.recebedor.cidade),
    desistir: status === "AGUARDANDO_CONTRATO" && garantia?.situacao === "ATIVA" && Boolean(garantia.ate),
  };
}

export function termosDaOferta(oferta: Oferta) {
  // Em uma atualização do app, o GET pode vir de uma versão mais nova que esta aba.
  return oferta.termos.versao === VERSAO_TERMOS_PRE_RESERVA ? TERMOS_PRE_RESERVA : oferta.termos.texto;
}

export const corpoEntrada = (cpf: string) => ({ cpf: cpf.replace(/\D/g, "") });
export const corpoCodigo = (desafio: string, codigo: string) => ({ desafio, codigo: codigo.trim() });
export const corpoAceite = (oferta: Oferta) => ({ termosVersao: oferta.termos.versao, versaoOferta: oferta.versaoOferta });
export const corpoDesistencia = (confirmado: boolean) => confirmado ? { confirmarLiberacao: true } : null;

export function iniciarLeitura(referencia: { current: number }) {
  const leitura = ++referencia.current;
  return () => leitura === referencia.current;
}
