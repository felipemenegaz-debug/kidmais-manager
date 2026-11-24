/** Ambiente deste deploy para os cartões do Wall-e (sem dependências: Marketing e Oportunidades importam daqui). */
export function ambienteDoDeploy(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.KIDMAIS_DEPLOY_ENV === 'staging' || env.KIDMAIS_DEPLOY_ENV === 'production' ? env.KIDMAIS_DEPLOY_ENV : null;
}
