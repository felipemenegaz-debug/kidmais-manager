// Empresa SINTÉTICA da avaliação (mesmos nomes da demonstração), com as fontes oficiais em memória no formato da porta
// real (FontesWallE). Sem banco, sem rede. Usada pelo avaliador e pelo teste de regressão do holdout.
export const HOJE = '2026-10-05';
export const AGORA = `${HOJE}T15:00:00.000Z`;
export const EMPRESA = '00000000-0000-4000-8000-00000000a7a1';
export const CATALOGOS = {
  pacotes: [{ codigo: 'ESSENCIAL', nome: 'Essencial' }, { codigo: 'COMPLETA', nome: 'Completa' }, { codigo: 'PREMIUM', nome: 'Premium' }],
  unidades: [{ id: 'u-asa-sul', nome: 'Asa Sul (demonstração)' }, { id: 'u-aguas-claras', nome: 'Águas Claras (demonstração)' }],
  unidadesAgenda: [],
  turnos: [{ codigo: 'TURNO_1', nome: 'Primeiro horário', inicio: '11:00', fim: '15:00' }, { codigo: 'TURNO_2', nome: 'Segundo horário', inicio: '17:00', fim: '21:00' }],
  // Como em catalogosWallE: pergunta e resposta publicadas (a resposta não vai ao modelo).
  perguntas: [
    { id: 'estacionamento', pergunta: 'Vocês têm estacionamento?', resposta: 'Resposta sintética: estacionamento no local.' },
    { id: 'horario', pergunta: 'Qual é o horário de atendimento?', resposta: 'Resposta sintética: de terça a domingo, das 9h às 18h.' },
  ],
  // Como em catalogosWallE (rodada 4): nomes dos itens do buffet dos pacotes vigentes, os mesmos de FONTES.composicao.
  itensBuffet: ['Coxinha', 'Kibe'],
  hoje: HOJE,
};
export const CONFIG = {
  ativo: true, nome: 'Buffet sintético', limites: { respostasPor24h: 20 },
  perguntas: [
    { id: 'estacionamento', pergunta: 'Vocês têm estacionamento?', resposta: 'Resposta sintética: estacionamento no local.' },
    { id: 'horario', pergunta: 'Qual é o horário de atendimento?', resposta: 'Resposta sintética: de terça a domingo, das 9h às 18h.' },
  ],
};
const pronta = (p) => ({ versao: 1, texto: p.titulo, link: null, midiaUrl: null, arquivoId: null, arquivoNome: null, pacoteCodigo: null, unidadeId: null, ...p });
const PRONTAS = {
  PRECOS: [pronta({ id: 'p-tabela', titulo: 'Tabela de preços', tipo: 'DOCUMENTO', finalidade: 'PRECOS', arquivoId: 'a-tabela', arquivoNome: 'tabela.pdf' })],
  LOCALIZACAO: [
    pronta({ id: 'p-asa-sul', titulo: 'Endereço Asa Sul', tipo: 'LINK', finalidade: 'LOCALIZACAO', texto: 'Asa Sul: endereço sintético.', link: 'https://maps.example.test/asa-sul', unidadeId: 'u-asa-sul' }),
    pronta({ id: 'p-aguas', titulo: 'Endereço Águas Claras', tipo: 'LINK', finalidade: 'LOCALIZACAO', texto: 'Águas Claras: endereço sintético.', link: 'https://maps.example.test/aguas-claras', unidadeId: 'u-aguas-claras' }),
  ],
  DECORACAO: [pronta({ id: 'p-decoracao', titulo: 'Decoração', tipo: 'TEXTO', finalidade: 'DECORACAO', texto: 'Na Kidmais fazemos qualquer decoração.' })],
  CARDAPIO: ['ESSENCIAL', 'COMPLETA', 'PREMIUM'].map((c) => pronta({ id: `p-cardapio-${c}`, titulo: `Cardápio ${c}`, tipo: 'DOCUMENTO', finalidade: 'CARDAPIO', arquivoId: `a-${c}`, arquivoNome: `cardapio-${c}.pdf`, pacoteCodigo: c })),
};
export const PACOTES = [
  { id: 'pk-e', codigo: 'ESSENCIAL', nome: 'Essencial', descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 60 },
  { id: 'pk-c', codigo: 'COMPLETA', nome: 'Completa', descricao: null, duracaoMinutos: 240, convidadosMinimos: 50, convidadosMaximos: 100 },
  { id: 'pk-p', codigo: 'PREMIUM', nome: 'Premium', descricao: null, duracaoMinutos: 300, convidadosMinimos: 80, convidadosMaximos: 150 },
];
const periodos = () => CATALOGOS.turnos.map((t) => ({ codigo: t.codigo, nome: t.nome, inicio: t.inicio, fim: t.fim, disponivel: true }));
export const FONTES = {
  async prontasAutorizadas(f) { return PRONTAS[f] ?? []; },
  async pacotes() { return PACOTES; },
  async composicao() { return { categorias: [{ nome: 'Salgados', escolhasMin: 0, escolhasMax: 4, itens: ['Coxinha', 'Kibe'] }], inclusos: [], extras: [] }; },
  async preco(codigo, _data, _turno, convidados) {
    const p = PACOTES.find((x) => x.codigo === codigo);
    if (convidados > p.convidadosMaximos) return { erro: 'ACIMA_CAPACIDADE', maximo: p.convidadosMaximos };
    const faturados = Math.max(convidados, p.convidadosMinimos);
    return { valor: faturados * 100, convidadosFaturados: faturados, minimoAplicado: convidados < p.convidadosMinimos, desconto: null, tabela: { id: 't-sint', codigo: 'TABELA_SINTETICA', nome: 'Tabela sintética' } };
  },
  // Escopo: a agenda da empresa inteira (sem a 062 por unidade), como na demonstração.
  async disponibilidade() { return { periodos: periodos(), escopo: { tipo: 'EMPRESA' } }; },
  async alternativas() { return []; },
  async linkContratoProprio() { return null; },
};
