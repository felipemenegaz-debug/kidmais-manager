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
type Estado = { estado: string; metaConfigurada: boolean; ambiente?: string | null; empresa?: string | null; conexao: null | { id: string; numeroExibicao: string; nomeVerificado: string; businessId: string; wabaId: string; phoneNumberId: string }; tentativa: null | { status: string; expira_em: string }; demoAtivosTeste?: boolean };
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

export default function WhatsappConfiguracao() {
  const [data, setData] = useState<Estado | null>(null), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  const [senha, setSenha] = useState(''), [ocupado, setOcupado] = useState(false);
  const [preparado, setPreparado] = useState(false), [falhaCarga, setFalhaCarga] = useState(false);
  const inicio = useRef<Inicio | null>(null), codigo = useRef<string | null>(null), sessaoMeta = useRef<DadosSessao | null>(null), concluindo = useRef(false);
  const listenerMeta = useRef<((event: MessageEvent) => void) | null>(null);
  // Desconectar (083): motivo + senha reconfirmada; o servidor exige a Gestão da empresa.
  const [motivoDesconexao, setMotivoDesconexao] = useState(''), [senhaDesconexao, setSenhaDesconexao] = useState('');
  // Verificação de ativos de teste (análise do app Meta): só leitura, visível apenas quando o servidor libera.
  const [demo, setDemo] = useState<DemoAtivos | null>(null), [verificandoDemo, setVerificandoDemo] = useState(false);
  const carregar = useCallback(async () => { const r = await adminFetch('/api/admin/configuracoes/whatsapp'), j = await r.json(); if (!j.ok) throw new Error(j.erro || FALHA_CARGA); setData(j.data); }, []);
  useEffect(() => {
    let ativo = true;
    void (async () => {
      try { await carregar(); }
      // Mostra o motivo real (ex.: 403 de quem não é a conta da plataforma) e para de dizer "Carregando…".
      catch (e) { if (ativo) { setErro(e instanceof Error && !(e instanceof SyntaxError) && e.message ? e.message : FALHA_CARGA); setFalhaCarga(true); } }
    })();
    return () => { ativo = false; };
  }, [carregar]);
  useEffect(() => () => { if (listenerMeta.current) window.removeEventListener('message', listenerMeta.current); }, []);

  const concluir = useCallback(async () => {
    if (!inicio.current || !codigo.current || !sessaoMeta.current || concluindo.current) return;
    concluindo.current = true; setAviso('Validando configuração com a Meta…');
    try {
      const r = await adminFetch('/api/admin/configuracoes/whatsapp/onboarding/concluir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tentativaId: inicio.current.tentativaId, state: inicio.current.state, authorizationCode: codigo.current, ...sessaoMeta.current }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.erro);
      codigo.current = null; sessaoMeta.current = null; inicio.current = null;
      if (listenerMeta.current) window.removeEventListener('message', listenerMeta.current); listenerMeta.current = null;
      setAviso('WhatsApp conectado. O envio e o recebimento de mensagens pelo Kidmais serão ativados numa próxima etapa.'); await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível concluir a conexão.'); }
    finally { concluindo.current = false; setOcupado(false); }
  }, [carregar]);

  function carregarSdk(meta: MetaInicio) {
    return new Promise<void>((resolve, reject) => {
      if (window.FB) { window.FB.init({ appId: meta.appId, version: meta.graphApiVersion, cookie: false, xfbml: false }); resolve(); return; }
      window.fbAsyncInit = () => { window.FB?.init({ appId: meta.appId, version: meta.graphApiVersion, cookie: false, xfbml: false }); resolve(); };
      const existente = document.getElementById('facebook-jssdk'); if (existente) { existente.addEventListener('error', () => reject(new Error('Falha ao carregar o SDK da Meta.')), { once: true }); return; }
      const script = document.createElement('script'); script.id = 'facebook-jssdk'; script.async = true; script.defer = true; script.crossOrigin = 'anonymous'; script.src = 'https://connect.facebook.net/pt_BR/sdk.js'; script.onerror = () => reject(new Error('Falha ao carregar o SDK da Meta.')); document.head.appendChild(script);
    });
  }

  async function prepararConexao() {
    setErro(''); setAviso(''); setOcupado(true); codigo.current = null; sessaoMeta.current = null;
    setPreparado(false); inicio.current = null;
    if (listenerMeta.current) window.removeEventListener('message', listenerMeta.current);
    listenerMeta.current = null;
    try {
      // Renovação anunciada: a reautenticação troca a sessão; sem o anúncio a página seria descartada antes de iniciar.
      const reauth = await reautenticarSessao(senha); setSenha(''); if (!reauth.ok) throw new Error(reauth.erro);
      const response = await adminFetch('/api/admin/configuracoes/whatsapp/onboarding/iniciar', { method: 'POST' });
      const body = await response.json(); if (!body.ok) throw new Error(body.erro); inicio.current = body.data;
      const meta = inicio.current!.meta;
      await carregarSdk(meta);
      if (!window.FB) throw new Error('SDK da Meta indisponível.');
      setPreparado(true);
      setAviso('Tudo pronto. Clique em Continuar na Meta para abrir a janela de autorização.');
    } catch (e) { inicio.current = null; setErro(e instanceof Error ? e.message : 'Não foi possível preparar a conexão.'); }
    finally { setOcupado(false); }
  }

  async function desconectar() {
    if (!data?.conexao) return;
    setErro(''); setAviso(''); setOcupado(true);
    try {
      const reauth = await reautenticarSessao(senhaDesconexao); setSenhaDesconexao(''); if (!reauth.ok) throw new Error(reauth.erro);
      const r = await adminFetch('/api/admin/configuracoes/whatsapp/desconectar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conexaoId: data.conexao.id, motivo: motivoDesconexao.trim() }) });
      const j = await r.json(); if (!j.ok) throw new Error(j.erro);
      setMotivoDesconexao(''); setAviso('WhatsApp desconectado. Você pode conectar outro número quando quiser.'); await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível desconectar o WhatsApp.'); }
    finally { setOcupado(false); }
  }

  async function verificarAtivosTeste() {
    setErro(''); setAviso(''); setVerificandoDemo(true);
    try {
      const r = await adminFetch('/api/admin/configuracoes/whatsapp/demo-ativos', { method: 'POST' });
      const j = await r.json(); if (!j.ok) throw new Error(j.erro); setDemo(j.data);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível verificar os ativos de teste.'); }
    finally { setVerificandoDemo(false); }
  }

  function abrirMeta() {
    const tentativa = inicio.current;
    setErro(''); setAviso('');
    if (!tentativa || !Number.isFinite(Date.parse(tentativa.expiraEm)) || Date.parse(tentativa.expiraEm) <= Date.now()) {
      inicio.current = null; setPreparado(false); setErro('A preparação expirou. Confirme sua senha para preparar a conexão novamente.'); return;
    }
    if (!window.FB) { inicio.current = null; setPreparado(false); setErro('SDK da Meta indisponível. Prepare a conexão novamente.'); return; }
    setOcupado(true); setPreparado(false);
    try {
      const meta = tentativa.meta;
      const listener = (event: MessageEvent) => {
        if (!inicio.current || !meta.messageOrigins.includes(event.origin)) return;
        let payload: unknown = event.data;
        if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return; } }
        if (!payload || typeof payload !== 'object') return;
        const envelope = payload as Record<string, unknown>;
        if (envelope.event !== meta.eventName) return;
        const ids = idsDaMensagem(envelope.data); if (!ids) { setErro('A Meta concluiu o fluxo, mas retornou um formato diferente do configurado no painel.'); return; }
        sessaoMeta.current = ids; void concluir();
      };
      if (listenerMeta.current) window.removeEventListener('message', listenerMeta.current);
      listenerMeta.current = listener;
      window.addEventListener('message', listener, { once: false });
      // Deve permanecer síncrono no segundo clique: nenhum await antes de FB.login.
      window.FB.login((fb) => {
        const code = fb.authResponse?.code;
        if (!code) { window.removeEventListener('message', listener); listenerMeta.current = null; inicio.current = null; setAviso(''); setErro('A autorização não foi concluída na Meta. Se a janela não abriu, confira se o navegador bloqueou o pop-up.'); setOcupado(false); return; }
        codigo.current = code; void concluir();
      }, meta.launchOptions);
      if (inicio.current) setAviso('Conclua a autorização na janela da Meta e, se solicitado, confirme no WhatsApp Business App.');
    } catch (e) {
      if (listenerMeta.current) window.removeEventListener('message', listenerMeta.current);
      listenerMeta.current = null; inicio.current = null;
      setErro(e instanceof Error ? e.message : 'Não foi possível abrir a Meta.'); setOcupado(false);
    }
  }

  return <main className={styles.page}><VoltarConfiguracoes /><h1>WhatsApp</h1><p>Conecte o WhatsApp Business da sua empresa ao Kidmais pelo fluxo oficial da Meta. O número continua funcionando no WhatsApp Business App.</p>
    {erro && <p role="alert">{erro}</p>}{aviso && <p role="status" className={whatsapp.pending}>{aviso}</p>}
    {!data ? (falhaCarga ? null : <p>Carregando…</p>) : <><section className={whatsapp.status}><strong>{rotulos[data.estado] ?? 'Ação necessária'}</strong>{data.empresa && <p>Empresa: {data.empresa}</p>}{data.conexao ? <><p>{data.conexao.nomeVerificado} · {data.conexao.numeroExibicao}</p><p className={whatsapp.technical}>Conta Meta e número conferidos. O envio e o recebimento de mensagens pelo Kidmais serão ativados numa próxima etapa.</p></> : <p>Esta empresa ainda não tem um WhatsApp conectado.</p>}</section>
      {!data.metaConfigurada && <p className={whatsapp.pending}>A conexão com a Meta ainda não está disponível neste ambiente. <Link href={ROTA_AJUDA}>Fale com o suporte da Kidmais</Link>.</p>}
      {!data.conexao && <section className={styles.card}><h2>Conectar WhatsApp Business</h2><p>Você vai entrar na Meta com a conta que administra o WhatsApp Business da empresa e escolher o número.</p>{data.ambiente === 'STAGING' && <p className={whatsapp.pending}>Ambiente de testes: use somente um número de teste.</p>}<div className={whatsapp.actions}>{preparado ? <AdminPrimaryButton onClick={abrirMeta}>Continuar na Meta</AdminPrimaryButton> : <><label>Confirme sua senha<input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} /></label><AdminPrimaryButton carregando={ocupado} disabled={!senha || !data.metaConfigurada} onClick={prepararConexao}>Preparar conexão</AdminPrimaryButton></>}</div></section>}
      {data.conexao && <section className={styles.card}><h2>Desconectar</h2><p>O Kidmais deixa de usar este número. O WhatsApp Business App continua funcionando normalmente.</p><div className={whatsapp.actions}><label>Motivo<input value={motivoDesconexao} maxLength={500} onChange={(e) => setMotivoDesconexao(e.target.value)} /></label><label>Confirme sua senha<input type="password" autoComplete="current-password" value={senhaDesconexao} onChange={(e) => setSenhaDesconexao(e.target.value)} /></label><AdminPrimaryButton carregando={ocupado} disabled={!senhaDesconexao || motivoDesconexao.trim().length < 3} onClick={desconectar}>Desconectar</AdminPrimaryButton></div></section>}
      {data.demoAtivosTeste && <section className={styles.card}><h2>Verificação de ativos de teste da Meta</h2><p className={whatsapp.pending}>Ambiente de teste: esta verificação não cria conexão.</p><p>Confere, com os ativos de teste do Kidmais, se a conta do WhatsApp Business pertence ao portfólio empresarial e lê os números dessa conta.</p><div className={whatsapp.actions}><AdminPrimaryButton carregando={verificandoDemo} onClick={verificarAtivosTeste}>Verificar ativos de teste</AdminPrimaryButton></div>
        {demo && <div className={whatsapp.status}><p>Portfólio {demo.portfolio.id}: {demo.portfolio.possuiWabaTeste ? 'a conta do WhatsApp Business ' + demo.waba.id + ' pertence a este portfólio.' : 'a conta do WhatsApp Business ' + demo.waba.id + ' não pertence a este portfólio.'}</p>{demo.numeros.map((n) => <p key={n.id}>{n.verified_name ?? 'Sem nome verificado'} · {n.display_phone_number ?? n.id} · is_on_biz_app: {n.is_on_biz_app === null ? 'não informado' : String(n.is_on_biz_app)}</p>)}<p>Requisito do Kidmais para coexistência (is_on_biz_app=true): {rotulosRequisito[demo.requisitoKidmaisIsOnBizApp]}.</p><p className={whatsapp.technical}>{demo.aviso}</p></div>}</section>}</>}
  </main>;
}
