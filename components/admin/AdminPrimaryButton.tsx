import type { ButtonHTMLAttributes } from "react";
import styles from "./visual.module.css";

export const classePrimaria = styles.primario;

export function AdminPrimaryButton({ className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={className ? `${styles.primario} ${className}` : styles.primario} {...props} />;
}
