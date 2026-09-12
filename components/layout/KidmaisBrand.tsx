import Image from "next/image";
import Link from "next/link";
import styles from "./KidmaisBrand.module.css";

type KidmaisBrandProps = {
  compact?: boolean;
  subtitle?: string;
  href?: string;
  context?: "manager" | "customer";
};

export default function KidmaisBrand({
  compact = false,
  subtitle,
  href,
  context = "manager",
}: KidmaisBrandProps) {
  const isManager = context === "manager";
  const effectiveSubtitle =
    subtitle ?? (isManager ? "Gestão de clientes e festas" : "");

  const content = (
    <>
      <Image
        className={styles.logo}
        src="/assets/kidmais-logo-horizontal.png"
        alt="Kidmais"
        width={2048}
        height={878}
        priority
      />

      {isManager ? (
        <span className={styles.copy}>
          <strong className={styles.title}>Manager</strong>
          {!compact && effectiveSubtitle ? (
            <span className={styles.subtitle}>{effectiveSubtitle}</span>
          ) : null}
        </span>
      ) : effectiveSubtitle ? (
        <span className={styles.customerSubtitle}>{effectiveSubtitle}</span>
      ) : null}
    </>
  );

  const className = `${styles.brand} ${styles[context]} ${compact ? styles.compact : ""}`.trim();
  const ariaLabel = isManager ? "Kidmais Manager" : "Kidmais";

  // Segurança de navegação: a marca só vira link quando a rota é
  // fornecida explicitamente pela tela. Nas telas do cliente, não passar href.
  return href ? (
    <Link className={className} href={href} aria-label={ariaLabel}>
      {content}
    </Link>
  ) : (
    <div className={className} aria-label={ariaLabel}>
      {content}
    </div>
  );
}
