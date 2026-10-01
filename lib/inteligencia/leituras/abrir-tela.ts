import { z } from "zod";
import type { RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { InteligenciaError } from "../politica.ts";
import { TELAS, TELAS_NAVEGACAO, montarDestino, type TelaNavegacao } from "../rotas-navegacao.ts";
import { PAPEIS_ADMIN, fato, montarResposta } from "./comum.ts";

/**
 * `abrir_tela` / `abrir_festa` (AI V1.1, PR 3): destino de navegação interna, só da lista fechada de rotas.
 * Não lê dado de negócio além da POSSE da entidade: tela com entidade só com id que existe na empresa comprovada
 * (outra empresa ⇒ inexistente, fail-closed). Nunca escreve. A conversa transforma o resultado em resposta de
 * navegação; a UI só navega depois de revalidar o destino.
 *
 * Duas ferramentas porque a posse da festa só é provada pelo serviço de festas, que abre a própria transação
 * (SERVICO_PROPRIO); cliente e contrato são provados dentro da transação do gateway.
 */
const FONTE = "kidmais.navegacao";
const naoEncontrado = (o: string) => new InteligenciaError("NAO_ENCONTRADO", `${o} não encontrado.`, 404);

export function respostaNavegacao(tela: TelaNavegacao, destino: string, contexto: ContextoFerramenta): RespostaLeitura {
  const { rotulo } = TELAS_NAVEGACAO[tela];
  return montarResposta(tela === "festa" ? "abrir_festa" : "abrir_tela", contexto, {
    estado: "informativo",
    resumo: `Abrindo ${rotulo}.`,
    fatos: [fato(`Destino: ${rotulo}.`, FONTE)],
    itens: [{ id: `abrir_${tela}`, prioridade: "baixa", titulo: rotulo, detalhe: "Navegação", destino }],
    fontes: [FONTE],
  });
}

const TELAS_NA_TRANSACAO = TELAS.filter((t) => t !== "festa") as [TelaNavegacao, ...TelaNavegacao[]];
const entradaTela = z.object({ tela: z.enum(TELAS_NA_TRANSACAO), id: z.string().uuid().optional() }).strict();

export const abrirTela: Ferramenta<RespostaLeitura> = {
  nome: "kidmais.navegacao.abrir",
  capacidade: "abrir_tela",
  classe: "READ",
  grupo: "READ",
  entrada: entradaTela,
  papeis: PAPEIS_ADMIN,
  descricao: "Abre uma tela do Kidmais (lista fechada de rotas).",
  preparar(bruto) {
    const { tela, id } = entradaTela.parse(bruto);
    const destino = montarDestino(tela, id ?? null);
    return async (tx, tenant, contexto) => {
      const entidade = (TELAS_NAVEGACAO[tela] as { entidade?: string }).entidade;
      // Posse na empresa comprovada ANTES de emitir o destino (id é só dica da tela).
      if (entidade === "cliente") {
        if (!contexto.portas.clientes) throw naoEncontrado("Cliente");
        await contexto.portas.clientes.obter(tx, tenant.empresaComprovada, id!);
      } else if (entidade === "contrato") {
        const versoes = contexto.portas.contratos ? await contexto.portas.contratos.versoes(tx, tenant.empresaComprovada, id!) : null;
        if (!versoes) throw naoEncontrado("Contrato");
      }
      return respostaNavegacao(tela, destino, contexto);
    };
  },
};

const entradaFesta = z.object({ id: z.string().uuid() }).strict();

export const abrirFesta: Ferramenta<RespostaLeitura> = {
  nome: "kidmais.navegacao.abrir_festa",
  capacidade: "abrir_festa",
  classe: "READ",
  grupo: "READ",
  entrada: entradaFesta,
  papeis: PAPEIS_ADMIN,
  entidade: "festa",
  descricao: "Abre a tela de uma festa da empresa.",
  modo: "SERVICO_PROPRIO",
  preparar(bruto) {
    const { id } = entradaFesta.parse(bruto);
    const destino = montarDestino("festa", id);
    return async (_tenant, contexto) => {
      // `consultarFestas` prova o tenant e a capacidade de festa; outra empresa responde como inexistente.
      if (!contexto.portas.festas) throw naoEncontrado("Festa");
      await contexto.portas.festas.consultarDetalhe(id);
      return respostaNavegacao("festa", destino, contexto);
    };
  },
};
