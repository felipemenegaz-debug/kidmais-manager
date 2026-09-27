import Link from 'next/link';
import { AdminIcon, type AdminIconName } from '@/components/admin/AdminIcon';
import styles from '@/components/admin/workspace.module.css';
import hub from '@/components/admin/configuracoes.module.css';

const cards: { route: string; title: string; text: string; icon: AdminIconName }[] = [
  { route:'perfil-empresa', title:'Perfil da Empresa', text:'Cadastro da empresa, endereço da unidade e contatos. Revise as alterações antes de aplicar.', icon:'profile' },
  { route:'pacotes', title:'Pacotes', text:'Gerencie pacotes, duração e composição. Alterações preservam as revisões já utilizadas.', icon:'packages' },
  { route:'tabelas-preco', title:'Tabelas de Preços', text:'Consulte vigências, escopo comercial, preços e pendências antes da publicação.', icon:'prices' },
  { route:'catalogo', title:'Itens de Buffet e Adicionais', text:'Consulte o catálogo e configure os itens permitidos para os pacotes da empresa.', icon:'buffet' },
  { route:'acessos', title:'Usuários e Acessos', text:'Gerencie contas e os acessos disponíveis no sistema e na operação das festas.', icon:'users' },
  { route:'whatsapp', title:'WhatsApp', text:'Consulte o estado da configuração e as opções de conexão disponíveis.', icon:'contact' },
  { route:'tabela-pacotes', title:'PDF de Pacotes e Preços', text:'Revise e publique o documento consultado pelos clientes. Sua publicação é independente dos preços.', icon:'pdf' },
];

export default function Page() {
  return <main className={styles.page} data-admin-workspace><header className={styles.header}><h1>Configurações</h1></header><div className={styles.content}><div className={hub.grid}>{cards.map(card => <section className={hub.card} key={card.route}><span className={hub.icon}><AdminIcon name={card.icon} size={20} /></span><h2>{card.title}</h2><p>{card.text}</p><Link href={'/admin/configuracoes/'+card.route}>Abrir {card.title.toLocaleLowerCase('pt-BR')}</Link></section>)}</div></div></main>;
}
