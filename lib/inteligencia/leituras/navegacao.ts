import { z } from "zod";
import type { RespostaLeitura } from "../contratos.ts";
import type { Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, fato, montarResposta } from "./comum.ts";

/**
 * `onde_encontrar` (Copiloto): navegação conceitual entre módulos — "onde eu cadastro um pacote?".
 * Não lê dado de negócio: só aponta a tela real (mesmas rotas do menu do Admin) e o que se faz nela.
 * Continua passando pelo caminho único do gateway (Policy + Tenant Context), como qualquer ferramenta.
 */
const FONTE = "kidmais.navegacao";

export const TEMAS_NAVEGACAO = {
  pacotes: { tela: "Configurações › Pacotes", destino: "/admin/configuracoes/pacotes", faz: "criar, editar, ativar ou desativar pacotes e seus preços" },
  buffet: { tela: "Configurações › Itens do Buffet", destino: "/admin/configuracoes/catalogo", faz: "ver as categorias e os itens do buffet" },
  acessos: { tela: "Configurações › Usuários e acessos", destino: "/admin/configuracoes/acessos", faz: "adicionar pessoas e ajustar o acesso de cada uma, por quem tem essa autoridade" },
  whatsapp: { tela: "Configurações › WhatsApp", destino: "/admin/configuracoes/whatsapp", faz: "ver e conectar a conta de WhatsApp da empresa" },
  pdf_pacotes: { tela: "Configurações › PDF de Pacotes", destino: "/admin/configuracoes/tabela-pacotes", faz: "publicar o PDF de pacotes que as famílias consultam" },
  perfil: { tela: "Configurações › Perfil da empresa", destino: "/admin/configuracoes/perfil-empresa", faz: "revisar e aplicar os dados cadastrais da empresa" },
  contratos: { tela: "Contratos", destino: "/admin/contratos", faz: "acompanhar assinaturas, versões e o financeiro de cada contrato" },
  importar_contrato: { tela: "Contratos › Importar contrato antigo", destino: "/admin/contratos/importar", faz: "trazer um contrato histórico, com revisão antes de gravar" },
  festas: { tela: "Festas", destino: "/admin/festas", faz: "ver cada festa, o checklist, as pendências e o histórico" },
  agenda: { tela: "Agenda", destino: "/admin/disponibilidade", faz: "ver a disponibilidade de datas e horários" },
  clientes: { tela: "Clientes", destino: "/clientes", faz: "cadastrar e consultar clientes e aniversariantes" },
  financeiro: { tela: "Financeiro › Contas a receber", destino: "/admin/financeiro/contas-receber", faz: "ver parcelas, vencimentos e recebimentos" },
  contas_pagar: { tela: "Financeiro › Contas a pagar", destino: "/admin/financeiro/contas-pagar", faz: "registrar e acompanhar as saídas da empresa" },
  dashboard: { tela: "Dashboard", destino: "/admin/dashboard", faz: "ver o resumo do dia e o que precisa de atenção" },
} as const;

export type TemaNavegacao = keyof typeof TEMAS_NAVEGACAO;

const parametros = z.object({ tema: z.enum(Object.keys(TEMAS_NAVEGACAO) as [TemaNavegacao, ...TemaNavegacao[]]) }).strict();

export const ondeEncontrar: Ferramenta<RespostaLeitura> = {
  nome: "kidmais.navegacao.onde",
  capacidade: "onde_encontrar",
  classe: "READ",
  grupo: "READ",
  papeis: PAPEIS_ADMIN,
  descricao: "Onde fica cada assunto no Kidmais (tela e o que se faz nela).",
  preparar(bruto) {
    const { tema } = parametros.parse(bruto);
    return async (_tx, _tenant, contexto) => {
      const alvo = TEMAS_NAVEGACAO[tema];
      return montarResposta("onde_encontrar", contexto, {
        estado: "informativo",
        resumo: `Isso fica em ${alvo.tela}.`,
        fatos: [fato(`Em ${alvo.tela} você pode ${alvo.faz}.`, FONTE)],
        itens: [{ id: `abrir_${tema}`, prioridade: "baixa", titulo: `Abrir ${alvo.tela}`, detalhe: alvo.faz, destino: alvo.destino }],
        fontes: [FONTE],
      });
    };
  },
};
