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

export function registrarContextoEmpresa(sessaoId: string, empresaId: string | null, aviso?: string) {
    const novo = chave(sessaoId, empresaId);
    if (contexto !== null && contexto !== novo) {
        if (aguardandoRenovacao(empresaId))
            return false;
        reiniciarContextoEmpresa(aviso ?? 'A empresa ativa ou a sessão mudou. Os dados da tela anterior foram descartados.');
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

export function guardarAvisoDeContexto(texto: string) {
    try { sessionStorage.setItem(AVISO, texto.slice(0, 500)); } catch { /* sem armazenamento: o aviso se perde, os dados antigos não */ }
}

/** Lê e remove o aviso deixado antes de uma navegação de descarte (mostrado pela próxima tela). */
export function lerAvisoDeContexto() {
    try {
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

export function reiniciarContextoEmpresa(aviso?: string, destino?: string) {
    if (saidaDaSessao) return;
    if (aviso) guardarAvisoDeContexto(aviso);
    // Navegação completa descarta o Router Cache, estados React, conversas/rascunhos e pedidos da página antiga.
    // Nenhum dado de negócio é guardado no sinal entre abas nem no aviso.
    const alvo = destino ?? (window.location.pathname.startsWith('/desenvolvedor') ? '/desenvolvedor' : '/admin/dashboard');
    window.location.replace(alvo);
}

/**
 * Troca de empresa iniciada NESTA página (AdminShell): a sessão atual é revogada e outra é criada. Uma leitura da sessão
 * que saiu ANTES do início da troca, ou DURANTE ela (ainda com os cookies da sessão anterior), pode chegar dizendo
 * "sessão encerrada" — é a sessão anterior, não a nova. Essa resposta é obsoleta: não manda ao login (a própria troca
 * navega ao painel e descarta a página). Leituras que saem fora disso seguem a regra normal: sessão realmente
 * encerrada, expirada ou revogada → login. Troca recusada ou sem resposta encerra a janela (encerrarTrocaDeEmpresa).
 */
let trocasDeEmpresa = 0;
let trocaEmCurso = false;

/** Marca o início de uma troca de empresa nesta página (antes do pedido ao servidor). */
export function iniciarTrocaDeEmpresa() {
    trocasDeEmpresa += 1;
    trocaEmCurso = true;
}

/** A troca não aconteceu (recusada, falhou): a sessão atual continua valendo e as leituras voltam à regra normal. */
export function encerrarTrocaDeEmpresa() {
    trocaEmCurso = false;
}

export type MarcaDaSessao = { geracao: number; durante: boolean };

/** Marca do momento em que uma leitura da sessão sai; compare com sessaoObsoletaDesde quando a resposta chegar. */
export function marcaDaSessao(): MarcaDaSessao {
    return { geracao: trocasDeEmpresa, durante: trocaEmCurso };
}

/** true quando a leitura saiu durante uma troca, ou uma troca começou depois dela: a resposta é da sessão anterior. */
export function sessaoObsoletaDesde(marca: MarcaDaSessao) {
    return marca.durante || marca.geracao !== trocasDeEmpresa;
}
