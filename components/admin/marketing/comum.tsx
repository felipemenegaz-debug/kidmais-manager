'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './marketing.module.css';

export type RespostaApi<T> = { ok: true; data: T } | { ok: false; erro?: string; codigo?: string; detalhes?: Record<string, unknown> | null };
export type FalhaCarga = { mensagem: string; codigo: string | null; status: number };

/**
 * Leitura de uma API de Marketing com estados de carregamento, erro e acesso negado (plano ou permissão).
 * `dadosDe` diz de qual URL vieram os dados exibidos: ao trocar de filtro (ex.: unidade), `dados` continua com a resposta
 * anterior até a nova chegar — telas que editam precisam conferir `dadosDe === url` antes de permitir ação.
 * `setDados` aceita função (atualiza sobre o estado mais recente, não sobre uma cópia antiga) e mantém a origem.
 */
export function useMarketing<T>(url: string | null) {
  const [estado, setEstado] = useState<{ de: string; dados: T } | null>(null);
  const [falha, setFalha] = useState<FalhaCarga | null>(null);
  const [versao, setVersao] = useState(0);
  // Carregando = a última resposta recebida não é da consulta atual (url + versão); derivado, sem setState no efeito.
  const [respondida, setRespondida] = useState<string | null>(null);
  const consulta = url ? `${versao}:${url}` : null;
  const recarregar = useCallback(() => setVersao((v) => v + 1), []);
  const setDados = useCallback((valor: T | ((atual: T) => T)) => setEstado((atual) => {
    if (typeof valor !== 'function') return { de: atual?.de ?? '', dados: valor };
    return atual ? { de: atual.de, dados: (valor as (a: T) => T)(atual.dados) } : atual;
  }), []);
  useEffect(() => {
    if (!url || !consulta) return;
    let ativo = true;
    adminFetch(url).then(async (resposta) => {
      const corpo = await resposta.json().catch(() => null) as RespostaApi<T> | null;
      if (!ativo) return;
      if (corpo?.ok) { setEstado({ de: url, dados: corpo.data }); setFalha(null); }
      else setFalha({ mensagem: (corpo && !corpo.ok && corpo.erro) || 'Não foi possível carregar.', codigo: (corpo && !corpo.ok && corpo.codigo) || null, status: resposta.status });
    }).catch((e: unknown) => {
      if (ativo) setFalha({ mensagem: e instanceof Error ? e.message : 'Não foi possível carregar.', codigo: null, status: 0 });
    }).finally(() => { if (ativo) setRespondida(consulta); });
    return () => { ativo = false; };
  }, [url, consulta]);
  return { dados: estado?.dados ?? null, dadosDe: estado?.de ?? null, falha, carregando: consulta !== null && respondida !== consulta, recarregar, setDados };
}

/** Envio (POST JSON) com o mesmo tratamento de erro; devolve os dados ou lança Error com a mensagem do servidor. */
export async function enviarMarketing<T>(url: string, corpo: unknown): Promise<T> {
  const resposta = await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  const json = await resposta.json().catch(() => null) as RespostaApi<T> | null;
  if (!json?.ok) throw Object.assign(new Error((json && !json.ok && json.erro) || 'Não foi possível concluir.'), { codigo: json && !json.ok ? json.codigo : null });
  return json.data;
}

const ABAS = [
  { href: '/admin/marketing', rotulo: 'Visão geral' },
  { href: '/admin/marketing/campanhas', rotulo: 'Campanhas' },
  { href: '/admin/marketing/origens', rotulo: 'Origens dos contatos' },
  { href: '/admin/marketing/site', rotulo: 'Site e SEO' },
  { href: '/admin/marketing/automacoes', rotulo: 'Automações' },
  { href: '/admin/marketing/permissoes', rotulo: 'Permissões' },
];

export function CabecalhoMarketing({ titulo, descricao, acao }: { titulo: string; descricao: string; acao?: ReactNode }) {
  const caminho = usePathname();
  return <>
    <header className={styles.topo}><div><h1>{titulo}</h1><p>{descricao}</p></div>{acao}</header>
    <nav className={styles.abas} aria-label="Seções de Marketing">
      {ABAS.map((a) => <Link key={a.href} href={a.href} aria-current={caminho === a.href ? 'page' : undefined}>{a.rotulo}</Link>)}
    </nav>
  </>;
}

/** Estados padronizados: carregando, acesso negado (plano/permissão), indisponível (migration ausente) e erro. */
export function EstadoCarga({ carregando, falha, aoTentar }: { carregando: boolean; falha: FalhaCarga | null; aoTentar: () => void }) {
  if (carregando) return <p role="status" aria-busy="true" className={styles.muted}>Carregando…</p>;
  if (!falha) return null;
  if (falha.codigo === 'RECURSO_FORA_DO_PLANO') {
    return <section className={styles.cartao} role="alert"><h2>Marketing não está no plano desta empresa</h2><p>{falha.mensagem}</p>
      <p className={styles.muted}>A origem dos contatos continua disponível nos cadastros de clientes e negociações.</p></section>;
  }
  if (falha.status === 403) {
    return <section className={styles.cartao} role="alert"><h2>Acesso não liberado</h2><p>{falha.mensagem}</p>
      <p className={styles.muted}>A Gestão da empresa pode liberar em Marketing → Permissões.</p></section>;
  }
  if (falha.codigo === 'MARKETING_INDISPONIVEL') {
    return <section className={styles.cartao} role="alert"><h2>Marketing indisponível neste ambiente</h2><p>{falha.mensagem}</p></section>;
  }
  return <section className={styles.cartao} role="alert"><p className={styles.erro}>{falha.mensagem}</p><button type="button" className={styles.secundario} onClick={aoTentar}>Tentar novamente</button></section>;
}

export function novaChave() {
  try { return crypto.randomUUID().replace(/-/g, ''); } catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.padEnd(24, '0').slice(0, 40); }
}
