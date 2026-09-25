import { cadastroVazio, normalizarCadastro, type CadastroPerfil, type EnderecoCadastro } from './cadastro.ts';

export type CapacidadesTela = {
    PERFIL_CONSULTAR: boolean;
    PERFIL_EDITAR_RASCUNHO: boolean;
    PERFIL_APLICAR: boolean;
    PERFIL_ADMINISTRAR_CONCESSOES: boolean;
};

export function cadastrosIguais(atual: CadastroPerfil, salvo: CadastroPerfil) {
    return JSON.stringify(normalizarCadastro(atual)) === JSON.stringify(normalizarCadastro(salvo));
}

export function podeAplicar(input: {
    sujo: boolean;
    ocupado: boolean;
    numero: number | null;
    edicao: number | null;
    motivo: string;
    permitir: boolean;
    confirmado: boolean;
    conflito?: boolean;
    confirmacaoConfere?: boolean;
}) {
    const conferiu = input.confirmacaoConfere ?? input.confirmado;
    return input.permitir
        && !input.sujo
        && !input.ocupado
        && !input.conflito
        && input.numero != null
        && input.edicao != null
        && input.motivo.trim().length >= 3
        && input.confirmado
        && conferiu;
}

export function aposOperacao(input: { formAtual: CadastroPerfil; enviado: CadastroPerfil; ok: boolean; tardio: boolean }) {
    if (input.tardio || !input.ok)
        return { form: input.formAtual, atualizarSalvo: false, salvo: null as CadastroPerfil | null };
    return { form: input.formAtual, atualizarSalvo: true, salvo: normalizarCadastro(input.enviado) };
}

export type EstadoFluxo = {
    form: CadastroPerfil;
    salvo: CadastroPerfil;
    numero: number | null;
    edicao: number | null;
    versaoBase: number;
    confirmado: boolean;
    conflito: boolean;
    carregou: boolean;
    digitou: boolean;
    conteudoConfirmado: CadastroPerfil | null;
};

export type CargaPerfil = {
    contexto: {
        versao: number;
        cadastro: CadastroPerfil;
        rascunho: { numero: number; edicao: number; versaoBase: number; conteudo: CadastroPerfil } | null;
    } | null;
};

export function estadoFluxoInicial(): EstadoFluxo {
    const vazio = cadastroVazio();
    return {
        form: vazio,
        salvo: vazio,
        numero: null,
        edicao: null,
        versaoBase: 0,
        confirmado: false,
        conflito: false,
        carregou: false,
        digitou: false,
        conteudoConfirmado: null,
    };
}

export function devePreencherNaRetentativa(estado: EstadoFluxo) {
    return !estado.carregou && !estado.digitou;
}

export function aposCarga(estado: EstadoFluxo, carga: CargaPerfil, substituirForm: boolean): EstadoFluxo {
    const recebido = carga.contexto ? (carga.contexto.rascunho?.conteudo ?? carga.contexto.cadastro) : null;
    const preencher = Boolean(recebido) && !estado.digitou && (substituirForm || !estado.carregou);
    if (preencher && recebido && carga.contexto) {
        const normal = normalizarCadastro(recebido);
        const rascunho = carga.contexto.rascunho;
        return {
            ...estado,
            form: normal,
            salvo: normal,
            numero: rascunho?.numero ?? null,
            edicao: rascunho?.edicao ?? null,
            versaoBase: rascunho?.versaoBase ?? carga.contexto.versao,
            carregou: true,
            conflito: false,
            confirmado: false,
            conteudoConfirmado: null,
            digitou: false,
        };
    }
    return estado;
}

export function aposDigitacao(estado: EstadoFluxo, form: CadastroPerfil): EstadoFluxo {
    return { ...estado, form, digitou: true, confirmado: false, conteudoConfirmado: null };
}

export function aposConflito(estado: EstadoFluxo, formAtual: CadastroPerfil): EstadoFluxo {
    return {
        ...estado,
        form: formAtual,
        digitou: true,
        conflito: true,
        confirmado: false,
        conteudoConfirmado: null,
    };
}

export function identidadeDoConflito(detalhes: unknown) {
    if (!detalhes || typeof detalhes !== 'object')
        return null;
    const dados = detalhes as { versao?: unknown; edicao?: unknown; numero?: unknown };
    if (typeof dados.numero !== 'number' || typeof dados.edicao !== 'number' || typeof dados.versao !== 'number')
        return null;
    return { numero: dados.numero, edicao: dados.edicao, versaoBase: dados.versao };
}

export function resolverConflito(
    estado: EstadoFluxo,
    identidade: { numero: number; edicao: number; versaoBase: number },
    conteudoAtual: CadastroPerfil,
): EstadoFluxo {
    const salvo = normalizarCadastro(conteudoAtual);
    return {
        ...estado,
        salvo,
        numero: identidade.numero,
        edicao: identidade.edicao,
        versaoBase: identidade.versaoBase,
        conflito: false,
        confirmado: false,
        conteudoConfirmado: null,
        digitou: !cadastrosIguais(estado.form, salvo),
    };
}

export function aposAplicar(estado: EstadoFluxo, input: {
    formAtual: CadastroPerfil;
    enviado: CadastroPerfil;
    versaoAplicada: number;
}): EstadoFluxo {
    const digitou = recarregarDepoisDeAplicar(input.formAtual, input.enviado) === 'preservar';
    return {
        ...estado,
        form: input.formAtual,
        numero: null,
        edicao: null,
        versaoBase: input.versaoAplicada,
        digitou,
        confirmado: false,
        conteudoConfirmado: null,
        conflito: false,
    };
}

export function pedidoRascunho(estado: Pick<EstadoFluxo, 'numero' | 'edicao' | 'versaoBase' | 'form'>) {
    return {
        acao: 'salvar-rascunho' as const,
        numero: estado.numero,
        edicao: estado.edicao,
        versaoBase: estado.versaoBase,
        cadastro: estado.form,
    };
}

export function confirmarRevisao(estado: EstadoFluxo, marcado: boolean): EstadoFluxo {
    if (!marcado)
        return { ...estado, confirmado: false, conteudoConfirmado: null };
    return { ...estado, confirmado: true, conteudoConfirmado: normalizarCadastro(estado.salvo) };
}

export function revisaoAindaConfere(estado: Pick<EstadoFluxo, 'confirmado' | 'conteudoConfirmado' | 'salvo'>) {
    if (!estado.confirmado || !estado.conteudoConfirmado)
        return false;
    return cadastrosIguais(normalizarCadastro(estado.conteudoConfirmado), normalizarCadastro(estado.salvo));
}

export function aplicarResultadoOperacao(
    estado: EstadoFluxo,
    efeito: { form: CadastroPerfil; atualizarSalvo: boolean; salvo: CadastroPerfil | null },
    identidade: { numero: number; edicao: number; versaoBase: number } | null,
): EstadoFluxo {
    if (!efeito.atualizarSalvo || !efeito.salvo || !identidade)
        return { ...estado, form: efeito.form };
    const salvo = normalizarCadastro(efeito.salvo);
    const conferia = revisaoAindaConfere(estado);
    return {
        ...estado,
        form: efeito.form,
        salvo,
        numero: identidade.numero,
        edicao: identidade.edicao,
        versaoBase: identidade.versaoBase,
        conflito: false,
        confirmado: conferia && cadastrosIguais(normalizarCadastro(estado.salvo), salvo) ? estado.confirmado : false,
        conteudoConfirmado: conferia && cadastrosIguais(normalizarCadastro(estado.salvo), salvo) ? estado.conteudoConfirmado : null,
    };
}

export function recarregarDepoisDeAplicar(formAtual: CadastroPerfil, enviado: CadastroPerfil) {
    return cadastrosIguais(formAtual, enviado) ? 'substituir' as const : 'preservar' as const;
}

function textoEndereco(endereco: EnderecoCadastro, prefixo: string) {
    return [
        [`CEP ${prefixo}`, endereco.cep],
        [`Logradouro ${prefixo}`, endereco.logradouro],
        [`Número ${prefixo}`, endereco.semNumero ? 'sem número' : endereco.numero],
        [`Complemento ${prefixo}`, endereco.complemento],
        [`Bairro ${prefixo}`, endereco.bairro],
        [`Cidade ${prefixo}`, endereco.cidade],
        [`UF ${prefixo}`, endereco.uf],
    ] as Array<[string, string]>;
}

function paresEndereco(antes: EnderecoCadastro, depois: EnderecoCadastro, prefixo: string): Array<[string, string, string]> {
    const esquerda = textoEndereco(antes, prefixo);
    const direita = textoEndereco(depois, prefixo);
    return esquerda.map(([rotulo, valor], indice) => [rotulo, valor, direita[indice]?.[1] ?? '']);
}

export function linhasAntesDepois(antes: CadastroPerfil, depois: CadastroPerfil) {
    const esquerda = normalizarCadastro(antes);
    const direita = normalizarCadastro(depois);
    const pares: Array<[string, string, string]> = [
        ['Nome que os clientes veem', esquerda.nomeComercial, direita.nomeComercial],
        ['Razão social', esquerda.razaoSocial, direita.razaoSocial],
        ['CNPJ', esquerda.cnpj, direita.cnpj],
        ...paresEndereco(esquerda.sede, direita.sede, 'da sede'),
        ['Mesmo endereço da sede', esquerda.mesmoEnderecoSede ? 'sim' : 'não', direita.mesmoEnderecoSede ? 'sim' : 'não'],
        ['Nome da unidade', esquerda.unidadeNome, direita.unidadeNome],
        ...paresEndereco(esquerda.unidade, direita.unidade, 'da unidade'),
        ['Referência de chegada', esquerda.referenciaChegada, direita.referenciaChegada],
        ['Telefone', esquerda.telefone, direita.telefone],
        ['WhatsApp', esquerda.whatsapp, direita.whatsapp],
        ['E-mail comercial', esquerda.emailComercial, direita.emailComercial],
        ['Site', esquerda.site, direita.site],
        ['Instagram', esquerda.instagram, direita.instagram],
    ];
    return pares
        .filter(([, valorAntes, valorDepois]) => valorAntes !== valorDepois)
        .map(([rotulo, valorAntes, valorDepois]) => ({ rotulo, antes: valorAntes, depois: valorDepois }));
}
