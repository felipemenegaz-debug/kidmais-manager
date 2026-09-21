'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { Contratacao } from '@/lib/fechamentos/contratacoes';
import { formatarFormaPagamento, formatarMoeda } from '@/lib/contratos/documento/formatters';
import styles from './festa.module.css';

export default function Contratacoes({ clienteId, onTotal }: { clienteId?: string; onTotal?: (total: number) => void }) {
    const [itens, setItens] = useState<Contratacao[] | null>(null);
    const [erro, setErro] = useState('');
    const [tentativa, setTentativa] = useState(0);
    useEffect(() => {
        let ativo = true, sequencia = 0;
        async function carregar() {
            const atual = ++sequencia;
            try {
                const response = await adminFetch('/api/admin/fechamentos/contratacoes' + (clienteId ? `?clienteId=${encodeURIComponent(clienteId)}` : ''));
                const body = await response.json();
                if (!response.ok || !body.ok) throw Error(body.erro || 'Não foi possível carregar as contratações.');
                if (ativo && atual === sequencia) { setItens(body.data.itens); setErro(''); onTotal?.(body.data.total); }
            } catch (error) {
                if (ativo && atual === sequencia) setErro(error instanceof Error ? error.message : 'Não foi possível carregar as contratações.');
            }
        }
        void carregar();
        const atualizar = () => { void carregar(); };
        window.addEventListener('focus', atualizar);
        const timer = window.setInterval(atualizar, 30000);
        return () => { ativo = false; window.clearInterval(timer); window.removeEventListener('focus', atualizar); };
    }, [clienteId, onTotal, tentativa]);
    return <section className={styles.contratacoes} aria-label="Contratações em andamento">
        {erro && <div role="alert" className={styles.warning}>{erro} <button type="button" onClick={() => setTentativa(v => v + 1)}>Atualizar contratações</button></div>}
        {!erro && itens === null && <p role="status">Carregando contratações…</p>}
        {!erro && itens?.length === 0 && <p>Nenhuma contratação em andamento.</p>}
        {!erro && itens && <ContratacoesLista itens={itens}/>}
    </section>;
}

export function ContratacoesLista({ itens }: { itens: Contratacao[] }) {
    return <div className={styles.grid}>{itens.map(item => <article className={styles.card} key={item.id}>
            <p className={styles.customer}>Cliente</p><h3>{item.cliente}</h3>
            {item.clienteStatus === 'INATIVO' && <small>Cliente arquivado/inativo</small>}
            <p>{new Date(item.data + 'T12:00:00Z').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} • {item.inicio.slice(0, 5)}–{item.fim.slice(0, 5)}</p>
            <p>{item.pacote} • {item.convidados} convidados</p>
            <p><strong>{item.situacao}</strong></p>
            {item.valorContratual !== null && <p>Valor contratual: {formatarMoeda(Number(item.valorContratual))}</p>}
            {item.formaPagamento && <p>{formatarFormaPagamento(item.formaPagamento)}</p>}
            <p>Criado em {new Date(item.criadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
            <p>Próximo passo: {item.proximoPasso}</p>
            <div className={styles.actions}><Link className={styles.button} href={item.acao.href}>{item.acao.titulo}</Link>
                {item.acessoPublico && <Link href={item.acessoPublico}>Abrir acesso público do cliente</Link>}</div>
        </article>)}</div>;
}
