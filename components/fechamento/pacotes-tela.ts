import type { Pacote } from "./data.ts";
import type { PacoteId } from "./types.ts";

/** Código do pacote no servidor (pacotes/preços da empresa) para cada id da tela. */
export const CODIGO_PACOTE: Record<string, string> = { pocket: 'POCKET', mini: 'MINI_FESTA', compacta: 'COMPACTA', essencial: 'ESSENCIAL', completa: 'COMPLETA', premium: 'PREMIUM', pizza_party_scienza: 'PIZZA_PARTY' };

/** O que /api/fechamentos/pacotes devolve por pacote vigente da empresa do endereço. */
export type FatoPacote = { nome: string; descricao: string | null; duracaoMinutos: number | null; convidadosMinimos: number | null; convidadosMaximos: number | null; precoMinimo: string | null };
export type FatosPacote = Record<string, FatoPacote>;

/** Cartão da etapa “Escolha o pacote”. `disponibilidade`/`destaque` nulos = não exibidos. */
export type PacoteExibido = { id: PacoteId; nome: string; preco: number | null; descricao: string; disponibilidade: string | null; destaque: string | null };

/** Pacote escolhido; `limiteCadastrado` falso = a empresa não informou o máximo de convidados. */
export type PacoteDaTela = Pacote & { limiteCadastrado: boolean };

/** Sem máximo cadastrado: limite só do campo (o servidor recusa o que o pacote não aceitar). */
const MAXIMO_SEM_CADASTRO = 500;

function precoDe(fato: FatoPacote) {
    return fato.precoMinimo == null ? null : Number(fato.precoMinimo);
}

/**
 * Pacotes da etapa de escolha.
 * - Kidmais (endereço atual): o catálogo atual, com nome/preço/descrição publicados quando chegam — inalterado.
 * - Outra empresa (/b/<código>): SOMENTE os pacotes que o servidor devolveu para ela, com os dados dela.
 *   Sem resposta ainda (ou falha) → null: a tela mostra carregando/erro, nunca o catálogo da Kidmais.
 */
export function pacotesExibidos(kidmais: boolean, catalogo: readonly Pacote[], fatos: FatosPacote | null): PacoteExibido[] | null {
    if (kidmais)
        return catalogo.map((item) => {
            const publicado = fatos?.[CODIGO_PACOTE[item.id]!];
            return {
                id: item.id, nome: publicado?.nome ?? item.nome,
                preco: publicado ? precoDe(publicado) : item.precoInicial,
                descricao: publicado ? (publicado.descricao || "Descrição não cadastrada.") : item.descricao,
                disponibilidade: item.disponibilidade, destaque: item.destaque ?? null,
            };
        });
    if (!fatos) return null;
    return catalogo.flatMap((item) => {
        const fato = fatos[CODIGO_PACOTE[item.id]!];
        return fato ? [{ id: item.id, nome: fato.nome, preco: precoDe(fato), descricao: fato.descricao || "Descrição não cadastrada.", disponibilidade: null, destaque: null }] : [];
    });
}

/**
 * Pacote escolhido, para as etapas seguintes.
 * - Kidmais: o mesmo de antes (catálogo + dados publicados por cima).
 * - Outra empresa: só se ela oferece o pacote; todos os dados vêm do servidor. Nenhum texto, regra
 *   (sob consulta, observação, buffet, horários) ou limite do catálogo da Kidmais é herdado.
 */
export function pacoteDaTela(kidmais: boolean, catalogo: readonly Pacote[], fatos: FatosPacote | null, id: string): PacoteDaTela | undefined {
    const base = catalogo.find((item) => item.id === id);
    if (!base) return undefined;
    const fato = fatos?.[CODIGO_PACOTE[base.id]!];
    if (kidmais) {
        if (!fato) return { ...base, limiteCadastrado: true };
        return {
            ...base, limiteCadastrado: true,
            nome: fato.nome,
            minPagantes: fato.convidadosMinimos ?? base.minPagantes,
            maxPagantes: fato.convidadosMaximos ?? base.maxPagantes,
            precoInicial: precoDe(fato),
            duracao: fato.duracaoMinutos == null ? "" : `${fato.duracaoMinutos} minutos`,
        };
    }
    if (!fato) return undefined;
    return {
        id: base.id,
        nome: fato.nome,
        precoInicial: precoDe(fato),
        minPagantes: fato.convidadosMinimos ?? 1,
        maxPagantes: fato.convidadosMaximos ?? MAXIMO_SEM_CADASTRO,
        limiteCadastrado: fato.convidadosMaximos != null,
        descricao: fato.descricao ?? "",
        disponibilidade: "",
        duracao: fato.duracaoMinutos == null ? "" : `${fato.duracaoMinutos} minutos`,
        buffet: "",
    };
}
