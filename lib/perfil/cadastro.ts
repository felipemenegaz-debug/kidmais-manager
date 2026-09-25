import { cnpjRaizPlaceholder, cnpjValido, normalizarCnpj } from '../cadastro/cnpj.ts';

export type EnderecoCadastro = {
    cep: string;
    logradouro: string;
    numero: string;
    semNumero: boolean;
    complemento: string;
    bairro: string;
    cidade: string;
    uf: string;
    pais: string;
};

export type CadastroPerfil = {
    nomeComercial: string;
    razaoSocial: string;
    cnpj: string;
    sede: EnderecoCadastro;
    unidadeNome: string;
    mesmoEnderecoSede: boolean;
    unidade: EnderecoCadastro;
    referenciaChegada: string;
    telefone: string;
    whatsapp: string;
    emailComercial: string;
    site: string;
    instagram: string;
};

export type FalhaCadastro = { campo: string; mensagem: string };

function texto(valor: unknown, maximo: number) {
    return String(valor ?? '').trim().slice(0, maximo);
}

function endereco(valor: Partial<EnderecoCadastro> | undefined): EnderecoCadastro {
    return {
        cep: texto(valor?.cep, 16).replace(/\D/g, '').slice(0, 8),
        logradouro: texto(valor?.logradouro, 160),
        numero: texto(valor?.numero, 20),
        semNumero: valor?.semNumero === true,
        complemento: texto(valor?.complemento, 80),
        bairro: texto(valor?.bairro, 80),
        cidade: texto(valor?.cidade, 80),
        uf: texto(valor?.uf, 2).toUpperCase(),
        pais: texto(valor?.pais, 2).toUpperCase() || 'BR',
    };
}

export function cadastroVazio(): CadastroPerfil {
    const vazio = endereco({});
    return {
        nomeComercial: '',
        razaoSocial: '',
        cnpj: '',
        sede: vazio,
        unidadeNome: '',
        mesmoEnderecoSede: false,
        unidade: endereco({}),
        referenciaChegada: '',
        telefone: '',
        whatsapp: '',
        emailComercial: '',
        site: '',
        instagram: '',
    };
}

export function normalizarCadastro(valor: Partial<CadastroPerfil>): CadastroPerfil {
    const sede = endereco(valor.sede);
    if (sede.semNumero)
        sede.numero = '';
    const mesmoEnderecoSede = valor.mesmoEnderecoSede === true;
    const unidade = mesmoEnderecoSede ? { ...sede } : endereco(valor.unidade);
    if (unidade.semNumero)
        unidade.numero = '';
    return {
        nomeComercial: texto(valor.nomeComercial, 160),
        razaoSocial: texto(valor.razaoSocial, 160),
        cnpj: normalizarCnpj(texto(valor.cnpj, 32)),
        sede,
        unidadeNome: texto(valor.unidadeNome, 160),
        mesmoEnderecoSede,
        unidade,
        referenciaChegada: texto(valor.referenciaChegada, 160),
        telefone: texto(valor.telefone, 20).replace(/[^\d+]/g, ''),
        whatsapp: texto(valor.whatsapp, 20).replace(/[^\d+]/g, ''),
        emailComercial: texto(valor.emailComercial, 254).toLowerCase(),
        site: texto(valor.site, 200),
        instagram: texto(valor.instagram, 200),
    };
}

function urlHttp(valor: string) {
    if (!valor)
        return true;
    try {
        const url = new URL(valor);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

function validarEndereco(enderecoAtual: EnderecoCadastro, prefixo: string, completo: boolean, falhas: FalhaCadastro[]) {
    if (enderecoAtual.semNumero && enderecoAtual.numero)
        falhas.push({ campo: `${prefixo}.numero`, mensagem: 'Com “sem número”, o número fica vazio.' });
    if (!completo)
        return;
    if (!/^\d{8}$/.test(enderecoAtual.cep))
        falhas.push({ campo: `${prefixo}.cep`, mensagem: 'Informe o CEP com 8 dígitos.' });
    if (!enderecoAtual.logradouro)
        falhas.push({ campo: `${prefixo}.logradouro`, mensagem: 'Informe o logradouro.' });
    if (!enderecoAtual.semNumero && !enderecoAtual.numero)
        falhas.push({ campo: `${prefixo}.numero`, mensagem: 'Informe o número ou marque sem número.' });
    if (!enderecoAtual.bairro)
        falhas.push({ campo: `${prefixo}.bairro`, mensagem: 'Informe o bairro.' });
    if (!enderecoAtual.cidade)
        falhas.push({ campo: `${prefixo}.cidade`, mensagem: 'Informe a cidade.' });
    if (!/^[A-Z]{2}$/.test(enderecoAtual.uf))
        falhas.push({ campo: `${prefixo}.uf`, mensagem: 'Informe a UF.' });
    if (enderecoAtual.pais !== 'BR')
        falhas.push({ campo: `${prefixo}.pais`, mensagem: 'A V1 usa endereço no Brasil.' });
}

function validarCnpj(cnpj: string, obrigatorio: boolean, falhas: FalhaCadastro[]) {
    if (!cnpj) {
        if (obrigatorio)
            falhas.push({ campo: 'cnpj', mensagem: 'Informe o CNPJ.' });
        return;
    }
    if (!cnpjValido(cnpj))
        falhas.push({ campo: 'cnpj', mensagem: 'CNPJ com formato ou dígitos inválidos.' });
    else if (cnpjRaizPlaceholder(cnpj))
        falhas.push({ campo: 'cnpj', mensagem: 'Este CNPJ é um placeholder e não identifica a empresa.' });
}

export function validarRascunho(valor: Partial<CadastroPerfil>) {
    const cadastro = normalizarCadastro(valor);
    const falhas: FalhaCadastro[] = [];
    validarCnpj(cadastro.cnpj, false, falhas);
    validarEndereco(cadastro.sede, 'sede', false, falhas);
    if (!cadastro.mesmoEnderecoSede)
        validarEndereco(cadastro.unidade, 'unidade', false, falhas);
    if (cadastro.emailComercial && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cadastro.emailComercial))
        falhas.push({ campo: 'emailComercial', mensagem: 'E-mail comercial inválido.' });
    if (!urlHttp(cadastro.site))
        falhas.push({ campo: 'site', mensagem: 'Site precisa ser um endereço http ou https.' });
    if (!urlHttp(cadastro.instagram))
        falhas.push({ campo: 'instagram', mensagem: 'Instagram precisa ser um endereço http ou https.' });
    return { cadastro, falhas };
}

export function validarAplicacao(valor: Partial<CadastroPerfil>) {
    const cadastro = normalizarCadastro(valor);
    const falhas: FalhaCadastro[] = [];
    if (!cadastro.nomeComercial)
        falhas.push({ campo: 'nomeComercial', mensagem: 'Informe o nome que os clientes veem.' });
    if (!cadastro.razaoSocial)
        falhas.push({ campo: 'razaoSocial', mensagem: 'Informe a razão social.' });
    validarCnpj(cadastro.cnpj, true, falhas);
    validarEndereco(cadastro.sede, 'sede', true, falhas);
    if (!cadastro.unidadeNome)
        falhas.push({ campo: 'unidadeNome', mensagem: 'Informe o nome da unidade.' });
    if (!cadastro.mesmoEnderecoSede)
        validarEndereco(cadastro.unidade, 'unidade', true, falhas);
    if (cadastro.telefone.replace(/\D/g, '').length < 10 && cadastro.whatsapp.replace(/\D/g, '').length < 10)
        falhas.push({ campo: 'telefone', mensagem: 'Informe telefone ou WhatsApp para contato.' });
    if (cadastro.emailComercial && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cadastro.emailComercial))
        falhas.push({ campo: 'emailComercial', mensagem: 'E-mail comercial inválido.' });
    if (!urlHttp(cadastro.site))
        falhas.push({ campo: 'site', mensagem: 'Site precisa ser um endereço http ou https.' });
    if (!urlHttp(cadastro.instagram))
        falhas.push({ campo: 'instagram', mensagem: 'Instagram precisa ser um endereço http ou https.' });
    return { cadastro, falhas };
}

export function alteracaoSensivel(antes: CadastroPerfil, depois: CadastroPerfil) {
    const enderecoMudou = (esquerda: EnderecoCadastro, direita: EnderecoCadastro) => JSON.stringify(esquerda) !== JSON.stringify(direita);
    return antes.razaoSocial !== depois.razaoSocial
        || antes.cnpj !== depois.cnpj
        || enderecoMudou(antes.sede, depois.sede)
        || antes.mesmoEnderecoSede !== depois.mesmoEnderecoSede
        || (!depois.mesmoEnderecoSede && enderecoMudou(antes.unidade, depois.unidade));
}
