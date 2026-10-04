import { z } from 'zod';

export const LIMITE_PADRAO_RESPOSTAS = 20;
export const configuracaoSchema = z.object({
  ativo: z.boolean(), nome: z.string().trim().min(2).max(100),
  perguntas: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/), pergunta: z.string().trim().min(3).max(250), resposta: z.string().trim().min(3).max(1500) }).strict()).max(30),
  // Respostas automáticas por conversa em 24 h; atingido o limite, a conversa vai para a equipe sem chamar o modelo.
  // O teto de tokens/custo continua no orçamento da capacidade `whatsapp_atendimento`, definido no servidor.
  limites: z.object({ respostasPor24h: z.number().int().min(1).max(100) }).strict().default({ respostasPor24h: LIMITE_PADRAO_RESPOSTAS }),
}).strict().refine(v => new Set(v.perguntas.map(p => p.id)).size === v.perguntas.length, 'Identificadores repetidos.');
export type ConfiguracaoAtendimento = z.infer<typeof configuracaoSchema>;
/** Texto fixo quando a IA não pode responder (modelo, orçamento ou limite): encaminha sem inventar conteúdo. */
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
 * Minimização antes do modelo: CPF, e-mail e telefone (com DDD) viram marcadores. Datas como 14/11/2027 e
 * quantidades ficam: são o que a classificação precisa.
 */
export function ocultarDadosPessoais(texto: string) {
  return texto
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[documento omitido]')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, '[e-mail omitido]')
    .replace(/(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/g, '[telefone omitido]');
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
export function comandoDireto(texto: string): Interpretacao | null {
  const normal = texto.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
  if (/^(parar|sair|stop|nao me envie mensagens)[.!]?$/u.test(normal)) return { intencao: 'PARAR', perguntaId: null, data: null, convidados: null };
  if (/\b(atendente|pessoa|humano|reclamacao)\b/u.test(normal)) return { intencao: 'HUMANO', perguntaId: null, data: null, convidados: null };
  return null;
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
 * (texto ou nulo) e a empresa precisa ter sido SELECIONADA explicitamente e ser a piloto: nula = seleção pendente,
 * outra = divergência (falha fechada, antes de qualquer leitura). Sem a 063 o campo não existe e vale o comportamento
 * anterior: a piloto, provada no banco pelo vínculo ativo.
 */
export function conferirEmpresaAtiva(sessao: object, piloto: string): void {
  if (!Object.prototype.hasOwnProperty.call(sessao, 'empresa_ativa_id')) return;
  const ativa = (sessao as { empresa_ativa_id?: unknown }).empresa_ativa_id;
  if (ativa === undefined) return;
  if (ativa === null || ativa === '') throw new Error('ATENDIMENTO_EMPRESA_NAO_SELECIONADA');
  if (typeof ativa !== 'string' || ativa.toLowerCase() !== piloto.toLowerCase()) throw new Error('ATENDIMENTO_EMPRESA_DIVERGENTE');
}
