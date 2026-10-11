import { numeroParaMoeda } from "./calculos";
import type { PacoteExibido } from "./pacotes-tela";
import styles from "./FechamentoWizard.module.css";

/**
 * Cartões da etapa “Escolha o pacote”. `itens` nulo = ainda carregando os pacotes da empresa (ou falhou, com
 * `falha`); lista vazia = a empresa não tem pacote para orçamento online. Nenhum dos três estados mostra pacote
 * que não veio em `itens`.
 */
export default function EscolhaPacote({ itens, falha, selecionado, onEscolher, onTentarNovamente }: {
  itens: PacoteExibido[] | null;
  falha: boolean;
  selecionado: string;
  onEscolher: (item: PacoteExibido) => void;
  onTentarNovamente: () => void;
}) {
  if (!itens) {
    if (falha)
      return (
        <div className={styles.warningBox} role="alert">
          <strong>Não foi possível carregar os pacotes agora.</strong>
          <p>Tente novamente em instantes.</p>
          <button type="button" className={styles.secondaryButton} onClick={onTentarNovamente}>Tentar novamente</button>
        </div>
      );
    return (
      <div className={styles.infoBox} role="status">
        <strong>Carregando os pacotes…</strong>
      </div>
    );
  }
  if (!itens.length)
    return (
      <div className={styles.infoBox} role="status">
        <strong>Nenhum pacote disponível para orçamento online no momento.</strong>
        <p>Entre em contato com o buffet para consultar as opções.</p>
      </div>
    );
  return (
    <div className={styles.packageGrid}>
      {itens.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${styles.packageCard} ${selecionado === item.id ? styles.packageSelected : ""}`}
          onClick={() => onEscolher(item)}
        >
          {item.destaque && (
            <span className={styles.packageBadge}>{item.destaque}</span>
          )}
          <span className={styles.radioVisual}>
            {selecionado === item.id ? "✓" : ""}
          </span>
          <strong>{item.nome}</strong>
          <b>{item.preco == null ? "Sob consulta" : `A partir de ${numeroParaMoeda(item.preco)}`}</b>
          <p>{item.descricao}</p>
          {item.disponibilidade ? <small>{item.disponibilidade}</small> : null}
          <span className={styles.selectText}>
            {selecionado === item.id ? "Selecionado" : "Selecionar"}
          </span>
        </button>
      ))}
    </div>
  );
}
