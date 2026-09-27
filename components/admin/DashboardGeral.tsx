'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import { reaisDe } from '@/lib/financeiro/calculos';
import styles from './dashboard.module.css';

type Festa = { id: string; data: string; cliente: string; pacote: string; convidados: number; status: string; hora: string };
type Atencao = { tom: 'alerta' | 'aviso'; titulo: string; detalhe: string; href: string };
export type PainelDashboard = {
  empresa: string;
  hoje: string;
  numeros: { recebidoMesCentavos: number; aReceberCentavos: number; aPagarCentavos: number; emAtrasoCentavos: number; saldoPrevistoCentavos: number };
  agenda: Festa[];
  proximas: Festa[];
  atencao: Atencao[];
  contratosPendentes: number;
  festasProximas: number;
  realizadas: number;
  futuras: number;
  ticketCentavos: number;
  pacote: string;
};

function rotulo(status: string) {
  if (status === 'ASSINADO') return 'Confirmada';
  if (status === 'AGUARDANDO_ASSINATURA') return 'Pendente';
  if (status === 'CANCELADO') return 'Cancelada';
  return status;
}

function classe(status: string) {
  if (status === 'ASSINADO') return styles.ok;
  if (status === 'CANCELADO') return styles.cancelada;
  return styles.pendente;
}

function classeTexto(status: string) {
  if (status === 'ASSINADO') return styles.textoOk;
  if (status === 'CANCELADO') return styles.textoCancelada;
  return styles.textoPendente;
}

function hora(valor: string) {
  return String(valor ?? '').slice(0, 5);
}

function dataCurta(valor: string) {
  const data = new Date(`${valor.slice(0, 10)}T12:00:00Z`);
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'America/Sao_Paulo' }).replace('.', '');
}

function dataLonga(valor: string) {
  return new Date(`${valor.slice(0, 10)}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
}

export default function DashboardGeral({ inicial }: { inicial?: PainelDashboard }) {
  const [painel, setPainel] = useState<PainelDashboard | null>(inicial ?? null);
  const [erro, setErro] = useState('');
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    if (inicial) return;
    let ativo = true;
    adminFetch('/api/admin/dashboard').then((resposta) => resposta.json()).then((corpo) => {
      if (!ativo) return;
      if (corpo.ok) setPainel(corpo.data);
      else setErro(corpo.erro || 'Não foi possível carregar o dashboard.');
    }).catch(() => { if (ativo) setErro('Não foi possível carregar o dashboard.'); });
    return () => { ativo = false; };
  }, [inicial, tentativa]);

  if (erro) return <main className={styles.pagina}><p className={styles.erro} role="alert">{erro}</p><button type="button" onClick={() => { setErro(''); setTentativa((n) => n + 1); }}>Tentar novamente</button></main>;
  if (!painel) return <main className={styles.pagina} aria-busy="true"><p>Carregando o dia…</p></main>;

  return <main className={styles.pagina}>
    <header className={styles.topo}>
      <div>
        <h1>Dashboard</h1>
        <p>Visão geral da operação</p>
      </div>
      <div className={styles.empresa}>
        <strong>{painel.empresa}</strong>
        <small>{dataLonga(painel.hoje)}</small>
      </div>
    </header>
    <div className={styles.grade}>
      <section className={styles.kpis} aria-label="Indicadores">
        <article className={styles.kpi}><strong>{painel.festasProximas}</strong><span>Festas próximas</span></article>
        <article className={styles.kpi}><strong>{painel.contratosPendentes}</strong><span>Contratos pendentes</span></article>
        <article className={`${styles.kpi} ${styles.receber}`}><strong>{reaisDe(painel.numeros.aReceberCentavos)}</strong><span>A receber</span></article>
        <article className={`${styles.kpi} ${styles.atraso}`}><strong>{reaisDe(painel.numeros.emAtrasoCentavos)}</strong><span>Em atraso</span></article>
      </section>

      <section className={`${styles.cartao} ${styles.largo} ${styles.agenda}`}>
        <div className={styles.cabeca}><h2 className={styles.lilas}>Agenda de hoje</h2><Link href="/admin/disponibilidade">Ver agenda completa</Link></div>
        {painel.agenda.length === 0 && <p className={styles.vazio}>Nenhuma festa hoje.</p>}
        {painel.agenda.map((festa) => <Link key={festa.id} className={styles.linha} href={`/admin/festas/${festa.id}`}>
          <div className={styles.hora}><strong>{hora(festa.hora)}</strong><span>Início</span></div>
          <div className={styles.cresce}><p>{festa.pacote} — {festa.cliente}</p><small>{festa.convidados} convidados</small></div>
          <span className={`${styles.selo} ${classe(festa.status)}`}>{rotulo(festa.status)}</span>
        </Link>)}
      </section>

      <section className={`${styles.cartao} ${styles.estreito} ${styles.atencaoBloco}`}>
        <h2 className={styles.alertaTitulo}>Precisa de atenção</h2>
        {painel.atencao.length === 0 && <p className={styles.vazio}>Nada pendente por aqui.</p>}
        <div className={styles.atencao}>
          {painel.atencao.map((item) => <Link key={item.titulo} href={item.href}>
            <span className={`${styles.ponto} ${item.tom === 'alerta' ? styles.vermelho : styles.amarelo}`} aria-hidden="true" />
            <div className={styles.cresce}><p>{item.titulo}</p><small>{item.detalhe}</small></div>
          </Link>)}
        </div>
      </section>

      <section className={`${styles.cartao} ${styles.largo} ${styles.festas}`}>
        <h2>Próximas festas</h2>
        {painel.proximas.length === 0 && <p className={styles.vazio}>Nenhuma festa marcada.</p>}
        <table className={styles.tabela}>
          <thead><tr><th>Data</th><th>Cliente</th><th>Pacote</th><th>Convidados</th><th>Status</th></tr></thead>
          <tbody>
            {painel.proximas.map((festa) => <tr key={festa.id}>
              <td><Link href={`/admin/festas/${festa.id}`}>{dataCurta(festa.data)}</Link></td>
              <td>{festa.cliente}</td><td>{festa.pacote}</td><td>{festa.convidados}</td>
              <td className={classeTexto(festa.status)}>{rotulo(festa.status)}</td>
            </tr>)}
          </tbody>
        </table>
        <div className={styles.cards}>
          {painel.proximas.map((festa) => <Link key={festa.id} className={styles.festaCard} href={`/admin/festas/${festa.id}`}>
            <div className={styles.cresce}><p>{dataCurta(festa.data)} — {festa.cliente}</p><small>{festa.pacote} · {festa.convidados} conv</small></div>
            <span className={classe(festa.status)}>{rotulo(festa.status)}</span>
          </Link>)}
        </div>
      </section>

      <section className={`${styles.cartao} ${styles.estreito} ${styles.resumo}`}>
        <h2>Resumo financeiro</h2>
        <div className={styles.resumoLinha}><span>Recebido no mês</span><strong>{reaisDe(painel.numeros.recebidoMesCentavos)}</strong></div>
        <div className={styles.resumoLinha}><span>A receber</span><strong>{reaisDe(painel.numeros.aReceberCentavos)}</strong></div>
        <div className={styles.resumoLinha}><span>A pagar</span><strong>{reaisDe(painel.numeros.aPagarCentavos)}</strong></div>
        <div className={`${styles.resumoLinha} ${styles.saldo}`}><span className={styles.verde}>Saldo previsto</span><strong>{reaisDe(painel.numeros.saldoPrevistoCentavos)}</strong></div>
        <Link className={styles.botao} href="/admin/financeiro">Ver financeiro</Link>
      </section>

      <section className={`${styles.cartao} ${styles.meio} ${styles.mes}`}>
        <h2>Este mês</h2>
        <div className={styles.mesGrade}>
          <div><strong>{painel.realizadas}</strong><p>Festas realizadas</p></div>
          <div><strong>{painel.futuras}</strong><p>Festas futuras</p></div>
          <div><strong>{reaisDe(painel.ticketCentavos)}</strong><p>Ticket médio</p></div>
          <div><strong className={styles.lilas}>{painel.pacote}</strong><p>Pacote mais contratado</p></div>
        </div>
      </section>

      <section className={`${styles.cartao} ${styles.meio} ${styles.acoesCard}`}>
        <h2>Ações rápidas</h2>
        <div className={styles.acoes}>
          <Link href="/clientes">Novo cliente</Link>
          <Link href="/admin/disponibilidade">Consultar disponibilidade</Link>
          <Link href="/admin/financeiro/contas-receber">Registrar pagamento</Link>
        </div>
      </section>
    </div>
    <nav className={styles.base} aria-label="Atalhos">
      <Link href="/admin/dashboard" aria-current="page">Início</Link>
      <Link href="/admin/disponibilidade">Agenda</Link>
      <Link href="/clientes">Clientes</Link>
      <Link href="/admin/financeiro">Finanças</Link>
    </nav>
  </main>;
}
