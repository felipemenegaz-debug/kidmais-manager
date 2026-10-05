import { z } from 'zod';
import { cnpjRaizPlaceholder, cnpjValido, normalizarCnpj } from '../cadastro/cnpj.ts';
import { erroAcesso } from './erros.ts';

/** Campos de cadastro do painel. Normalização única para tela, banco e detecção de duplicidade. */

export function normalizarEmail(valor: string) {
    return valor.trim().toLowerCase();
}

export function somenteDigitos(valor: string | null | undefined) {
    return (valor ?? '').replace(/\D/g, '');
}

function cpfValido(cpf: string) {
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf))
        return false;
    const digito = (base: string, peso: number) => {
        let soma = 0;
        for (let i = 0; i < base.length; i += 1)
            soma += Number(base[i]) * (peso - i);
        const resto = (soma * 10) % 11;
        return resto === 10 ? 0 : resto;
    };
    return digito(cpf.slice(0, 9), 10) === Number(cpf[9]) && digito(cpf.slice(0, 10), 11) === Number(cpf[10]);
}

/** CPF (11 dígitos) ou CNPJ (numérico ou alfanumérico, DV oficial). Devolve a forma normalizada ou null. */
export function normalizarDocumentoFiscal(valor: string | null | undefined): string | null {
    const bruto = (valor ?? '').trim();
    if (!bruto)
        return null;
    const digitos = somenteDigitos(bruto);
    if (/^[\d.\-\s]+$/.test(bruto) && digitos.length === 11)
        return cpfValido(digitos) ? digitos : documentoInvalido();
    const cnpj = normalizarCnpj(bruto);
    if (cnpjValido(cnpj) && !cnpjRaizPlaceholder(cnpj))
        return cnpj;
    return documentoInvalido();
}

function documentoInvalido(): never {
    throw erroAcesso('DADOS_INVALIDOS', 'CPF ou CNPJ inválido.', 400, { campo: 'documentoFiscal' });
}

/** Telefone brasileiro só com dígitos: DDD + número (10–11) ou com 55 na frente (12–13). */
export function normalizarTelefone(valor: string | null | undefined): string | null {
    const digitos = somenteDigitos(valor);
    if (!digitos)
        return null;
    if (digitos.length < 10 || digitos.length > 13)
        throw erroAcesso('DADOS_INVALIDOS', 'Telefone inválido. Informe DDD e número.', 400, { campo: 'telefone' });
    return digitos;
}

export function textoOpcional(max: number) {
    return z.string().max(max * 2).transform((valor) => valor.trim().replace(/\s+/g, ' ')).pipe(z.string().max(max)).nullish()
        .transform((valor) => (valor ? valor : null));
}

export const emailObrigatorio = z.string().trim().max(254).email('E-mail inválido.').transform(normalizarEmail);
export const emailOpcional = z.string().trim().max(254).nullish().transform((valor, ctx) => {
    if (!valor)
        return null;
    const r = z.string().email().safeParse(valor);
    if (!r.success) {
        ctx.addIssue({ code: 'custom', message: 'E-mail inválido.' });
        return z.NEVER;
    }
    return normalizarEmail(valor);
});

export const nomeObrigatorio = (min: number, max: number) => z.string().transform((valor) => valor.trim().replace(/\s+/g, ' ')).pipe(z.string().min(min, 'Informe o nome.').max(max));

export const observacoes = z.string().max(4000).nullish().transform((valor) => (valor && valor.trim() ? valor.trim() : null));

/** Código da empresa: mesmo formato do banco (031). */
export const CODIGO_EMPRESA = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

export function sugerirCodigoEmpresa(nome: string) {
    const base = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 60).replace(/-+$/, '');
    const codigo = base.length >= 3 ? base : `empresa-${base}`.replace(/-+$/, '');
    return CODIGO_EMPRESA.test(codigo) ? codigo : 'empresa-nova';
}

/** Máscaras para respostas e auditoria (nunca o dado inteiro quando não precisa). */
export function mascararEmail(email: string) {
    const [local, dominio] = email.split('@');
    if (!dominio)
        return '***';
    return `${local.slice(0, 1)}***@${dominio}`;
}

export function mascararDocumento(documento: string | null) {
    if (!documento)
        return null;
    return `${'*'.repeat(Math.max(0, documento.length - 4))}${documento.slice(-4)}`;
}
