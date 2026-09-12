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
      ...["/admin/:path*", "/clientes/:path*", "/contrato/:path*", "/api/:path*"].map(
        (source) => ({
          source,
          headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
        }),
      ),
    ];
  },
};

export default nextConfig;
