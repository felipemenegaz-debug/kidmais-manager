import { useState } from "react";
import { numeroParaMoeda } from "./calculos";
import { separarPorConvidados, type PacoteExibido } from "./pacotes-tela";
import styles from "./FechamentoWizard.module.css";

/**
 * Cartões da etapa “Escolha o pacote”. `itens` nulo = ainda carregando os pacotes da empresa (ou falhou, com
 * `falha`); lista vazia = a empresa não tem pacote para orçamento online. Nenhum dos três estados mostra pacote
 * que não veio em `itens`.
 * S-C: com `convidados`, os que comportam vêm primeiro; os demais ficam atrás de "ver mesmo assim", esmaecidos e com o
 * motivo (o servidor recusa acima do máximo, como antes).
 */
export default function EscolhaPacote({ itens, falha, selecionado, onEscolher, onTentarNovamente, convidados = null, naoComporta, salao = null }: {
  itens: PacoteExibido[] | null;
  falha: boolean;
  selecionado: string;
  onEscolher: (item: PacoteExibido) => void;
  onTentarNovamente: () => void;
  convidados?: number | null;
  naoComporta?: (id: string) => string | null;
  /** S-D: nome do salão de preferência — o contador passa a dizer "não servem no salão". */
  salao?: string | null;
}) {
  const [verTodos, setVerTodos] = useState(false);
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
  const { comportam, naoComportam } = convidados && naoComporta
    ? separarPorConvidados(itens, naoComporta)
    : { comportam: itens, naoComportam: [] as Array<PacoteExibido & { motivo: string }> };
  // O pacote já escolhido nunca some da tela, mesmo que deixe de comportar.
  const mostrarDemais = verTodos || naoComportam.some((item) => item.id === selecionado);
  const cartao = (item: PacoteExibido, motivo?: string) => (
        <button
          key={item.id}
          type="button"
          className={`${styles.packageCard} ${selecionado === item.id ? styles.packageSelected : ""} ${motivo ? styles.packageFaded : ""}`}
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
          {motivo ? <small className={styles.packageMotivo}>{motivo}</small> : null}
          <span className={styles.selectText}>
            {selecionado === item.id ? "Selecionado" : "Selecionar"}
          </span>
        </button>
  );
  return (
    <>
      {convidados && comportam.length === 0 && naoComportam.length > 0 ? (
        <div className={styles.warningBox} role="status">
          <strong>Nenhum pacote comporta {convidados} convidados.</strong>
          <p>Altere a quantidade ou veja os pacotes mesmo assim.</p>
        </div>
      ) : null}
      <div className={styles.packageGrid}>
        {comportam.map((item) => cartao(item))}
      </div>
      {naoComportam.length > 0 ? (
        <div className={styles.packageOthers}>
          <span>{salao
            ? `${naoComportam.length === 1 ? "1 pacote não serve" : `${naoComportam.length} pacotes não servem`} no ${salao} para ${convidados} convidados.`
            : <>{naoComportam.length === 1 ? "1 pacote não comporta" : `${naoComportam.length} pacotes não comportam`} {convidados} convidados.</>}</span>
          {!mostrarDemais ? (
            <button type="button" className={styles.secondaryButton} onClick={() => setVerTodos(true)}>Ver mesmo assim</button>
          ) : null}
        </div>
      ) : null}
      {mostrarDemais && naoComportam.length > 0 ? (
        <div className={styles.packageGrid}>
          {naoComportam.map((item) => cartao(item, item.motivo))}
        </div>
      ) : null}
    </>
  );
}
