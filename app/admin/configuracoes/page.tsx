import CartoesConfiguracoes, { type CartaoConfiguracao } from '@/components/admin/CartoesConfiguracoes';
import styles from '@/components/admin/workspace.module.css';

const cards: CartaoConfiguracao[] = [
  { route:'perfil-empresa', title:'Perfil da empresa', text:'Cadastro da empresa, endereço da unidade, contatos e chave Pix de recebimento.', icon:'profile' },
  { route:'agenda', title:'Agenda', text:'Horários de festa, salões, quantas festas por dia e o intervalo entre elas, por unidade.', icon:'calendar' },
  { route:'pacotes', title:'Pacotes', text:'Nome, duração, dias, preços e o que está incluído. O histórico das festas já contratadas permanece.', icon:'packages' },
  { route:'importar-documentos', title:'Importar documentos', text:'Envie em PDF a tabela de preços, o contrato da loja ou o contrato antigo de uma festa: o Kidmais lê e você revisa.', icon:'pdf' },
  { route:'catalogo', title:'Itens do Buffet', text:'Categorias e itens do buffet usados na composição dos pacotes.', icon:'buffet' },
  { route:'acessos', title:'Usuários e acessos', text:'Gerencie contas e os acessos disponíveis no sistema e na operação das festas.', icon:'users' },
  { route:'creditos', title:'Créditos de IA', text:'Créditos de convite e do WhatsApp.AI: saldo, pacotes, pedidos, devoluções e extrato.', icon:'wallet' },
  { route:'whatsapp', title:'WhatsApp', text:'Conecte o WhatsApp Business da empresa ao Kidmais pelo fluxo oficial da Meta.', icon:'contact' },
];

export default function Page() {
  return <main className={styles.page} data-admin-workspace><header className={styles.header}><h1>Configurações</h1></header><div className={styles.content}><CartoesConfiguracoes cards={cards} /></div></main>;
}
