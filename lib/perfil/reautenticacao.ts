import { ClienteServiceError } from '../clientes/services/errors.ts';

const JANELA_REAUTENTICACAO_MS = 5 * 60 * 1000;

export function reautenticacaoPerfilRecente(autenticadoEm: string, agora = Date.now()) {
    const autenticado = new Date(autenticadoEm).getTime();
    return Number.isFinite(autenticado) && agora - autenticado <= JANELA_REAUTENTICACAO_MS && agora >= autenticado;
}

export function exigirReautenticacaoPerfil(sessao: { autenticado_em: string }, agora = Date.now()) {
    if (!reautenticacaoPerfilRecente(sessao.autenticado_em, agora)) {
        throw new ClienteServiceError(
            'PERFIL_REAUTENTICACAO',
            'Confirme sua senha novamente antes de aplicar dados sensíveis ou administrar concessões.',
            403,
        );
    }
}
