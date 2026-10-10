'use client';

/**
 * Contexto de acesso da página (sessão + empresa ativa). Qualquer mudança descarta a página inteira (navegação
 * completa), EXCETO a renovação comprovada de sessão: depois de uma reautenticação ou troca de senha validadas, o
 * servidor devolve { anterior, atual } e esta página aceita a troca só se `anterior` for exatamente a sessão que ela
 * tinha, `atual` for a sessão que o servidor agora informa e a empresa continuar a mesma. Nenhuma outra troca de
 * sessão é aceita, nem na mesma empresa.
 */
let contexto: string | null = null;
let renovacaoEmCurso: { anterior: string } | null = null;
const AVISO = 'kidmais-aviso-contexto';

const sessaoDe = (valor: string | null) => (valor ?? '').split(':')[0] ?? '';
const empresaDe = (valor: string | null) => (valor ?? '').split(':')[1] ?? '';
const chave = (sessaoId: string, empresaId: string | null) => `${sessaoId}:${empresaId ?? ''}`;

/** Mudança aguardada durante uma renovação em curso: mesma empresa, sessão ainda não confirmada. Não recarrega. */
function aguardandoRenovacao(empresaId: string | null) {
    return renovacaoEmCurso !== null && sessaoDe(contexto) === renovacaoEmCurso.anterior && empresaDe(contexto) === (empresaId ?? '');
}

/** true quando a sessão/empresa informadas diferem das desta página (sem efeitos colaterais). */
export function contextoMudou(sessaoId: string, empresaId: string | null) {
    return contexto !== null && contexto !== chave(sessaoId, empresaId) && !aguardandoRenovacao(empresaId);
}

export function registrarContextoEmpresa(sessaoId: string, empresaId: string | null, aviso?: string, origem: OrigemAviso = 'descarte') {
    const novo = chave(sessaoId, empresaId);
    if (contexto !== null && contexto !== novo) {
        if (aguardandoRenovacao(empresaId))
            return false;
        reiniciarContextoEmpresa(aviso ?? 'A empresa ativa ou a sessão mudou. Os dados da tela anterior foram descartados.', undefined, aviso ? origem : 'descarte');
        return false;
    }
    contexto = novo;
    return true;
}

/** Marca o início de uma reautenticação/troca de senha desta página (a sessão atual é a "anterior"). */
export function iniciarRenovacaoDeSessao() {
    renovacaoEmCurso = contexto ? { anterior: sessaoDe(contexto) } : null;
}

export function cancelarRenovacaoDeSessao() {
    renovacaoEmCurso = null;
}

/**
 * Conclui a renovação. `renovacao` vem da resposta do servidor à reautenticação; `sessaoAtual`/`empresaAtual` vêm
 * de uma leitura da sessão feita logo depois. Qualquer divergência descarta a página.
 */
export function concluirRenovacaoDeSessao(renovacao: { anterior: string; atual: string } | null | undefined, sessaoAtual: string | null, empresaAtual: string | null) {
    const esperada = renovacaoEmCurso;
    renovacaoEmCurso = null;
    const valida = Boolean(renovacao && esperada && contexto !== null
        && renovacao.anterior === esperada.anterior && sessaoDe(contexto) === renovacao.anterior
        && sessaoAtual === renovacao.atual && empresaDe(contexto) === (empresaAtual ?? ''));
    if (!valida) {
        reiniciarContextoEmpresa('A sessão mudou de forma inesperada. Os dados da tela anterior foram descartados.');
        return false;
    }
    contexto = chave(renovacao!.atual, empresaAtual);
    return true;
}

/**
 * Origem do aviso: RESULTADO de uma escrita (concluída, incerta, recusada, nada enviado) ou DESCARTE (leitura descartada,
 * contexto trocado, outra aba). Nesta página, um descarte nunca apaga o resultado de uma escrita: se apagasse, a pessoa
 * não saberia que a operação foi concluída e poderia repeti-la. Resultados de escritas diferentes se somam; entre
 * descartes vale o primeiro (os seguintes costumam ser efeito da própria navegação, como pedidos abortados).
 * SAÍDA (components/admin/sair.ts) mantém a regra própria: o aviso dela é o único que vale.
 */
export type OrigemAviso = 'escrita' | 'descarte' | 'saida';
let avisoDaPagina: { texto: string; origem: OrigemAviso } | null = null;
let destinoDaPagina: string | null = null;

export function guardarAvisoDeContexto(texto: string, origem: OrigemAviso = 'descarte') {
    let final = texto;
    if (avisoDaPagina && origem !== 'saida') {
        if (origem === 'descarte' || avisoDaPagina.texto.includes(texto))
            return;
        if (avisoDaPagina.origem === 'escrita')
            final = `${avisoDaPagina.texto} ${texto}`;
    }
    avisoDaPagina = { texto: final.slice(0, 500), origem };
    try { sessionStorage.setItem(AVISO, avisoDaPagina.texto); } catch { /* sem armazenamento: o aviso se perde, os dados antigos não */ }
}

/** Lê e remove o aviso deixado antes de uma navegação de descarte (mostrado pela próxima tela). */
export function lerAvisoDeContexto() {
    try {
        avisoDaPagina = null;
        const texto = sessionStorage.getItem(AVISO);
        if (texto) sessionStorage.removeItem(AVISO);
        return texto;
    }
    catch {
        return null;
    }
}

let saidaDaSessao = false;

/** Saída da sessão iniciada nesta página (components/admin/sair.ts): ela mesma navega ao login no prazo. */
export function marcarSaidaDaSessao() {
    saidaDaSessao = true;
}

/** true depois de a saída começar: respostas tardias não navegam nem deixam aviso por cima do resultado da saída. */
export function saidaDaSessaoEmAndamento() {
    return saidaDaSessao;
}

export function reiniciarContextoEmpresa(aviso?: string, destino?: string, origem: OrigemAviso = 'descarte') {
    if (saidaDaSessao) return;
    if (aviso) guardarAvisoDeContexto(aviso, origem);
    // Navegação completa descarta o Router Cache, estados React, conversas/rascunhos e pedidos da página antiga.
    // Nenhum dado de negócio é guardado no sinal entre abas nem no aviso.
    // Um destino explícito (sessão encerrada → login) não é desfeito por um descarte posterior da mesma página.
    if (destino) destinoDaPagina = destino;
    const alvo = destinoDaPagina ?? (window.location.pathname.startsWith('/desenvolvedor') ? '/desenvolvedor' : '/admin/dashboard');
    window.location.replace(alvo);
}
