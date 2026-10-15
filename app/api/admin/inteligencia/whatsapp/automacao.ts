import { inteligenciaAtiva } from '@/lib/inteligencia/flags';

/**
 * Composition root da RECEPÇÃO do atendimento: o estado da chave global da IA, lido aqui (camada de IA) e entregue ao
 * Core como opção de `receberEntrada` — o Core e o webhook não leem a chave (regras de arquitetura). Mesmo padrão do
 * processador (`processarFilaAtendimento`), que a rota do worker importa desta pasta. Desligada: a entrada é registrada
 * já com a equipe, sem ficar PENDENTE, e nunca recebe resposta automática depois de religar, com ou sem ciclo do worker.
 */
export function opcoesRecepcaoAtendimento(env: NodeJS.ProcessEnv = process.env) {
  return { automacaoGlobal: inteligenciaAtiva(env) };
}
