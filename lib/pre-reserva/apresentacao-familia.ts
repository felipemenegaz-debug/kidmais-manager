import { createHmac } from 'node:crypto';
import { montarBrCodeEstatico, qrSvg, txidDaParcela } from '../pagamentos/pix/brcode.ts';
import { sinalDaOferta, vencimentoDaGarantia } from './politica.ts';
import { TEXTO_CONFERENCIA_PIX } from './termos.ts';

export type RecebedorDaOferta = { nome: string; cidade: string; chave: string };

type Elegibilidade = {
  status: string;
  temGarantia: boolean;
  habilitada: boolean;
  orcamentoOnline: boolean;
  escritaPermitida: boolean;
  recebedor: RecebedorDaOferta | null;
  sinalConfigurado: number;
  precoCentavos: number;
  agora: Date;
  inicioEvento: string;
};

export function avaliarOferta(dados: Elegibilidade) {
  if (dados.temGarantia) return { motivo: 'GARANTIA_EXISTENTE' } as const;
  if (dados.status !== 'AGUARDANDO_CONTRATO') return { motivo: 'PEDIDO_INELEGIVEL' } as const;
  if (!dados.habilitada) return { motivo: 'PILOTO_DESLIGADO' } as const;
  if (!dados.orcamentoOnline) return { motivo: 'ORCAMENTO_ONLINE_INDISPONIVEL' } as const;
  if (!dados.escritaPermitida) return { motivo: 'ACESSO_COMERCIAL_RESTRITO' } as const;
  if (!dados.recebedor) return { motivo: 'PRE_RESERVA_SEM_PIX' } as const;
  const sinalCentavos = sinalDaOferta(dados.habilitada, dados.orcamentoOnline, dados.sinalConfigurado, dados.precoCentavos);
  if (sinalCentavos === null) return { motivo: 'SINAL_INDISPONIVEL' } as const;
  const inicio = new Date(dados.inicioEvento);
  if (!Number.isFinite(inicio.getTime())) return { motivo: 'HORARIO_INDISPONIVEL' } as const;
  if (!vencimentoDaGarantia(dados.agora, inicio)) return { motivo: 'MENOS_DE_24_HORAS' } as const;
  return { motivo: null, sinalCentavos, recebedor: dados.recebedor } as const;
}

export type AceiteDoPedido = {
  sequencia: number;
  sinalCentavos: number;
  precoCentavos: string;
  estabelecimentoId: string | null;
  salaoId: string | null;
  salaoNome?: string | null;
  inicioEvento: string;
  fimEvento: string;
  recebedor: string;
  chave: string;
  termosVersao: string;
  termosAceitos: string;
  aceitoEm: Date;
};

export type SituacaoDoSinal = {
  garantia: string;
  garantiaAte: Date | null;
  dinheiro: string;
  valorCentavos: string;
  devolverDesde: Date | null;
  aceiteSequencia: number;
  motivoSemGarantia: string | null;
};

export function sinalJaConferido(aceite: AceiteDoPedido, sinais: SituacaoDoSinal[]) {
  return sinais.some(s => s.aceiteSequencia === aceite.sequencia && s.motivoSemGarantia !== 'VALOR_DIVERGENTE');
}

type DestinoDoAceite = Pick<AceiteDoPedido, 'estabelecimentoId' | 'inicioEvento' | 'fimEvento' | 'salaoId'>;

export function destinoDoAceiteConfere(atual: DestinoDoAceite, aceite: AceiteDoPedido, porSalao: boolean) {
  return atual.estabelecimentoId === aceite.estabelecimentoId && atual.inicioEvento === aceite.inicioEvento &&
    atual.fimEvento === aceite.fimEvento && (porSalao
      ? aceite.salaoId !== null && (atual.salaoId === null || atual.salaoId === aceite.salaoId)
      : aceite.salaoId === null);
}

// Os dois campos do BR Code são normalizados sem o separador. O retrato continua legível na revisão da Gestão.
const SEPARADOR_RECEBEDOR = ' · ';

export function retratoDoRecebedor({ nome, cidade }: RecebedorDaOferta) {
  return nome + SEPARADOR_RECEBEDOR + cidade;
}

function lerRecebedor(retrato: string) {
  const [nome, cidade] = retrato.split(SEPARADOR_RECEBEDOR);
  return { nome, cidade: cidade ?? null };
}

export function apresentarAceite(a: AceiteDoPedido) {
  return {
    sequencia: a.sequencia, sinalCentavos: a.sinalCentavos, aceitoEm: a.aceitoEm,
    inicioEvento: a.inicioEvento, fimEvento: a.fimEvento, salao: a.salaoNome ?? null,
    recebedor: lerRecebedor(a.recebedor), termos: { versao: a.termosVersao, texto: a.termosAceitos },
  };
}

export function apresentarSituacao(status: string, aceite: AceiteDoPedido | null, sinais: SituacaoDoSinal[],
  { destinoMudou = false, ofertaDisponivel = false } = {}) {
  const vigente = destinoMudou ? null : aceite;
  const aguardandoConferencia = status === 'AGUARDANDO_CONTRATO' && vigente !== null &&
    !sinais.some(s => s.garantiaAte !== null) && !sinalJaConferido(vigente, sinais);
  const garantia = sinais.find(s => s.garantiaAte !== null) ?? sinais.find(s => s.aceiteSequencia === aceite?.sequencia);
  return {
    aceite: vigente && apresentarAceite(vigente),
    novoAceiteNecessario: destinoMudou && ofertaDisponivel,
    aguardandoConferencia,
    mensagemConferencia: aguardandoConferencia ? TEXTO_CONFERENCIA_PIX : null,
    garantia: garantia ? { situacao: garantia.garantia, ate: garantia.garantiaAte } : null,
    dinheiro: sinais.map(s => ({
      situacao: s.dinheiro, valorCentavos: Number(s.valorCentavos), devolverDesde: s.devolverDesde,
    })),
  };
}

export function assinaturaDaOferta(pepper: string, dados: readonly unknown[]) {
  return createHmac('sha256', pepper).update('meu-pedido:oferta:v2|').update(JSON.stringify(dados)).digest('base64url');
}

export function montarPixDoAceite(pedidoId: string, a: AceiteDoPedido) {
  const { nome, cidade } = lerRecebedor(a.recebedor);
  if (!cidade) return null; // Aceites sintéticos anteriores ao retrato completo não têm cidade.
  const copiaECola = montarBrCodeEstatico({
    chave: a.chave, nomeRecebedor: nome, cidadeRecebedor: cidade,
    valorCentavos: a.sinalCentavos, txid: txidDaParcela(a.sequencia.toString(36).padStart(6, '0') + pedidoId),
  });
  return { copiaECola, qrSvg: qrSvg(copiaECola), valorCentavos: a.sinalCentavos };
}
