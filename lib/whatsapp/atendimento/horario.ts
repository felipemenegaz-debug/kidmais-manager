import { z } from 'zod';

/**
 * Wall-e, fatia 8 (25/11/2026): horário de atendimento da equipe e e-mails de aviso na passagem.
 *
 * Os dois campos vivem na configuração do atendimento (jsonb `whatsapp_atendimento_config.configuracao`), sem migration,
 * e são opcionais: configuração antiga continua válida e, sem horário, nenhuma frase muda.
 *
 * O modelo nunca escreve a frase de retorno: ele só classifica. A frase é montada aqui, por código, a partir do horário
 * cadastrado e do relógio, sempre no fuso de São Paulo.
 */
export const FUSO_ATENDIMENTO = 'America/Sao_Paulo';
export const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'] as const;
export type DiaSemana = (typeof DIAS_SEMANA)[number];
export const NOME_DIA: Record<DiaSemana, string> = {
  dom: 'domingo', seg: 'segunda-feira', ter: 'terça-feira', qua: 'quarta-feira', qui: 'quinta-feira', sex: 'sexta-feira', sab: 'sábado',
};
/** Artigo do dia para a frase ("no sábado", "na segunda-feira"). */
const ARTIGO: Record<DiaSemana, 'no' | 'na'> = { dom: 'no', seg: 'na', ter: 'na', qua: 'na', qui: 'na', sex: 'na', sab: 'no' };

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido (use HH:MM).');
const minutos = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
const faixa = z.object({ inicio: hhmm, fim: hhmm }).strict()
  .refine((f) => minutos(f.inicio) < minutos(f.fim), 'O início precisa vir antes do fim.');
export type FaixaHorario = z.infer<typeof faixa>;

/** Um dia ausente ou `null` = sem atendimento nesse dia. Objeto sem nenhum dia = sem horário (nada muda). */
export const horarioEquipeSchema = z.object(Object.fromEntries(DIAS_SEMANA.map((d) => [d, faixa.nullable().optional()])) as Record<DiaSemana, z.ZodOptional<z.ZodNullable<typeof faixa>>>).strict();
export type HorarioEquipe = z.infer<typeof horarioEquipeSchema>;

export const LIMITE_EMAILS_AVISO = 5;
/**
 * E-mails que recebem o aviso de conversa passada à equipe. Só são usados os de pessoas autorizadas da empresa
 * (conferido ao salvar e de novo a cada envio, aviso-equipe.ts). Lista vazia = aviso desligado.
 */
export const avisoEquipeSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().max(254).regex(/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/, 'E-mail inválido.'))
    .max(LIMITE_EMAILS_AVISO)
    .refine((l) => new Set(l).size === l.length, 'E-mail repetido.'),
}).strict();
export type AvisoEquipe = z.infer<typeof avisoEquipeSchema>;

/** Dia da semana e minuto do dia no fuso de São Paulo. */
export function momentoLocal(agora: Date): { dia: DiaSemana; minuto: number } {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: FUSO_ATENDIMENTO, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(agora);
  const valor = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const dia = ({ Sun: 'dom', Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab' } as const)[valor('weekday') as 'Sun'];
  return { dia, minuto: Number(valor('hour')) * 60 + Number(valor('minute')) };
}

/** "9h", "13h30". */
export function horaFalada(h: string) {
  const m = h.slice(3, 5);
  return `${Number(h.slice(0, 2))}h${m === '00' ? '' : m}`;
}

export type SituacaoHorario = { configurado: false } | { configurado: true; dentro: true } | { configurado: true; dentro: false; quando: string };

/**
 * Situação do horário agora. Sem horário cadastrado (ausente ou sem nenhum dia) = `configurado: false`.
 * Fora do horário, `quando` diz quando a equipe volta SEMPRE pelo dia da semana: "na segunda-feira a partir das 9h" (também
 * quando é hoje, antes de abrir) ou, se o único dia é o de hoje e já passou, "na próxima segunda-feira…". Astra r3 (P2): a
 * frase vai para a fila de saída e pode ser enviada depois da meia-noite de São Paulo; "hoje"/"amanhã" mudariam de sentido,
 * o nome do dia não (o próximo dia de atendimento está sempre a menos de 7 dias, e "próxima" só aparece quando é daqui a 7).
 * O fim da faixa é exclusivo (às 18:00 de uma faixa 09:00–18:00 já é fora).
 */
export function situacaoHorario(horario: HorarioEquipe | undefined | null, agora: Date): SituacaoHorario {
  if (!horario || !DIAS_SEMANA.some((d) => horario[d])) return { configurado: false };
  const { dia, minuto } = momentoLocal(agora);
  const hoje = horario[dia];
  if (hoje && minuto >= minutos(hoje.inicio) && minuto < minutos(hoje.fim)) return { configurado: true, dentro: true };
  if (hoje && minuto < minutos(hoje.inicio)) return { configurado: true, dentro: false, quando: `${ARTIGO[dia]} ${NOME_DIA[dia]} a partir das ${horaFalada(hoje.inicio)}` };
  const indice = DIAS_SEMANA.indexOf(dia);
  for (let i = 1; i <= 7; i++) {
    const proximo = DIAS_SEMANA[(indice + i) % 7];
    const f = horario[proximo];
    if (!f) continue;
    const a = `a partir das ${horaFalada(f.inicio)}`;
    if (i === 7) return { configurado: true, dentro: false, quando: `${ARTIGO[proximo]} ${proximo === 'sab' || proximo === 'dom' ? 'próximo' : 'próxima'} ${NOME_DIA[proximo]} ${a}` };
    return { configurado: true, dentro: false, quando: `${ARTIGO[proximo]} ${NOME_DIA[proximo]} ${a}` };
  }
  return { configurado: false };
}

/**
 * Frase FIXA ao cliente na passagem, fora do horário. Vazia dentro do horário ou sem horário cadastrado (o texto da
 * passagem fica exatamente como antes). Nunca vem do modelo.
 * Fatia 9 (Astra r4 da fatia 8, P-F8-4): a frase fala do MOMENTO DA PASSAGEM ("foi encaminhada fora do horário"), nunca
 * do momento da leitura ("agora estamos fora"): composta às 08h59 e enviada às 09h01, continua verdadeira. O
 * encaminhamento de contingência, isento da revalidação, é recomposto no despacho (worker.ts).
 */
export function retornoForaDoHorario(horario: HorarioEquipe | undefined | null, agora: Date) {
  const s = situacaoHorario(horario, agora);
  return s.configurado && !s.dentro ? `Sua mensagem foi encaminhada fora do horário de atendimento: a equipe responde ${s.quando}.` : '';
}
