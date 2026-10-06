import Link from 'next/link';
import { AdminIcon, type AdminIconName } from '@/components/admin/AdminIcon';
import styles from '@/components/admin/workspace.module.css';
import hub from '@/components/admin/configuracoes.module.css';

const cards: { route: string; title: string; text: string; icon: AdminIconName }[] = [
  { route:'perfil-empresa', title:'Perfil da empresa', text:'Cadastro da empresa, endereço da unidade e contatos.', icon:'profile' },
  { route:'pacotes', title:'Pacotes', text:'Nome, duração, dias, preços e o que está incluído. O histórico das festas já contratadas permanece.', icon:'packages' },
  { route:'catalogo', title:'Itens do Buffet', text:'Categorias e itens do buffet usados na composição dos pacotes.', icon:'buffet' },
  { route:'pix', title:'Recebimento por Pix', text:'Chave Pix da empresa para o Pix copia e cola das parcelas. O valor cai direto na conta da empresa.', icon:'contact' },
  { route:'acessos', title:'Usuários e acessos', text:'Gerencie contas e os acessos disponíveis no sistema e na operação das festas.', icon:'users' },
  { route:'whatsapp', title:'WhatsApp', text:'Consulte o estado da configuração e as opções de conexão disponíveis.', icon:'contact' },
  { route:'tabela-pacotes', title:'PDF de Pacotes', text:'Revise e publique o documento consultado pelos clientes. Sua publicação é independente dos preços.', icon:'pdf' },
];

export default function Page() {
  return <main className={styles.page} data-admin-workspace><header className={styles.header}><h1>Configurações</h1></header><div className={styles.content}><div className={hub.grid}>{cards.map(card => <section className={hub.card} key={card.route}><span className={hub.icon}><AdminIcon name={card.icon} size={20} /></span><h2>{card.title}</h2><p>{card.text}</p><Link href={'/admin/configuracoes/'+card.route}>Abrir {card.title.toLocaleLowerCase('pt-BR')}</Link></section>)}</div></div></main>;
}
