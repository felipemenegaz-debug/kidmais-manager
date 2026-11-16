import type { NextConfig } from "next";

const headersSeguranca = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
    : []),
];

// 'unsafe-inline' em script/style: o App Router injeta scripts e estilos inline de hidratação (sem nonce). 'unsafe-eval'
// só no next dev (React Refresh). Nenhuma origem de terceiros em nenhuma diretiva.
const cspPesquisa = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  distDir: process.env.KIDMAIS_FESTA_ISOLADO === 'true'
    ? (process.env.NODE_ENV === 'production' ? '.next-festa' : process.env.KIDMAIS_FESTA_AMBIENTE === 'manual' ? '.next-festa-manual' : process.env.KIDMAIS_FESTA_AMBIENTE === 'automated' ? '.next-festa-auto' : '.next-festa-dev')
    : '.next',
  allowedDevOrigins: ["100.112.40.14"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: headersSeguranca,
      },
      ...["/admin/:path*", "/desenvolvedor/:path*", "/acesso/:path*", "/clientes/:path*", "/contrato/:path*", "/convite/:path*", "/convites/:path*", "/api/:path*"].map(
        (source) => ({
          source,
          headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
        }),
      ),
      // Pesquisa pública de satisfação (110, PS-1): sem cache, sem indexação, sem Referer e sem nada de terceiros (o token
      // fica no fragmento; a CSP limita scripts, estilos, fontes e conexões à própria origem).
      {
        source: "/p/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Content-Security-Policy", value: cspPesquisa },
        ],
      },
    ];
  },
};

export default nextConfig;
