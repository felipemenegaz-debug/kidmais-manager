'use client';
import DrawerKidmais from './DrawerKidmais';
import type { Mensagem } from './conversa';
import type { RascunhoPublico } from './cliente-inteligencia';

/**
 * Vitrine do drawer para /preview-ux/inteligencia (KIDMAIS_PREVIEW_UX=1). Dados fictícios e estáticos:
 * nenhuma chamada de rede, nenhum dado real. Mostra leitura, rascunho, preview do Human Gate,
 * resultado e recusa honesta lado a lado para revisão de UX.
 */
const base: RascunhoPublico = {
  operacaoId: '00000001-0000-4000-8000-000000000000', capacidade: 'criar_pacote', estado: 'COLETANDO', versao: 2,
  payloadHash: '', expiraEm: '2026-09-28T15:30:00.000Z', titulo: 'Novo pacote', avisos: [],
  campos: [
    { id: 'nome', rotulo: 'Nome', valor: 'Festa Plus', obrigatorio: true },
    { id: 'precoCentavos', rotulo: 'Preço', valor: 'R$ 4.500,00 (de ? a ? convidados)', obrigatorio: false },
  ],
};

const preview: RascunhoPublico = {
  ...base, estado: 'AGUARDANDO_CONFIRMACAO', versao: 4, payloadHash: 'a'.repeat(64),
  campos: [
    { id: 'nome', rotulo: 'Nome', valor: 'Festa Plus', obrigatorio: true },
    { id: 'precoCentavos', rotulo: 'Preço', valor: 'R$ 4.500,00 (de 30 a 80 convidados)', obrigatorio: false },
    { id: 'duracaoMinutos', rotulo: 'Duração', valor: '4 horas', obrigatorio: true },
    { id: 'convidados', rotulo: 'Convidados', valor: '30 a 80', obrigatorio: true },
    { id: 'adicionais', rotulo: 'Adicionais', valor: 'Nenhum por enquanto (configure em Pacotes)', obrigatorio: false },
    { id: 'status', rotulo: 'Status', valor: 'Ativo ao criar', obrigatorio: false },
    { id: 'unidade', rotulo: 'Unidade', valor: 'Empresa atual, conferida na hora de gravar', obrigatorio: false },
  ],
  avisos: ['Dias e horários, buffet e adicionais não são definidos por aqui: complete em Pacotes depois da criação.'],
};

const MENSAGENS: Mensagem[] = [
  {
    id: 1, pergunta: 'Quais contratos estão pendentes?', fase: 'leitura', dados: {
      capacidade: 'contratos_pendentes', estado: 'atencao', resumo: '2 contratos aguardam assinatura; 1 tem festa nos próximos 15 dias.',
      fatos: [
        { natureza: 'FATO', texto: '2 contratos com status Aguardando assinatura.', fonte: 'contratos.aguardando_assinatura' },
        { natureza: 'FATO', texto: '1 com festa em até 15 dias.', fonte: 'contratos.aguardando_assinatura' },
      ],
      itens: [
        { id: 'c1', prioridade: 'alta', titulo: 'Cliente Exemplo · 02/10/2026', detalhe: 'Festa Completa · festa em 4 dias', destino: '/admin/contratos' },
        { id: 'c2', prioridade: 'baixa', titulo: 'Outro Cliente · 10/12/2026', detalhe: 'Essencial · festa em 73 dias', destino: '/admin/contratos' },
      ],
      evidencias: [{ fonte: 'contratos.aguardando_assinatura', rotulo: 'Aguardando assinatura', valor: '2', destino: '/admin/contratos' }],
      referencia: { hoje: '2026-09-28', geradoEm: '2026-09-28T15:00:00.000Z', fontes: ['contratos.aguardando_assinatura'] },
    },
  },
  { id: 2, pergunta: 'Crie o pacote Festa Plus por R$ 4.500.', fase: 'rascunho', rascunho: base, perguntaKidmais: 'Qual é a duração da festa? Ex.: 4 horas ou 3h30.' },
  { id: 3, pergunta: 'de 30 a 80', fase: 'preview', rascunho: preview, decidindo: false, erro: null },
  { id: 4, pergunta: 'Crie uma categoria do buffet chamada Doces', fase: 'nao_suportado', mensagem: "Entendi que você quer criar a categoria 'Doces'. Essa ação ainda não está disponível pelo assistente. Hoje o Buffet é um catálogo global: nenhuma empresa pode alterá-lo, nem pela tela nem pelo Kidmais Intelligence.", sugestoes: ['O que precisa da minha atenção hoje?'] },
  { id: 5, pergunta: 'Confirmar', fase: 'resultado', rascunho: { ...preview, estado: 'EXECUTADA' }, mensagem: 'Pacote "Festa Plus" criado.', destino: '/admin/configuracoes/pacotes' },
];

export default function PreviewInteligencia({ estado }: { estado?: string }) {
  const mensagens = estado === 'vazio' ? [] : estado === 'gravando' ? MENSAGENS.slice(0, 3).map((m) => (m.fase === 'preview' ? { ...m, decidindo: true } : m)) : MENSAGENS;
  return <DrawerKidmais mensagens={mensagens} aguardando={estado === 'gravando'} contexto={null} onPerguntar={() => {}} onDecidir={() => {}} onFechar={() => {}} />;
}
