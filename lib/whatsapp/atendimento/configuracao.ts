export type AmbienteAtendimento = 'staging' | 'production';
export function ambienteAtendimento(env: NodeJS.ProcessEnv = process.env): AmbienteAtendimento {
  if (env.KIDMAIS_DEPLOY_ENV !== 'staging' && env.KIDMAIS_DEPLOY_ENV !== 'production') throw new Error('ATENDIMENTO_AMBIENTE_INVALIDO');
  return env.KIDMAIS_DEPLOY_ENV;
}
export function empresaPiloto(env: NodeJS.ProcessEnv = process.env) {
  const id = env.WHATSAPP_ATENDIMENTO_EMPRESA_ID;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('ATENDIMENTO_EMPRESA_NAO_CONFIGURADA');
  return id;
}
/**
 * Receptor único do número comercial. O app Gupshup aceita até cinco assinaturas de webhook e cada uma recebe uma
 * cópia dos eventos: staging e produção podem receber a mesma mensagem. Só o ambiente nomeado em
 * WHATSAPP_ATENDIMENTO_RECEPTOR (igual a KIDMAIS_DEPLOY_ENV) grava entradas e envia respostas. Ausente ou divergente:
 * nenhuma automação (fail-closed); as flags de ligar não bastam sem o receptor.
 */
export function receptorDoNumero(env: NodeJS.ProcessEnv = process.env) {
  const receptor = env.WHATSAPP_ATENDIMENTO_RECEPTOR;
  return (receptor === 'staging' || receptor === 'production') && receptor === env.KIDMAIS_DEPLOY_ENV;
}
/** Sem empresa piloto válida a recepção fica desligada (só metadados): erro de configuração não vira 503 eterno. */
export function recepcaoAtiva(env: NodeJS.ProcessEnv = process.env) {
  if (env.WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED !== 'true' || !receptorDoNumero(env)) return false;
  try { empresaPiloto(env); return true; } catch { return false; }
}
export function atendimentoAtivo(env: NodeJS.ProcessEnv = process.env) { return env.WHATSAPP_ATENDIMENTO_ENABLED === 'true' && receptorDoNumero(env); }

/**
 * Contatos que o canal pode receber e responder (WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS: números com DDI, só
 * dígitos, separados por vírgula). Staging usa o número comercial real: sem a lista, nada é gravado nem enviado
 * (fail-closed), e mensagens de clientes reais nunca entram no banco de homologação. Em produção a lista é opcional
 * (ativação gradual); ausente, todos os contatos são atendidos.
 */
export function contatoPermitido(contato: string, env: NodeJS.ProcessEnv = process.env) {
  const lista = (env.WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (lista.some(v => !/^\d{8,15}$/.test(v))) return false;
  if (!lista.length) return ambienteAtendimento(env) === 'production';
  return lista.includes(contato);
}
