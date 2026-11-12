'use client';
import Link from 'next/link';
import { AdminIcon, type AdminIconName } from '@/components/admin/AdminIcon';
import hub from '@/components/admin/configuracoes.module.css';
import { configuracaoVisivel } from '@/lib/admin/navegacao';
import { usePermissoesAdmin } from './PermissoesAdmin';

export type CartaoConfiguracao = { route: string; title: string; text: string; icon: AdminIconName };

/** Só os cartões que a conta pode abrir (D7): os da empresa exigem Gestão; os da plataforma, a autoridade de plataforma. */
export default function CartoesConfiguracoes({ cards }: { cards: CartaoConfiguracao[] }) {
  const permissoes = usePermissoesAdmin();
  const visiveis = cards.filter((card) => configuracaoVisivel('/admin/configuracoes/' + card.route, permissoes));
  return <div className={hub.grid}>{visiveis.map(card => <section className={hub.card} key={card.route}><span className={hub.icon}><AdminIcon name={card.icon} size={20} /></span><h2>{card.title}</h2><p>{card.text}</p><Link href={'/admin/configuracoes/'+card.route}>Abrir {card.title.toLocaleLowerCase('pt-BR')}</Link></section>)}</div>;
}
