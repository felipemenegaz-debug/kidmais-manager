import type { ContratoSnapshot } from "../../repositories/index.ts";
import {
  formatarCep,
  formatarCpf,
  formatarDataContrato,
  formatarFormaPagamento,
  formatarHorarioContrato,
  formatarMoeda,
  textoOuNaoInformado,
} from "../formatters.ts";
import type {
  ContratoOficialClausula,
  ContratoOficialRenderizado,
  GerarContratoOficialInput,
} from "./models.ts";

const ENDERECO_KIDMAIS = "SCRN 704/705 Bloco D Loja 12, Asa Norte/DF - CEP 70.730-640";
const CONTRATADA = "Mary Marra Menegaz - EPP (KIDMAIS FESTAS)";
const CNPJ_KIDMAIS = "20.119.900/0001-60";
const REPRESENTANTE = "Mary Marra Menegaz";
const CPF_REPRESENTANTE = "226.945.441-34";

function enderecoContratante(snapshot: ContratoSnapshot) {
  const e = snapshot.contratante.endereco;
  const complemento = e.complemento?.trim() ? `, ${e.complemento.trim()}` : "";
  return `${e.logradouro}, ${e.numero}${complemento}, ${e.bairro}, ${e.cidade}/${e.uf}, CEP ${formatarCep(e.cep)}`;
}

function telefoneContratante(snapshot: ContratoSnapshot) {
  return snapshot.contratante.whatsapp ?? snapshot.contratante.telefone ?? "Não informado";
}

function idadeAniversariante(snapshot: ContratoSnapshot) {
  return snapshot.aniversariante.idadeNoEvento == null
    ? "idade não informada"
    : `${snapshot.aniversariante.idadeNoEvento} anos`;
}

function responsavelAdicional(snapshot: ContratoSnapshot) {
  const r = snapshot.responsavelAdicional;
  if (!r) return "Outro responsável: não informado.";
  const partes = [`Outro responsável: ${r.nome}`];
  if (r.cpf) partes.push(`CPF ${formatarCpf(r.cpf)}`);
  if (r.telefone || r.whatsapp) partes.push(`telefone ${r.whatsapp ?? r.telefone}`);
  if (r.relacao) partes.push(`relação ${r.relacao}`);
  return `${partes.join(", ")}.`;
}

function dataPorExtensoBr(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const meses = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  ];
  return `${date.getUTCDate()} de ${meses[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

function clausulaPagamento(snapshot: ContratoSnapshot) {
  const forma = snapshot.comercial.formaPagamentoPretendida;
  const formaLabel = formatarFormaPagamento(forma);

  switch (forma) {
    case "PIX_AVISTA":
      return `A forma de pagamento indicada no Fechamento é ${formaLabel}. O pagamento será solicitado após a assinatura deste contrato, conforme as condições comerciais registradas no Resumo da Contratação. A indicação da forma de pagamento, por si só, não constitui pagamento realizado nem quitação.`;
    case "PIX_PARCELADO":
      return `A forma de pagamento indicada no Fechamento é ${formaLabel}. O primeiro pagamento será solicitado após a assinatura deste contrato, e as demais parcelas seguirão as condições acordadas no fechamento e apresentadas ao CONTRATANTE. A indicação da forma de pagamento, por si só, não constitui pagamento realizado nem quitação.`;
    case "CARTAO_CIELO":
      return `A forma de pagamento indicada no Fechamento é ${formaLabel}. A cobrança será realizada após a assinatura deste contrato, conforme as condições acordadas no fechamento e apresentadas ao CONTRATANTE. A indicação da forma de pagamento, por si só, não constitui pagamento realizado nem quitação.`;
    default:
      return "A forma de pagamento será aquela registrada no Fechamento e apresentada no Resumo da Contratação. O primeiro pagamento, quando devido, será solicitado após a assinatura deste contrato. A indicação da forma de pagamento, por si só, não constitui pagamento realizado nem quitação.";
  }
}

function clausula(numero: number, texto: string): ContratoOficialClausula {
  return { numero, texto };
}

/**
 * Festa Completa V1
 * -----------------
 * Fonte jurídica usada nesta primeira implementação:
 * contrato oficial da antiga "Festa Standard" fornecido pela Kidmais em
 * 08/09/2026, hoje correspondente à "Festa Completa".
 *
 * O conteúdo foi preservado como referência, com ajustes funcionais aprovados
 * pela Kidmais em 08/09/2026: pagamento conforme a forma registrada no
 * Fechamento, tratamento do aumento de convidados para fechamentos próximos
 * ao evento, retirada da antiga cláusula 16 e redação objetiva do foro.
 * Em 08/09/2026, após revisão funcional pela Kidmais, os valores, regras
 * comerciais e dados do modelo foram confirmados para uso no fluxo oficial
 * do Kidmais Manager. Esta marcação representa aprovação interna de produção
 * do sistema e não substitui revisão jurídica profissional externa.
 */
export function renderizarContratoOficialFestaCompletaV1(
  input: GerarContratoOficialInput,
): ContratoOficialRenderizado {
  const s = input.snapshot;
  const dataEvento = formatarDataContrato(s.evento.data);
  const inicio = formatarHorarioContrato(s.evento.horarioInicio);
  const fim = formatarHorarioContrato(s.evento.horarioFim);
  const geradoEm = dataPorExtensoBr(input.geradoEm) ?? "data do aceite eletrônico";

  const contratada = [
    `CONTRATADA: ${CONTRATADA}, inscrita no CNPJ nº ${CNPJ_KIDMAIS}, com sede no ${ENDERECO_KIDMAIS}.`,
    `Representada pela proprietária ${REPRESENTANTE}, inscrita no CPF nº ${CPF_REPRESENTANTE}.`,
  ];

  const contratante = [
    `CONTRATANTE: ${s.contratante.nomeCompleto}, CPF ${formatarCpf(s.contratante.cpf)}, RG ${textoOuNaoInformado(s.contratante.rg)}, telefone ${telefoneContratante(s)}, e-mail ${s.contratante.email}, endereço ${enderecoContratante(s)}.`,
    responsavelAdicional(s),
    `Aniversariante: ${s.aniversariante.nome}, ${idadeAniversariante(s)}. Tema: ${textoOuNaoInformado(s.aniversariante.temaFesta)}.`,
  ];

  const preambulo = [
    "As partes acima identificadas têm, entre si, justo e acertado o presente Contrato de Prestação de Serviço para realização de festa, que se regerá pelas cláusulas seguintes e pelas condições de pagamento descritas no presente, bem como pelo documento denominado Resumo da Contratação Kidmais, parte integrante deste contrato.",
  ];

  const clausulas = [
    clausula(1, `O presente contrato tem como objeto a prestação de serviços para realização da ${s.evento.pacote.nome}, de acordo com as especificações constantes no Resumo da Contratação. A festa será realizada no dia ${dataEvento}, com início às ${inicio} e término às ${fim}, para ${s.evento.convidadosFaturados} pessoas, na KidMais Festas localizada na ${ENDERECO_KIDMAIS}.`),
    clausula(2, `O valor da festa contratada é de ${formatarMoeda(s.comercial.valorFinalContrato)}.`),
    clausula(3, "O número de convidados poderá ser aumentado até 8 (oito) dias corridos antes da data do evento, mediante disponibilidade e pelo valor da tabela vigente no momento da solicitação, sendo o aumento confirmado somente após o pagamento correspondente. Quando a contratação for concluída dentro dos 8 (oito) dias anteriores ao evento, qualquer aumento posterior dependerá de análise e autorização expressa da CONTRATADA. Caso o número de convidados pagantes exceda ao contratado no dia do evento, será cobrado o valor de R$ 120,00 por pessoa excedente."),
    clausula(4, "Crianças de 0 a 6 anos e 11 meses não contarão como convidados. Essa cortesia é limitada a um terço do total de pagantes. Se o aniversariante for menor de 16 anos, o pai, a mãe e os irmãos participarão como cortesia."),
    clausula(5, "A CONTRATANTE fornecerá até 18 lembrancinhas para as crianças com a idade entre 0 e 9 anos e 11 meses presentes no evento. Acima disso; se a contratante desejar, será entregue mais lembrancinhas no valor de R$ 12,00 a unidade, se houve estoque disponível."),
    clausula(6, clausulaPagamento(s)),
    clausula(7, "Quando a contratação possuir parcelas ou quaisquer valores com vencimento futuro, em caso de inadimplemento por parte do CONTRATANTE incidirá sobre cada valor em atraso multa pecuniária de 2%, juros de mora de 1% ao mês e correção monetária pelo índice INPC. Em caso de cobrança judicial, poderão ser acrescidas as custas processuais e os honorários advocatícios cabíveis."),
    clausula(8, "Os horários deverão ser obedecidos, respeitando o início e o término já estabelecidos. Caso não haja outra festa posteriormente, a duração da festa poderá ser prorrogada com o acréscimo de R$ 700,00 por hora ou fração superior a trinta minutos de tolerância. O espaço do subsolo e o buffet terminará 30 minutos antes do término estipulado neste contrato, e os parabéns será cantado, no máximo, até 45 (quarenta e cinco) minutos antes do horário do término estipulado neste contrato. Em caso de permanência de convidados após o término da festa, será cobrada uma multa de R$ 175,00 a cada 15 minutos."),
    clausula(9, "No caso de desistência do(a) CONTRATANTE sem aviso prévio de 60 (sessenta) dias corridos, será cobrada multa de 20% do valor total da festa contratada. No tocante as mudanças de data e horário, elas deverão respeitar a disponibilidade da agenda, bem como uma taxa de R$ 600,00."),
    clausula(10, "No caso de impossibilidade da CONTRATADA realizar a festa, ela devolverá o valor já pago pelo evento, pela mesma condição de pagamento que recebeu."),
    clausula(11, "As bebidas alcoólicas não estão inclusas e é cobrada uma taxa de R$ 180,00; se o (a) CONTRATANTE as trouxer. É necessário pagar a taxa até uma semana antes da festa."),
    clausula(12, "O cardápio foi elaborado de acordo com o número de convidados determinado pelo (a) CONTRATANTE. Portanto, a CONTRATADA não será responsabilizada se, atendidas as especificações contratadas, a insuficiência da comida e/ou da bebida resultar de convidado excedente."),
    clausula(13, "A CONTRATADA não se responsabiliza por eventuais falhas da Neoenergia. Dessa forma, o CONTRATANTE pode alugar um gerador de energia por conta própria para se precaver de transtornos causados por possível queda de energia durante o evento."),
    clausula(14, "Para o uso de confetes, chuva de prata, serpentina, folhas ou qualquer item que aumente o serviço da limpeza será cobrado uma taxa no valor de R$ 150,00."),
    clausula(15, "O (a) CONTRATANTE se responsabiliza por quaisquer danos causados dentro da casa de festas provocados por este(a) ou seus convidados durante o evento."),
    clausula(16, "A CONTRATADA se responsabilizará por pelo menos 20 (vinte) atrações em funcionamento durante o evento."),
    clausula(17, "A CONTRATADA disponibilizará até 350 balões comuns a ser utilizado na mesa temática. A contratação de mais balões ou em outro espaço requer um valor de R$ 180,00/metro."),
    clausula(18, "Fica eleito o foro da Comarca de Brasília-DF para dirimir quaisquer controvérsias ou questões decorrentes deste contrato que demandem medida ou ação judicial, observada a legislação aplicável."),
  ];

  const observacoes = [
    `Observações do cliente: ${textoOuNaoInformado(s.contratacao.observacoesCliente)}`,
    `Alterações específicas do pacote: ${textoOuNaoInformado(s.contratacao.alteracoesPacote)}`,
    `Tema: ${textoOuNaoInformado(s.aniversariante.temaFesta)}.`,
  ];

  const integridade = [
    `Este instrumento corresponde à versão ${input.numeroVersao} do Contrato no Kidmais Manager.`,
    `SHA-256 do snapshot contratual: ${input.snapshotHash}.`,
    "O aceite eletrônico é vinculado à exata versão exibida ao CONTRATANTE e a uma validação de identidade por código de uso único (OTP). Alterações materiais posteriores exigem nova versão, preservando a anterior.",
  ];

  const assinatura = [
    `Brasília, ${geradoEm}.`,
    `CONTRATANTE: ${s.contratante.nomeCompleto} - CPF ${formatarCpf(s.contratante.cpf)}`,
    `CONTRATADA: ${CONTRATADA} - CNPJ ${CNPJ_KIDMAIS}`,
    "TESTEMUNHA 1 - Nome: ______________________________  CPF: ______________________________",
    "TESTEMUNHA 2 - Nome: ______________________________  CPF: ______________________________",
  ];

  return {
    templateVersao: 1,
    modeloCodigo: "FESTA_COMPLETA_V1",
    pacoteCodigo: s.evento.pacote.codigo,
    pacoteNome: s.evento.pacote.nome,
    homologadoParaProducao: true,
    titulo: "CONTRATO DE PRESTAÇÃO DE SERVIÇOS",
    subtitulo: "FESTA COMPLETA",
    avisoHomologacao: null,
    contratada,
    contratante,
    preambulo,
    clausulas,
    observacoes,
    integridade,
    assinatura,
  };
}
