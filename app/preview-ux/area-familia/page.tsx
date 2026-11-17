import { notFound } from "next/navigation";
import AreaFamilia from "@/components/area-familia/AreaFamilia";
import { MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { fonteTexto, fonteTitulo } from "@/components/site/fonte";
import type { MinhaFesta } from "@/lib/area-familia/leitura";
import { REGRAS_LEGADAS } from "@/lib/comercial/regras-pagamento";

/**
 * Superfície isolada para revisão visual da área "Minha festa" (Parte 1, visual iA.Fest). Só com KIDMAIS_PREVIEW_UX=1;
 * dados fictícios, sem banco: as ações chamam APIs que aqui não existem (nada é gravado). ?tela=entrada|logado&logo=1.
 */
const LOGO = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#b990ff"/><circle cx="32" cy="28" r="14" fill="#80f5c4"/><path d="M32 42v12" stroke="#030712" stroke-width="3"/></svg>',
).toString("base64")}`;

const DADOS: MinhaFesta = {
  festa: {
    data: "2026-12-12", horarioInicio: "15:00", horarioFim: "19:00", diasAteFesta: 26, salao: "Salão Arco-íris",
    aniversariante: "Criança Fictícia", tema: "Fundo do mar", pacote: "Alegria", convidados: 60,
    adicionais: [{ nome: "Personagem", quantidade: 1 }, { nome: "Mesa de doces", quantidade: 2 }],
    buffet: [{ campo: "Salgados", texto: "Coxinha, quibe e esfiha" }],
  },
  documentos: [{ tipo: "contrato", titulo: "Contrato da festa" }, { tipo: "resumo", titulo: "Resumo da festa" }],
  assinadoEmPapel: false,
  assinadoPeloClienteEmPapel: "Você assinou o contrato em papel em 10/11/2026. O buffet assinou eletronicamente.",
  pagamentos: {
    totalCentavos: 680000, pagoCentavos: 340000, saldoCentavos: 340000,
    parcelas: [
      { id: "p1", numero: 1, vencimento: "2026-10-10", valorCentavos: 340000, pagoCentavos: 340000, saldoCentavos: 0, estado: "PAGA", pix: false },
      { id: "p2", numero: 2, vencimento: "2026-12-01", valorCentavos: 340000, pagoCentavos: 0, saldoCentavos: 340000, estado: "EM_ABERTO", pix: true },
    ],
    proxima: { id: "p2", numero: 2, vencimento: "2026-12-01", valorCentavos: 340000, pagoCentavos: 0, saldoCentavos: 340000, estado: "EM_ABERTO", pix: true },
  },
  papel: "CONTRATANTE",
  acoes: {
    disponivel: true, avisoFixo: "Lembrete: a lista de convidados fecha 7 dias antes da festa.",
    pendencias: [{ id: "x1", texto: "Enviar a lista de convidados", prazo: "2026-12-05", feita: false, devolvida: false }],
    parcelasAvisadas: [], segundo: null,
  },
};

export default async function Page({ searchParams }: { searchParams: Promise<{ tela?: string; logo?: string }> }) {
  if (process.env.KIDMAIS_PREVIEW_UX !== "1") notFound();
  const { tela, logo } = await searchParams;
  const logado = tela !== "entrada";
  const contato = { whatsapp: { texto: "(11) 90000-0000", url: "https://wa.me/5511900000000" }, telefone: null, email: null, site: null, instagram: null };
  return (
    <MarcaPublicaProvider nome="Buffet Fictício" pagamento={{ ...REGRAS_LEGADAS }} contato={contato}>
      <div className={`${fonteTitulo.variable} ${fonteTexto.variable}`}>
        <AreaFamilia empresa="preview" sessao={logado ? { papel: "CONTRATANTE", primeiroNome: "Ana" } : null} dados={logado ? DADOS : null} logo={logo === "1" ? LOGO : null} />
      </div>
    </MarcaPublicaProvider>
  );
}
