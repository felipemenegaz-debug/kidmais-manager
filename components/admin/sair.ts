'use client';
import { guardarAvisoDeContexto, marcarSaidaDaSessao } from '@/lib/http/contexto-empresa-cliente';

/**
 * Saída da sessão a partir de qualquer tela: Admin, painel do desenvolvedor, perfil, seleção vazia ou estado de erro.
 *
 * Regras:
 *   - prazo total (PRAZO_SAIDA_MS): nenhum pedido fica pendente para sempre; ao estourar, a tela segue para o login e o
 *     aviso diz que o servidor NÃO confirmou o encerramento (a sessão pode continuar aberta no servidor; o cookie
 *     HttpOnly não é apagável pelo cliente);
 *   - não depende da confirmação de contexto das operações de negócio (lib/http/admin-fetch): sair não exige que a empresa da
 *     página continue a mesma; precisa só da sessão do cookie e do CSRF dela;
 *   - CSRF preservado: usa o último CSRF que a tela recebeu do servidor (lembrarCsrf) e, sem ele ou quando o servidor
 *     o recusa (rotação após reautenticação), lê a sessão UMA vez para obter o atual — no máximo dois POSTs;
 *   - um pedido por vez: cliques repetidos durante a saída compartilham a mesma saída; respostas atrasadas são
 *     ignoradas; nada é repetido automaticamente depois do resultado;
 *   - ir para o login nunca é apresentado como prova de encerramento: o resultado diz se foi confirmado e o aviso
 *     deixado para a tela de login diz quando não foi;
 *   - respostas tardias de outras requisições da página (401 ou contexto mudado depois do clique) não mudam o destino
 *     nem o aviso (marcarSaidaDaSessao em lib/http/contexto-empresa-cliente).
 */
export const PRAZO_SAIDA_MS = 8000;
export const AVISO_SAIDA_NAO_CONFIRMADA = 'O servidor não confirmou o encerramento da sessão: ela pode continuar aberta. Se este dispositivo é compartilhado, entre de novo e saia novamente ou feche o navegador.';
export const AVISO_SAIDA_PRAZO = 'O servidor não respondeu ao pedido de saída dentro do prazo: a sessão pode continuar aberta. Se este dispositivo é compartilhado, entre de novo e saia novamente ou feche o navegador.';

export type MotivoSaida = 'CONFIRMADA' | 'SESSAO_JA_ENCERRADA' | 'NAO_CONFIRMADA' | 'PRAZO_ESGOTADO';
export type ResultadoSaida = { confirmada: boolean; motivo: MotivoSaida; pedidos: number };
export type DependenciasSaida = {
    fetch?: typeof fetch;
    navegar?: (destino: string) => void;
    avisar?: (texto: string) => void;
    prazoMs?: number;
    agora?: () => number;
};

const CSRF = /^[A-Za-z0-9_-]{43}$/;
const ROTA = '/api/admin/autenticacao';
let csrfConhecido: string | null = null;
let saidaEmCurso: Promise<ResultadoSaida> | null = null;

/** As telas registram o CSRF que receberam do servidor; sair usa esse valor sem precisar de uma leitura prévia. */
export function lembrarCsrf(csrf: unknown) {
    csrfConhecido = typeof csrf === 'string' && CSRF.test(csrf) ? csrf : null;
}

/** Só para testes: zera o CSRF lembrado e a saída em curso. */
export function reiniciarSaidaParaTestes() {
    csrfConhecido = null;
    saidaEmCurso = null;
}

type Pedido = { tipo: 'resposta'; status: number; corpo: unknown } | { tipo: 'tempo' } | { tipo: 'rede' };
type Postagem = 'ok' | 'encerrada' | 'csrf' | 'recusada' | 'tempo';

export function sairDaSessao(deps: DependenciasSaida = {}): Promise<ResultadoSaida> {
    if (saidaEmCurso)
        return saidaEmCurso;
    saidaEmCurso = executarSaida(deps).finally(() => { saidaEmCurso = null; });
    return saidaEmCurso;
}

async function executarSaida(deps: DependenciasSaida): Promise<ResultadoSaida> {
    const pedirRede: typeof fetch = deps.fetch ?? ((entrada, init) => fetch(entrada, init));
    const navegar = deps.navegar ?? ((destino: string) => { window.location.assign(destino); });
    // O aviso da saída é o único que vale (origem 'saida': substitui qualquer outro desta página).
    const avisar = deps.avisar ?? ((texto: string) => guardarAvisoDeContexto(texto, 'saida'));
    const agora = deps.agora ?? (() => Date.now());
    const limite = agora() + (deps.prazoMs ?? PRAZO_SAIDA_MS);
    let pedidos = 0;
    // A partir daqui, respostas tardias de outras requisições da página (401, contexto mudado) não navegam nem deixam
    // aviso: esta saída vai ao login no prazo e o aviso dela é o único que vale.
    marcarSaidaDaSessao();

    /** Um pedido com o tempo que resta do prazo total; a resposta que chegar depois do prazo é ignorada. */
    async function pedir(init: RequestInit): Promise<Pedido> {
        const restante = limite - agora();
        if (restante <= 0)
            return { tipo: 'tempo' };
        pedidos += 1;
        const controle = new AbortController();
        let temporizador: ReturnType<typeof setTimeout> | undefined;
        const prazo = new Promise<Pedido>((resolve) => {
            temporizador = setTimeout(() => { controle.abort(); resolve({ tipo: 'tempo' }); }, restante);
        });
        const rede = pedirRede(ROTA, { ...init, cache: 'no-store', credentials: 'same-origin', signal: controle.signal })
            .then(async (r): Promise<Pedido> => ({ tipo: 'resposta', status: r.status, corpo: await r.json().catch(() => null) }), (): Pedido => ({ tipo: 'rede' }));
        try {
            return await Promise.race([rede, prazo]);
        }
        finally {
            clearTimeout(temporizador);
        }
    }

    async function lerCsrf(): Promise<{ tipo: 'csrf'; csrf: string } | { tipo: 'encerrada' } | { tipo: 'tempo' } | { tipo: 'falha' }> {
        const r = await pedir({ method: 'GET' });
        if (r.tipo === 'tempo')
            return { tipo: 'tempo' };
        if (r.tipo === 'rede' || r.status !== 200)
            return { tipo: 'falha' };
        const corpo = r.corpo as { ok?: boolean; data?: { usuarioId?: string | null; csrf?: unknown } } | null;
        if (!corpo?.ok)
            return { tipo: 'falha' };
        if (!corpo.data?.usuarioId)
            return { tipo: 'encerrada' };
        return typeof corpo.data.csrf === 'string' && CSRF.test(corpo.data.csrf) ? { tipo: 'csrf', csrf: corpo.data.csrf } : { tipo: 'falha' };
    }

    async function postar(csrf: string): Promise<Postagem> {
        const r = await pedir({ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ acao: 'logout' }) });
        if (r.tipo === 'tempo')
            return 'tempo';
        if (r.tipo === 'rede')
            return 'recusada';
        if (r.status === 200 && (r.corpo as { ok?: boolean } | null)?.ok === true)
            return 'ok';
        if (r.status === 401)
            return 'encerrada';
        if (r.status === 403)
            return 'csrf';
        return 'recusada';
    }

    let resultado: Postagem | null = csrfConhecido ? await postar(csrfConhecido) : null;
    if (resultado === null || resultado === 'csrf') {
        // Sem CSRF lembrado, ou CSRF recusado (rotação): uma única leitura da sessão e, no máximo, mais um POST.
        const leitura = await lerCsrf();
        if (leitura.tipo === 'csrf')
            resultado = await postar(leitura.csrf);
        else if (leitura.tipo === 'encerrada')
            resultado = 'encerrada';
        else if (leitura.tipo === 'tempo')
            resultado = 'tempo';
        else
            resultado = 'recusada';
    }
    const motivo: MotivoSaida = resultado === 'ok' ? 'CONFIRMADA' : resultado === 'encerrada' ? 'SESSAO_JA_ENCERRADA' : resultado === 'tempo' ? 'PRAZO_ESGOTADO' : 'NAO_CONFIRMADA';
    csrfConhecido = null;
    if (motivo === 'PRAZO_ESGOTADO')
        avisar(AVISO_SAIDA_PRAZO);
    else if (motivo === 'NAO_CONFIRMADA')
        avisar(AVISO_SAIDA_NAO_CONFIRMADA);
    navegar('/admin/login');
    return { confirmada: motivo === 'CONFIRMADA', motivo, pedidos };
}
