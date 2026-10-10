import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kidmais Manager",
  description: "Gestão de clientes, festas e disponibilidade da Kidmais.",
  // Mesmo <link rel="icon" href="/favicon.ico" sizes="any"> de antes (arquivo agora em public/), declarado aqui para
  // que os endereços públicos de outras empresas (/b/<código>) possam substituí-lo por um ícone neutro.
  icons: { icon: [{ url: "/favicon.ico", sizes: "any" }] },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
