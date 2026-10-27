import { useState } from "react";
import { ATALHOS_CONVIDADOS } from "@/lib/fechamentos/convidados";
import styles from "./FechamentoWizard.module.css";

/**
 * S-C: "80 convidados · alterar" no topo do Pacote e do Valor quando o número veio da disponibilidade (a etapa
 * Convidados não aparece). O editor usa a mesma validação da etapa; `validar` devolve a mensagem de erro ou null.
 */
export default function ConvidadosChip({ convidados, validar, onAlterar }: {
  convidados: number;
  validar: (quantidade: number) => string | null;
  onAlterar: (quantidade: number) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(String(convidados));
  const [erro, setErro] = useState("");

  function aplicar(quantidade: number) {
    const mensagem = validar(quantidade);
    if (mensagem) { setErro(mensagem); return; }
    setErro("");
    setEditando(false);
    if (quantidade !== convidados) onAlterar(quantidade);
  }

  if (!editando)
    return (
      <div className={styles.guestChip}>
        <span><strong>{convidados} convidados</strong> pagantes (crianças e adultos)</span>
        <button type="button" onClick={() => { setTexto(String(convidados)); setErro(""); setEditando(true); }}>alterar</button>
      </div>
    );

  return (
    <div className={styles.guestEditor}>
      <label className={styles.field}>
        <span>Quantos convidados pagantes? (crianças e adultos)</span>
        <input
          type="number"
          min={1}
          max={150}
          inputMode="numeric"
          value={texto}
          onChange={(e) => { setTexto(e.target.value); setErro(""); }}
          aria-invalid={Boolean(erro)}
        />
      </label>
      <div className={styles.quickChoices}>
        {ATALHOS_CONVIDADOS.map((qtd) => (
          <button type="button" key={qtd} onClick={() => aplicar(qtd)}>{qtd}</button>
        ))}
      </div>
      {erro ? <div className={styles.warningBox} role="alert"><p>{erro}</p></div> : null}
      <div className={styles.guestEditorActions}>
        <button type="button" className={styles.primaryButton} onClick={() => aplicar(Number(texto))}>Aplicar</button>
        <button type="button" className={styles.secondaryButton} onClick={() => { setEditando(false); setErro(""); }}>Cancelar</button>
      </div>
    </div>
  );
}
