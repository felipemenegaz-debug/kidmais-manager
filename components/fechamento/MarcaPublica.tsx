"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import KidmaisBrand from "@/components/layout/KidmaisBrand";
import { MARCA_KIDMAIS, textosMarca, type MarcaPublica } from "@/lib/fechamentos/marca-publica";
import type { RegrasPagamento } from "@/lib/comercial/regras-pagamento";
import styles from "./MarcaPublica.module.css";

const Contexto = createContext<MarcaPublica>(MARCA_KIDMAIS);

/** Só os endereços /b/<código> usam o provedor; sem ele, as telas continuam com a marca Kidmais. */
export function MarcaPublicaProvider({ nome, pagamento, children }: { nome: string; pagamento: RegrasPagamento; children: ReactNode }) {
  const valor = useMemo<MarcaPublica>(() => ({ kidmais: false, nome, pagamento }), [nome, pagamento]);
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useMarcaPublica() {
  const marca = useContext(Contexto);
  return useMemo(() => textosMarca(marca), [marca]);
}

/** Cabeçalho do cliente: logo Kidmais no endereço atual; nome da empresa, sem logo, nos demais. */
export function MarcaPublicaCabecalho({ subtitle }: { subtitle?: string }) {
  const marca = useMarcaPublica();
  if (marca.kidmais) return <KidmaisBrand context="customer" subtitle={subtitle} />;
  return (
    <div className={styles.marca} aria-label={marca.nome}>
      <strong className={styles.nome}>{marca.nome}</strong>
      {subtitle ? <span className={styles.subtitulo}>{subtitle}</span> : null}
    </div>
  );
}
