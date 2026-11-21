'use client';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import { VoltarConfiguracoes } from './VoltarConfiguracoes';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ROTA_AJUDA } from '@/lib/suporte/rota';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';
import whatsapp from './WhatsappConfiguracao.module.css';

type MetaInicio = { appId: string; graphApiVersion: string; configurationId: string; eventName: string; launchOptions: Record<string, unknown>; messageOrigins: string[] };
type Inicio = { tentativaId: string; state: string; expiraEm: string; meta: MetaInicio };
type DadosSessao = { wabaId: string; businessId?: string; phoneNumberId?: string };
type Estado = { estado: string; metaConfigurada: boolean; ambiente?: string | null; empresa?: string | null; conexao: null | { id: string; numeroExibicao: string; nomeVerificado: string; businessId: string; wabaId: string; phoneNumberId: string; tokenExpiraEm?: string | null }; tentativa: null | { id: string; status: string; expira_em: string }; demoAtivosTeste?: boolean };
type DemoAtivos = { portfolio: { id: string; possuiWabaTeste: boolean }; waba: { id: string }; numeros: { id: string; display_phone_number: string | null; verified_name: string | null; is_on_biz_app: boolean | null }[]; numeroTestePresente: boolean; requisitoKidmaisIsOnBizApp: 'atendido' | 'nao_atendido' | 'nao_informado'; aviso: string };
const rotulosRequisito: Record<DemoAtivos['requisitoKidmaisIsOnBizApp'], string> = { atendido: 'atendido', nao_atendido: 'não atendido', nao_informado: 'não informado pela Meta' };
type FbResponse = { authResponse?: { code?: string }; status?: string };
type FacebookSdk = { init(input: { appId: string; version: string; cookie: boolean; xfbml: boolean }): void; login(callback: (response: FbResponse) => void, options: Record<string, unknown>): void };

declare global { interface Window { FB?: FacebookSdk; fbAsyncInit?: () => void } }
const rotulos: Record<string, string> = {
  NAO_CONFIGURADA: 'Não conectado', AGUARDANDO_META: 'Aguardando conclusão na Meta', VALIDANDO: 'Validando configuração',
  CONFIGURADA_SEM_WEBHOOK_OTP: 'Conectado', TENTATIVA_EXPIRADA: 'Tentativa expirada', ACAO_NECESSARIA: 'Ação necessária',
};

function idsDaMensagem(value: unknown): DadosSessao | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const businessId = data.business_id ?? data.businessId;
  const wabaId = data.waba_id ?? data.wabaId;
  const phoneNumberId = data.phone_number_id ?? data.phoneNumberId;
  // waba_id é obrigatório; negócio e número podem faltar (fluxo do WhatsApp Business App) e o servidor os resolve e comprova.
  const numerico = (item: unknown) => typeof item === 'string' && /^[0-9]+$/.test(item);
  const opcional = (item: unknown) => item === undefined || item === null || numerico(item);
  if (!numerico(wabaId) || !opcional(businessId) || !opcional(phoneNumberId)) return null;
  return { wabaId: String(wabaId), ...(numerico(businessId) ? { businessId: String(businessId) } : {}), ...(numerico(phoneNumberId) ? { phoneNumberId: String(phoneNumberId) } : {}) };
}

const FALHA_CARGA = 'Não foi possível carregar a configuração do WhatsApp.';
/** Conectar um número novo ou renovar a credencial do número já conectado (mesmo fluxo da Meta, rotas próprias). */
type Modo = 'conectar' | 'renovar';
const rotaDo = (modo: Modo, etapa: 'iniciar' | 'concluir') => modo === 'renovar' ? `/api/admin/configuracoes/whatsapp/renovacao/${etapa}` : `/api/admin/configuracoes/whatsapp/onboarding/${etapa}`;
const AVISO_VENCIMENTO_MS = 15 * 24 * 60 * 60 * 1000;
/** Prazo da tela para a conclusão (o servidor faz até 6 chamadas à Meta, cada uma com prazo próprio de 10 s). */
export const PRAZO_CONCLUIR_MS = 90_000;
const CONCLUSAO_INCERTA = 'A Meta demorou a responder e o resultado não foi confirmado. Confira acima se a autorização mudou antes de tentar de novo.';
/** Prazo da consulta do estado que confere o resultado de uma conclusão sem resposta. */
export const PRAZO_CONSULTA_MS = 15_000;
const AINDA_PENDENTE = 'A tentativa ainda está em andamento. Use Conferir de novo em alguns instantes; se ela não terminar, expira sozinha e a tela é liberada.';
const ATUALIZACAO_FALHOU = 'A tela não foi atualizada: recarregue a página para ver os dados novos.';
const ROTA_CONFERIR = '/api/admin/configuracoes/whatsapp/tentativa/conferir';
const CONSULTA_FALHOU = 'Não foi possível conferir o resultado. Os dados desta tela podem estar desatualizados: use Conferir de novo antes de tentar outra vez.';
const NAO_CONCLUIDA = 'A autorização não foi concluída e nada mudou. Você pode tentar de novo.';
const CONECTADO = 'WhatsApp conectado. O envio e o recebimento de mensagens pelo iA.Fest serão ativados numa próxima etapa.';
/** Recusa legível do servidor na conclusão (mensagem e código), conferida pelo id antes de liberar. */
type Recusa = { erro: string; codigo: string | null };
type Conferencia = { tentativaId: string; renovando: boolean; recusa?: Recusa };
export const PRAZO_PREPARAR_MS = 30_000;
export const PRAZO_DESCONECTAR_MS = 30_000;
/** Prazo da carga do SDK da Meta (script externo). */
export const PRAZO_SDK_MS = 20_000;
const SDK_FALHOU = 'A preparação foi feita, mas a janela da Meta não carregou. Clique em Continuar na Meta para tentar carregar de novo.';
const SENHA_VENCEU = 'A confirmação de senha vale 5 minutos e venceu antes de concluir. Nada mudou. Confirme sua senha e prepare de novo: a preparação nova substitui a anterior.';
const NOVA_PREPARACAO = ' Nada mudou. Prepare de novo para tentar outra vez.';
/**
 * Prazo sobre a operação inteira (pedido, leitura do corpo e o que mais a chamada esperar, como a confirmação de sessão
 * do adminFetch depois da resposta, que não aceita cancelamento). Vencido o prazo, o sinal é abortado e a espera da tela
 * termina; o trabalho pode seguir em segundo plano, mas a entrega tardia é descartada.
 */
export function comPrazo<T>(executar: (signal: AbortSignal) => Promise<T>, ms: number, motivo: string): Promise<T> {
  const prazo = new AbortController();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rejeitar) => { relogio = setTimeout(() => { const erro = new Error(motivo); prazo.abort(erro); rejeitar(erro); }, ms); });
  let trabalho: Promise<T>;
  try { trabalho = executar(prazo.signal); } catch (erro) { trabalho = Promise.reject(erro); }
  trabalho.catch(() => undefined); // entrega tardia (sucesso ou erro) descartada sem rejeição solta
  return Promise.race([trabalho, limite]).finally(() => clearTimeout(relogio));
}

function lerEstado(): Promise<Estado> {
  return comPrazo(async (signal) => {
    const r = await adminFetch('/api/admin/configuracoes/whatsapp', { signal });
    const j = await r.json();
    if (!j.ok) throw new Error(j.erro || FALHA_CARGA);
    return j.data;
  }, PRAZO_CONSULTA_MS, FALHA_CARGA);
}
/** Janela de onde veio a mensagem: a própria, ou a janela de topo de um quadro dela (propriedade legível entre origens). */
function topoDa(fonte: MessageEventSource | null): unknown {
  try { return fonte && typeof fonte === 'object' && 'top' in fonte ? (fonte as Window).top : null; } catch { return null; }
}
/** Validade da credencial em texto simples; perto do vencimento (15 dias) ou vencida, pede a renovação. Sem data gravada a validade é DESCONHECIDA (a troca pode omitir expires_in), nunca "permanente". */
export function textoValidade(tokenExpiraEm: string | null | undefined, agora = Date.now()) {
  if (!tokenExpiraEm) return { texto: 'Data de vencimento da autorização da Meta não informada.', alerta: false };
  const vence = Date.parse(tokenExpiraEm);
  if (!Number.isFinite(vence)) return { texto: 'Não foi possível ler a validade da autorização da Meta.', alerta: true };
  const data = new Date(vence).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  if (vence <= agora) return { texto: `A autorização da Meta venceu em ${data}. O iA.Fest não consegue enviar mensagens por este número até você renovar a autorização.`, alerta: true };
  return { texto: `A autorização da Meta vale até ${data}.`, alerta: vence - agora <= AVISO_VENCIMENTO_MS };
}

export default function WhatsappConfiguracao() {
  const [data, setData] = useState<Estado | null>(null), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  const [senha, setSenha] = useState(''), [ocupado, setOcupado] = useState(false);
  const [preparado, setPreparado] = useState(false), [falhaCarga, setFalhaCarga] = useState(false);
  const inicio = useRef<Inicio | null>(null), codigo = useRef<string | null>(null), sessaoMeta = useRef<DadosSessao | null>(null), concluindo = useRef(false);
  const listenerMeta = useRef<((event: MessageEvent) => void) | null>(null);
  // Prazo da espera pelo retorno da Meta: vence junto com a tentativa (expiraEm) e libera a tela.
  const prazoMeta = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modo = useRef<Modo>('conectar');
  // Desconectar (083): motivo + senha reconfirmada; o servidor exige a Gestão da empresa.
  const [motivoDesconexao, setMotivoDesconexao] = useState(''), [senhaDesconexao, setSenhaDesconexao] = useState('');
  // Verificação de ativos de teste (análise do app Meta): só leitura, visível apenas quando o servidor libera.
  const [demo, setDemo] = useState<DemoAtivos | null>(null), [verificandoDemo, setVerificandoDemo] = useState(false);
  // Renovar a credencial (20/11/2026): senha reconfirmada; o número, a conta e o status continuam os mesmos.
  const [senhaRenovacao, setSenhaRenovacao] = useState(''), [preparadoRenovacao, setPreparadoRenovacao] = useState(false);
  // Conclusão sem resultado confirmado: novas tentativas ficam bloqueadas até uma consulta confirmar o estado.
  const [conferencia, setConferencia] = useState<Conferencia | null>(null);
  // Janela da Meta aberta pela tentativa atual: só mensagens dela valem, e ela é fechada quando a escuta acaba.
  const janelaMeta = useRef<Window | null>(null);
  // Abertura atual da Meta (cada clique em Continuar na Meta): listener, retorno do FB.login e prazo só valem para ela.
  const aberturaMeta = useRef<object | null>(null);
  // Desmontada: retornos atrasados (Meta, conclusão, conferência, SDK) não mexem na tela nem disparam pedidos.
  const desmontado = useRef(false);
  const preparacao = useRef<object | null>(null);
  const sdkInicializado = useRef<FacebookSdk | null>(null);
  const bloqueado = ocupado || verificandoDemo;
  /** Para de escutar a Meta: remove o listener e o prazo da espera e fecha a janela da tentativa. A tentativa continua (a conclusão usa). */
  const pararEscuta = useCallback(() => {
    if (listenerMeta.current) window.removeEventListener('message', listenerMeta.current);
    listenerMeta.current = null;
    if (prazoMeta.current) clearTimeout(prazoMeta.current);
    prazoMeta.current = null;
    // Janela fechada não manda mensagem atrasada para a tentativa seguinte.
    try { if (janelaMeta.current && !janelaMeta.current.closed) janelaMeta.current.close(); } catch { /* janela de outra origem já fechada */ }
    janelaMeta.current = null;
    aberturaMeta.current = null;
  }, []);
  useEffect(() => {
    desmontado.current = false;
    // Saiu da tela: a abertura deixa de valer (listener, retorno do FB.login e prazo), a janela fecha e a preparação some.
    return () => { desmontado.current = true; preparacao.current = null; pararEscuta(); codigo.current = null; sessaoMeta.current = null; inicio.current = null; };
  }, [pararEscuta]);
  const descartarPreparacao = useCallback(() => {
    pararEscuta();
    codigo.current = null; sessaoMeta.current = null; inicio.current = null;
    setPreparado(false); setPreparadoRenovacao(false);
  }, [pararEscuta]);
  const aplicarEstado = useCallback((estado: Estado) => {
    setData(estado);
    if (estado.tentativa?.status === 'VALIDANDO') {
      descartarPreparacao();
      setConferencia({ tentativaId: estado.tentativa.id, renovando: Boolean(estado.conexao) });
      setErro(AINDA_PENDENTE);
    }
  }, [descartarPreparacao]);
  const carregarInicial = useCallback((ativo: () => boolean) => {
    return lerEstado().then((estado) => {
      if (ativo()) aplicarEstado(estado);
    }).catch((e: unknown) => {
      if (!ativo()) return;
      setErro(e instanceof Error && !(e instanceof SyntaxError) && e.message ? e.message : FALHA_CARGA);
      setFalhaCarga(true);
    });
  }, [aplicarEstado]);
  useEffect(() => {
    let ativo = true;
    void carregarInicial(() => ativo);
    return () => { ativo = false; };
  }, [carregarInicial]);

  function repetirCarga() {
    setFalhaCarga(false); setErro('');
    return carregarInicial(() => !desmontado.current);
  }

  /** Encerra a espera pela Meta (sucesso, erro ou prazo): para a escuta, descarta a tentativa e libera os controles. */
  const encerrarEspera = useCallback((mensagemErro?: string) => {
    descartarPreparacao();
    if (mensagemErro !== undefined) { setAviso(''); setErro(mensagemErro); }
    setOcupado(false);
  }, [descartarPreparacao]);
  /**
   * A espera acabou sem resultado (pop-up bloqueado, Meta sem código, formato inesperado, erro do SDK), mas a tentativa
   * segue válida no servidor: mantém a preparação para repetir Continuar na Meta, em vez de mandar preparar de novo (o
   * servidor recusaria com 409 até a tentativa vencer). Só o vencimento descarta a preparação.
   */
  const voltarParaContinuar = useCallback((mensagemErro: string) => {
    pararEscuta();
    codigo.current = null; sessaoMeta.current = null;
    if (inicio.current) { if (modo.current === 'renovar') setPreparadoRenovacao(true); else setPreparado(true); }
    setAviso(''); setErro(mensagemErro); setOcupado(false);
  }, [pararEscuta]);
  /** Atualiza a tela com prazo próprio. Falha não desfaz o que já foi confirmado: quem chama só acrescenta o aviso. */
  const atualizar = useCallback(async () => {
    try {
      const estado = await lerEstado();
      if (desmontado.current) return null;
      aplicarEstado(estado);
      return estado;
    } catch { return null; }
  }, [aplicarEstado]);

  async function consultarAntesDeReautenticar() {
    const estado = await atualizar();
    if (desmontado.current) return null;
    if (!estado) throw new Error('Não foi possível confirmar o estado atual do WhatsApp. Tente de novo.');
    return estado.tentativa?.status === 'VALIDANDO' ? null : estado;
  }

  /**
   * Confere o resultado de uma conclusão sem resposta legível pela rota de conferência, com prazo próprio. O servidor
   * fecha a tentativa vencida que ficou em andamento (lock da empresa) e devolve o status pelo id. INICIADA ou VALIDANDO
   * (o pedido pode estar na fila) e falha da consulta mantêm novas tentativas bloqueadas com Conferir de novo; CONCLUIDA
   * confirma; FALHOU ou EXPIRADA dizem que nada mudou; tentativa ausente ou de outro id libera com resultado incerto.
   * Com recusa legível (ok:false) o pedido já terminou: INICIADA prova que a tentativa não foi consumida (libera e pede
   * nova preparação, que substitui a anterior no servidor; senha vencida tem mensagem própria) e VALIDANDO (500 depois de
   * falhar a gravação de FALHOU) segue pendente até o servidor fechar a vencida.
   */
  const conferirResultado = useCallback(async (alvo: Conferencia) => {
    const { recusa } = alvo;
    setConferencia(null); setOcupado(true); setErro(''); setAviso('Conferindo o resultado…');
    let resposta: { tentativa: { id: string; status: string } | null } | null = null;
    try {
      resposta = await comPrazo(async (signal) => {
        const r = await adminFetch(ROTA_CONFERIR, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ tentativaId: alvo.tentativaId }) });
        const j = await r.json();
        return j && j.ok === true && j.data && typeof j.data === 'object' && 'tentativa' in j.data ? j.data : null;
      }, PRAZO_CONSULTA_MS, 'PRAZO_CONSULTA');
    } catch { resposta = null; }
    if (desmontado.current) return;
    setAviso('');
    const prefixo = recusa ? recusa.erro + ' ' : '';
    const tentativa = resposta?.tentativa && resposta.tentativa.id === alvo.tentativaId ? resposta.tentativa : null;
    const emAndamento = Boolean(tentativa && (tentativa.status === 'VALIDANDO' || (tentativa.status === 'INICIADA' && !recusa)));
    if (!resposta || emAndamento) {
      setConferencia(alvo); setErro(prefixo + (resposta ? AINDA_PENDENTE : CONSULTA_FALHOU)); setOcupado(false); return;
    }
    if (recusa && (!tentativa || tentativa.status === 'INICIADA')) {
      setErro(recusa.codigo === 'WHATSAPP_REAUTENTICACAO_NECESSARIA' ? SENHA_VENCEU : recusa.erro + NOVA_PREPARACAO); setOcupado(false); return;
    }
    const atualizado = await atualizar();
    if (desmontado.current) return;
    if (atualizado?.tentativa?.status === 'VALIDANDO') { setOcupado(false); return; }
    const nota = atualizado ? '' : ' ' + ATUALIZACAO_FALHOU;
    if (tentativa?.status === 'CONCLUIDA') { setAviso(alvo.renovando ? 'Autorização renovada.' : CONECTADO); if (nota) setErro(nota.trim()); }
    else if (tentativa && ['FALHOU', 'EXPIRADA'].includes(tentativa.status)) setErro(prefixo + NAO_CONCLUIDA + nota);
    else setErro(CONCLUSAO_INCERTA + nota);
    setOcupado(false);
  }, [atualizar]);

  const concluir = useCallback(async () => {
    if (!inicio.current || !codigo.current || !sessaoMeta.current || concluindo.current || desmontado.current) return;
    concluindo.current = true; pararEscuta(); setOcupado(true); setAviso('Validando configuração com a Meta…');
    const alvo: Conferencia = { tentativaId: inicio.current.tentativaId, renovando: modo.current === 'renovar' };
    const rota = rotaDo(modo.current, 'concluir');
    const corpo = JSON.stringify({ tentativaId: inicio.current.tentativaId, state: inicio.current.state, authorizationCode: codigo.current, ...sessaoMeta.current });
    let j: { ok?: unknown; erro?: unknown; codigo?: unknown } | null = null;
    try {
      j = await comPrazo(async (signal) => (await adminFetch(rota, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: corpo })).json(), PRAZO_CONCLUIR_MS, 'PRAZO_CONCLUIR');
    } catch { j = null; }
    concluindo.current = false;
    if (desmontado.current) return;
    // A tentativa não é reaproveitada: sucesso, recusa ou dúvida encerram esta preparação.
    encerrarEspera();
    if (j && typeof j === 'object' && j.ok === true) {
      setOcupado(true);
      const atualizado = await atualizar();
      if (desmontado.current) return;
      setAviso(alvo.renovando ? 'Autorização renovada.' : CONECTADO);
      if (!atualizado) setErro(ATUALIZACAO_FALHOU);
      setOcupado(false);
      return;
    }
    // Sem resposta legível (prazo, queda da rede depois do commit, corpo truncado ou não JSON) o servidor pode ter
    // concluído; com recusa legível a tentativa pode ter ficado em andamento (500 genérico) ou intacta (senha vencida).
    // Nos dois casos confere pelo id antes de liberar.
    const recusa: Recusa | undefined = j && typeof j === 'object' && j.ok === false
      ? { erro: typeof j.erro === 'string' && j.erro ? j.erro : alvo.renovando ? 'Não foi possível concluir a renovação.' : 'Não foi possível concluir a conexão.', codigo: typeof j.codigo === 'string' ? j.codigo : null }
      : undefined;
    await conferirResultado({ ...alvo, recusa });
  }, [atualizar, conferirResultado, encerrarEspera, pararEscuta]);

  function inicializarSdk(sdk: FacebookSdk, meta: MetaInicio) {
    sdk.init({ appId: meta.appId, version: meta.graphApiVersion, cookie: false, xfbml: false });
    sdkInicializado.current = sdk;
  }

  function carregarSdk(meta: MetaInicio, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (window.FB) { inicializarSdk(window.FB, meta); resolve(); return; }
      document.getElementById('facebook-jssdk')?.remove();
      const script = document.createElement('script');
      function limpar() {
        signal.removeEventListener('abort', cancelar);
        script.onerror = null;
        if (window.fbAsyncInit === inicializar) window.fbAsyncInit = undefined;
      }
      function cancelar() {
        limpar();
        script.remove();
        reject(signal.reason);
      }
      function inicializar() {
        if (signal.aborted || window.fbAsyncInit !== inicializar || (document.currentScript && document.currentScript !== script)) return;
        limpar();
        try {
          if (window.FB) inicializarSdk(window.FB, meta);
          resolve();
        } catch (e) { reject(e); }
      }
      window.fbAsyncInit = inicializar;
      signal.addEventListener('abort', cancelar, { once: true });
      script.id = 'facebook-jssdk'; script.async = true; script.defer = true; script.crossOrigin = 'anonymous'; script.src = 'https://connect.facebook.net/pt_BR/sdk.js';
      script.onerror = () => { limpar(); script.remove(); reject(new Error('Falha ao carregar o SDK da Meta.')); };
      document.head.appendChild(script);
    });
  }

  async function prepararConexao(novoModo: Modo = 'conectar') {
    if (bloqueado || conferencia || preparacao.current) return;
    const conexaoId = data?.conexao?.id;
    if (novoModo === 'renovar' && !conexaoId) return;
    const operacao = {};
    preparacao.current = operacao;
    const senhaConfirmada = novoModo === 'renovar' ? senhaRenovacao : senha;
    const atual = () => preparacao.current === operacao;
    setErro(''); setAviso(''); setOcupado(true);
    setSenha(''); setSenhaRenovacao('');
    descartarPreparacao(); modo.current = novoModo;
    try {
      const estado = await consultarAntesDeReautenticar();
      if (!atual() || !estado) return;
      if (novoModo === 'renovar' && estado.conexao?.id !== conexaoId) {
        throw new Error('A conexão do WhatsApp mudou. Confira os dados atuais e clique de novo para renovar.');
      }
      const tentativa = await comPrazo(async (signal): Promise<Inicio | null> => {
        // A reautenticação anuncia a troca da sessão para manter a página aberta durante o início.
        const reauth = await reautenticarSessao(senhaConfirmada);
        if (!atual() || signal.aborted) return null;
        if (!reauth.ok) throw new Error(reauth.erro);
        const response = await adminFetch(rotaDo(novoModo, 'iniciar'), {
          method: 'POST', signal,
          ...(novoModo === 'renovar' && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conexaoId }) }),
        });
        if (!atual() || signal.aborted) return null;
        const body = await response.json();
        if (!body.ok) throw new Error(body.erro);
        return body.data;
      }, PRAZO_PREPARAR_MS, 'Não foi possível confirmar a preparação no prazo. Confirme sua senha e prepare de novo.');
      if (!atual() || !tentativa) return;
      inicio.current = tentativa;
      // A tentativa já existe no servidor: SDK que falha ou não carrega no prazo mantém a preparação para repetir a carga.
      const sdkPronto = await comPrazo((signal) => carregarSdk(tentativa.meta, signal), PRAZO_SDK_MS, 'PRAZO_SDK').then(() => Boolean(window.FB), () => false);
      if (!atual()) return;
      if (!sdkPronto) { if (novoModo === 'renovar') setPreparadoRenovacao(true); else setPreparado(true); setErro(SDK_FALHOU); return; }
      if (novoModo === 'renovar') setPreparadoRenovacao(true); else setPreparado(true);
      setAviso(novoModo === 'renovar' ? 'Tudo pronto. Clique em Continuar na Meta e escolha o MESMO número já conectado.' : 'Tudo pronto. Clique em Continuar na Meta para abrir a janela de autorização.');
    } catch (e) {
      if (atual()) { inicio.current = null; setErro(e instanceof Error ? e.message : 'Não foi possível preparar a conexão.'); }
    } finally {
      if (atual()) { preparacao.current = null; setOcupado(false); }
    }
  }

  async function desconectar() {
    const conexaoId = data?.conexao?.id;
    if (!conexaoId || bloqueado || conferencia) return;
    const motivo = motivoDesconexao.trim();
    const desconectado = 'WhatsApp desconectado. Você pode conectar outro número quando quiser.';
    setErro(''); setAviso(''); setOcupado(true);
    try {
      const estado = await consultarAntesDeReautenticar();
      if (!estado) return;
      if (estado.conexao?.id !== conexaoId) throw new Error('A conexão do WhatsApp mudou. Confira os dados antes de desconectar.');
      const senhaConfirmada = senhaDesconexao;
      setSenhaDesconexao('');
      const reauth = await comPrazo(async (signal) => {
        const resultado = await reautenticarSessao(senhaConfirmada);
        signal.throwIfAborted();
        return resultado;
      }, PRAZO_DESCONECTAR_MS, 'Não foi possível confirmar a senha no prazo. A desconexão não foi enviada.');
      if (desmontado.current) return;
      if (!reauth.ok) throw new Error(reauth.erro);
      descartarPreparacao();
      const j = await comPrazo(async (signal): Promise<{ ok?: unknown; erro?: unknown } | null> => {
        const r = await adminFetch('/api/admin/configuracoes/whatsapp/desconectar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ conexaoId, motivo }) });
        return r.json();
      }, PRAZO_DESCONECTAR_MS, 'PRAZO_DESCONECTAR').catch(() => null);
      if (desmontado.current) return;
      if (j?.ok === false) throw new Error(typeof j.erro === 'string' ? j.erro : 'Não foi possível desconectar o WhatsApp.');
      const consultado = await atualizar();
      if (desmontado.current) return;
      const atualizado = consultado?.ambiente === estado.ambiente ? consultado : null;
      if (j?.ok === true || (atualizado && !atualizado.conexao)) {
        setMotivoDesconexao(''); setAviso(desconectado);
        if (!atualizado) setErro(ATUALIZACAO_FALHOU);
      } else if (atualizado?.conexao?.id && atualizado.conexao.id !== conexaoId) {
        setMotivoDesconexao(''); setAviso('A conexão anterior não está mais ativa. Confira os dados atuais.');
      } else if (atualizado?.tentativa?.status !== 'VALIDANDO') {
        setErro('Não foi possível confirmar a desconexão. ' + (atualizado ? 'A conexão ainda aparecia ativa na última consulta.' : ATUALIZACAO_FALHOU));
      }
    } catch (e) { if (!desmontado.current) setErro(e instanceof Error ? e.message : 'Não foi possível desconectar o WhatsApp.'); }
    finally { if (!desmontado.current) setOcupado(false); }
  }

  async function verificarAtivosTeste() {
    if (bloqueado || conferencia) return;
    setErro(''); setAviso(''); setVerificandoDemo(true);
    try {
      const ativos = await comPrazo(async (signal): Promise<DemoAtivos> => {
        const r = await adminFetch('/api/admin/configuracoes/whatsapp/demo-ativos', { method: 'POST', signal });
        const j = await r.json();
        if (!j.ok) throw new Error(j.erro);
        return j.data;
      }, PRAZO_CONSULTA_MS, 'A verificação dos ativos de teste demorou demais. Tente de novo.');
      if (!desmontado.current) setDemo(ativos);
    } catch (e) { if (!desmontado.current) setErro(e instanceof Error ? e.message : 'Não foi possível verificar os ativos de teste.'); }
    finally { if (!desmontado.current) setVerificandoDemo(false); }
  }

  function abrirMeta() {
    if (bloqueado || conferencia) return;
    const tentativa = inicio.current;
    setErro(''); setAviso('');
    if (!tentativa || !Number.isFinite(Date.parse(tentativa.expiraEm)) || Date.parse(tentativa.expiraEm) <= Date.now()) {
      inicio.current = null; setPreparado(false); setPreparadoRenovacao(false); setErro('A preparação expirou. Confirme sua senha para preparar a conexão novamente.'); return;
    }
    if (!window.FB) {
      // A janela precisa nascer do clique: aqui só carrega o SDK (com prazo) e devolve o botão para o próximo clique.
      setOcupado(true); setPreparado(false); setPreparadoRenovacao(false); setAviso('Carregando a janela da Meta…');
      void comPrazo((signal) => carregarSdk(tentativa.meta, signal), PRAZO_SDK_MS, 'PRAZO_SDK').then(() => Boolean(window.FB), () => false).then((pronto) => {
        if (desmontado.current || inicio.current !== tentativa) return;
        if (!pronto) { voltarParaContinuar(SDK_FALHOU); return; }
        if (modo.current === 'renovar') setPreparadoRenovacao(true); else setPreparado(true);
        setAviso('A janela da Meta está pronta. Clique em Continuar na Meta.'); setOcupado(false);
      });
      return;
    }
    setOcupado(true); setPreparado(false); setPreparadoRenovacao(false);
    try {
      const meta = tentativa.meta;
      const sdk = window.FB;
      // O script pode terminar depois do prazo, quando o callback da carga já foi removido.
      if (sdkInicializado.current !== sdk) inicializarSdk(sdk, meta);
      // Janela que o FB.login desta tentativa abrir: mensagem de outra janela (popup de tentativa anterior) é ignorada.
      let janela: Window | null = null;
      const abertura = {};
      const listener = (event: MessageEvent) => {
        if (aberturaMeta.current !== abertura || inicio.current !== tentativa || concluindo.current || !meta.messageOrigins.includes(event.origin)) return;
        if (!janela || (event.source !== janela && topoDa(event.source) !== janela)) return;
        let payload: unknown = event.data;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return; } }
        if (!payload || typeof payload !== 'object') return;
        const envelope = payload as Record<string, unknown>;
        if (envelope.event !== meta.eventName) return;
        const ids = idsDaMensagem(envelope.data); if (!ids) { voltarParaContinuar('A Meta concluiu o fluxo, mas retornou um formato diferente do configurado no painel. Tente de novo em Continuar na Meta; se repetir, fale com o suporte.'); return; }
        sessaoMeta.current = ids; void concluir();
      };
      if (listenerMeta.current) window.removeEventListener('message', listenerMeta.current);
      listenerMeta.current = listener;
      window.addEventListener('message', listener, { once: false });
      aberturaMeta.current = abertura;
      if (prazoMeta.current) clearTimeout(prazoMeta.current);
      prazoMeta.current = setTimeout(() => { if (aberturaMeta.current === abertura && inicio.current === tentativa && !concluindo.current) encerrarEspera('A janela da Meta não respondeu a tempo. Confirme sua senha para preparar de novo.'); }, Math.max(0, Date.parse(tentativa.expiraEm) - Date.now()));
      // Deve permanecer síncrono no segundo clique: nenhum await antes de FB.login. O SDK abre a janela da Meta com
      // window.open dentro do FB.login; a janela é guardada para prender as mensagens a esta tentativa.
      const abrirJanela = window.open;
      window.open = ((...args: Parameters<typeof window.open>) => { const aberta = abrirJanela.apply(window, args); if (!janela) { janela = aberta; janelaMeta.current = aberta; } return aberta; }) as typeof window.open;
      try {
      sdk.login((fb) => {
        // Retorno atrasado de uma tentativa anterior (encerrada pelo prazo ou substituída) ou durante a conclusão: ignorado.
        if (aberturaMeta.current !== abertura || inicio.current !== tentativa || concluindo.current) return;
        const code = fb.authResponse?.code;
        // Sem janela aberta, quem responde é o aviso de pop-up logo depois do FB.login.
        if (!code) { if (janela) voltarParaContinuar('A autorização não foi concluída na Meta. Clique de novo em Continuar na Meta para tentar outra vez.'); return; }
        codigo.current = code; void concluir();
      }, meta.launchOptions);
      } finally { window.open = abrirJanela; }
      if (aberturaMeta.current !== abertura || inicio.current !== tentativa) return;
      if (!janela) { voltarParaContinuar('A janela da Meta não abriu. Libere pop-ups para este site e clique de novo em Continuar na Meta.'); return; }
      janelaMeta.current = janela;
      setAviso('Conclua a autorização na janela da Meta e, se solicitado, confirme no WhatsApp Business App.');
    } catch (e) {
      voltarParaContinuar(e instanceof Error ? e.message : 'Não foi possível abrir a Meta.');
    }
  }

  return <main className={styles.page}><VoltarConfiguracoes /><h1>WhatsApp</h1><p>Conecte o WhatsApp Business da sua empresa ao iA.Fest pelo fluxo oficial da Meta. O número continua funcionando no WhatsApp Business App.</p>
    {erro && <p role="alert">{erro}</p>}{aviso && <p role="status" className={whatsapp.pending}>{aviso}</p>}
    {conferencia && <div className={whatsapp.actions}><AdminPrimaryButton carregando={bloqueado} onClick={() => conferirResultado(conferencia)}>Conferir de novo</AdminPrimaryButton></div>}
    {!data && falhaCarga && <AdminPrimaryButton onClick={repetirCarga}>Tentar carregar de novo</AdminPrimaryButton>}
    {!data ? (falhaCarga ? null : <p>Carregando…</p>) : <><section className={whatsapp.status}><strong>{rotulos[data.estado] ?? 'Ação necessária'}</strong>{data.empresa && <p>Empresa: {data.empresa}</p>}{data.conexao ? <><p>{data.conexao.nomeVerificado} · {data.conexao.numeroExibicao}</p><p className={whatsapp.technical}>Conta Meta e número conferidos. O envio e o recebimento de mensagens pelo iA.Fest serão ativados numa próxima etapa.</p></> : <p>Esta empresa ainda não tem um WhatsApp conectado.</p>}</section>
      {!data.metaConfigurada && <p className={whatsapp.pending}>A conexão com a Meta ainda não está disponível neste ambiente. <Link href={ROTA_AJUDA}>Fale com o suporte do iA.Fest</Link>.</p>}
      {!data.conexao && <section className={styles.card}><h2>Conectar WhatsApp Business</h2><p>Você vai entrar na Meta com a conta que administra o WhatsApp Business da empresa e escolher o número.</p>{data.ambiente === 'STAGING' && <p className={whatsapp.pending}>Ambiente de testes: use somente um número de teste.</p>}<div className={whatsapp.actions}>{preparado ? <AdminPrimaryButton disabled={bloqueado || Boolean(conferencia)} onClick={abrirMeta}>Continuar na Meta</AdminPrimaryButton> : <><label>Confirme sua senha<input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} /></label><AdminPrimaryButton carregando={bloqueado} disabled={!senha || !data.metaConfigurada || Boolean(conferencia)} onClick={() => prepararConexao('conectar')}>Preparar conexão</AdminPrimaryButton></>}</div></section>}
      {data.conexao && (() => { const validade = textoValidade(data.conexao.tokenExpiraEm); return <section className={styles.card}><h2>Renovar autorização da Meta</h2><p className={validade.alerta ? whatsapp.pending : undefined}>{validade.texto}</p><p>Renova a autorização sem desconectar o número no iA.Fest. Na janela da Meta, escolha o mesmo número já conectado.</p><div className={whatsapp.actions}>{preparadoRenovacao ? <AdminPrimaryButton disabled={bloqueado || Boolean(conferencia)} onClick={abrirMeta}>Continuar na Meta</AdminPrimaryButton> : <><label>Confirme sua senha<input type="password" autoComplete="current-password" value={senhaRenovacao} onChange={(e) => setSenhaRenovacao(e.target.value)} /></label><AdminPrimaryButton carregando={bloqueado} disabled={!senhaRenovacao || !data.metaConfigurada || Boolean(conferencia)} onClick={() => prepararConexao('renovar')}>Renovar credencial</AdminPrimaryButton></>}</div></section>; })()}
      {data.conexao && <section className={styles.card}><h2>Desconectar</h2><p>O iA.Fest deixa de usar este número. O WhatsApp Business App continua funcionando normalmente.</p><div className={whatsapp.actions}><label>Motivo<input value={motivoDesconexao} maxLength={500} onChange={(e) => setMotivoDesconexao(e.target.value)} /></label><label>Confirme sua senha<input type="password" autoComplete="current-password" value={senhaDesconexao} onChange={(e) => setSenhaDesconexao(e.target.value)} /></label><AdminPrimaryButton carregando={bloqueado} disabled={!senhaDesconexao || motivoDesconexao.trim().length < 3 || Boolean(conferencia)} onClick={desconectar}>Desconectar</AdminPrimaryButton></div></section>}
      {data.demoAtivosTeste && <section className={styles.card}><h2>Verificação de ativos de teste da Meta</h2><p className={whatsapp.pending}>Ambiente de teste: esta verificação não cria conexão.</p><p>Confere, com os ativos de teste do iA.Fest, se a conta do WhatsApp Business pertence ao portfólio empresarial e lê os números dessa conta.</p><div className={whatsapp.actions}><AdminPrimaryButton carregando={verificandoDemo} disabled={ocupado || Boolean(conferencia)} onClick={verificarAtivosTeste}>Verificar ativos de teste</AdminPrimaryButton></div>
        {demo && <div className={whatsapp.status}><p>Portfólio {demo.portfolio.id}: {demo.portfolio.possuiWabaTeste ? 'a conta do WhatsApp Business ' + demo.waba.id + ' pertence a este portfólio.' : 'a conta do WhatsApp Business ' + demo.waba.id + ' não pertence a este portfólio.'}</p>{demo.numeros.map((n) => <p key={n.id}>{n.verified_name ?? 'Sem nome verificado'} · {n.display_phone_number ?? n.id} · is_on_biz_app: {n.is_on_biz_app === null ? 'não informado' : String(n.is_on_biz_app)}</p>)}<p>Requisito do Kidmais para coexistência (is_on_biz_app=true): {rotulosRequisito[demo.requisitoKidmaisIsOnBizApp]}.</p><p className={whatsapp.technical}>{demo.aviso}</p></div>}</section>}</>}
  </main>;
}
