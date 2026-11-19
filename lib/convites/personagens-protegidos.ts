const personagens = [
  'Barbie', 'Ben 10', 'Bluey', 'Bob Esponja', 'Capitão América',
  'Dora Aventureira', 'Dragon Ball', 'Frozen', 'Galinha Pintadinha', 'Harry Potter',
  'Hello Kitty', 'Homem-Aranha', 'Homem Aranha', 'Homem de Ferro', 'Hulk',
  'Lightning McQueen', 'Lilo e Stitch', 'Looney Tunes', 'Luccas Neto',
  'Masha e o Urso', 'Meu Malvado Favorito', 'Mickey Mouse', 'Minnie Mouse',
  'Mickey', 'Minnie', 'Minions', 'Moana', 'My Little Pony', 'Naruto',
  'Patrulha Canina', 'Paw Patrol', 'Peppa Pig', 'Peppa', 'Pikachu',
  'PJ Masks', 'Pokémon', 'Pocoyo', 'Power Rangers', 'Relâmpago McQueen',
  'Scooby-Doo', 'Shrek', 'Sonic', 'Spider-Man', 'Star Wars', 'Stitch',
  'Super Mario', 'Mario', 'Mario Bros', 'Mario Kart', 'Luigi', 'Princesa Peach', 'Yoshi', 'Bowser',
  'Super-Homem', 'Superman', 'Batman', 'Mulher-Maravilha',
  'Toy Story', 'Transformers', 'Turma da Mônica',
  'Ursinho Pooh', 'Vingadores', 'Wandinha',
];

const marcas = ['Disney', 'Pixar', 'Marvel', 'LEGO', 'Nickelodeon', 'Roblox', 'Minecraft'];

export type MencaoProtegida = { termo: string; tipo: 'personagem' | 'marca' };

function palavras(texto: string) {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
}

/** Todos os termos reconhecidos; a sugestão original (sugestao-original.ts) cobre cada um. */
export const termos: readonly MencaoProtegida[] = [
  ...personagens.map(termo => ({ termo, tipo: 'personagem' as const })),
  ...marcas.map(termo => ({ termo, tipo: 'marca' as const })),
];
const porTermo = termos.map(mencao => ({ mencao, chave: palavras(mencao.termo) }))
  .sort((a, b) => b.chave.length - a.chave.length);

export function acharPersonagemProtegido(pedido: string): MencaoProtegida | undefined {
  const texto = ' ' + palavras(pedido) + ' ';
  return porTermo.find(({ chave }) => texto.includes(' ' + chave + ' '))?.mencao;
}
