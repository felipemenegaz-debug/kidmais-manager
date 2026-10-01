import type { EnderecoCadastro } from './cadastro.ts';

export type RespostaCep = {
    cep: string;
    logradouro: string;
    bairro: string;
    cidade: string;
    uf: string;
};

export type PedidoCep = {
    cep: string;
    logradouro: string;
    bairro: string;
    cidade: string;
    uf: string;
};

export function cepCompleto(valor: string) {
    const digitos = valor.replace(/\D/g, '');
    return /^\d{8}$/.test(digitos) ? digitos : null;
}

export function aplicarConsultaCep(atual: EnderecoCadastro, pedido: PedidoCep, resposta: RespostaCep | null): EnderecoCadastro {
    if (atual.cep.replace(/\D/g, '') !== pedido.cep || !resposta || resposta.cep !== pedido.cep)
        return atual;
    const manter = (campo: 'logradouro' | 'bairro' | 'cidade' | 'uf') => atual[campo] === pedido[campo] ? resposta[campo] : atual[campo];
    return {
        ...atual,
        logradouro: manter('logradouro'),
        bairro: manter('bairro'),
        cidade: manter('cidade'),
        uf: manter('uf').toUpperCase(),
    };
}
