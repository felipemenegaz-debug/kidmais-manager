/**
 * Consulta de CEP no serviço externo (ViaCEP). Ligada por padrão; `CONSULTA_CEP_EXTERNA=desligada` a desliga
 * (ex.: servidor local de homologação, sem chamadas externas). Desligada, a rota responde como serviço indisponível
 * e a tela aceita o endereço preenchido manualmente — o mesmo caminho de uma falha do ViaCEP.
 */
export function consultaCepExternaLigada(env: Record<string, string | undefined> = process.env) {
    return env.CONSULTA_CEP_EXTERNA?.trim().toLowerCase() !== 'desligada';
}
