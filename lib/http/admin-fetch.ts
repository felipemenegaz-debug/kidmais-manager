'use client';
import {
    cancelarRenovacaoDeSessao, concluirRenovacaoDeSessao, contextoMudou, guardarAvisoDeContexto, iniciarRenovacaoDeSessao,
    encerrarTrocaDeEmpresa, iniciarTrocaDeEmpresa, marcaDaSessao, registrarContextoEmpresa, reiniciarContextoEmpresa, saidaDaSessaoEmAndamento,
    sessaoObsoletaDesde,
} from './contexto-empresa-cliente';
import { conversaSoLeu, dependeDaResposta, ehConsulta } from './consultas-admin';
import { loginDestaPagina } from './retorno-login';
import { anotarResultadoPendente, decidirFalhaSessao, enderecoFinal, registrarResultadoMantido, sessaoValida } from '../enderecos/cliente';

type InfoSessao = { ok?: boolean; data?: { usuarioId?: string | null; sessaoId?: string; csrf?: string; contexto?: { empresaAtual?: { id: string } | null } } };

/**
 * Erro das telas administrativas com a causa tipada (lote de importação, plano rev. 2 R2-3). A mensagem é a mesma de
 * antes: quem só lê `message` não muda. `enviado` diz se o pedido chegou a sair para o servidor.
 */
export type TipoErroContexto = 'ENDERECO_EM_VERIFICACAO' | 'SESSAO_NAO_CONFIRMADA' | 'CONTEXTO_MUDOU' | 'SESSAO_ENCERRADA' | 'REDE' | 'RESULTADO_INCERTO' | 'RECUSADA_PELO_CONTEXTO';
export class ErroContextoAdmin extends Error {
    readonly tipo: TipoErroContexto;
    readonly enviado: boolean;
    constructor(tipo: TipoErroContexto, mensagem: string, enviado: boolean) {
        super(mensagem);
        this.tipo = tipo;
        this.enviado = enviado;
    }
}

export const AVISO_RESULTADO_INCERTO = 'Resultado incerto: a operação pode ou não ter sido concluída. Confira antes de repetir — nada é reenviado automaticamente.';

/**
 * Leitura da sessão para confirmar o contexto. Distingue sessão encerrada (resposta válida sem usuário) de FALHA
 * na própria confirmação (rede, HTTP não-2xx ou corpo inválido): na falha o contexto é desconhecido.
 * "Encerrada" de uma leitura que saiu antes de uma troca de empresa desta página é OBSOLETA (sessão anterior, já
 * revogada pela troca): não vale como fim da sessão nova (lib/http/contexto-empresa-cliente.ts, iniciarTrocaDeEmpresa).
 */
type Confirmacao = { estado: 'valida'; info: InfoSessao } | { estado: 'encerrada' } | { estado: 'obsoleta' } | { estado: 'falha'; status?: number };
async function confirmarSessao(): Promise<Confirmacao> {
    const marca = marcaDaSessao();
    try {
        const r = await fetch('/api/admin/autenticacao', { cache: 'no-store' });
        if (!r.ok) return { estado: 'falha', status: r.status };
        const info = await r.json() as InfoSessao;
        if (!info?.ok) return { estado: 'falha' };
        if (info.data?.usuarioId) return { estado: 'valida', info };
        return sessaoObsoletaDesde(marca) ? { estado: 'obsoleta' } : { estado: 'encerrada' };
    }
    catch {
        return { estado: 'falha' };
    }
}

export const AVISO_LEITURA_NAO_CONFIRMADA = 'Não foi possível confirmar a empresa ativa depois da leitura. Os dados recebidos foram descartados por segurança.';
export const AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO = 'A operação foi concluída, mas não foi possível confirmar a empresa ativa em seguida. A tela foi recarregada; confira o resultado.';
export const AVISO_RECUSADA_SEM_CONTEXTO = 'A operação não foi concluída: o servidor recusou. Os dados da tela anterior foram descartados.';
const empresaDe = (info: InfoSessao) => info.data?.contexto?.empresaAtual?.id ?? null;

/** Tipo de falha para a decisão da troca de host; 401 é fim real e nunca consulta (plano D4, H23). */
const tipoDaFalha = (status?: number) => status === 403 ? '403' as const : 'falha' as const;

/** Resultado real quando a tela é mantida: nada diz que ela foi recarregada ou descartada, e a escrita não é repetida (G16). */
export const AVISO_LEITURA_EM_VERIFICACAO = 'Não foi possível confirmar a sessão. Os dados recebidos não foram exibidos.';
export const AVISO_ESCRITA_EM_VERIFICACAO = 'A operação foi concluída, mas não foi possível confirmar a sessão em seguida. Não repita; confira o resultado depois de atualizar a página.';
export const AVISO_RECUSADA_EM_VERIFICACAO = 'A operação não foi concluída: o servidor recusou. Confira antes de tentar de novo.';
/** Escrita já entregue a uma tela: o texto não depende de quando a aba chegou ao estado final. */
export const AVISO_ULTIMA_ESCRITA_CONCLUIDA = 'A última operação enviada foi concluída antes de o endereço mudar. Não repita; confira o resultado depois de atualizar a página.';
/** Escrita entregue, com outra enviada depois: fala só desta, sem dizer que é a última e sem entrar no aviso central. */
export const AVISO_ESCRITA_ANTERIOR_CONCLUIDA = 'Esta operação foi concluída antes de o endereço mudar. Não repita; confira o resultado depois de atualizar a página.';
export const AVISO_ENDERECO_MUDOU = 'Este sistema mudou de endereço. Atualize a página.';

export const AVISO_CONSULTA_EM_VERIFICACAO = 'Este sistema mudou de endereço antes de concluir esta consulta. Atualize a página.';

/** O que o pedido significa para o resultado na tela mantida. Consulta é POST que só lê (lib/http/consultas-admin.ts). */
type Natureza = 'leitura' | 'consulta' | 'escrita';
type Situacao = Pick<Response, 'ok' | 'status'>;
const avisoEmVerificacao = (natureza: Natureza, situacao: Situacao, avisoDeSucesso: string) => natureza === 'leitura' ? AVISO_LEITURA_EM_VERIFICACAO
    : natureza === 'consulta' ? AVISO_CONSULTA_EM_VERIFICACAO
        : situacao.ok ? avisoDeSucesso
            : situacao.status >= 500 ? AVISO_RESULTADO_INCERTO : AVISO_RECUSADA_EM_VERIFICACAO;

/** Tela descartada depois da resposta: vale o mesmo resultado da tela mantida, e o que só leu não fala como operação. */
const avisoDoDescarte = (natureza: Natureza, situacao: Situacao, avisoDeLeitura: string, avisoDeSucesso: string) => natureza !== 'escrita' ? avisoDeLeitura
    : situacao.ok ? avisoDeSucesso
        : situacao.status >= 500 ? AVISO_RESULTADO_INCERTO : AVISO_RECUSADA_SEM_CONTEXTO;

/** Sucesso HTTP sem resultado legível, ou conversa que falhou: o servidor pode ter gravado. O texto é o de resultado incerto. */
const SEM_CERTEZA: Situacao = { ok: false, status: 599 };

/**
 * Resultado de uma escrita, decidido quando a resposta chega, antes de qualquer outra coisa: HTTP de sucesso com corpo
 * `ok:false` é recusa. O mesmo valor vale para a resposta e os clones, venha de quem vier a leitura do corpo.
 * Só JSON é lido aqui: PDF e fluxo contínuo seguem o status.
 */
async function situacaoDaResposta(natureza: Natureza, resposta: Response): Promise<Situacao> {
    const situacao: Situacao = { ok: resposta.ok, status: resposta.status };
    if (natureza !== 'escrita' || !resposta.ok || !/^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i.test(resposta.headers.get('content-type') ?? '')) return situacao;
    try {
        const corpo = await resposta.clone().json() as { ok?: unknown } | null;
        return corpo?.ok === false ? { ok: false, status: situacao.status } : situacao;
    }
    catch {
        return SEM_CERTEZA;
    }
}

/** Resposta já iniciada quando a aba chegou ao estado final: nada é entregue; o resultado da escrita fica registrado. */
function pararSeEnderecoFinal(natureza: Natureza, situacao: Situacao, avisoDeSucesso = AVISO_ESCRITA_EM_VERIFICACAO) {
    if (!enderecoFinal()) return;
    throw erroDeTelaMantida(natureza, situacao, avisoDeSucesso);
}

function erroDeTelaMantida(natureza: Natureza, situacao: Situacao, avisoDeSucesso: string) {
    const aviso = avisoEmVerificacao(natureza, situacao, avisoDeSucesso);
    if (natureza === 'escrita') registrarResultadoNaTela(aviso);
    return new ErroContextoAdmin('ENDERECO_EM_VERIFICACAO', aviso, true);
}

function registrarResultadoNaTela(aviso: string) {
    guardarAvisoDeContexto(aviso, 'escrita');
    registrarResultadoMantido(aviso);
}

/**
 * A resposta entregue segue protegida enquanto quem chamou a usa: se a aba chegar ao estado final, ler o corpo, `status`
 * ou `ok` falha com o resultado real, e a continuação do componente (ir ao login ou a outra tela, por exemplo) não
 * acontece. Fora de migração nada muda, porque a aba nunca chega ao estado final.
 */
function protegerResposta(natureza: Natureza, resposta: Response, situacao: Situacao, avisoDeSucesso = AVISO_ESCRITA_EM_VERIFICACAO, ehDoUltimoEnvio: () => boolean = () => true): Response {
    const original: Situacao = { ok: resposta.ok, status: resposta.status };
    const parar = () => {
        if (!enderecoFinal()) return;
        if (ehDoUltimoEnvio()) throw erroDeTelaMantida(natureza, situacao, avisoDeSucesso);
        // Outra escrita saiu depois desta: o resultado dela é o do aviso central, e este não fala por ela.
        throw new ErroContextoAdmin('ENDERECO_EM_VERIFICACAO', avisoEmVerificacao(natureza, situacao, AVISO_ESCRITA_ANTERIOR_CONCLUIDA), true);
    };
    for (const metodo of ['json', 'text', 'blob', 'arrayBuffer', 'formData'] as const) {
        const ler = (resposta[metodo] as () => Promise<unknown>).bind(resposta);
        Object.defineProperty(resposta, metodo, {
            configurable: true,
            value: async () => {
                try {
                    const valor = await ler();
                    parar();
                    return valor;
                }
                catch (erro) {
                    parar();
                    throw erro;
                }
            },
        });
    }
    for (const campo of ['ok', 'status'] as const) {
        Object.defineProperty(resposta, campo, {
            configurable: true,
            get: () => {
                parar();
                return original[campo];
            },
        });
    }
    const clonar = resposta.clone.bind(resposta);
    Object.defineProperty(resposta, 'clone', { configurable: true, value: () => protegerResposta(natureza, clonar(), situacao, avisoDeSucesso, ehDoUltimoEnvio) });
    return resposta;
}

function anotarResultado(aviso: string) {
    anotarResultadoPendente(() => registrarResultadoNaTela(aviso));
}

/**
 * Vale o resultado da última escrita ENVIADA: a resposta atrasada de um envio anterior não passa por cima dela. Com a aba
 * já no estado final, todo resultado fica registrado, porque nada mais sai. A posição é sempre a do envio, mas a conversa
 * só a ocupa quando a resposta mostra que ela pode ter alterado algo: a que só leu não muda o último lugar.
 */
type Envio = { anotar: (aviso: string) => void; ehUltimo: () => boolean };
let envios = 0;
let ultimoEnvio = 0;
const reservarEnvio = () => ++envios;
function ocuparEnvio(posicao: number): Envio {
    if (posicao > ultimoEnvio) {
        ultimoEnvio = posicao;
        anotarResultadoPendente(null);
    }
    return {
        anotar: (aviso) => { if (enderecoFinal() || posicao === ultimoEnvio) anotarResultado(aviso); },
        ehUltimo: () => posicao === ultimoEnvio,
    };
}
const novoEnvio = () => ocuparEnvio(reservarEnvio());
/** Renovação é confirmada por quem a chamou e fica fora da ordem: só registra com a aba final. */
const ENVIO_DE_RENOVACAO: Envio = {
    anotar: (aviso) => { if (enderecoFinal()) anotarResultado(aviso); },
    ehUltimo: () => true,
};

/** Texto real da tela mantida, para quem troca o erro por uma mensagem própria. */
export function mensagemDoEndereco(erro: unknown) {
    return erro instanceof ErroContextoAdmin && erro.tipo === 'ENDERECO_EM_VERIFICACAO' ? erro.message : null;
}

/** Corpo ilegível vira nulo, como `.catch(() => null)`; o estado final da aba não é confundido com corpo ilegível. */
export async function lerCorpoOuNulo<T>(resposta: Response): Promise<T | null> {
    try {
        return await resposta.json() as T;
    }
    catch (erro) {
        if (mensagemDoEndereco(erro)) throw erro;
        return null;
    }
}

const ENDERECO_MUDOU_NADA_ENVIADO = 'Este sistema mudou de endereço. Nada foi enviado. Atualize a página.';
/** Pedido que ainda não saiu quando a aba chegou ao estado final: nada é enviado e a tela fica como está. */
function pararAntesDoEnvio(escrita: boolean) {
    if (enderecoFinal())
        throw new ErroContextoAdmin('ENDERECO_EM_VERIFICACAO', escrita ? ENDERECO_MUDOU_NADA_ENVIADO : AVISO_ENDERECO_MUDOU, false);
}

/**
 * fetch das telas administrativas: CSRF + sessão da página (x-kidmais-sessao). Nunca repete uma requisição.
 * Se a empresa/sessão mudar no meio do caminho, descarta a página e deixa um aviso com o resultado REAL:
 *   - mudou antes do envio, ou o servidor recusou pelo contexto antigo → nada foi alterado;
 *   - escrita respondida com sucesso, contexto mudou depois → concluída (dados antigos descartados);
 *   - escrita sem resposta (conexão) ou erro 5xx → resultado incerto;
 *   - falha na confirmação da sessão depois da resposta → nada é entregue ao componente: leitura descartada;
 *     escrita confirmada continua "concluída", 5xx continua incerto, recusa continua recusa.
 */
export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}, avisoDeSucesso = AVISO_ESCRITA_EM_VERIFICACAO) {
    const escrita = !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
    let natureza: Natureza = !escrita ? 'leitura' : ehConsulta(input, init) ? 'consulta' : 'escrita';
    const conversa = natureza === 'escrita' && dependeDaResposta(input);
    // Reautenticação e troca de senha renovam a sessão e são confirmadas por quem as chamou.
    const url = String(input);
    const renovacao = url.includes('/api/admin/autenticacao') || url.includes('/api/admin/perfil/senha');
    // Aviso de escrita = resultado real da operação: nenhum descarte posterior desta página o apaga (G16).
    const origem = escrita ? 'escrita' as const : 'descarte' as const;
    pararAntesDoEnvio(escrita);
    const marcaOperacao = marcaDaSessao();
    const aindaValida = () => !sessaoObsoletaDesde(marcaOperacao) && !saidaDaSessaoEmAndamento();
    const previa = await confirmarSessao();
    // O estado final vale antes de qualquer ramo: nada sai, e nada navega nem descarta.
    pararAntesDoEnvio(escrita);
    // Nada navega aqui: só alimenta o estado da aba (403 em aba não armada, ou falha em aba armada).
    if (previa.estado === 'falha' && previa.status !== 401)
        void decidirFalhaSessao({ tipo: tipoDaFalha(previa.status), telaCarregada: true, aindaValida });
    if (previa.estado === 'falha')
        // Nada foi pedido ao servidor e nada é entregue: o componente só recebe o erro.
        throw new ErroContextoAdmin('SESSAO_NAO_CONFIRMADA', escrita ? 'Não foi possível confirmar a sessão antes do envio. Nada foi enviado.' : 'Não foi possível confirmar a sessão. Tente novamente.', false);
    if (previa.estado === 'obsoleta') {
        // A troca de empresa desta página está em curso: nada é enviado com a sessão anterior; a própria troca navega.
        // Escrita impedida: a próxima tela diz que nada foi enviado. Origem 'escrita' quando a prioridade de avisos (#155)
        // existe; sem ela, o segundo argumento é ignorado.
        if (escrita) (guardarAvisoDeContexto as (texto: string, origem?: 'escrita') => void)(AVISO_ESCRITA_NAO_ENVIADA_NA_TROCA, 'escrita');
        throw new ErroContextoAdmin('CONTEXTO_MUDOU', escrita ? AVISO_ESCRITA_NAO_ENVIADA_NA_TROCA : 'A empresa ou a sessão mudou. Atualizando a página.', false);
    }
    const info: InfoSessao = previa.estado === 'valida' ? previa.info : {};
    if (previa.estado === 'encerrada' || !info.data?.usuarioId) {
        // Durante a saída iniciada pela própria tela (components/admin/sair.ts) nada é sobreposto: ela já navega.
        if (!saidaDaSessaoEmAndamento()) {
            if (escrita) guardarAvisoDeContexto('Sua sessão terminou antes do envio. Nada foi enviado.', 'escrita');
            // Limpa a página administrativa em memória quando a sessão expira; helper fora de React.
            window.location.assign(loginDestaPagina());
        }
        throw new ErroContextoAdmin('SESSAO_ENCERRADA', 'Faça login para continuar.', false);
    }
    if (!registrarContextoEmpresa(info.data.sessaoId!, empresaDe(info), escrita ? 'A empresa ativa ou a sessão mudou antes do envio. Nada foi enviado.' : undefined, origem))
        throw new ErroContextoAdmin('CONTEXTO_MUDOU', 'A empresa ou a sessão mudou. Atualizando a página.', false);
    sessaoValida();
    const headers = new Headers(init.headers);
    headers.set('x-kidmais-sessao', info.data.sessaoId!);
    headers.set('x-csrf-token', info.data.csrf ?? '');
    const posicaoDaConversa = conversa ? reservarEnvio() : 0;
    let envio: Envio | null = natureza !== 'escrita' || conversa ? null : renovacao ? ENVIO_DE_RENOVACAO : novoEnvio();
    let resposta: Response;
    try {
        resposta = await fetch(input, { ...init, headers, cache: 'no-store' });
    }
    catch (erro) {
        if (escrita) {
            (conversa ? ocuparEnvio(posicaoDaConversa) : envio)?.anotar(AVISO_RESULTADO_INCERTO);
            throw new ErroContextoAdmin('RESULTADO_INCERTO', AVISO_RESULTADO_INCERTO, true);
        }
        // Leitura: o MESMO erro de antes (nome, pilha, instanceof), só com a causa tipada anexada.
        if (erro instanceof Error) throw Object.assign(erro, { tipo: 'REDE' as const, enviado: true });
        throw new ErroContextoAdmin('REDE', String(erro), true);
    }
    let situacao = await situacaoDaResposta(natureza, resposta);
    if (conversa) {
        if (await conversaSoLeu(resposta)) natureza = 'consulta';
        else {
            envio = ocuparEnvio(posicaoDaConversa);
            // A falha da conversa não prova que nada foi gravado: um rascunho pode ter sido salvo antes dela.
            if (!situacao.ok) situacao = SEM_CERTEZA;
        }
    }
    // Daqui em diante vale o que a resposta mostrou: consulta nunca deixa aviso com prioridade de resultado de escrita.
    const origemDoResultado = natureza === 'escrita' ? 'escrita' as const : 'descarte' as const;
    pararSeEnderecoFinal(natureza, situacao, avisoDeSucesso);
    if (resposta.status === 409) {
        const corpo = await resposta.clone().json().catch(() => null) as { codigo?: string } | null;
        pararSeEnderecoFinal(natureza, situacao, avisoDeSucesso);
        if (corpo?.codigo === 'AUTENTICACAO_ADMINISTRATIVA') {
            // O servidor recusou ANTES de executar: a página usava uma sessão/empresa que já não é a atual.
            reiniciarContextoEmpresa('A empresa ativa ou a sessão mudou antes de a operação ser processada. Nada foi alterado.', undefined, origemDoResultado);
            throw new ErroContextoAdmin('RECUSADA_PELO_CONTEXTO', 'A empresa ou a sessão mudou. Nada foi alterado.', true);
        }
    }
    if (renovacao) return protegerResposta(natureza, resposta, situacao, avisoDeSucesso);
    // Nenhum dado chega ao componente sem confirmar que a empresa/sessão continuam as mesmas.
    const depois = await confirmarSessao();
    // Estado final antes de qualquer ramo, inclusive 401 e sessão encerrada: resultado real, sem navegar nem descartar.
    pararSeEnderecoFinal(natureza, situacao, avisoDeSucesso);
    if (depois.estado === 'falha') {
        if (depois.status !== 401) {
            const decisao = await decidirFalhaSessao({ tipo: tipoDaFalha(depois.status), telaCarregada: true, aindaValida });
            pararSeEnderecoFinal(natureza, situacao, avisoDeSucesso);
            if (decisao !== 'COMO_HOJE') {
                // Tela mantida, leitura não entregue, escrita não repetida: sem reiniciar o contexto.
                envio?.anotar(avisoEmVerificacao(natureza, situacao, AVISO_ULTIMA_ESCRITA_CONCLUIDA));
                throw erroDeTelaMantida(natureza, situacao, avisoDeSucesso);
            }
        }
        // Contexto desconhecido: descarta a tela. Escrita já respondida com sucesso continua "concluída" (não vira
        // incerta só porque a confirmação falhou); 5xx continua incerto; recusa continua recusa.
        const aviso = avisoDoDescarte(natureza, situacao, AVISO_LEITURA_NAO_CONFIRMADA, AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO);
        reiniciarContextoEmpresa(aviso, undefined, origemDoResultado);
        throw new ErroContextoAdmin('SESSAO_NAO_CONFIRMADA', aviso, true);
    }
    const encerrada = depois.estado === 'encerrada';
    // Obsoleta (troca de empresa desta página em curso) = contexto mudou, sem ir ao login: o resultado da escrita é avisado.
    if (encerrada || depois.estado === 'obsoleta' || contextoMudou(depois.info.data!.sessaoId!, empresaDe(depois.info))) {
        const aviso = avisoDoDescarte(natureza, situacao,
            'A empresa ativa ou a sessão mudou. Os dados da tela anterior foram descartados.',
            'A operação foi concluída antes da mudança de empresa ou de sessão. Os dados da tela anterior foram descartados; confira o resultado.');
        reiniciarContextoEmpresa(aviso, encerrada ? loginDestaPagina() : undefined, origemDoResultado);
        throw new ErroContextoAdmin(encerrada ? 'SESSAO_ENCERRADA' : 'CONTEXTO_MUDOU', aviso, true);
    }
    sessaoValida();
    if (natureza !== 'escrita') return protegerResposta(natureza, resposta, situacao, avisoDeSucesso);
    // Escrita entregue: o resultado continua valendo se a aba chegar ao estado final depois, por qualquer caminho.
    envio?.anotar(avisoEmVerificacao(natureza, situacao, AVISO_ULTIMA_ESCRITA_CONCLUIDA));
    return protegerResposta(natureza, resposta, situacao, AVISO_ULTIMA_ESCRITA_CONCLUIDA, envio?.ehUltimo);
}

/** Senha aceita pelo servidor, confirmação indisponível durante a troca de host: o resultado fica, e nada mais sai. */
export const AVISO_RENOVACAO_EM_VERIFICACAO = 'A senha foi aceita, mas não foi possível confirmar a sessão em seguida. Nada mais foi enviado; atualize a página antes de continuar.';

export type ResultadoReautenticacao = { ok: true } | { ok: false; erro: string; senhaIncorreta: boolean };

/**
 * Reautenticação da própria página: confirma a senha, recebe do servidor a renovação (sessão anterior → nova) e só
 * então aceita a sessão nova. Senha incorreta mantém sessão, contexto e formulário intactos.
 */
export async function reautenticarSessao(senha: string): Promise<ResultadoReautenticacao> {
    const confirmada = await confirmarSessao();
    if (enderecoFinal()) return { ok: false, erro: ENDERECO_MUDOU_NADA_ENVIADO, senhaIncorreta: false };
    if (confirmada.estado === 'falha')
        return { ok: false, erro: 'Não foi possível confirmar a sessão. Tente novamente.', senhaIncorreta: false };
    const inicial: InfoSessao = confirmada.estado === 'valida' ? confirmada.info : {};
    if (!inicial.data?.usuarioId)
        return { ok: false, erro: 'Sua sessão terminou. Entre novamente.', senhaIncorreta: false };
    if (!registrarContextoEmpresa(inicial.data.sessaoId!, empresaDe(inicial)))
        return { ok: false, erro: 'A empresa ou a sessão mudou. Atualizando a página.', senhaIncorreta: false };
    sessaoValida();
    iniciarRenovacaoDeSessao();
    let res: Response;
    try {
        res = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'reautenticar', senha }) }, AVISO_RENOVACAO_EM_VERIFICACAO);
    }
    catch (erro) {
        cancelarRenovacaoDeSessao();
        return { ok: false, erro: erro instanceof Error ? erro.message : 'Falha de conexão. Tente novamente.', senhaIncorreta: false };
    }
    let corpo: { ok?: boolean; erro?: string; data?: { renovacao?: { anterior: string; atual: string } | null } } | null;
    let situacao: Situacao;
    try {
        corpo = await lerCorpoOuNulo(res);
        situacao = { ok: res.ok, status: res.status };
    }
    catch (erro) {
        cancelarRenovacaoDeSessao();
        return { ok: false, erro: (erro as Error).message, senhaIncorreta: false };
    }
    if (!situacao.ok || !corpo?.ok) {
        cancelarRenovacaoDeSessao();
        return { ok: false, erro: situacao.status === 401 ? 'Senha incorreta.' : (corpo?.erro ?? `Não foi possível confirmar a senha (HTTP ${situacao.status}).`), senhaIncorreta: situacao.status === 401 };
    }
    return confirmarRenovacao(corpo.data?.renovacao);
}

/** Conclui uma renovação devolvida pelo servidor (reautenticação ou troca de senha). */
export async function confirmarRenovacao(renovacao: { anterior: string; atual: string } | null | undefined): Promise<ResultadoReautenticacao> {
    const marca = marcaDaSessao();
    const aindaValida = () => !sessaoObsoletaDesde(marca) && !saidaDaSessaoEmAndamento();
    const confirmada = await confirmarSessao();
    // Confirmação indisponível não prova divergência: a decisão da troca de host vem antes do descarte, sem repetir o POST.
    // A renovação pendente é cancelada: se a sessão voltar diferente, ela cai na regra normal de contexto mudou.
    let manter = enderecoFinal();
    if (!manter && confirmada.estado === 'falha' && confirmada.status !== 401) {
        const decisao = await decidirFalhaSessao({ tipo: tipoDaFalha(confirmada.status), telaCarregada: true, aindaValida });
        manter = enderecoFinal() || decisao !== 'COMO_HOJE';
    }
    if (manter) {
        cancelarRenovacaoDeSessao();
        registrarResultadoNaTela(AVISO_RENOVACAO_EM_VERIFICACAO);
        return { ok: false, erro: AVISO_RENOVACAO_EM_VERIFICACAO, senhaIncorreta: false };
    }
    const depois = confirmada.estado === 'valida' ? confirmada.info : null;
    if (!concluirRenovacaoDeSessao(renovacao, depois?.data?.sessaoId ?? null, depois ? empresaDe(depois) : null))
        return { ok: false, erro: 'A sessão mudou de forma inesperada. Atualizando a página.', senhaIncorreta: false };
    sessaoValida();
    return { ok: true };
}

export { iniciarRenovacaoDeSessao, cancelarRenovacaoDeSessao };

const ENDERECO_MUDOU_NADA_ALTERADO = 'Este sistema mudou de endereço. Nada foi alterado. Atualize a página.';

/** Mensagem da escrita impedida antes do envio porque a troca de empresa desta página está em curso. */
export const AVISO_ESCRITA_NAO_ENVIADA_NA_TROCA = 'A empresa ativa mudou antes do envio. Nada foi enviado nem salvo; confira e refaça, se ainda for preciso.';

/**
 * Troca da empresa ativa desta página (AdminShell). A proteção contra respostas da sessão anterior tem início e fim
 * definidos: começa DEPOIS de confirmar a sessão atual (uma sessão já inválida antes da troca segue a regra normal e
 * vai ao login) e termina quando a resposta do POST chega (com sucesso ou não). Leituras que saíram antes ou durante
 * esse intervalo continuam marcadas (marcaDaSessao); as que saem depois seguem a regra normal, mesmo que a navegação
 * de descarte seja cancelada (aviso de alterações não salvas). Nada é repetido.
 */
export async function trocarEmpresaAtiva(empresaId: string): Promise<Response> {
    if (enderecoFinal()) throw Error(ENDERECO_MUDOU_NADA_ALTERADO);
    const previa = await confirmarSessao();
    if (enderecoFinal()) throw Error(ENDERECO_MUDOU_NADA_ALTERADO);
    if (previa.estado === 'falha' || previa.estado === 'obsoleta')
        throw Error('Não foi possível confirmar a sessão. Nada foi alterado; tente novamente.');
    if (previa.estado === 'encerrada' || !previa.info.data?.usuarioId) {
        if (!saidaDaSessaoEmAndamento()) {
            window.location.assign(loginDestaPagina());
        }
        throw Error('Faça login para continuar.');
    }
    const info = previa.info;
    if (!registrarContextoEmpresa(info.data!.sessaoId!, empresaDe(info)))
        throw Error('A empresa ou a sessão mudou. Atualizando a página.');
    sessaoValida();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set('x-kidmais-sessao', info.data!.sessaoId!);
    headers.set('x-csrf-token', info.data!.csrf ?? '');
    // Sair já começou (durante a confirmação prévia): nenhuma sessão nova é criada. Daqui até o envio não há espera.
    if (saidaDaSessaoEmAndamento())
        throw Error('Saindo da sessão. Nada foi alterado.');
    iniciarTrocaDeEmpresa();
    const envio = novoEnvio();
    let resposta: Response;
    try {
        resposta = await fetch('/api/admin/autenticacao', { method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ acao: 'selecionar-empresa', empresaId }) });
    }
    catch {
        envio.anotar(AVISO_RESULTADO_INCERTO);
        throw Error('Não foi possível confirmar a troca de empresa. Atualize a página antes de continuar.');
    }
    finally {
        // A resposta chegou (cookies novos, se houver, já aplicados) ou não vai chegar: a janela da troca termina aqui.
        encerrarTrocaDeEmpresa();
    }
    // Estado final com a resposta na mão: resultado real, e nem o login nem o descarte (nem o de quem chamou) acontecem.
    const situacao = await situacaoDaResposta('escrita', resposta);
    pararSeEnderecoFinal('escrita', situacao);
    if (resposta.status === 401) {
        // A sessão já não valia: fim real da sessão, não resposta antiga.
        if (!saidaDaSessaoEmAndamento()) {
            window.location.assign(loginDestaPagina());
        }
        throw Error('Faça login para continuar.');
    }
    if (resposta.status === 409) {
        const corpo = await resposta.clone().json().catch(() => null) as { codigo?: string } | null;
        pararSeEnderecoFinal('escrita', situacao);
        if (corpo?.codigo === 'AUTENTICACAO_ADMINISTRATIVA') {
            reiniciarContextoEmpresa('A empresa ativa ou a sessão mudou antes de a operação ser processada. Nada foi alterado.');
            throw Error('A empresa ou a sessão mudou. Nada foi alterado.');
        }
    }
    envio.anotar(avisoEmVerificacao('escrita', situacao, AVISO_ULTIMA_ESCRITA_CONCLUIDA));
    return protegerResposta('escrita', resposta, situacao, AVISO_ULTIMA_ESCRITA_CONCLUIDA, envio.ehUltimo);
}

