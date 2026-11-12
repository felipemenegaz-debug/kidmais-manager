'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { ler } from './AssistenteAgenda';
import css from './salao-apresentacao.module.css';
import { avisoPaginaPublica } from './saloes-pagina-publica';
import ws from './workspace.module.css';

/** Configurações › Salões (102): salões ativos da empresa e se cada um já está pronto para aparecer ao cliente. */
type Salao = { id: string; nome: string; unidade: string | null; capacidadeConvidados: number | null; fotos: number; pronto: boolean; pendencias: number };
type Dados = { instalacao: 'AUSENTE' | 'COMPLETA' | 'PARCIAL'; gestao: boolean; paginaPublica?: boolean; saloes: Salao[] };

export default function SaloesApresentacaoLista() {
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState('');
  useEffect(() => {
    let ativo = true;
    void (async () => {
      try {
        const d = (await ler(await adminFetch('/api/admin/configuracoes/saloes', { cache: 'no-store' }))).data as Dados;
        if (ativo) setDados(d);
      } catch (e) {
        if (ativo) setErro(e instanceof Error ? e.message : 'Não foi possível carregar os salões.');
      }
    })();
    return () => { ativo = false; };
  }, []);

  return <main className={ws.page} data-admin-workspace>
    <header className={ws.header}><div><h1>Salões</h1><p className={ws.muted}>Como cada salão vai aparecer para o cliente: fotos, capacidade, o que tem e o que é só da festa.{dados?.instalacao === 'COMPLETA' ? ` ${avisoPaginaPublica(dados.paginaPublica === true)}` : ''}</p></div></header>
    <div className={ws.content}>
      {erro && <p role="alert">{erro}</p>}
      {!dados && !erro && <p className={ws.muted}>Carregando…</p>}
      {dados?.instalacao === 'AUSENTE' && <p className={css.aviso}>A apresentação dos salões ainda não está disponível neste ambiente.</p>}
      {dados?.instalacao === 'PARCIAL' && <p role="alert">A apresentação dos salões está temporariamente indisponível.</p>}
      {dados?.instalacao === 'COMPLETA' && <section className={ws.card} aria-labelledby="lista-saloes">
        <h2 id="lista-saloes">Salões ativos</h2>
        {dados.saloes.length === 0
          ? <p className={ws.muted}>Nenhum salão cadastrado. Cadastre os salões em <Link href="/admin/configuracoes/agenda">Configurações › Agenda</Link>.</p>
          : <div className={css.lista}>
            {dados.saloes.map((s) => <div className={css.salaoLinha} key={s.id}>
              <span><strong>{s.nome}</strong>{s.unidade ? ` · ${s.unidade}` : ''}<br />
                <span className={ws.muted}>{s.capacidadeConvidados ? `até ${s.capacidadeConvidados} convidados · ` : ''}{s.fotos} foto(s)</span></span>
              <span className={s.pronto ? css.ok : css.falta}>{s.pronto ? '✓ Pronto para o cliente' : `${s.pendencias} pendência(s)`}</span>
              <Link href={`/admin/configuracoes/saloes/${s.id}`}>{dados.gestao ? 'Editar' : 'Ver'}</Link>
            </div>)}
          </div>}
        <p className={ws.muted}>Nome, máximo de convidados e salões novos são cadastrados em <Link href="/admin/configuracoes/agenda">Configurações › Agenda</Link>.</p>
      </section>}
    </div>
  </main>;
}
