import type { ContratoDocumentoLinha, GerarDocumentoContratoInput } from "./models.ts";
import type { ContratoSnapshotV1 } from "../repositories";
import {
  formatarCep,
  formatarCpf,
  formatarDataContrato,
  formatarFormaPagamento,
  formatarHorarioContrato,
  formatarMoeda,
  formatarCondicaoPix,
  textoOuNaoInformado,
} from "./formatters.ts";

function linha(
  texto: string,
  estilo: ContratoDocumentoLinha["estilo"] = "corpo",
  espacoDepois?: number,
): ContratoDocumentoLinha {
  return { texto, estilo, espacoDepois };
}

function endereco(snapshot: ContratoSnapshotV1) {
  const e = snapshot.contratante.endereco;
  const complemento = e.complemento?.trim() ? `, ${e.complemento.trim()}` : "";
  return `${e.logradouro}, ${e.numero}${complemento} - ${e.bairro}, ${e.cidade}/${e.uf} - CEP ${formatarCep(e.cep)}`;
}

function adicionais(snapshot: ContratoSnapshotV1) {
  if (snapshot.contratacao.adicionais.length === 0) {
    return [linha("Nenhum adicional registrado nesta versão.")];
  }

  return snapshot.contratacao.adicionais.map((item, index) =>
    linha(
      `${index + 1}. ${item.nome} - quantidade ${item.quantidade} - ${formatarMoeda(item.valorTotal)}`,
    ),
  );
}

function buffet(snapshot: ContratoSnapshotV1) {
  const b = snapshot.contratacao.buffet;
  if (b.status === "PENDENTE") {
    return [
      linha(
        "Buffet: definição pendente. A escolha poderá ser registrada posteriormente conforme as regras comerciais do pacote, sem que esta indicação represente pagamento ou consumo já realizado.",
      ),
    ];
  }

  return [
    linha(`Salgados: ${textoOuNaoInformado(b.salgados)}`),
    linha(`Bebidas: ${textoOuNaoInformado(b.bebidas)}`),
    linha(`Doces: ${textoOuNaoInformado(b.doces)}`),
    linha(`Bolo: ${textoOuNaoInformado(b.bolo)}`),
    linha(`Outros: ${textoOuNaoInformado(b.outros)}`),
  ];
}

/**
 * Template V1 do RESUMO DA CONTRATAÇÃO.
 * É um documento comercial/informativo e não substitui o Contrato Oficial.
 * O aceite eletrônico e o hash persistido pertencem ao Contrato Oficial.
 */
export function renderizarContratoTemplateV1(
  input: GerarDocumentoContratoInput,
) {
  const s = input.snapshot;
  const linhas: ContratoDocumentoLinha[] = [
    linha("KIDMAIS FESTAS", "subtitulo", 3),
    linha("RESUMO DA CONTRATAÇÃO", "titulo", 8),
    linha(
      "DOCUMENTO INFORMATIVO - As condições jurídicas completas constam do Contrato Oficial correspondente ao pacote contratado.",
      "aviso",
      12,
    ),

    linha("1. IDENTIFICAÇÃO DO CONTRATANTE", "secao", 5),
    linha(`Nome: ${s.contratante.nomeCompleto}`),
    linha(`CPF: ${formatarCpf(s.contratante.cpf)}`),
    linha(`RG: ${textoOuNaoInformado(s.contratante.rg)}`),
    linha(`E-mail: ${s.contratante.email}`),
    linha(`Endereço: ${endereco(s)}`, "corpo", 10),

    linha("2. DADOS DO EVENTO", "secao", 5),
    linha(`Aniversariante: ${s.aniversariante.nome}`),
    linha(`Tema: ${textoOuNaoInformado(s.aniversariante.temaFesta)}`),
    linha(`Data: ${formatarDataContrato(s.evento.data)}`),
    linha(
      `Horário: ${formatarHorarioContrato(s.evento.horarioInicio)} às ${formatarHorarioContrato(s.evento.horarioFim)}`,
    ),
    linha(`Pacote: ${s.evento.pacote.nome}`),
    linha(
      `Convidados informados: ${s.evento.convidados} | Convidados faturados: ${s.evento.convidadosFaturados}`,
      "corpo",
      10,
    ),

    linha("3. OBJETO DA CONTRATAÇÃO", "secao", 5),
    linha(
      `A presente versão registra a contratação do pacote "${s.evento.pacote.nome}" e dos adicionais descritos abaixo, para a data e o horário indicados neste documento.`,
      "corpo",
      5,
    ),
    ...adicionais(s),
    linha(
      `Alterações específicas do pacote: ${textoOuNaoInformado(s.contratacao.alteracoesPacote)}`,
      "corpo",
      10,
    ),

    linha("4. BUFFET", "secao", 5),
    ...buffet(s),
    linha("", "corpo", 5),

    linha("5. VALOR E FORMA DE PAGAMENTO", "secao", 5),
    linha(`Valor do pacote aplicado: ${formatarMoeda(s.comercial.valorPacoteAplicado)}`),
    linha(`Valor dos adicionais: ${formatarMoeda(s.comercial.valorAdicionais)}`),
    linha(`Valor final desta contratação: ${formatarMoeda(s.comercial.valorFinalContrato)}`, "destaque"),
    linha(`Forma de pagamento pretendida: ${formatarFormaPagamento(s.comercial.formaPagamentoPretendida)}`),
    ...(s.comercial.condicaoPagamento ? [
      linha(`Base comercial antes do desconto: ${formatarMoeda(s.comercial.valorBaseComercial!)}`),
      linha(`Desconto da forma de pagamento: ${s.comercial.descontoFormaPagamentoPercentual}% (${formatarMoeda(s.comercial.valorDescontoFormaPagamento!)})`),
      ...(s.comercial.condicaoPagamento.forma === "PIX_PARCELADO" ? [
        linha(`Condição pretendida pelo cliente: ${formatarCondicaoPix(s.comercial.condicaoPagamento.pretendida)}`),
        linha(`Condição aprovada pela Kidmais: ${formatarCondicaoPix(s.comercial.condicaoPagamento.aprovada)}`),
        linha("A proposta e a aprovação comercial não representam pagamento realizado. O plano financeiro será registrado após a assinatura."),
      ] : []),
    ] : []),
    linha(
      "A forma de pagamento acima representa a intenção registrada no Fechamento e não constitui comprovante, baixa financeira ou confirmação de pagamento.",
      "corpo",
      10,
    ),

    linha("6. OBSERVAÇÕES REGISTRADAS PELO CLIENTE", "secao", 5),
    linha(textoOuNaoInformado(s.contratacao.observacoesCliente), "corpo", 10),

    linha("7. VÍNCULO COM O CONTRATO OFICIAL", "secao", 5),
    linha(
      `Este Resumo corresponde à versão ${input.numeroVersao} da contratação. Identificador de integridade do snapshot: ${input.snapshotHash}.`,
    ),
    linha(
      "O Resumo da Contratação e o Contrato Oficial são gerados a partir da mesma versão congelada do snapshot, evitando divergência de dados entre os dois documentos.",
    ),
    linha(
      "Este Resumo não substitui o Contrato Oficial. O aceite eletrônico é realizado sobre o Contrato Oficial correspondente ao pacote contratado.",
      "corpo",
      12,
    ),

    linha(
      `Versão do resumo: ${input.numeroVersao} | Template Resumo V1 | Snapshot: ${input.snapshotHash}`,
      "rodape",
    ),
  ];

  return {
    templateVersao: 1 as const,
    homologadoParaProducao: true,
    titulo: "Resumo da Contratação Kidmais",
    linhas,
  };
}
