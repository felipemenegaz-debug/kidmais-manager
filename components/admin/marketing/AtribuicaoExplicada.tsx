import Link from 'next/link';
import styles from './marketing.module.css';

/**
 * Como uma campanha chega até o contrato — fiel ao comportamento atual (utm.ts, contatos.ts e metricas.ts):
 * só o código `kc` do link da campanha atribui automaticamente; a negociação herda a origem do contato quando é
 * VINCULADA (ação manual) e ainda não tem uma; a conversão conta com contrato ASSINADO. Sem vínculo, nada é presumido.
 */
export function AtribuicaoExplicada({ aberto = false }: { aberto?: boolean }) {
  return <details className={styles.definicoes} open={aberto}>
    <summary>Como o sistema liga uma campanha a um contrato</summary>
    <ol className={styles.fluxoAtribuicao}>
      <li><strong>Link da campanha</strong> — o link gerado em <Link href="/admin/marketing/campanhas">Campanhas</Link> leva o código da campanha. Quem chega por ele e envia o formulário do site vira um contato já ligado à campanha.</li>
      <li><strong>Contato</strong> — aparece em <Link href="/admin/marketing/origens">Origens dos contatos</Link> e cria ou reaproveita o cadastro do cliente (a primeira origem de um cliente que já existia não é trocada).</li>
      <li><strong>Negociação vinculada</strong> — <em>ação da equipe</em>: abra o contato em Origens dos contatos e use “Vincular” na negociação do cliente. A negociação herda a origem do contato se ainda não tiver uma; uma origem já registrada é mantida. “Virou negociação” quer dizer só isso: ainda não há contrato.</li>
      <li><strong>Contrato assinado</strong> — quando o contrato dessa negociação é assinado, a Visão geral conta a conversão e a receita contratada da campanha. Receita recebida é outra conta: só o que foi efetivamente pago.</li>
    </ol>
    <p className={styles.muted}>O sistema não adivinha. Endereço com UTM mas sem o código da campanha fica só como informação; clique no botão de WhatsApp é contado à parte e não identifica a conversa; fechar uma festa sem vínculo não é ligado a campanha por telefone, data ou aniversário. Quando a origem for conhecida por outro meio, registre-a à mão no painel “Origem” da negociação (perfil do cliente).</p>
  </details>;
}
