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
export function atendimentoAtivo(env: NodeJS.ProcessEnv = process.env) { return env.WHATSAPP_ATENDIMENTO_ENABLED === 'true'; }

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
