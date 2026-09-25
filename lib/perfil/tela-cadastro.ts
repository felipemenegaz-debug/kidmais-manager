import type { CadastroPerfil } from './cadastro.ts';

export type CapacidadesTela = {
    PERFIL_CONSULTAR: boolean;
    PERFIL_EDITAR_RASCUNHO: boolean;
    PERFIL_APLICAR: boolean;
    PERFIL_ADMINISTRAR_CONCESSOES: boolean;
};

export function cadastrosIguais(atual: CadastroPerfil, salvo: CadastroPerfil) {
    return JSON.stringify(atual) === JSON.stringify(salvo);
}

export function podeAplicar(input: {
    sujo: boolean;
    ocupado: boolean;
    numero: number | null;
    edicao: number | null;
    motivo: string;
    permitir: boolean;
    confirmado: boolean;
}) {
    return input.permitir
        && !input.sujo
        && !input.ocupado
        && input.numero != null
        && input.edicao != null
        && input.motivo.trim().length >= 3
        && input.confirmado;
}

export function aposOperacao<T>(input: { formAtual: T; enviado: T; ok: boolean; tardio: boolean }) {
    if (input.tardio || !input.ok)
        return { form: input.formAtual, atualizarSalvo: false, salvo: null as T | null };
    return { form: input.formAtual, atualizarSalvo: true, salvo: input.enviado as T | null };
}

export function recarregarDepoisDeAplicar(formAtual: CadastroPerfil, enviado: CadastroPerfil) {
    return cadastrosIguais(formAtual, enviado) ? 'substituir' as const : 'preservar' as const;
}

export function linhasAntesDepois(antes: CadastroPerfil, depois: CadastroPerfil) {
    const pares: Array<[string, string, string]> = [
        ['Nome que os clientes veem', antes.nomeComercial, depois.nomeComercial],
        ['Razão social', antes.razaoSocial, depois.razaoSocial],
        ['CNPJ', antes.cnpj, depois.cnpj],
        ['Complemento da sede', antes.sede.complemento, depois.sede.complemento],
        ['Complemento da unidade', antes.unidade.complemento, depois.unidade.complemento],
        ['Nome da unidade', antes.unidadeNome, depois.unidadeNome],
    ];
    return pares.map(([rotulo, valorAntes, valorDepois]) => ({ rotulo, antes: valorAntes, depois: valorDepois }));
}
