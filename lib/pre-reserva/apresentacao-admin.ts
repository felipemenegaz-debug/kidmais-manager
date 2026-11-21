import { POLITICA_PRE_RESERVA, referenciaTransferencia } from './politica.ts';

export type ConfiguracaoPreReserva = {
  habilitada: boolean; sinalCentavos: number; versao: number;
  orcamentoOnline: boolean; recebedorPix: boolean;
};

export type RevisaoPreReserva = {
  sequencia: number; sinalCentavos: number; aceitoEm: string;
  inicio: string; fim: string; unidade: string | null; salao: string | null;
  recebedor: string; garantiaAte: string | null; garantia: string | null;
  destinos: string[];
};

export type OcupacaoPreReserva = {
  data: string; inicio: string; fim: string; salao: string | null;
  garantiaAte: string; fechamentoId: string | null;
};

export type DevolucaoPreReserva = {
  fechamento_id: string; end_to_end_id: string; motivo: string;
  valor_centavos: string; responsavel: string | null; responsavel_nome: string | null;
  devolucao_assumida_em: string | null; devolvido_em: string | null;
  devolvido_por: string | null; devolvido_por_nome: string | null; situacao: string;
};

const motivos: Record<string, string> = {
  VALOR_DIVERGENTE: 'Valor recebido diferente do sinal',
  MENOS_DE_24_HORAS: 'Menos de 24 horas até a festa',
  PEDIDO_INELEGIVEL: 'Pedido fora da situação exigida para garantir o horário',
  DESTINO_MUDOU: 'Local ou horário mudou após o aceite',
  HORARIO_INDISPONIVEL: 'Horário indisponível',
  SEM_GARANTIA_ANTERIOR: 'Recebimento anterior sem garantia',
  SEM_GARANTIA: 'Recebimento sem garantia',
  EXPIRADA: 'Garantia vencida',
  DESISTENCIA: 'Desistência do pedido',
  RECUSA: 'Pedido recusado',
  FORMALIZACAO_SEM_CREDITO: 'Contrato formalizado sem crédito do sinal',
  FORMALIZACAO: 'Pedido formalizado',
  CANCELAMENTO_FESTA_SEM_BAIXA: 'Festa cancelada antes da baixa do crédito',
  ADITIVO_ABAIXO_DO_CREDITO: 'Valor do aditivo abaixo do crédito do sinal',
};

const situacoes: Record<string, string> = {
  A_DEVOLVER: 'A devolver', EM_DEVOLUCAO: 'Devolução assumida', DEVOLVIDO: 'Devolvido',
  EM_GARANTIA: 'Vinculado à garantia', CREDITO_CONTRATO: 'Crédito no contrato',
};

export function rotuloMotivo(codigo: string) {
  return Object.hasOwn(motivos, codigo) ? motivos[codigo] : 'Motivo não informado';
}

export function rotuloDestino(codigo: string) {
  return Object.hasOwn(situacoes, codigo) ? situacoes[codigo] : 'Situação não informada';
}

const fuso = 'America/Sao_Paulo';
const dataHora = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'short', timeStyle: 'short' });
const partesDoHorario = new Intl.DateTimeFormat('en-GB', {
  timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
  hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
});

export function formatarInstanteSP(instante: string) {
  return dataHora.format(new Date(instante));
}

export function instanteComOffsetSP(data: string, hora: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{2}:\d{2}(:\d{2})?$/.test(hora)) {
    throw new Error('Informe a data e a hora da saída no horário de São Paulo.');
  }
  const local = `${data}T${hora.length === 5 ? `${hora}:00` : hora}`;
  const comoUtc = new Date(`${local}Z`);
  if (data.startsWith('0000-') || !Number.isFinite(comoUtc.getTime()) || comoUtc.toISOString().slice(0, 19) !== local) {
    throw new Error('Informe uma data e hora válidas.');
  }
  const dia = 86_400_000;
  const offsets = new Set([-dia, dia].map((delta) =>
    partesDoHorario.formatToParts(comoUtc.getTime() + delta).find((p) => p.type === 'timeZoneName')!.value.slice(3)));
  const instantes = [...offsets].map((offset) => `${local}${offset}`).filter((candidato) => {
    const instante = new Date(candidato);
    if (!Number.isFinite(instante.getTime())) return false;
    const partes = Object.fromEntries(partesDoHorario.formatToParts(instante).map(({ type, value }) => [type, value]));
    return `${partes.year.padStart(4, '0')}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}` === local;
  });
  if (instantes.length !== 1) throw new Error('Confira a data e a hora da saída no horário de São Paulo.');
  return instantes[0];
}

function centavos(valor: string) {
  const partes = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(valor.trim());
  if (!partes) throw new Error('Informe um valor com até duas casas decimais.');
  const resultado = Number(`${partes[1]}${(partes[2] ?? '').padEnd(2, '0')}`);
  if (!Number.isSafeInteger(resultado) || resultado <= 0) throw new Error('Informe um valor positivo e válido.');
  return resultado;
}

export function corpoConfiguracao(habilitada: boolean, valor: string, versao: number) {
  const sinalCentavos = centavos(valor);
  if (sinalCentavos < POLITICA_PRE_RESERVA.sinalMinimoCentavos || sinalCentavos > POLITICA_PRE_RESERVA.sinalMaximoCentavos) {
    throw new Error('O sinal deve ficar entre R$ 10 e R$ 500.');
  }
  return { habilitada, sinalCentavos, versao };
}

export type AcaoSinal = 'CONFIRMAR' | 'REGISTRAR_DIVERGENTE_A_DEVOLVER';

export function corpoSinal(aceiteSequencia: number, referencia: string, valor: string, acao: AcaoSinal) {
  return { aceiteSequencia, referencia: referenciaTransferencia(referencia), valorCentavos: centavos(valor), acao };
}

export function corpoBaixa(original: string, referencia: string, valor: string, integral: string, data: string, hora: string, extratoConferido: boolean) {
  const valorCentavos = centavos(valor);
  if (valorCentavos !== Number(integral)) throw new Error('Informe o valor integral do Pix recebido.');
  if (!referencia.trim()) throw new Error('Informe a referência da saída no extrato.');
  if (!extratoConferido) throw new Error('Confirme a conferência da saída no extrato.');
  return { original, referencia: referencia.trim(), valorCentavos, devolvidoEm: instanteComOffsetSP(data, hora), extratoConferido };
}
