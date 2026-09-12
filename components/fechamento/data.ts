import type { PacoteId } from "./types.ts";

export type Pacote = {
  id: PacoteId;
  nome: string;
  precoInicial: number | null;
  minPagantes: number;
  maxPagantes: number;
  descricao: string;
  disponibilidade: string;
  duracao: string;
  buffet: string;
  observacao?: string;
  destaque?: string;
  sobConsulta?: boolean;
};

export const CONTATO_KIDMAIS = {
  whatsapp: "(61) 99340-5359",
  whatsappUrl: "https://wa.me/5561993405359",
  instagram: "@kidmais_festas",
  site: "www.kidmaisfestas.com",
  endereco: "SHCGN 704/5, Bloco D, Asa Norte, Brasília-DF",
};

export const PACOTES: Pacote[] = [
  {
    id: "pocket",
    nome: "Kidmais Pocket",
    precoInicial: 3800,
    minPagantes: 20,
    maxPagantes: 150,
    descricao: "Pacote de entrada para festas menores e comemorações mais intimistas.",
    disponibilidade: "Segunda a quinta e sexta-feira, das 11h às 15h.",
    duracao: "3 horas de festa + 30 minutos de tolerância sem buffet e sem subsolo.",
    buffet:
      "Salgadinhos, pão de queijo, pipoca, batata frita, cachorro-quente, pizza, refrigerante, suco de polpa, água, docinhos tradicionais e bolo.",
    observacao: "R$ 190 por convidado, com mínimo faturável de 20 convidados. Lembrancinha não inclusa.",
  },
  {
    id: "mini",
    nome: "Mini Festa Kidmais",
    precoInicial: 5100,
    minPagantes: 30,
    maxPagantes: 150,
    descricao: "Opção prática para turma da escola, festa infantil menor e comemoração compacta.",
    disponibilidade: "Segunda a quinta e sexta de manhã.",
    duracao: "3 horas de festa + 30 minutos de tolerância sem buffet e sem subsolo.",
    buffet:
      "Salgadinhos, pão de queijo, pipoca, batata frita, cachorro-quente, pizza, refrigerante, suco de polpa, água, docinhos tradicionais e bolo.",
    observacao: "R$ 170 por criança. Lembrancinha inclusa.",
  },
  {
    id: "compacta",
    nome: "Festa Compacta",
    precoInicial: 6490,
    minPagantes: 40,
    maxPagantes: 150,
    descricao: "Pacote de entrada com estrutura Kidmais para famílias que buscam investimento menor.",
    disponibilidade:
      "Horários selecionados. Sugestões da tabela: sexta à tarde, domingo de manhã, domingo à tarde e datas de menor procura.",
    duracao: "3 horas de festa + 30 minutos de tolerância sem buffet e sem subsolo.",
    buffet:
      "Salgadinhos, pipoca, pão de queijo, cachorro-quente, batata frita, refrigerante, suco de polpa, água e bolo.",
    observacao: "Base de 40 pessoas pagantes. Valores acima desta base devem ser confirmados pela equipe.",
  },
  {
    id: "essencial",
    nome: "Festa Essencial",
    precoInicial: 8490,
    minPagantes: 50,
    maxPagantes: 150,
    descricao: "Pacote tradicional de entrada para festas maiores.",
    disponibilidade: "Conforme data, horário e disponibilidade da agenda.",
    duracao: "3h30 com espaço e buffet + 30 minutos sem subsolo e sem buffet.",
    buffet:
      "Salgadinhos, minipizza, cachorro-quente, pipoca, pão de queijo, batata frita, docinhos, bolo, refrigerantes, suco de polpa e água.",
  },
  {
    id: "completa",
    nome: "Festa Completa",
    precoInicial: 8990,
    minPagantes: 50,
    maxPagantes: 150,
    descricao: "O pacote tradicional mais escolhido da Kidmais.",
    disponibilidade: "Conforme data, horário e disponibilidade da agenda.",
    duracao: "3h30 com espaço e buffet + 30 minutos sem subsolo e sem buffet.",
    buffet:
      "Tudo da Festa Essencial + lembrancinha, salada, massa penne, crepe de queijo e sorvete.",
    destaque: "Mais escolhida",
  },
  {
    id: "premium",
    nome: "Festa Premium",
    precoInicial: 9790,
    minPagantes: 50,
    maxPagantes: 150,
    descricao: "A experiência tradicional mais completa da Kidmais.",
    disponibilidade: "Conforme data, horário e disponibilidade da agenda.",
    duracao: "3h30 com espaço e buffet + 30 minutos sem subsolo e sem buffet.",
    buffet:
      "Tudo da Festa Completa + crepe de chocolate, coquetel de frutas, pastelzinho, bombom, pintura de rosto, empratado e salada premium.",
    destaque: "Experiência completa",
  },
  {
    id: "pizza_party_scienza",
    nome: "Pizza Party Scienza",
    precoInicial: null,
    minPagantes: 1,
    maxPagantes: 50,
    descricao:
      "Festa Kidmais com rodízio de pizzas artesanais Scienza, unindo diversão e uma experiência gastronômica diferenciada.",
    disponibilidade: "Disponibilidade sujeita à confirmação da data e da operação Scienza.",
    duracao: "Conforme configuração do pacote e horário contratado.",
    buffet:
      "Espaço Kidmais exclusivo, recreação com monitores, som ambiente, decoração padrão Kidmais, refrigerantes e sucos, rodízio de pizzas artesanais Scienza, pizza doce ao final da festa e equipe de apoio.",
    observacao:
      "Sabores informados na tabela: Muçarela Scienza, Margherita Clássica, Calabresa Ceratti, Frango com Requeijão Scala e Pizza de Chocolate Scienza. Sabores e quantidades são ajustados conforme o número de convidados.",
    destaque: "Pizza artesanal Scienza",
    sobConsulta: true,
  },
];

// O catálogo completo permanece disponível para gestão e consulta interna.
// O fechamento comercial da V1 exibe somente pacotes com contrato oficial.
export const PACOTES_FECHAMENTO_V1 = PACOTES;

// Matrizes comerciais oficiais persistidas nas migrations 006/006a.
// PADRAO = combinações regulares.
// NOBRE = sábado TURNO_2 e domingo TURNO_1.
// O backend continua sendo a autoridade final; estas matrizes alimentam apenas
// a prévia do fechamento e devem permanecer alinhadas ao PricingService.
export const PRECOS_TRADICIONAIS_PADRAO: Record<
  number,
  { essencial: number; completa: number; premium: number }
> = {
  50: { essencial: 8490, completa: 8990, premium: 9790 },
  60: { essencial: 9190, completa: 9790, premium: 10690 },
  70: { essencial: 9890, completa: 10590, premium: 11590 },
  80: { essencial: 10590, completa: 11390, premium: 12490 },
  90: { essencial: 11290, completa: 12190, premium: 13390 },
  100: { essencial: 11990, completa: 12990, premium: 14290 },
  110: { essencial: 12690, completa: 13790, premium: 15190 },
  120: { essencial: 13390, completa: 14590, premium: 16090 },
  130: { essencial: 14090, completa: 15390, premium: 16990 },
  140: { essencial: 14790, completa: 16190, premium: 17890 },
  150: { essencial: 15490, completa: 16990, premium: 18790 },
};

export const PRECOS_TRADICIONAIS_NOBRE: Record<
  number,
  { essencial: number; completa: number; premium: number }
> = {
  50: { essencial: 8490, completa: 9290, premium: 10690 },
  60: { essencial: 9190, completa: 9990, premium: 11790 },
  70: { essencial: 9890, completa: 10790, premium: 12890 },
  80: { essencial: 10590, completa: 11590, premium: 13990 },
  90: { essencial: 11290, completa: 12390, premium: 15090 },
  100: { essencial: 11990, completa: 13290, premium: 16190 },
  110: { essencial: 12690, completa: 14190, premium: 17290 },
  120: { essencial: 13390, completa: 15090, premium: 18390 },
  130: { essencial: 14090, completa: 15990, premium: 19490 },
  140: { essencial: 14790, completa: 16890, premium: 20590 },
  150: { essencial: 15490, completa: 17790, premium: 21690 },
};

export type Adicional = {
  id: string;
  nome: string;
  categoria: "buffet" | "mesa" | "decoracao" | "extra";
  descricao?: string;
  precoFixo?: number;
  precoPorFaixa?: [number, number, number, number];
};

export const ADICIONAIS: Adicional[] = [
  { id: "penne", nome: "Penne à bolonhesa e molho branco", categoria: "buffet", precoPorFaixa: [500, 490, 590, 690] },
  { id: "salada-premium", nome: "Salada premium", categoria: "buffet", precoPorFaixa: [320, 420, 520, 620] },
  { id: "crepe-1", nome: "Crepe — 1 sabor", categoria: "buffet", precoPorFaixa: [290, 390, 490, 590] },
  { id: "crepe-2", nome: "Crepe — 2 sabores", categoria: "buffet", precoPorFaixa: [490, 590, 690, 790] },
  { id: "pastelzinho", nome: "Pastelzinho de carne e queijo", categoria: "buffet", precoPorFaixa: [290, 390, 490, 590] },
  { id: "sorvete", nome: "Sorvete", categoria: "buffet", precoPorFaixa: [290, 390, 490, 590] },
  { id: "empratado", nome: "Empratado premium", categoria: "buffet", precoPorFaixa: [590, 790, 990, 1190] },

  { id: "mesa-cafe-p", nome: "Mesa de café — pequena", categoria: "mesa", precoFixo: 590 },
  { id: "mesa-cafe-m", nome: "Mesa de café — média", categoria: "mesa", precoFixo: 790 },
  { id: "mesa-cafe-g", nome: "Mesa de café — grande", categoria: "mesa", precoFixo: 990 },
  { id: "mesa-frios-p", nome: "Mesa de frios — pequena", categoria: "mesa", precoFixo: 690 },
  { id: "mesa-frios-m", nome: "Mesa de frios — média", categoria: "mesa", precoFixo: 890 },
  { id: "mesa-frios-g", nome: "Mesa de frios — grande", categoria: "mesa", precoFixo: 1190 },
  { id: "mesa-frutas-p", nome: "Mesa de frutas — pequena", categoria: "mesa", precoFixo: 390 },
  { id: "mesa-frutas-m", nome: "Mesa de frutas — média", categoria: "mesa", precoFixo: 590 },
  { id: "mesa-frutas-g", nome: "Mesa de frutas — grande", categoria: "mesa", precoFixo: 790 },

  { id: "arco-simples", nome: "Arco de balão simples", categoria: "decoracao", precoFixo: 490 },
  { id: "arco-medio", nome: "Arco de balão médio", categoria: "decoracao", precoFixo: 690 },
  { id: "arco-grande", nome: "Arco de balão grande", categoria: "decoracao", precoFixo: 890 },
  { id: "segundo-tema", nome: "2º tema", categoria: "decoracao", precoFixo: 600 },
  { id: "painel-redondo", nome: "Painel redondo", categoria: "decoracao", precoFixo: 650 },
  { id: "painel-retangular", nome: "Painel retangular grande", categoria: "decoracao", precoFixo: 850 },
  { id: "chao-vidro", nome: "Chão de vidro", categoria: "decoracao", precoFixo: 790 },
  { id: "personalizados", nome: "Montagem de personalizados", categoria: "decoracao", precoFixo: 180 },

  { id: "doces-extra", nome: "Doces tradicionais extras — cento", categoria: "extra", precoFixo: 200 },
  { id: "bombom", nome: "Bombom — unidade", categoria: "extra", precoFixo: 8 },
  { id: "lembrancinha-extra", nome: "Lembrancinha extra simples — unidade", categoria: "extra", precoFixo: 12 },
];

export function faixaBuffet(convidados: number) {
  if (convidados <= 50) return 0;
  if (convidados <= 80) return 1;
  if (convidados <= 110) return 2;
  return 3;
}

export function precoAdicional(adicional: Adicional, convidados: number) {
  if (adicional.precoFixo != null) return adicional.precoFixo;
  if (adicional.precoPorFaixa) {
    return adicional.precoPorFaixa[faixaBuffet(convidados)];
  }
  return 0;
}
