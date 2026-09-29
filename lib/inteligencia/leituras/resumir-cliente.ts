import type { RespostaLeitura } from "../contratos.ts";
import type { ClienteDominio, ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, ausencia, calculo, dataCurta, evidencia, fato, montarResposta, plural, comEntidade } from "./comum.ts";

/**
 * `resumir_cliente`: situação do cadastro e aniversariantes, a partir de `obterClienteBase`
 * (tenant comprovado; outra empresa ou legado respondem como inexistente, pelo próprio domínio).
 * Minimização: CPF, RG, telefone, WhatsApp, e-mail e endereço não entram na resposta. Os campos
 * faltantes são citados só pelo nome do campo.
 */
const FONTE = "crm.clientes";

/** Próximo aniversário (dia/mês) a partir de hoje; só para aniversariantes ativos com data. */
function proximoAniversario(dataNascimento: string, hoje: string) {
  const [, mes, dia] = dataNascimento.slice(0, 10).split("-");
  const anoHoje = Number(hoje.slice(0, 4));
  const candidato = `${anoHoje}-${mes}-${dia}`;
  return candidato >= hoje ? candidato : `${anoHoje + 1}-${mes}-${dia}`;
}

export function montarResumoCliente(dados: ClienteDominio, clienteId: string, contexto: ContextoFerramenta): RespostaLeitura {
  const destino = `/clientes/${clienteId}`;
  const ativos = dados.aniversariantes.filter((a) => a.ativo);
  // O rótulo vem do próprio domínio (camposFaltantesParaContrato); o valor do campo nunca é lido.
  const faltantes = dados.cadastro.camposFaltantes.map((campo) => campo.label);
  const proximos = ativos
    .filter((a) => a.dataNascimento)
    .map((a) => ({ nome: a.nome, data: proximoAniversario(a.dataNascimento!, contexto.hoje) }))
    .sort((a, b) => a.data.localeCompare(b.data));
  const fatos = [
    fato(`Cliente ${dados.cliente.status === "ATIVO" ? "ativo" : `com situação ${dados.cliente.status}`}, cadastrado em ${dataCurta(dados.cliente.criadoEm)}.`, FONTE),
    dados.cadastro.completoParaContrato
      ? fato("Cadastro completo para gerar contrato.", FONTE)
      : fato(`Cadastro incompleto para contrato: falta ${faltantes.join(", ")}.`, FONTE),
    ativos.length
      ? fato(`${ativos.length} ${plural(ativos.length, "aniversariante ativo", "aniversariantes ativos")}.`, FONTE)
      : ausencia("Nenhum aniversariante ativo cadastrado.", FONTE),
    ...(proximos[0] ? [calculo(`Próximo aniversário: ${proximos[0].nome}, em ${dataCurta(proximos[0].data)}.`, FONTE)] : []),
    ...(ativos.length && !proximos.length ? [ausencia("Nenhum aniversariante tem data de nascimento registrada.", FONTE)] : []),
  ];
  const itens = [
    ...(!dados.cadastro.completoParaContrato ? [{ id: "cadastro", prioridade: "alta" as const, titulo: "Completar cadastro", detalhe: `Falta: ${faltantes.join(", ")}`, destino }] : []),
    ...proximos.slice(0, 3).map((a, i) => ({ id: `aniversario_${i}`, prioridade: "baixa" as const, titulo: `Aniversário de ${a.nome}`, detalhe: dataCurta(a.data), destino })),
  ];
  return montarResposta("resumir_cliente", contexto, {
    estado: dados.cadastro.completoParaContrato ? "informativo" : "atencao",
    resumo: `${dados.cliente.nomeCompleto}: cadastro ${dados.cadastro.completoParaContrato ? "completo" : "incompleto"}, ${ativos.length} ${plural(ativos.length, "aniversariante", "aniversariantes")}.`,
    fatos,
    itens,
    evidencias: [
      evidencia(FONTE, "Cadastro completo para contrato", dados.cadastro.completoParaContrato ? "Sim" : "Não", destino),
      evidencia(FONTE, "Aniversariantes ativos", ativos.length, destino),
      evidencia(FONTE, "Responsáveis adicionais", dados.responsaveis.length, destino),
    ],
    fontes: [FONTE],
  });
}

export const resumirCliente: Ferramenta<RespostaLeitura> = {
  nome: "clientes.resumir",
  capacidade: "resumir_cliente",
  classe: "READ",
  grupo: "READ",
  entrada: comEntidade,
  papeis: PAPEIS_ADMIN,
  descricao: "Situação do cadastro, pendências para contrato e próximos aniversários do cliente aberto.",
  entidade: "cliente",
  preparar(parametros) {
    const { id } = comEntidade.parse(parametros);
    return async (tx, tenant, contexto) => {
      if (!contexto.portas.clientes) {
        return montarResposta("resumir_cliente", contexto, { estado: "sem_dados", resumo: "O resumo de clientes não está disponível agora.", fatos: [ausencia("Serviço de clientes indisponível para a IA.", FONTE)], fontes: [FONTE] });
      }
      return montarResumoCliente(await contexto.portas.clientes.obter(tx, tenant.empresaComprovada, id), id, contexto);
    };
  },
};
