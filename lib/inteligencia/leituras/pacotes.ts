import type { RespostaLeitura } from "../contratos.ts";
import type { Ferramenta, PacoteDominio } from "../ferramentas.ts";
import { PAPEIS_ADMIN, ausencia, evidencia, fato, montarResposta, plural, semParametros } from "./comum.ts";

/**
 * `pacotes_disponiveis` (Agente de Atendimento): pacotes ATIVOS e vigentes desta empresa, pelo serviço de
 * domínio (`listarPacotesAdmin`, empresa comprovada no WHERE). Descrição, duração, faixa de convidados e dias.
 * Preço nunca: segue a tabela vigente (o Kidmais não informa nem negocia preço fora dela).
 */
const FONTE = "comercial.pacotes";
const DESTINO = "/admin/configuracoes/pacotes";
const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function duracao(minutos: number | null) {
  if (!minutos) return null;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h && m ? `${h}h${String(m).padStart(2, "0")}` : h ? `${h}h` : `${m}min`;
}

function convidados(p: PacoteDominio) {
  if (p.convidadosMinimos && p.convidadosMaximos) return `${p.convidadosMinimos} a ${p.convidadosMaximos} convidados`;
  if (p.convidadosMaximos) return `até ${p.convidadosMaximos} convidados`;
  if (p.convidadosMinimos) return `a partir de ${p.convidadosMinimos} convidados`;
  return null;
}

export function montarPacotesDisponiveis(pacotes: readonly PacoteDominio[], contexto: Parameters<typeof montarResposta>[1]): RespostaLeitura {
  const ativos = pacotes.filter((p) => p.ativo && p.vigente && !p.arquivadoEm);
  const precos = ausencia("Preços seguem a tabela vigente em Configurações › Pacotes; o Kidmais não informa preço fora dela.", FONTE);
  if (!ativos.length) {
    return montarResposta("pacotes_disponiveis", contexto, { estado: "sem_dados", resumo: "Nenhum pacote ativo nesta empresa.", fatos: [ausencia("Nenhum pacote ativo e vigente cadastrado.", FONTE), precos], fontes: [FONTE] });
  }
  return montarResposta("pacotes_disponiveis", contexto, {
    estado: "informativo",
    resumo: `${ativos.length} ${plural(ativos.length, "pacote ativo", "pacotes ativos")}.`,
    fatos: [
      ...ativos.map((p) => fato(`${p.nome}: ${[duracao(p.duracaoMinutos), convidados(p), p.diasPermitidos.length ? p.diasPermitidos.map((d) => DIAS[d] ?? String(d)).join(", ") : null].filter(Boolean).join(" · ") || "sem detalhes cadastrados"}.`, FONTE)),
      precos,
    ],
    itens: ativos.map((p, i) => ({ id: `pacote_${i}`, prioridade: "baixa" as const, titulo: p.nome, detalhe: p.descricao ?? "Sem descrição cadastrada.", destino: DESTINO })),
    evidencias: [evidencia(FONTE, "Pacotes ativos", ativos.length, DESTINO)],
    fontes: [FONTE],
  });
}

export const pacotesDisponiveis: Ferramenta<RespostaLeitura> = {
  nome: "comercial.pacotes.listar",
  capacidade: "pacotes_disponiveis",
  classe: "READ",
  grupo: "READ",
  papeis: PAPEIS_ADMIN,
  descricao: "Pacotes ativos desta empresa: descrição, duração, faixa de convidados e dias (sem preço).",
  preparar(parametros) {
    semParametros.parse(parametros ?? {});
    return async (tx, tenant, contexto) => {
      if (!contexto.portas.pacotes) {
        return montarResposta("pacotes_disponiveis", contexto, { estado: "sem_dados", resumo: "A lista de pacotes não está disponível agora.", fatos: [ausencia("Serviço de pacotes indisponível para a IA.", FONTE)], fontes: [FONTE] });
      }
      return montarPacotesDisponiveis(await contexto.portas.pacotes.listar(tx, tenant.empresaComprovada), contexto);
    };
  },
};
