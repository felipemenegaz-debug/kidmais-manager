import type { ButtonHTMLAttributes } from "react";
import styles from "./visual.module.css";

export const classePrimaria = styles.primario;
/** Marca usada por folhas com regras genéricas de `button` (ex.: workspace) para não sobrescrever a ação canônica. */
export const marcaPrimaria = { "data-km-primario": "" } as const;

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Mostra o indicador de progresso sem trocar o rótulo nem o tamanho do botão; também bloqueia novo clique. */
  carregando?: boolean;
};

export function AdminPrimaryButton({ className, type = "button", carregando = false, disabled, ...props }: Props) {
  return <button
    type={type}
    className={className ? `${styles.primario} ${className}` : styles.primario}
    disabled={disabled || carregando}
    aria-busy={carregando || undefined}
    {...marcaPrimaria}
    {...props}
  />;
}
