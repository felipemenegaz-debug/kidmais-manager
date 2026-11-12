import { createHash } from 'node:crypto';
import { renderizarContratoOficial } from '../../../contratos/documento/oficial/registry.ts';
import { CONTRATO_OFICIAL_TEMPLATE_ATUAL } from '../../../contratos/documento/oficial/models.ts';
import type { ContratoSnapshotV1 } from '../../../contratos/repositories/index.ts';
import type { TemaContrato } from './tipos.ts';

/**
 * Condições GERAIS do modelo de contrato VIGENTE (não o contrato de uma cliente). O texto vem do próprio renderizador
 * oficial (lib/contratos/documento/oficial), na versão atual, com um contrato sintético neutro: só cláusulas que NÃO
 * dependem de dados da contratação são citadas, palavra por palavra, com modelo, versão e hash. Cláusulas com dados da
 * contratação (objeto, valor, pagamento) nunca são citadas: a resposta explica onde a condição fica.
 */
export const CLAUSULAS_FIXAS = [3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;
/** Tema → cláusulas do modelo vigente (V5; S-E só muda a Cláusula 1, nunca citada). Mapa revisado contra o texto (ver contrato-modelo.test.ts). */
export const CLAUSULAS_POR_TEMA: Record<TemaContrato, number[]> = {
  CANCELAMENTO: [9], REMARCACAO: [9], INADIMPLENCIA: [7], CONVIDADOS: [3, 4], CORTESIA: [4], HORARIOS: [8], DANOS: [15],
  BEBIDAS: [11], LIMPEZA: [14], BALOES: [17], LEMBRANCINHAS: [5], GERAL: [], PAGAMENTO: [], SINAL: [],
};
/** Modelo de referência para as cláusulas que não variam entre pacotes (só a 3 traz o valor do excedente do pacote). */
const PACOTE_REFERENCIA = 'COMPLETA';

export type ClausulaVigente = { numero: number; texto: string; sha256: string };
export type ModeloVigente = { modeloCodigo: string; templateVersao: number; pacoteCodigo: string; clausulas: ClausulaVigente[] };

function snapshotNeutro(pacoteCodigo: string): ContratoSnapshotV1 {
  return {
    schemaVersao: 1,
    fechamento: { id: '00000000-0000-4000-8000-000000000001', status: 'AGUARDANDO_CONTRATO', origem: 'CLIENTE' },
    contratante: { clienteId: '00000000-0000-4000-8000-000000000002', nomeCompleto: 'Contratante', cpf: '00000000000', rg: null, telefone: null, whatsapp: null, email: 'contratante@example.test',
      endereco: { cep: '00000000', logradouro: '-', numero: '-', complemento: null, bairro: '-', cidade: '-', uf: 'DF' } },
    responsavelAdicional: null,
    aniversariante: { id: '00000000-0000-4000-8000-000000000003', nome: 'Aniversariante', dataNascimento: '2020-01-01', idadeNoEvento: 6, temaFesta: null },
    evento: { data: '2030-01-01', horarioInicio: '11:00:00', horarioFim: '15:00:00', pacote: { id: '00000000-0000-4000-8000-000000000004', codigo: pacoteCodigo, nome: 'Pacote', duracaoMinutos: 240 }, convidados: 50, convidadosFaturados: 50 },
    contratacao: { adicionais: [], alteracoesPacote: null, observacoesCliente: null, observacoesEquipe: null, buffet: { status: 'PENDENTE', salgados: null, bebidas: null, doces: null, bolo: null, outros: null } },
    comercial: { tabelaPreco: { id: '00000000-0000-4000-8000-000000000005', codigo: '-', nome: '-' }, categoriaHorario: 'PADRAO', categoriaPrecoAplicada: 'PADRAO', valorPacoteBase: 0, descontoPercentual: 0,
      valorDescontoPacote: 0, valorPacoteAplicado: 0, valorAdicionais: 0, valorTabela: 0, valorNegociado: null, valorAprovado: null, valorFinalContrato: 0, formaPagamentoPretendida: 'PIX_AVISTA' },
  } as unknown as ContratoSnapshotV1;
}

const cache = new Map<string, ModeloVigente | null>();
/** Modelo vigente para o pacote (ou o de referência). null: pacote sem modelo oficial cadastrado. */
export function modeloVigente(pacoteCodigo?: string | null): ModeloVigente | null {
  const codigo = pacoteCodigo || PACOTE_REFERENCIA;
  if (cache.has(codigo)) return cache.get(codigo)!;
  const renderizado = renderizarContratoOficial({ snapshot: snapshotNeutro(codigo) as never, numeroVersao: 1, snapshotHash: '0'.repeat(64), templateVersao: CONTRATO_OFICIAL_TEMPLATE_ATUAL });
  const modelo = renderizado ? {
    modeloCodigo: renderizado.modeloCodigo, templateVersao: renderizado.templateVersao, pacoteCodigo: codigo,
    clausulas: renderizado.clausulas.filter((c) => (CLAUSULAS_FIXAS as readonly number[]).includes(c.numero))
      .map((c) => ({ numero: c.numero, texto: c.texto, sha256: createHash('sha256').update(c.texto).digest('hex') })),
  } : null;
  cache.set(codigo, modelo);
  return modelo;
}

/**
 * Cláusulas para um tema. A cláusula 3 (aumento de convidados) traz o valor do excedente do pacote: só é citada com o
 * pacote conhecido e com modelo oficial; sem ele, cita-se só a 4 (cortesia), que não varia.
 */
export function clausulasDoTema(tema: TemaContrato, pacoteCodigo: string | null) {
  const numeros = CLAUSULAS_POR_TEMA[tema];
  const geral = modeloVigente(null);
  const doPacote = pacoteCodigo ? modeloVigente(pacoteCodigo) : null;
  const itens: { modelo: ModeloVigente; clausula: ClausulaVigente }[] = [];
  for (const n of numeros) {
    const fonte = n === 3 ? doPacote : geral;
    const c = fonte?.clausulas.find((x) => x.numero === n);
    if (fonte && c) itens.push({ modelo: fonte, clausula: c });
  }
  return itens;
}
