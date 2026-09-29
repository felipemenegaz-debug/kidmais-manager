import { notFound } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import ImportacaoReal from "@/components/admin/importacao/ImportacaoReal";
import { fonteAdmin } from "@/components/admin/fonte";
import { extrairPorRegras } from "@/lib/importacao-contrato/extracao";
import { classificarMatch, montarPlano } from "@/lib/importacao-contrato/plano";
import { dadosNormalizados, montarRevisao } from "@/lib/importacao-contrato/rascunho";

/** Vitrine da revisão da importação real, com um contrato fictício lido pelas regras. Só com KIDMAIS_PREVIEW_UX=1. */
const PAGINAS = [
  "Contratante: Cliente Fictício da Silva\nCPF 529.982.247-25\nTelefone: (11) 98765-4321\nData do evento: 21/11/2019\nHorário: 14:00 às 18:00\nDuração: 3 horas\n80 convidados\nPacote: Festa Completa tabela 2019",
  "Valor do pacote: R$ 8.400,00\nAdicionais: R$ 500,00\nValor total: R$ 8.900,00\nEntrada de R$ 2.900,00 em 03/09/2019\nParcela 1 de R$ 5.000,00 vencimento 10/11/2019",
];

export default function Page() {
  if (process.env.KIDMAIS_PREVIEW_UX !== "1") notFound();
  const extracao = montarRevisao(extrairPorRegras(PAGINAS), PAGINAS, { nome: "contrato-ficticio.pdf", tipo: "application/pdf", tamanhoBytes: 48_213 });
  const dados = dadosNormalizados(extracao.secoes.flatMap((s) => s.campos));
  const match = classificarMatch(dados, { cpfExistente: null, possiveisDuplicidades: [{ clienteId: "00000000-0000-4000-8000-000000000001", nomeCompleto: "Cliente F. Silva", motivos: ["TELEFONE_IGUAL"] }] });
  const plano = montarPlano(extracao, [], match, null);
  return <div className={fonteAdmin.variable}>
    <AdminShell vitrine={{ nome: "Administrador", caminho: "/admin/contratos" }}>
      <ImportacaoReal vitrine={{
        etapa: "revisao",
        importacao: { id: "00000000-0000-4000-8000-00000000000a", versao: 1, status: "EM_REVISAO", extracao, revisados: [], decisaoCliente: null },
        plano: { pronto: plano.pronto, bloqueios: plano.bloqueios, avisos: plano.avisos, match: plano.match },
        avisos: ["ENVIO_EXTERNO_NAO_AUTORIZADO"],
        ocupado: false,
        erro: null,
      }} />
    </AdminShell>
  </div>;
}
