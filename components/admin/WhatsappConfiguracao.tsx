'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';
import whatsapp from './WhatsappConfiguracao.module.css';

type MetaInicio = { appId: string; graphApiVersion: string; configurationId: string; eventName: string; launchOptions: Record<string, unknown>; messageOrigins: string[] };
type Inicio = { tentativaId: string; state: string; expiraEm: string; meta: MetaInicio };
type DadosSessao = { businessId: string; wabaId: string; phoneNumberId: string };
type Estado = { estado: string; metaConfigurada: boolean; conexao: null | { numeroExibicao: string; nomeVerificado: string; businessId: string; wabaId: string; phoneNumberId: string }; tentativa: null | { status: string; expira_em: string } };
type FbResponse = { authResponse?: { code?: string }; status?: string };
type FacebookSdk = { init(input: { appId: string; version: string; cookie: boolean; xfbml: boolean }): void; login(callback: (response: FbResponse) => void, options: Record<string, unknown>): void };

declare global { interface Window { FB?: FacebookSdk; fbAsyncInit?: () => void } }
const rotulos: Record<string, string> = {
  NAO_CONFIGURADA: 'Não configurado', AGUARDANDO_META: 'Aguardando conclusão na Meta', VALIDANDO: 'Validando configuração',
  CONFIGURADA_SEM_WEBHOOK_OTP: 'Configurado — webhook e OTP ainda não ativados', TENTATIVA_EXPIRADA: 'Tentativa expirada', ACAO_NECESSARIA: 'Ação necessária',
};

function idsDaMensagem(value: unknown): DadosSessao | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const businessId = data.business_id ?? data.businessId;
  const wabaId = data.waba_id ?? data.wabaId;
  const phoneNumberId = data.phone_number_id ?? data.phoneNumberId;
  return [businessId, wabaId, phoneNumberId].every((item) => typeof item === 'string' && /^[0-9]+$/.test(item))
    ? { businessId: String(businessId), wabaId: String(wabaId), phoneNumberId: String(phoneNumberId) } : null;
}

export default function WhatsappConfiguracao() {
  const [data, setData] = useState<Estado | null>(null), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  const [senha, setSenha] = useState(''), [ocupado, setOcupado] = useState(false);
  const inicio = useRef<Inicio | null>(null), codigo = useRef<string | null>(null), sessaoMeta = useRef<DadosSessao | null>(null), concluindo = useRef(false);
  const listenerMeta = useRef<((event: MessageEvent) => void) | null>(null);
  const carregar = useCallback(async () => { const r = await adminFetch('/api/admin/configuracoes/whatsapp'), j = await r.json(); if (!j.ok) throw new Error(j.erro); setData(j.data); }, []);
  useEffect(() => {
    let ativo = true;
    void (async () => {
      try { await carregar(); }
      catch { if (ativo) setErro('Não foi possível carregar a configuração do WhatsApp.'); }
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
      setAviso('WhatsApp configurado. Webhook, envio e OTP continuam desativados nesta etapa.'); await carregar();
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

  async function conectar() {
    setErro(''); setAviso(''); setOcupado(true); codigo.current = null; sessaoMeta.current = null;
    try {
      const reauth = await adminFetch('/api/admin/autenticacao', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'reautenticar', senha }) });
      const reauthBody = await reauth.json(); setSenha(''); if (!reauthBody.ok) throw new Error(reauthBody.erro);
      const response = await adminFetch('/api/admin/configuracoes/whatsapp/onboarding/iniciar', { method: 'POST' });
      const body = await response.json(); if (!body.ok) throw new Error(body.erro); inicio.current = body.data;
      const meta = inicio.current!.meta;
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
      await carregarSdk(meta);
      if (!window.FB) throw new Error('SDK da Meta indisponível.');
      window.FB.login((fb) => {
        const code = fb.authResponse?.code;
        if (!code) { window.removeEventListener('message', listener); listenerMeta.current = null; setErro('A autorização não foi concluída na Meta.'); setOcupado(false); return; }
        codigo.current = code; void concluir();
      }, meta.launchOptions);
      setAviso('Conclua a autorização na janela da Meta e, se solicitado, confirme no WhatsApp Business App.');
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível iniciar a conexão.'); setOcupado(false); }
  }

  return <main className={styles.page}><Link href="/admin/configuracoes">Voltar às configurações</Link><h1>WhatsApp</h1><p>Conecte uma conta pelo fluxo oficial da Meta com suporte ao WhatsApp Business App.</p>
    {erro && <p role="alert">{erro}</p>}{aviso && <p role="status" className={whatsapp.pending}>{aviso}</p>}
    {!data ? <p>Carregando…</p> : <><section className={whatsapp.status}><strong>{rotulos[data.estado] ?? 'Ação necessária'}</strong>{data.conexao ? <><p>{data.conexao.nomeVerificado} · {data.conexao.numeroExibicao}</p><p className={whatsapp.technical}>Conta Meta e número foram conferidos. Webhook, mensagens e OTP permanecem desativados.</p></> : <p>Nenhuma conexão WhatsApp está ativa neste ambiente.</p>}</section>
      {!data.metaConfigurada && <p className={whatsapp.pending}>Configuração Meta pendente. Informe no Render os dados e o snippet atual do Embedded Signup antes de iniciar.</p>}
      {!data.conexao && <section className={styles.card}><h2>Conectar WhatsApp Business</h2><p>Use somente um número secundário e controlado no staging. O número oficial da Kidmais não deve ser conectado nesta etapa.</p><div className={whatsapp.actions}><label>Confirme sua senha<input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} /></label><button disabled={ocupado || !senha || !data.metaConfigurada} onClick={conectar}>{ocupado ? 'Aguardando…' : 'Conectar WhatsApp Business'}</button></div></section>}
      <section className={styles.card}><h2>Próximas etapas</h2><p>Testar envio e Desconectar serão habilitados em blocos posteriores. Nenhuma mensagem ou OTP é enviado por esta tela.</p><button disabled>Testar</button><button disabled>Desconectar</button></section></>}
  </main>;
}
