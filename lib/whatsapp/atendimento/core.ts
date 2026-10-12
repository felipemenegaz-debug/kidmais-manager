import { z } from 'zod';
import { pedidoDeParar } from './opt-out.ts';
import type { Passagem } from './walle/tipos.ts';
import { ALERGIA } from './walle/alergia.ts';

export const LIMITE_PADRAO_RESPOSTAS = 20;
export const configuracaoSchema = z.object({
  ativo: z.boolean(), nome: z.string().trim().min(2).max(100),
  perguntas: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/), pergunta: z.string().trim().min(3).max(250), resposta: z.string().trim().min(3).max(1500) }).strict()).max(30),
  // Respostas automáticas por conversa em 24 h; atingido o limite, a conversa vai para a equipe sem chamar o modelo.
  // O teto de tokens/custo continua no orçamento da capacidade `whatsapp_atendimento`, definido no servidor.
  limites: z.object({ respostasPor24h: z.number().int().min(1).max(100) }).strict().default({ respostasPor24h: LIMITE_PADRAO_RESPOSTAS }),
  // Wall-e (082): atendimento com fontes oficiais (agenda, pacotes, preço, buffet, biblioteca autorizada, contrato modelo).
  // Ausente ou desligado: o atendimento da fase B (respostas publicadas e encaminhamento). Sem a 082, fica desligado.
  wallE: z.object({ ativo: z.boolean() }).strict().optional(),
}).strict().refine(v => new Set(v.perguntas.map(p => p.id)).size === v.perguntas.length, 'Identificadores repetidos.');
export type ConfiguracaoAtendimento = z.infer<typeof configuracaoSchema>;
/** Texto fixo quando a IA não pode responder (modelo indisponível ou orçamento recusado): encaminha sem inventar conteúdo.
 *  Limite diário de respostas esgotado NÃO usa este texto: a conversa vai para a equipe em silêncio (M1, worker). */
export const MENSAGEM_ENCAMINHAMENTO = 'Não consigo responder automaticamente agora. Encaminhei sua mensagem para a equipe; a resposta dependerá do horário de atendimento.';
/**
 * O JSON Schema enviado ao modelo só garante `string | null` em `data`; o modelo pode devolver a data como o cliente
 * escreveu (14/11/2027). Normalização determinística, só de FORMA e sem suposição: DD/MM/AAAA (ou AAAA/MM/DD)
 * com ano de 4 dígitos vira AAAA-MM-DD; ano abreviado ou outro texto segue como veio e é recusado pelo formato.
 * A existência e o prazo da data continuam com dataValida/responder ("não existe", "já passou").
 */
export function normalizarDataModelo(valor: unknown) {
  if (typeof valor !== 'string') return valor;
  const t = valor.trim();
  const br = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  const iso = /^(\d{4})[/.](\d{2})[/.](\d{2})$/.exec(t);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : t;
}
export const interpretacaoSchema = z.object({
  intencao: z.enum(['DUVIDA', 'INTERESSE', 'HUMANO', 'PARAR', 'OUTRO']),
  perguntaId: z.string().max(40).nullable(),
  data: z.preprocess(normalizarDataModelo, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()),
  convidados: z.number().int().min(1).max(10000).nullable(),
}).strict();
export type Interpretacao = z.infer<typeof interpretacaoSchema>;
export const ESQUEMA_INTERPRETACAO = { type: 'object', additionalProperties: false, required: ['intencao', 'perguntaId', 'data', 'convidados'], properties: { intencao: { type: 'string', enum: ['DUVIDA', 'INTERESSE', 'HUMANO', 'PARAR', 'OUTRO'] }, perguntaId: { type: ['string', 'null'] }, data: { type: ['string', 'null'] }, convidados: { type: ['integer', 'null'] } } };

/**
 * D1 — minimização antes de QUALQUER chamada ao modelo (e dos campos derivados gravados, como a passagem): documentos
 * (CPF/CNPJ com pontos, traços, barras ou espaços), e-mail (também "arroba … ponto com"), telefone (com ou sem DDD, com
 * +55, com o 9 separado), CEP, endereço com número, data de NASCIMENTO e nomes em frases de identificação ("meu nome é",
 * "minha filha Ana", "o aniversariante é …") viram marcadores. A data e a quantidade da festa ficam: são o que a
 * classificação precisa. Limite conhecido: um nome solto no meio da frase ("festa da Ana") não é reconhecível por regra
 * sem apagar também temas ("festa da Frozen"); por isso o nome do contato, o nome de perfil e o cadastro nunca são
 * enviados, e dado de saúde nunca vai ao modelo (dadoSensivel).
 */
// Nome = palavras com inicial MAIÚSCULA. Sem a flag "i" (com ela, \p{Lu} aceitaria minúsculas e apagaria o resto da
// frase): os gatilhos aceitam a inicial maiúscula ou minúscula letra a letra (semCaixa).
const NOME = String.raw`\p{Lu}[\p{L}'’-]+(?:\s+(?:d[aeo]s?\s+)?\p{Lu}[\p{L}'’-]+){0,3}`;
const semCaixa = (frases: string[]) => frases.map((f) => [...f].map((c) => (c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c === ' ' ? '\\s+' : c)).join('')).join('|');
const GATILHO_NOME_PROPRIO = semCaixa(['meu nome é', 'meu nome e', 'me chamo', 'aqui é a', 'aqui é o', 'aqui e a', 'aqui e o',
  ...['mãe', 'mae', 'pai', 'avó', 'avô', 'avo', 'tia', 'tio', 'madrinha', 'padrinho'].flatMap((p) => ['a', 'o'].flatMap((s) => ['da', 'do', 'de'].map((d) => `sou ${s} ${p} ${d}`)))]);
// 12/10: "sou Ana", "chamo Ana", "o nome dele é Pedro", "mãe do Pedro" (o parente vem antes do nome).
const GATILHO_NOME_EXTRA = semCaixa(['sou', 'chamo', 'o nome dele é', 'o nome dela é', 'o nome dele e', 'o nome dela e', 'nome da criança é', 'nome do aniversariante é',
  ...['mãe', 'mae', 'pai', 'avó', 'avô', 'avo', 'tia', 'tio', 'madrinha', 'padrinho', 'irmã', 'irma', 'irmão', 'irmao'].flatMap((x) => ['da', 'do'].map((d) => `${x} ${d}`))]);
const GATILHO_NOME_CRIANCA = semCaixa([...['meu', 'minha'].flatMap((p) => ['filho', 'filha', 'neto', 'neta', 'sobrinho', 'sobrinha', 'enteado', 'enteada', 'afilhado', 'afilhada'].map((x) => `${p} ${x}`)),
  'o aniversariante é', 'a aniversariante é', 'o aniversariante e', 'a aniversariante e', 'o aniversariante:', 'a aniversariante:', 'o aniversariante', 'a aniversariante']);
const PADROES_PESSOAIS: [RegExp, string][] = [
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, '[e-mail omitido]'],
  [/[\p{L}\p{N}._-]+\s*[([]?\s*arroba\s*[)\]]?\s*[\p{L}\p{N}-]+\s*(?:ponto|\.)\s*(?:com|net|org|br)(?:\s*(?:ponto|\.)\s*br)?(?![\p{L}])/giu, '[e-mail omitido]'],
  [/(?<!\d)\d{2}[\s.]?\d{3}[\s.]?\d{3}[\s/]?\d{4}[\s-]?\d{2}(?!\d)/g, '[documento omitido]'],
  [/(?<!\d)\d{3}[\s./-]?\d{3}[\s./-]?\d{3}[\s./-]?\d{2}(?!\d)/g, '[documento omitido]'],
  [/(?<![\d/])(?:\+?\s?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?[\s.-]?\d{4}[\s.-]?\d{4}(?![\d/])/g, '[telefone omitido]'],
  [/(?<![\d/])9[\s.-]?\d{4}[\s.-]?\d{4}(?![\d/])/g, '[telefone omitido]'],
  [/(?<![\d/])[2-5]\d{3}-\d{4}(?![\d/])/g, '[telefone omitido]'],
  [/(?<![\p{L}])CEP:?\s*\d{5}-?\d{3}(?!\d)|(?<![\d/])\d{5}-\d{3}(?![\d/])/giu, '[CEP omitido]'],
  [/(?<![\p{L}])((?:rua|avenida|av\.?|travessa|alameda|rodovia|estrada)\s)[^\n,;!?]{2,60}?,?\s*(?:n[ºo°.]?\s*)?\d{1,5}(?![\d/])[A-Za-z]?/giu, '[endereço omitido]'],
  [/(?<![\p{L}])(?:S[A-Z]{2,3}|Q[A-Z]{1,3})\s?\d{1,3}(?:\s+(?:bloco|bl\.?|conjunto|cj\.?|casa|lote|apto|ap\.?)\s*[A-Z0-9]{1,4}){1,3}/gu, '[endereço omitido]'],
  [/((?:nasc\p{L}*|data de nascimento)[^\d\n]{0,20})\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?/giu, '$1[data de nascimento omitida]'],
  [new RegExp(String.raw`((?<![\p{L}])(?:${GATILHO_NOME_PROPRIO}))\s+${NOME}`, 'gu'), '$1 [nome omitido]'],
  [new RegExp(String.raw`((?<![\p{L}])(?:${GATILHO_NOME_CRIANCA}))\s+${NOME}`, 'gu'), '$1 [nome omitido]'],
  [new RegExp(String.raw`((?<![\p{L}])(?:${GATILHO_NOME_EXTRA}))\s+${NOME}`, 'gu'), '$1 [nome omitido]'],
];
/**
 * D1 — normalização ANTES de qualquer análise de privacidade e do envio ao modelo: NFKC (largura total e formas de
 * compatibilidade viram as letras comuns) e remoção de caracteres invisíveis (controle, formatação, "default ignorable"),
 * a mesma regra da barreira do roteador (lib/inteligencia/texto-modelo.ts), aplicada aqui primeiro para que o detector
 * e a máscara vejam exatamente o texto que o modelo veria ("alerg\u200Bia" é "alergia").
 */
const OCULTOS = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
export function normalizarParaPrivacidade(texto: string | null | undefined) {
  return String(texto ?? '').normalize('NFKC').replace(OCULTOS, '');
}
/** O texto que pode ir ao modelo: normalizado e com os dados pessoais reconhecíveis ocultados. */
export function ocultarDadosPessoais(texto: string) {
  let t = normalizarParaPrivacidade(texto);
  for (const [re, marcador] of PADROES_PESSOAIS) t = t.replace(re, marcador);
  return t;
}
/**
 * D1 — dado pessoal SENSÍVEL (LGPD art. 5º II e saúde de criança): a mensagem que o contém NUNCA vai ao modelo (o Wall-e
 * entende pelas regras e a alergia segue para a equipe; a fase B encaminha à equipe; no histórico vira marcador).
 * Cobre: a regra de alergia/restrição do próprio Wall-e (walle/alergia.ts) e termos de saúde, deficiência, crença
 * religiosa ou filosófica, origem étnica, orientação sexual e dado genético/biométrico, sobre o texto normalizado, sem
 * acento e em minúsculas, inclusive grafias comuns erradas. É uma lista: NÃO é garantia completa. A cobertura é medida
 * contra um corpus independente (privacidade-cobertura.test.ts) e as lacunas mantêm o modo IA bloqueado com dados reais.
 */
const SENSIVEL = new RegExp('(?<![a-z])(?:' + [
  // alergia, intolerância, dieta médica, reação
  'aler[gj]\\w*', 'e?ntoleran\\w*', '[cs]eliac\\w*', 'doenca celiaca', 'lacto[sz]\\w*', 'lato[sz]e', 'glute[nm]', 'proteina do leite',
  'restricao (?:alimentar|medica)', 'restricoes alimentares', 'dieta (?:medica|restrita|especial|prescrita)', 'reacao alergica', 'da reacao',
  'passa mal (?:com|quando)', 'contaminacao cruzada', 'traco(?:s)? de', 'pode conter', 'fenilceton\\w*', 'seletividade alimentar', 'transtorno alimentar',
  'anorex\\w*', 'bulimi\\w*', 'anafila\\w*', 'epi ?pen', 'caneta de adrenalina',
  // condições e cuidados de saúde
  'diabet\\w*', 'insulin\\w*', 'glicemi\\w*', 'epilep\\w*', 'convuls\\w*', 'autis\\w*', 'espectro autista', 'neurodivergent\\w*', 'hiperativ\\w*',
  'deficit de atencao', 'asma', 'asmatic\\w*', 'bombinha', 'bronquit\\w*', 'rinite\\w*', 'dermatit\\w*', 'eczema\\w*', 'remedio\\w*', 'medicament\\w*',
  'medicacao', 'medicad[oa]s?', 'tratamento (?:medico|de saude)', 'quimio\\w*', 'radioterap\\w*', 'cancer', 'tumor\\w*', 'leucemi\\w*', 'hiv', 'aids',
  'hepatite', 'gravid\\w*', 'gestante', 'gestacao', 'hospital\\w*', 'internad[oa]s?', 'internacao', 'uti', 'cirurgi\\w*', 'pos[ -]?operatori\\w*',
  'doenca\\w*', 'doente\\w*', 'depress\\w*', 'ansiedade', 'sindrome do panico', 'psiquiatr\\w*', 'psicolog\\w*', 'terapia', 'terapeut\\w*',
  'sindrome\\w*', 'laudo\\w*', 'pressao alta', 'hipertens\\w*', 'cardiac\\w*', 'cardiopat\\w*', 'marca[- ]?passo', 'pediatra', 'alergista',
  'neurolog\\w*', 'neuropediatra', 'gastroenterolog\\w*', 'endocrin\\w*',
  // deficiência e acessibilidade ligada a uma pessoa
  'deficien\\w*', 'cadeirante', 'cadeira de rodas', 'muleta\\w*', 'surd[oa]s?', 'surdez', 'ceg[oa]s?', 'cegueira', 'baixa visao', 'libras', 'mobilidade reduzida',
  'sindrome de down', 'paralisia cerebral', 'tdah', 'tod',
  // crença religiosa ou filosófica
  'kosher', 'kasher', 'halal', 'adventist\\w*', 'testemunhas? de jeova', 'judaic\\w*', 'judeu', 'judia', 'muculman\\w*', 'islam\\w*', 'candomble',
  'umbanda', 'evangelic\\w*', 'catolic\\w*', 'espirit[ai]\\w*', 'budist\\w*', 'religi\\w*', 'igreja', 'jejum', 'vegan[oa]s?', 'veganismo', 'vegetarian\\w*',
  // origem étnica, orientação sexual, genético/biométrico
  'indigena\\w*', 'quilombola\\w*', 'cigan[oa]s?', 'origem etnica', 'etnia', 'raca', 'homoafetiv\\w*', 'lgbt\\w*', 'gay', 'lesbic\\w*', 'transexua\\w*',
  'transgener\\w*', 'genetic\\w*', 'biometri\\w*',
].join('|') + ')(?![a-z])');
const SIGLAS_SENSIVEIS = /(?<![\p{L}])(?:APLV|TEA|TDAH|TOD|CID|PKU|HIV|UTI|LGBTQIA\+?|PCD)(?![\p{L}])/u;
const semAcentoMinusculo = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function dadoSensivel(texto: string | null | undefined) {
  const n = normalizarParaPrivacidade(texto);
  const s = semAcentoMinusculo(n);
  return SENSIVEL.test(s) || ALERGIA.test(s) || SIGLAS_SENSIVEIS.test(n);
}
/**
 * D4 — entrada da fase B (interpretarMensagem): o histórico de 24 h (até 8 entradas do próprio cliente) passa pelas
 * MESMAS proteções da mensagem atual, entrada por entrada (antes de virar JSON, onde "\n" grudado no número escaparia da
 * máscara): normalizada, dados pessoais ocultados, no máximo 500 caracteres, e entrada com dado sensível substituída por
 * um marcador. A mensagem atual com dado sensível nem chega aqui: o worker encaminha à equipe sem modelo.
 */
export const ENTRADA_SENSIVEL_OMITIDA = '[mensagem com dado sensível omitida]';
export function entradaFaseB(historico: string[], atual: string, interesseAnterior: unknown) {
  const minimizar = (t: string) => (dadoSensivel(t) ? ENTRADA_SENSIVEL_OMITIDA : ocultarDadosPessoais(t).slice(0, 500));
  return JSON.stringify({ mensagens: historico.map(minimizar), mensagemAtual: minimizar(atual), interesseAnterior });
}
/**
 * D2/B1 — campo derivado gravado (passagem.ultimaMensagem, resumo da equipe): nunca a mensagem bruta. Com dado sensível,
 * só o marcador (o texto continua no histórico da conversa, que a exclusão e a retenção alcançam); sem ele, o trecho
 * minimizado.
 */
export const REGISTRO_SENSIVEL = '[mensagem com dado sensível: ver o histórico]';
export function trechoParaRegistro(texto: string | null | undefined, limite = 500) {
  return dadoSensivel(texto) ? REGISTRO_SENSIVEL : ocultarDadosPessoais(String(texto ?? '')).slice(0, limite);
}
/** D1/B2 — texto livre que o modelo devolveu (tema): só se não for sensível; normalizado e minimizado. */
export function textoDoModeloSeguro(valor: string | null | undefined) {
  if (!valor || dadoSensivel(valor)) return null;
  const limpo = ocultarDadosPessoais(valor).trim();
  return limpo && !limpo.includes('[') ? limpo : null;
}
export function dataValida(valor: string) {
  const data = new Date(`${valor}T12:00:00Z`);
  return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === valor;
}
/** Data civil de hoje na operação (America/Sao_Paulo), no formato AAAA-MM-DD. */
export function hojeOperacao(agora = new Date()) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora); }
/** Interesse só registra data existente e ainda não passada. */
export function dataDeInteresse(valor: string | null, hoje: string) { return valor !== null && dataValida(valor) && valor >= hoje ? valor : null; }
export function janelaAberta(ultima: Date, agora: Date) { const idade = agora.getTime() - ultima.getTime(); return idade >= 0 && idade < 24 * 60 * 60 * 1000; }
/**
 * Pedido de pessoa (atendente, alguém, ligação). Na dúvida vai para a equipe: errar para o lado da passagem é seguro.
 * "Pessoa" só no singular ("60 pessoas" é quantidade) e fora de conta ("cada pessoa a mais", "valor por pessoa").
 */
const HUMANO_FRASE = [
  // Rodada 34: "a atendente falou/disse/comentou que…" é REFERÊNCIA ao funcionário (quem informou), não pedido de pessoa;
  // "falar com a atendente", "chama a atendente", "atendente!" continuam pedido.
  /(?:com|pra|para|pro|chama|chame|cade|cadê|quero|queria)\s+(?:(?:a|o|uma|um)\s+)?atendentes?\b|\batendentes?\b(?!(?:\s+(?:d[aoe]s?|daqui|dai|de\s+voces|de\s+vcs|que|me|ja|tinha|la|ai|\p{L}+)){0,3}\s+(?:falou|disse|comentou|informou|avisou|explicou|confirmou|garantiu|mencionou|passou|mandou|dito|falado|comentado|informado|atendeu))|\b(?:humano|humana|reclamacao)\b|(?<!\b(?:cada|por)\s)\bpessoa\b(?!\s+(?:a\s+mais|extra|adicional|excedente))/u,
  /\b(?:falar|conversar|tratar|resolver)\s+com\s+(?:alguem|algu\w+\s+(?:de voces|de vcs|da equipe|responsavel)|(?:o|a)\s+responsavel|(?:o|a|um|uma)\s+gerente|(?:um|uma|o|a)\s+(?:vendedor\w*|consultor\w*|funcionari\w*)|o\s+dono|a\s+dona|a\s+equipe|o\s+pessoal|voces\s+por\s+telefone)\b(?!\s+(?:(?:aqui|la)\s+)?(?:de|em)\s+casa)/u,
  /\b(?:passa|passe|passar|transfere|transfira|transferir|encaminha|encaminhe|chama|chame)\s+(?:(?:pra|para|pro|pros|pras)\s+)?(?:(?:o|a|um|uma)\s+)?(?:alguem|pessoa|equipe|pessoal|responsavel|gerente|dono|dona|vendedor\w*|consultor\w*)\b/u,
  /\balguem\s+(?:de\s+carne\s+e\s+osso|real|de\s+verdade|pode(?:ria)?\s+me\s+(?:atender|ajudar|responder|ligar|chamar)|me\s+(?:atende|responde|ajuda|liga|chama|atender|responder|retornar|atenda|responda|retorne))\b/u,
  /\btem\s+alguem\s+(?:ai|ae|online|disponivel|pra|para|que\s+(?:possa|pode))\b/u,
  /\b(?:me\s+liga|me\s+ligue|me\s+ligar|pode(?:m)?\s+me\s+ligar|liga(?:r)?\s+(?:pra|para)\s+mim|por\s+telefone|por\s+voz|uma\s+ligacao)\b/u,
  // "Conversar pessoalmente com alguém da equipe", "resolver isso com alguém daí", "conversar com quem decide". O cliente
  // que "vai conversar com quem decide" ou com "o pessoal aqui de casa" fala da família: não é pedido de pessoa.
  /(?<!\b(?:vou|vamos|irei|iremos|deixa\s+eu)\s+)\b(?:falar|conversar|tratar|resolver)\s+(?:(?:isso|isto|tudo)\s+)?(?:(?:pessoalmente|direto|diretamente|ao\s+vivo|cara\s+a\s+cara)\s+)?com\s+(?:alguem|algu\w+\s+(?:de\s+voces|de\s+vcs|dai|da\s+equipe|responsavel)|(?:o|a)\s+responsavel|(?:o|a|um|uma)\s+gerente|o\s+dono|a\s+dona|a\s+equipe|o\s+pessoal|quem\s+(?:decide|resolve|manda|cuida|pode\s+(?:resolver|decidir|autorizar|liberar)))\b(?!\s+(?:(?:aqui|la)\s+)?em\s+casa)/u,
  // "Consegue me passar pra ela?", "me passa pra quem resolve": com o "me" (sem ele, "vou passar pra ele os valores" é o
  // cliente repassando a informação em casa).
  /\bme\s+(?:passa|passe|passar|transfere|transfira|transferir|encaminha|encaminhe|encaminhar)\s+(?:pra|para|pro)\s+(?:ela|ele|quem\s+(?:resolve|decide|manda|cuida|pode))\b/u,
  // "Pedir pro pessoal do comercial me chamar no zap": pedido de contato de alguém da equipe.
  /\bpedir\s+(?:pra|pro|para|pros|pras)\s+(?:(?:o|a|os|as)\s+)?(?:alguem|pessoal|equipe|comercial|gerente|gerencia|responsavel|dono|dona|vendedor\w*|atendente\w*|consultor\w*|moca|moco|recepcao)\b(?:\s+\S+){0,5}?\s+me\s+(?:ligar|chamar|retornar|responder|atender|contatar|procurar)\b/u,
  // "Não quero falar com robô", "cansei de conversar com máquina".
  /\b(?:nao\s+quero|chega\s+de|cansei\s+de|nao\s+aguento\s+(?:mais\s+)?|odeio)\s*(?:falar|conversar|ficar\s+falando|ficar\s+conversando)\s+com\s+(?:robo|bot|maquina|computador|sistema|ia|inteligencia\s+artificial|atendimento\s+automatico|mensagem\s+automatica)\b/u,
];
/**
 * Comando sem modelo. PARAR só quando o pedido de parar é INEQUÍVOCO (opt-out.ts): bloqueia de vez na recepção e no
 * worker. Pedido de parar misturado com outro pedido ("para de mandar msg automática, quero falar com uma pessoa") é
 * AMBÍGUO: vira pedido de pessoa (o Wall-e passa em silêncio; a fase B encaminha), sem o bloqueio definitivo.
 */
export function comandoDireto(texto: string): Interpretacao | null {
  const parar = pedidoDeParar(texto);
  if (parar?.tipo === 'INEQUIVOCO') return { intencao: 'PARAR', perguntaId: null, data: null, convidados: null };
  const normal = texto.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
  // Sem pontuação, emoji e cortesia ("alguém aí??", "pessoa por favor 🙏"): o pedido é o que sobra.
  const curto = normal.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\b(?:por favor|porfavor|pfv|pf|obrigad[oa]|ok)\b/gu, ' ').replace(/\s+/g, ' ').trim();
  if (parar || HUMANO_FRASE.some((re) => re.test(curto))) return { intencao: 'HUMANO', perguntaId: null, data: null, convidados: null };
  return null;
}

/**
 * Rodada 22: o cliente pediu para parar sem que o pedido fosse inequívoco (pausa "por enquanto", junto de outro pedido,
 * só a forma): a conversa fica com a equipe SEM o bloqueio definitivo, mas nada automático sai mais — nem resposta do
 * Wall-e, nem o texto fixo de encaminhamento, nem reabertura automática, nem "Devolver ao Wall-e". Só a equipe responde.
 * A marca fica em `contexto.semAutomatico` (082); sem a 082 não há Wall-e nem a marca.
 */
/**
 * Rodada 47: pedido de PAUSA (ou de parar junto de outro pedido — AMBÍGUO no opt-out) que a recepção registra quando a
 * mensagem não passa pelo Wall-e (conversa já com a equipe, assumida ou sem automação). PARAR inequívoco é bloqueio, não
 * pausa (comandoDireto). Exportada para o simulador do avaliador espelhar a recepção do código avaliado.
 */
export function pausaPedidaNaRecepcao(texto: string | null | undefined) {
  return !!texto && pedidoDeParar(texto)?.tipo === 'AMBIGUO';
}
/**
 * Origem da marca de pausa (`contexto.semAutomatico.origem`), para rastreabilidade — toda marca gravada leva uma:
 * RECEPCAO (pedido reconhecido pelas regras na recepção), FILA (barreira do worker para entrada já enfileirada), WALLE
 * (silêncio do Wall-e: regras ou modelo revalidado), ENTRADA_VENCIDA e AUTOMACAO_DESLIGADA (encaminhamento sem resposta).
 */
export type OrigemMarcaPausa = 'RECEPCAO' | 'FILA' | 'WALLE' | 'ENTRADA_VENCIDA' | 'AUTOMACAO_DESLIGADA' | 'EXCLUSAO';
export function semAutomatico(conversa: { contexto?: Record<string, unknown> } | null | undefined) {
  const m = (conversa?.contexto as { semAutomatico?: unknown } | undefined)?.semAutomatico;
  return !!m && typeof m === 'object';
}
/**
 * Resumo de passagem de uma entrada que NÃO terá resposta automática (vencida na fila, automação global desligada na
 * recepção ou no processador): motivo SEM_RESPOSTA_AUTOMATICA (antes dele PARAR_A_CONFIRMAR, se o texto pediu pausa).
 * Só os campos simples da memória do Wall-e (sem catálogos); o resumo da tela completa o resto. Sem o texto do cliente.
 */
export function passagemSemRespostaAutomatica(contexto: unknown, em: string, pausa: boolean, motivo: 'SEM_RESPOSTA_AUTOMATICA' | 'LIMITE_DIARIO' = 'SEM_RESPOSTA_AUTOMATICA'): Passagem {
  const c = (contexto && typeof contexto === 'object' ? contexto : {}) as Record<string, unknown>;
  const texto = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
  const motivos: Passagem['motivos'] = pausa ? ['PARAR_A_CONFIRMAR', motivo] : [motivo];
  return { motivo: motivos[0], motivos, em, enviados: [], pendentes: [], ultimaMensagem: '',
    coletado: { data: texto(c.data, 10), turno: null, convidados: Number.isInteger(c.convidados) ? (c.convidados as number) : null, pacote: null, unidade: null, tema: texto(c.tema, 60) } };
}
/** O modelo escolhe uma resposta publicada; nunca escreve preço, promessa ou cláusula. */
export function responder(config: ConfiguracaoAtendimento, plano: Interpretacao, interesse: { data: string | null; convidados: number | null }, hoje = hojeOperacao()) {
  if (plano.intencao === 'PARAR') return { texto: null, humano: false, encerrada: true };
  if (plano.intencao === 'HUMANO') return { texto: 'Vou encaminhar seu pedido para um atendente. A resposta dependerá do horário da equipe.', humano: true, encerrada: false };
  if (plano.data && !dataValida(plano.data)) return { texto: 'Essa data não existe no calendário. Qual é a data completa da festa, incluindo o ano?', humano: false, encerrada: false };
  if (plano.data && plano.data < hoje) return { texto: 'Essa data já passou. Qual é a data desejada para a festa, incluindo o ano?', humano: false, encerrada: false };
  const faq = config.perguntas.find(p => p.id === plano.perguntaId);
  if (plano.intencao === 'DUVIDA' && faq) return { texto: faq.resposta, humano: false, encerrada: false };
  if (plano.intencao === 'INTERESSE') {
    if (!interesse.data) return { texto: 'Qual é a data desejada para a festa? Informe também o ano.', humano: false, encerrada: false };
    if (!interesse.convidados) return { texto: 'Quantas pessoas você pretende convidar?', humano: false, encerrada: false };
    return { texto: `Registrei seu interesse para ${interesse.data.split('-').reverse().join('/')} e ${interesse.convidados} pessoas. Vou encaminhar para a equipe conferir disponibilidade, pacote e valores. A data ainda não está reservada.`, humano: true, encerrada: false };
  }
  return { texto: 'Sou o atendimento virtual da ' + config.nome + '. Posso ajudar com as informações publicadas e encaminhar sua festa para a equipe. Para falar com uma pessoa, escreva “atendente”.', humano: plano.intencao === 'DUVIDA', encerrada: false };
}

/** `nomePerfil`: nome que a própria pessoa pôs no perfil do WhatsApp (Gupshup `payload.sender.name`). NÃO é verificado. */
export type Entrada = { id: string; app: string; source: string; texto: string | null; timestamp: number; nomePerfil?: string | null };
export const NOME_PERFIL_MAX = 80;
/**
 * Nome de perfil apresentável: sem caracteres de controle/formatação, espaços colapsados, até 80 caracteres.
 * Qualquer outra coisa (vazio, não texto) vira null. Nunca vai ao modelo nem identifica cliente.
 */
export function nomePerfilSeguro(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const cortado = Array.from(limpo).slice(0, NOME_PERFIL_MAX).join('').trim();
  return cortado || null;
}
/** Chamado somente após o receptor existente comprovar origem. Mídia não é enviada ao modelo. */
export function entradaGupshup(valor: unknown): Entrada | null {
  const schema = z.object({ app: z.literal('KidmaisManager'), version: z.literal(2), type: z.literal('message'), timestamp: z.number().int().nonnegative(), payload: z.object({ id: z.string().min(1).max(512), source: z.string().regex(/^\+?\d{8,15}$/), type: z.string(), payload: z.unknown(), sender: z.object({ name: z.unknown() }).partial().optional().catch(undefined) }) });
  const lido = schema.safeParse(valor);
  if (!lido.success) return null;
  const v = lido.data;
  // Texto vazio ou acima do limite vira conteúdo sem texto: vai para a equipe, sem modelo e sem repetir o webhook.
  const texto = v.payload.type === 'text' ? z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(v.payload.payload) : null;
  // `sender` malformado não derruba o evento: só fica sem nome de perfil.
  return { id: v.payload.id, app: v.app, source: v.payload.source.replace(/^\+/, ''), texto: texto?.success ? texto.data.text : null, timestamp: v.timestamp, nomePerfil: nomePerfilSeguro(v.payload.sender?.name) };
}

/** Vínculo da conversa com o cadastro de clientes DA EMPRESA pelo número: um, vários (nenhum escolhido) ou nenhum. */
export type CadastroContato = { situacao: 'UNICO'; nome: string } | { situacao: 'AMBIGUO'; quantidade: number } | { situacao: 'SEM_CADASTRO' };
export function situacaoCadastro(clientes: number, nome: string | null): CadastroContato {
  if (clientes > 1) return { situacao: 'AMBIGUO', quantidade: clientes };
  if (clientes === 1 && nome?.trim()) return { situacao: 'UNICO', nome: nome.trim() };
  return { situacao: 'SEM_CADASTRO' };
}

/**
 * Empresa ativa da sessão × empresa piloto do atendimento. Com a 063 do painel a sessão traz `empresa_ativa_id`
 * (texto ou nulo). Outra empresa = divergência (falha fechada, antes de qualquer leitura). Nula = sem escolha
 * explícita: vale a MESMA regra do painel (lib/autenticacao/contexto.ts) — com uma única empresa ativa ela é a atual;
 * com mais de uma, a seleção está pendente. Isso depende dos vínculos, então quem chama confere dentro da transação
 * do tenant ('SEM_ESCOLHA'). Sem a 063 o campo não existe e vale o comportamento anterior ('SEM_063').
 */
export type EmpresaAtivaSessao = 'SEM_063' | 'PILOTO' | 'SEM_ESCOLHA';
export function conferirEmpresaAtiva(sessao: object, piloto: string): EmpresaAtivaSessao {
  if (!Object.prototype.hasOwnProperty.call(sessao, 'empresa_ativa_id')) return 'SEM_063';
  const ativa = (sessao as { empresa_ativa_id?: unknown }).empresa_ativa_id;
  if (ativa === undefined) return 'SEM_063';
  if (ativa === null || ativa === '') return 'SEM_ESCOLHA';
  if (typeof ativa !== 'string' || ativa.toLowerCase() !== piloto.toLowerCase()) throw new Error('ATENDIMENTO_EMPRESA_DIVERGENTE');
  return 'PILOTO';
}
