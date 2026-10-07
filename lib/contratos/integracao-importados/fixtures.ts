import type { SnapshotHistorico } from '../../importacao-contrato/plano.ts';
import { decisoesSchema, type DecisoesIntegracao, type Referencias } from './modelo.ts';

/** Fixtures compartilhadas pelos testes da integração (dados sintéticos). */
export const snapshotBase = (): SnapshotHistorico => ({
  evento: { data: '2026-11-14', horario: { inicio: '14:00', fim: '18:00' }, duracaoMinutos: 240, aniversariante: 'Lia', idade: 6, convidados: 80, tema: 'Fundo do mar' },
  pacote: { nome: 'Festa Completa 2019', duracaoMinutos: 240, quantidade: 80, itens: 'Buffet, decoração, monitores' },
  buffet: { itens: 'Salgados e bolo', observacoes: null, restricoes: null },
  valores: { preco: 800000, adicionais: 50000, total: 850000 },
  pagamentosPrevistos: { condicao: 'Entrada de 30% e saldo à vista no dia', entrada: { valor: 255000, vencimento: '2026-08-01' }, parcelas: [{ numero: 1, valor: 595000, vencimento: '2026-11-14' }], natureza: 'PREVISTO' },
  observacoes: 'Contrato assinado em papel',
});

export const referenciasBase = (): Referencias => ({
  cliente: { id: '11111111-1111-4111-8111-111111111111', nome: 'Ana Souza', status: 'ATIVO' },
  estabelecimentos: [{ id: '22222222-2222-4222-8222-222222222222', nome: 'Unidade Centro' }],
  pacote: { id: '33333333-3333-4333-8333-333333333333', codigo: 'COMPLETA', nome: 'Festa Completa', duracaoMinutos: 240 },
  precoReferencia: { tabelaPrecoId: '44444444-4444-4444-8444-444444444444', precoPacoteId: '55555555-5555-4555-8555-555555555555', categoria: 'NOBRE' },
  configuracaoAgendaId: '66666666-6666-4666-8666-666666666666',
  categoriaHorario: 'NOBRE',
});

export const decisoesBase = (mudar: Partial<DecisoesIntegracao> = {}): DecisoesIntegracao => decisoesSchema.parse({
  situacaoContrato: 'VIGENTE',
  estabelecimentoId: '22222222-2222-4222-8222-222222222222',
  pacoteReferenciaId: '33333333-3333-4333-8333-333333333333',
  evento: { data: '2026-11-14', horarioInicio: '14:00', horarioFim: '18:00', convidados: 80 },
  valorContratadoCentavos: 850000,
  financeiro: { situacao: 'PARCIALMENTE_PAGO', parcelas: [
    { valorCentavos: 255000, vencimento: '2026-08-01', recebimento: { data: '2026-08-03', forma: 'PIX' } },
    { valorCentavos: 595000, vencimento: '2026-11-14', recebimento: null },
  ] },
  conferenciaDeclarada: true,
  ...mudar,
});

export const cadastroBase = () => ({ nomeCompleto: 'Ana Souza', cpf: '52998224725', rg: '', telefone: '11999990000', whatsapp: '', email: 'ana@example.invalid', cep: '01001000', logradouro: 'Rua Teste', numero: '1', complemento: '', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' });
