import type { Pacote } from "./data.ts";
import type { PacoteId } from "./types.ts";
import { erroConvidadosEmpresa, erroConvidadosFechamento, LIMITE_CONVIDADOS_PEDIDO_ONLINE } from "../../lib/fechamentos/convidados.ts";
import type { RegraPacoteEmpresa } from "../../lib/agenda/disponibilidade.ts";

/** Código do pacote no servidor (pacotes/preços da empresa) para cada id V1 da tela (endereço atual da Kidmais). */
export const CODIGO_PACOTE: Record<string, string> = { pocket: 'POCKET', mini: 'MINI_FESTA', compacta: 'COMPACTA', essencial: 'ESSENCIAL', completa: 'COMPLETA', premium: 'PREMIUM', pizza_party_scienza: 'PIZZA_PARTY' };

/**
 * Código do pacote no servidor para o id da tela, pela MARCA da página (não valida formato nem existência: quem valida é
 * `codigoDoPacoteDaTela` no servidor, que também aceita id V1 em /b).
 * - Kidmais (endereço atual): o id V1 traduzido; id fora dos sete = undefined.
 * - Outra empresa (/b/<código>): o id da tela JÁ é o código do pacote dela (POCKET, P_9F…), vindo do servidor.
 */
export function codigoServidorDoPacoteDaMarca(kidmais: boolean, id: string): string | undefined {
    if (!id) return undefined;
    return kidmais ? CODIGO_PACOTE[id] : id;
}

/**
 * O que /api/fechamentos/pacotes devolve por pacote vigente da empresa do endereço.
 * `disponibilidade`: só em /b/<código> — dias e períodos configurados pela empresa para o pacote.
 */
export type FatoPacote = { nome: string; descricao: string | null; duracaoMinutos: number | null; convidadosMinimos: number | null; convidadosMaximos: number | null; precoMinimo: string | null; disponibilidade?: RegraPacoteEmpresa[]; comporta?: boolean };
export type FatosPacote = Record<string, FatoPacote>;

/** Cartão da etapa “Escolha o pacote”. `disponibilidade`/`destaque` nulos = não exibidos. */
export type PacoteExibido = { id: PacoteId; nome: string; preco: number | null; descricao: string; disponibilidade: string | null; destaque: string | null };

/** Pacote escolhido; `limiteCadastrado` falso = a empresa não informou o máximo de convidados. */
export type PacoteDaTela = Pacote & { limiteCadastrado: boolean };

/** Sem máximo cadastrado: o teto do pedido online, o mesmo do servidor. */
const MAXIMO_SEM_CADASTRO = LIMITE_CONVIDADOS_PEDIDO_ONLINE;

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
    // Na ordem do servidor (a da tela de Pacotes da empresa); o id é o código do pacote — inclusive "Novo pacote" (P_…).
    return Object.entries(fatos).map(([codigo, fato]) => ({
        id: codigo, nome: fato.nome, preco: precoDe(fato), descricao: fato.descricao || "Descrição não cadastrada.", disponibilidade: null, destaque: null,
    }));
}

/**
 * Pacote escolhido, para as etapas seguintes.
 * - Kidmais: o mesmo de antes (catálogo + dados publicados por cima).
 * - Outra empresa: só se ela oferece o pacote; todos os dados vêm do servidor. Nenhum texto, regra
 *   (sob consulta, observação, buffet, horários) ou limite do catálogo da Kidmais é herdado.
 */
export function pacoteDaTela(kidmais: boolean, catalogo: readonly Pacote[], fatos: FatosPacote | null, id: string): PacoteDaTela | undefined {
    if (kidmais) {
        const base = catalogo.find((item) => item.id === id);
        if (!base) return undefined;
        const fato = fatos?.[CODIGO_PACOTE[base.id]!];
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
    const fato = id ? fatos?.[id] : undefined;
    if (!fato) return undefined;
    return {
        id,
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

/**
 * Regras de disponibilidade do pacote para a tela.
 * - Kidmais (endereço atual): null — vale a regra legada (inalterada).
 * - Outra empresa: as regras dela para o pacote; sem dados ainda (ou pacote que ela não oferece) = [],
 *   isto é, nada disponível pela regra — nunca a regra fixa da Kidmais pelo código do pacote.
 */
export function regrasDisponibilidadeDaTela(kidmais: boolean, fatos: FatosPacote | null, id: string): RegraPacoteEmpresa[] | null {
    if (kidmais) return null;
    return (id && fatos?.[id]?.disponibilidade) || [];
}

/**
 * S-C: por que o pacote não comporta N convidados (a mesma regra da etapa Convidados e do servidor); null = comporta.
 * Pacote desconhecido (lista ainda não chegou) = comporta: nada some por falta de dado.
 */
export function motivoNaoComporta(kidmais: boolean, catalogo: readonly Pacote[], fatos: FatosPacote | null, id: string, convidados: number): string | null {
    const pacote = pacoteDaTela(kidmais, catalogo, fatos, id);
    if (!pacote) return null;
    return kidmais ? erroConvidadosFechamento(convidados, pacote) : erroConvidadosEmpresa(convidados, pacote);
}

/** S-C: os que comportam primeiro (na ordem de antes); os demais ficam para o "ver mesmo assim". */
export function separarPorConvidados<T extends { id: string }>(itens: readonly T[], naoComporta: (id: string) => string | null) {
    const comportam: T[] = [];
    const naoComportam: Array<T & { motivo: string }> = [];
    for (const item of itens) {
        const motivo = naoComporta(item.id);
        if (motivo) naoComportam.push({ ...item, motivo });
        else comportam.push(item);
    }
    return { comportam, naoComportam };
}
