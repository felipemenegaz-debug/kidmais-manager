import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pesquisa da festa",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/** Pesquisa pública de satisfação (sem login). Cabeçalhos de segurança da rota em next.config.ts (/p/:path*). */
export default function PesquisaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
