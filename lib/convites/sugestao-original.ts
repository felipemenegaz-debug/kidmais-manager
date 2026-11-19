import type { MencaoProtegida } from './personagens-protegidos';

// Pedido pronto e original para quando o tema cita um personagem ou marca protegida.
// Determinístico (sem chamada ao modelo, sem custo): descreve clima, cores e elementos genéricos,
// sem nomes, logotipos nem traços característicos do personagem ou da franquia.
const HEROIS = 'Cidade de super-heróis ao entardecer, com prédios altos, holofotes no céu, estrelas e balões de história em quadrinhos escritos POW! e BUM!. Cores vermelho, azul e amarelo. Cena cheia de ação e alegria.';
const VIDEOGAME = 'Aventura de videogame retrô em pixel art, com plataformas de blocos coloridos, moedas douradas, estrelas brilhantes, nuvens sorridentes e um castelo ao fundo. Cores vermelho, azul, amarelo e verde. Cena alegre e cheia de movimento.';
const CORRIDA = 'Corrida de carros numa pista colorida, com bandeira quadriculada, troféu dourado, pneus e confete. Cores vermelho, amarelo e preto. Cena veloz e animada.';
const FESTA_CLASSICA = 'Festa clássica de desenho animado, com balões, bolinhas de poá, estrelas e confete. Cores vermelho, preto e amarelo. Cena alegre e divertida.';
const FESTA_DELICADA = 'Festa clássica e delicada, com laços, balões, bolinhas de poá, flores e confete. Cores rosa, branco e preto. Cena fofa e alegre.';
const CACHORRINHOS_RESGATE = 'Cachorrinhos de resgate com caminhãozinho de bombeiro, cones, ossinhos e estrelas, numa cidade pequena e ensolarada. Cores vermelho, azul e amarelo. Cena corajosa e alegre.';
const FAZENDINHA = 'Fazendinha ensolarada com porquinhos, galinhas, flores, cerca de madeira e sol sorridente. Cores rosa, verde e azul-claro. Cena fofa e alegre.';
const CRIATURINHAS = 'Floresta mágica com criaturinhas fantásticas fofas e originais, raios brilhantes, folhas e estrelas. Cores amarelo, vermelho e azul. Cena de aventura e alegria.';
const PRAIA_TROPICAL = 'Praia tropical com palmeiras, flores de hibisco, pranchas de surfe e pôr do sol. Cores azul, rosa e verde. Cena alegre e ensolarada.';
const LABORATORIO = 'Laboratório de invenções com engenhocas, foguetes, engrenagens e bolhas coloridas. Cores amarelo, azul e cinza. Cena engraçada e cheia de surpresas.';
const ESPACO = 'Aventura espacial com naves, planetas, nebulosas e muitas estrelas. Cores azul-escuro, prata e laranja. Cena épica e brilhante.';
const ROBOS = 'Robôs gigantes e carros futuristas numa cidade de metal, com faíscas e luzes. Cores vermelho, azul e prata. Cena cheia de ação.';
const GENERICO = 'Cena original de festa infantil com balões, estrelas, confete e muitas cores alegres. Cena divertida e cheia de energia.';

const PEDIDOS: Record<string, string> = {
  'Barbie': 'Festa fashion com vestidos, sapatinhos, espelho, corações e brilhos. Cores rosa-chiclete, branco e dourado. Cena glamourosa e delicada.',
  'Ben 10': 'Aventura de ficção científica com um jovem herói original, naves, raios de energia e planetas. Cores verde, preto e branco. Cena cheia de ação.',
  'Bluey': 'Cachorrinhos brincando num quintal ensolarado, com bolas, pipas, árvores e uma casinha. Cores azul-claro, laranja e verde. Cena alegre e familiar.',
  'Bob Esponja': 'Fundo do mar divertido com peixinhos, águas-vivas, corais e bolhas. Cores amarelo, azul-turquesa e rosa. Cena engraçada e alegre.',
  'Capitão América': HEROIS,
  'Dora Aventureira': 'Aventura na floresta tropical com mochila, mapa, borboletas, cachoeira e uma ponte de cordas. Cores roxo, laranja e verde. Cena curiosa e alegre.',
  'Dragon Ball': 'Aventura de artes marciais com montanhas, nuvens velozes e rajadas de energia no céu. Cores laranja, azul e amarelo. Cena cheia de energia.',
  'Frozen': 'Reino de gelo com castelo de cristal, flocos de neve, montanhas nevadas e aurora no céu. Cores azul-claro, lilás e prata. Cena mágica e delicada.',
  'Galinha Pintadinha': 'Fazendinha musical com galinhas, pintinhos, notas musicais e flores. Cores azul, amarelo e verde. Cena alegre e cantante.',
  'Harry Potter': 'Escola de magia num castelo antigo, com livros, poções coloridas, chapéu de mago, corujas e estrelas. Cores vinho, dourado e azul-noite. Cena mágica e misteriosa.',
  'Hello Kitty': 'Gatinhos fofos entre docinhos, corações, flores e nuvens. Cores rosa, branco e lilás. Cena delicada e alegre.',
  'Homem-Aranha': HEROIS,
  'Homem Aranha': HEROIS,
  'Homem de Ferro': HEROIS,
  'Hulk': HEROIS,
  'Lightning McQueen': CORRIDA,
  'Lilo e Stitch': PRAIA_TROPICAL,
  'Looney Tunes': 'Cena de desenho animado clássico com animais engraçados, estrelinhas, balões e cores vibrantes. Cena divertida e cheia de movimento.',
  'Luccas Neto': 'Festa muito colorida com balões, slime, doces, confete e serpentina. Cores azul, amarelo e vermelho. Cena animada e divertida.',
  'Masha e o Urso': 'Floresta encantada com uma casinha de madeira, um urso simpático, cogumelos e flores. Cores rosa, verde e marrom. Cena fofa e divertida.',
  'Meu Malvado Favorito': LABORATORIO,
  'Mickey Mouse': FESTA_CLASSICA,
  'Minnie Mouse': FESTA_DELICADA,
  'Mickey': FESTA_CLASSICA,
  'Minnie': FESTA_DELICADA,
  'Minions': LABORATORIO,
  'Moana': 'Ilha tropical com oceano azul, canoa, flores, conchas e ondas. Cores turquesa, coral e verde. Cena de aventura e alegria.',
  'My Little Pony': 'Vale encantado com pôneis coloridos, arco-íris, nuvens e estrelas. Cores rosa, lilás e azul-claro. Cena mágica e delicada.',
  'Naruto': 'Vila ninja ao entardecer, com telhados orientais, folhas ao vento, estrelas de arremesso e montanhas. Cores laranja, azul e preto. Cena de aventura.',
  'Patrulha Canina': CACHORRINHOS_RESGATE,
  'Paw Patrol': CACHORRINHOS_RESGATE,
  'Peppa Pig': FAZENDINHA,
  'Peppa': FAZENDINHA,
  'Pikachu': CRIATURINHAS,
  'PJ Masks': 'Heróis noturnos numa cidade à noite, com lua, estrelas e luzes coloridas. Cores azul, verde e vermelho. Cena de aventura.',
  'Pokémon': CRIATURINHAS,
  'Pocoyo': 'Espaço branco e limpo com formas geométricas, estrelas e balões. Cores azul, amarelo e rosa. Cena simples e fofa.',
  'Power Rangers': 'Robôs gigantes e raios de energia numa cidade futurista. Cores vermelho, azul, amarelo, verde e rosa. Cena cheia de ação.',
  'Relâmpago McQueen': CORRIDA,
  'Scooby-Doo': 'Mistério divertido numa casa assombrada simpática, com lanternas, morcegos fofos e lua cheia. Cores roxo, verde e laranja. Cena engraçada, sem sustos.',
  'Shrek': 'Pântano encantado com floresta, cogumelos, vagalumes e um castelo ao longe. Cores verde, marrom e dourado. Cena divertida e mágica.',
  'Sonic': 'Corrida superveloz por colinas verdes, com rastros de velocidade, estrelas e céu azul. Cores azul, verde e amarelo. Cena veloz e alegre.',
  'Spider-Man': HEROIS,
  'Star Wars': ESPACO,
  'Stitch': PRAIA_TROPICAL,
  'Super Mario': VIDEOGAME,
  'Mario': VIDEOGAME,
  'Mario Bros': VIDEOGAME,
  'Mario Kart': 'Corrida de karts em pixel art, numa pista colorida com curvas, estrelas, moedas douradas e bandeira quadriculada. Cores vermelho, azul, amarelo e verde. Cena veloz e divertida.',
  'Luigi': VIDEOGAME,
  'Princesa Peach': 'Castelo de conto de fadas em pixel art, com coroa, estrelas, flores e nuvens. Cores rosa, dourado e azul-claro. Cena delicada e alegre.',
  'Yoshi': VIDEOGAME,
  'Bowser': VIDEOGAME,
  'Super-Homem': HEROIS,
  'Superman': HEROIS,
  'Batman': 'Cidade de super-heróis à noite, com lua cheia, prédios altos, holofotes e estrelas. Cores preto, cinza e amarelo. Cena cheia de ação.',
  'Mulher-Maravilha': HEROIS,
  'Toy Story': 'Quarto de brinquedos com cubos de letras, carrinhos, piões, foguete de brinquedo e estrelas. Cores azul, amarelo e vermelho. Cena alegre e aventureira.',
  'Transformers': ROBOS,
  'Turma da Mônica': 'Rua de bairro alegre com crianças brincando, pipas, árvores e balões. Cores vermelho, amarelo e azul. Cena divertida e animada.',
  'Ursinho Pooh': 'Bosque ensolarado com um ursinho de pelúcia, abelhas, flores e balões. Cores amarelo, laranja e verde. Cena delicada e acolhedora.',
  'Vingadores': HEROIS,
  'Wandinha': 'Festa gótica divertida com morcegos, teias de aranha, lua e velas. Cores preto, roxo e branco. Cena misteriosa e elegante.',
  'Disney': 'Reino encantado de conto de fadas, com coroa, carruagem, estrelas e fogos de artifício. Cores azul, rosa e dourado. Cena mágica.',
  'Pixar': 'Cena de animação 3D alegre com brinquedos, balões e confete. Cores vivas. Cena divertida e cheia de vida.',
  'Marvel': HEROIS,
  'LEGO': 'Cidade de blocos de montar coloridos, com peças encaixadas, bonequinhos e balões. Cores vermelho, amarelo, azul e verde. Cena criativa e alegre.',
  'Nickelodeon': 'Festa divertida com slime colorido, respingos, balões e confete. Cores laranja, verde e roxo. Cena animada.',
  'Roblox': 'Mundo de jogo online com plataformas, obstáculos, moedas e personagens originais de blocos. Cores vermelho, azul e cinza. Cena de aventura.',
  'Minecraft': 'Aventura de mineração com cavernas, cristais coloridos, picaretas e uma paisagem de blocos quadrados. Cores verde, marrom e azul. Cena de exploração.',
};

/** Pedido original sugerido no lugar do tema protegido. Nunca vazio. */
export function sugestaoOriginal(mencao: MencaoProtegida): string {
  return PEDIDOS[mencao.termo] ?? GENERICO;
}
