import { notFound } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import ResumoContratacao from "@/components/admin/ResumoContratacao";
import { fonteAdmin } from "@/components/admin/fonte";
import { montarResumo, type PainelResumo } from "@/components/admin/resumo-contratacao";

/** Vitrine do Resumo da Contratação (Baixar PDF / Imprimir). Dados fictícios. Só com KIDMAIS_PREVIEW_UX=1. */
const snapshot = {
  schemaVersao: 1, fechamento: { id: "fechamento-vitrine", status: "CONTRATO_ASSINADO", origem: "ATENDIMENTO_KIDMAIS" },
  contratante: { clienteId: "c", nomeCompleto: "Cliente Fictício da Silva", cpf: null, rg: null, telefone: null, whatsapp: null, email: null, endereco: { cep: "", logradouro: "", numero: "", complemento: null, bairro: "", cidade: "", uf: "" } },
  responsavelAdicional: null, aniversariante: { id: "a", nome: "Aniversariante Fictício", dataNascimento: null, idadeNoEvento: 7, temaFesta: "Espaço" },
  evento: { data: "2027-06-26", horarioInicio: "11:00:00", horarioFim: "15:00:00", pacote: { id: "p", codigo: "COMPLETA", nome: "Festa Completa", duracaoMinutos: 240 }, convidados: 55, convidadosFaturados: 60 },
  contratacao: { adicionais: [{ adicionalId: "ad", nome: "Adicional fictício", unidadeCobranca: "unidade", quantidade: 2, valorUnitario: 50, valorTotal: 100, observacoes: null }], alteracoesPacote: null, observacoesCliente: "Sem amendoim", observacoesEquipe: null, buffet: { status: "PENDENTE", salgados: null, bebidas: null, doces: null, bolo: null, outros: null } },
  comercial: { tabelaPreco: { id: "t", codigo: "t", nome: "Tabela" }, categoriaHorario: "PADRAO", categoriaPrecoAplicada: "PADRAO", valorPacoteBase: 8711, descontoPercentual: 0, valorDescontoPacote: 0, valorPacoteAplicado: 8711, valorAdicionais: 100, valorTabela: 8811, valorNegociado: null, valorAprovado: null, valorFinalContrato: 8811, formaPagamentoPretendida: "PIX_AVISTA" },
};
const painel = {
  contrato: { id: "contrato-vitrine", fechamento_id: "fechamento-vitrine", status: "ASSINADO" },
  fluxo: { versao_vigente_id: "v1", versao_em_preparacao_id: null },
  versoes: [{ id: "v1", numero_versao: 1, status: "ASSINADA", estado_edicao: "CONCLUIDA", snapshot }],
  assinaturas: [], financeiro: [],
} as unknown as PainelResumo;

export default function Page() {
  if (process.env.KIDMAIS_PREVIEW_UX !== "1") notFound();
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: "Administrador", caminho: "/admin/contratos" }}>
      <ResumoContratacao vitrine={montarResumo(painel)} />
    </AdminShell>
  </div>;
}
