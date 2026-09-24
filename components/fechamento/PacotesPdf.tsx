"use client";

import { useEffect, useState } from "react";
import styles from "./PacotesPdf.module.css";

export default function PacotesPdf() {
  const [disponivel, setDisponivel] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/fechamentos/tabela-pacotes", {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((resposta) => {
        if (!controller.signal.aborted) setDisponivel(resposta.ok);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDisponivel(false);
      });
    return () => controller.abort();
  }, []);

  if (!disponivel) return null;

  return (
    <aside className={styles.card} aria-label="Tabela de pacotes e preços">
      <span className={styles.caption}>Conheça as possibilidades</span>
      <a className={styles.primary} href="/api/fechamentos/tabela-pacotes" target="_blank" rel="noopener noreferrer">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" />
          <path d="M14 3v5h5M8 12h8M8 16h6" />
        </svg>
        Ver pacotes e preços
        <span aria-hidden="true">↗</span>
        <span className={styles.srOnly}> (PDF, abre em nova aba)</span>
      </a>
      <div className={styles.secondary}>
        <span>PDF · abre em nova aba</span>
        <a href="/api/fechamentos/tabela-pacotes?download=1" download="pacotes-e-precos.pdf">Baixar PDF</a>
      </div>
    </aside>
  );
}
