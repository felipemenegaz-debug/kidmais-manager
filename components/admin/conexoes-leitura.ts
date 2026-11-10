/**
 * Uma leitura da lista por vez nesta tela. Pedido explícito (abrir, Atualizar situação, depois de desconectar) durante uma
 * leitura em curso vira UMA nova leitura ao final, para a tela não mostrar um resultado anterior ao pedido. Voltar à janela
 * é só conveniência: ignorado com leitura em curso ou iniciada há pouco, para trocar de aba não multiplicar pedidos.
 */
export const INTERVALO_FOCO_MS = 15_000;

export type CoordenadorDeLeitura = { pedir: () => void; aoFocar: () => void; encerrar: () => void };

export function criarCoordenadorDeLeitura(ler: () => Promise<void>, agora: () => number = Date.now, intervaloFocoMs = INTERVALO_FOCO_MS): CoordenadorDeLeitura {
    let emCurso = false;
    let pendente = false;
    let encerrado = false;
    let ultimoInicio = Number.NEGATIVE_INFINITY;
    const iniciar = () => {
        emCurso = true;
        ultimoInicio = agora();
        void ler().catch(() => undefined).finally(() => {
            emCurso = false;
            if (pendente && !encerrado) {
                pendente = false;
                iniciar();
            }
        });
    };
    return {
        pedir: () => {
            if (encerrado) return;
            if (emCurso) pendente = true;
            else iniciar();
        },
        aoFocar: () => {
            if (encerrado || emCurso || agora() - ultimoInicio < intervaloFocoMs) return;
            iniciar();
        },
        encerrar: () => {
            encerrado = true;
            pendente = false;
        },
    };
}

/**
 * Prazo da leitura completa, do lado da tela: confirmações de sessão, GET e corpo da resposta. Os prazos do banco não cobrem
 * esse percurso. Maior que o prazo do diagnóstico no servidor, para não cancelar uma resposta que ainda ia chegar.
 */
export const PRAZO_LEITURA_MS = 15_000;
/** Depois desta espera, a tela diz que o resultado não foi confirmado e solta os demais botões. O pedido não é cancelado nem repetido. */
export const ESPERA_REVOGACAO_MS = 15_000;
export const AVISO_REVOGACAO_SEM_CONFIRMACAO = 'Ainda não houve confirmação do pedido para desconectar. Ele não foi repetido e ainda pode ser concluído. Confira em Suas conexões se a conexão continua ativa antes de tentar de novo.';
export const AVISO_REVOGACOES_SEM_CONFIRMACAO = 'Ainda não houve confirmação de alguns pedidos para desconectar. Eles não foram repetidos e ainda podem ser concluídos. Confira em Suas conexões, nas marcadas como Aguardando confirmação.';
const URL_CONEXOES = '/api/admin/mcp/conexoes';
export const AVISO_PRAZO_SEM_DADOS = 'A situação das conexões demorou demais para responder. Tente de novo em instantes.';
export const AVISO_PRAZO_COM_DADOS = 'A situação das conexões demorou demais para responder. Abaixo está a última leitura recebida; use Atualizar situação para tentar de novo.';

/** Erro de leitura e resultado de Desconectar são coisas diferentes: leitura bem-sucedida limpa só o próprio erro. */
export type VistaConexoes<E> = { estado: E | null; erroLeitura: string; erroRevogacao: string; ocupado: string | null; emEspera: readonly string[]; atualizando: boolean };
export const vistaInicial = <E,>(): VistaConexoes<E> => ({ estado: null, erroLeitura: '', erroRevogacao: '', ocupado: null, emEspera: [], atualizando: false });
/** O aviso de espera vem de emEspera: pedidos concorrentes não apagam o aviso uns dos outros, e ele coexiste com erros. */
const avisoDaEspera = (quantos: number) => quantos === 0 ? '' : quantos === 1 ? AVISO_REVOGACAO_SEM_CONFIRMACAO : AVISO_REVOGACOES_SEM_CONFIRMACAO;
export const avisosDaVista = (v: { erroLeitura: string; erroRevogacao: string; emEspera: readonly string[] }) => [avisoDaEspera(v.emEspera.length), v.erroRevogacao, v.erroLeitura].filter(Boolean).join(' ');

export type ControladorDeConexoes = { iniciar: () => void; atualizar: () => void; aoFocar: () => void; revogar: (id: string) => Promise<void>; encerrar: () => void };

/** Corpo ilegível vira nulo. Na tela, `lerCorpoOuNulo` do adminFetch: o estado final do endereço (F2a) não vira corpo ilegível. */
const lerCorpoPadrao = async <T,>(r: Response): Promise<T | null> => await r.json().catch(() => null) as T | null;

export function criarControladorDeConexoes<E>({ buscar, publicar, prazoMs = PRAZO_LEITURA_MS, esperaRevogacaoMs = ESPERA_REVOGACAO_MS, agora, intervaloFocoMs, lerCorpo = lerCorpoPadrao, mensagemDoEndereco = () => null }: {
    buscar: (url: string, init?: RequestInit) => Promise<Response>;
    lerCorpo?: <T>(r: Response) => Promise<T | null>;
    /** Texto real da troca de host (F2a), quando o erro for dela: vale no lugar do aviso genérico. */
    mensagemDoEndereco?: (erro: unknown) => string | null;
    publicar: (vista: VistaConexoes<E>) => void;
    prazoMs?: number;
    esperaRevogacaoMs?: number;
    agora?: () => number;
    intervaloFocoMs?: number;
}): ControladorDeConexoes {
    let vista = vistaInicial<E>();
    let encerrado = false;
    let leituraAtual: AbortController | null = null;
    const alterar = (parte: Partial<VistaConexoes<E>>) => {
        vista = { ...vista, ...parte };
        if (!encerrado) publicar(vista);
    };
    const coordenador = criarCoordenadorDeLeitura(async () => {
        const controle = new AbortController();
        leituraAtual = controle;
        const prazo = setTimeout(() => controle.abort(), prazoMs);
        // A fila avança no prazo mesmo que quem busca não respeite o sinal; a resposta atrasada não grava nada.
        const interrompida = new Promise<never>((_, recusar) => controle.signal.addEventListener('abort', () => recusar(controle.signal.reason), { once: true }));
        const pedido = (async () => {
            const res = await buscar(URL_CONEXOES, { cache: 'no-store', signal: controle.signal });
            const corpo = await lerCorpo<{ ok?: boolean; erro?: string; data?: E }>(res);
            return { ok: res.ok, corpo };
        })();
        try {
            const { ok, corpo } = await Promise.race([pedido, interrompida]);
            if (!ok || !corpo?.ok || !corpo.data) alterar({ erroLeitura: corpo?.erro ?? 'Não foi possível carregar as conexões.' });
            else alterar({ erroLeitura: '', estado: corpo.data });
        } catch (falha) {
            const doEndereco = mensagemDoEndereco(falha);
            if (doEndereco) alterar({ erroLeitura: doEndereco });
            else if (controle.signal.aborted) alterar({ erroLeitura: vista.estado ? AVISO_PRAZO_COM_DADOS : AVISO_PRAZO_SEM_DADOS });
            else alterar({ erroLeitura: 'Falha de conexão ao carregar as conexões.' });
        } finally {
            clearTimeout(prazo);
            if (leituraAtual === controle) leituraAtual = null;
            alterar({ atualizando: false });
        }
    }, agora, intervaloFocoMs);
    return {
        iniciar: () => coordenador.pedir(),
        atualizar: () => { alterar({ atualizando: true }); coordenador.pedir(); },
        aoFocar: () => coordenador.aoFocar(),
        // Escrita não recebe prazo nem cancelamento: cancelar não desfaz o que o servidor já pode ter feito.
        revogar: async (id) => {
            if (vista.ocupado !== null || vista.emEspera.includes(id)) return;
            alterar({ ocupado: id, erroRevogacao: '' });
            let semConfirmacao = false;
            const espera = setTimeout(() => {
                semConfirmacao = true;
                alterar({ ocupado: null, emEspera: [...vista.emEspera, id] });
                coordenador.pedir();
            }, esperaRevogacaoMs);
            try {
                const res = await buscar(URL_CONEXOES, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ concessaoId: id }) });
                const corpo = await lerCorpo<{ ok?: boolean; erro?: string }>(res);
                if (!res.ok || !corpo?.ok) alterar({ erroRevogacao: corpo?.erro ?? 'Não foi possível desconectar. Atualize a página e confira.' });
            } catch (falha) {
                alterar({ erroRevogacao: mensagemDoEndereco(falha) ?? 'Resultado incerto: confira a lista antes de tentar de novo.' });
            } finally {
                clearTimeout(espera);
                if (semConfirmacao) alterar({ emEspera: vista.emEspera.filter((x) => x !== id) });
                else alterar({ ocupado: null });
                coordenador.pedir();
            }
        },
        encerrar: () => {
            encerrado = true;
            coordenador.encerrar();
            leituraAtual?.abort();
        },
    };
}
