import type { DbExecutor } from "../../db/contracts";
import { db } from "../../db/postgres";
import {
  buscarCategoriaHorarioAplicavel,
  buscarElegibilidadePacoteAplicavel,
  buscarPacoteAtivoPorId,
  buscarPrecoPacoteAplicavel,
  buscarTabelaPrecoVigente,
  listarAdicionaisAtivosComPreco,
  listarDescontosPacoteAplicaveis,
  listarPacotesAtivosComElegibilidade,
  type AdicionalComPrecoRecord,
  type RegraDescontoPacoteRecord,
} from "../repositories";
import { PricingServiceError } from "./errors";
import type {
  AdicionalPrecificado,
  AdicionalSelecionadoInput,
  CalcularResumoComercialInput,
  CatalogoAdicionais,
  CatalogoAdicionaisInput,
  ContextoComercial,
  ListarPacotesComerciaisInput,
  ObterContextoComercialInput,
  PacoteComercialResumo,
  PrecificarAdicionaisInput,
  PrecificarPacoteInput,
  ResultadoAdicionais,
  ResultadoPrecoPacote,
  ResumoComercial,
} from "./models";

function arredondarDinheiro(valor: number): number {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function validarDataIso(data: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    throw new PricingServiceError(
      "DADOS_INVALIDOS",
      "Informe a data no formato YYYY-MM-DD.",
      400,
      { campo: "data" },
    );
  }

  const [ano, mes, dia] = data.split("-").map(Number);
  const teste = new Date(Date.UTC(ano, mes - 1, dia));
  const valida =
    teste.getUTCFullYear() === ano &&
    teste.getUTCMonth() === mes - 1 &&
    teste.getUTCDate() === dia;

  if (!valida) {
    throw new PricingServiceError(
      "DADOS_INVALIDOS",
      "Informe uma data válida.",
      400,
      { campo: "data" },
    );
  }
}

function validarConfiguracaoAgendaId(configuracaoAgendaId: string) {
  if (!configuracaoAgendaId?.trim()) {
    throw new PricingServiceError(
      "DADOS_INVALIDOS",
      "A configuração de agenda é obrigatória.",
      400,
      { campo: "configuracaoAgendaId" },
    );
  }
}

function validarConvidados(convidados: number) {
  if (!Number.isInteger(convidados) || convidados <= 0) {
    throw new PricingServiceError(
      "DADOS_INVALIDOS",
      "A quantidade de convidados deve ser um número inteiro maior que zero.",
      400,
      { campo: "convidados" },
    );
  }
}


async function executarConsultasCompatíveisComTransacao<A, B>(
  customDb: DbExecutor | undefined,
  primeira: () => Promise<A>,
  segunda: () => Promise<B>,
): Promise<[A, B]> {
  if (customDb) {
    const a = await primeira();
    const b = await segunda();
    return [a, b];
  }

  return Promise.all([primeira(), segunda()]);
}

function validarBase(input: ObterContextoComercialInput) {
  validarDataIso(input.data);
  validarConfiguracaoAgendaId(input.configuracaoAgendaId);
}

export async function obterContextoComercial(
  input: ObterContextoComercialInput,
  customDb?: DbExecutor,
): Promise<ContextoComercial> {
  validarBase(input);

  const [tabelaPreco, regraCategoria] =
    await executarConsultasCompatíveisComTransacao(
      customDb,
      () => buscarTabelaPrecoVigente(input.data, customDb),
      () =>
        buscarCategoriaHorarioAplicavel(
          input.data,
          input.configuracaoAgendaId,
          customDb,
        ),
    );

  if (!tabelaPreco) {
    throw new PricingServiceError(
      "TABELA_PRECO_NAO_CONFIGURADA",
      "Não existe tabela de preço vigente para a data selecionada.",
      503,
      { data: input.data },
    );
  }

  if (!regraCategoria) {
    throw new PricingServiceError(
      "CATEGORIA_HORARIO_NAO_CONFIGURADA",
      "Não existe categoria comercial configurada para a data e período selecionados.",
      503,
      {
        data: input.data,
        configuracaoAgendaId: input.configuracaoAgendaId,
      },
    );
  }

  return {
    tabelaPreco,
    categoriaHorario: regraCategoria.categoriaHorario,
  };
}

export async function listarPacotesComerciais(
  input: ListarPacotesComerciaisInput,
  customDb?: DbExecutor,
): Promise<PacoteComercialResumo[]> {
  validarBase(input);

  const pacotes = await listarPacotesAtivosComElegibilidade(
    {
      data: input.data,
      configuracaoAgendaId: input.configuracaoAgendaId,
    },
    customDb,
  );

  return pacotes.map((item) => ({
    pacote: {
      id: item.id,
      codigo: item.codigo,
      nome: item.nome,
      descricao: item.descricao,
      convidadosMinimos: item.convidadosMinimos,
      convidadosMaximos: item.convidadosMaximos,
      duracaoMinutos: item.duracaoMinutos,
      ordemExibicao: item.ordemExibicao,
      ativo: item.ativo,
    },
    elegibilidade: item.elegibilidade,
    regraElegibilidadeId: item.regraElegibilidadeId,
  }));
}

function selecionarDesconto(
  regras: RegraDescontoPacoteRecord[],
): RegraDescontoPacoteRecord | null {
  // O repository já ordena por especificidade do turno, prioridade e vigência.
  // Não existe regra oficial de empilhamento: somente a primeira regra prevalece.
  return regras[0] ?? null;
}

export async function precificarPacote(
  input: PrecificarPacoteInput,
  customDb?: DbExecutor,
): Promise<ResultadoPrecoPacote> {
  validarBase(input);
  validarConvidados(input.convidados);

  if (!input.pacoteId?.trim()) {
    throw new PricingServiceError(
      "DADOS_INVALIDOS",
      "O pacote é obrigatório.",
      400,
      { campo: "pacoteId" },
    );
  }

  const pacote = await buscarPacoteAtivoPorId(input.pacoteId, customDb);

  if (!pacote) {
    throw new PricingServiceError(
      "PACOTE_NAO_ENCONTRADO",
      "O pacote informado não existe ou está inativo.",
      404,
      { pacoteId: input.pacoteId },
    );
  }

  if (
    pacote.convidadosMaximos !== null &&
    input.convidados > pacote.convidadosMaximos
  ) {
    throw new PricingServiceError(
      "DADOS_INVALIDOS",
      "A quantidade de convidados excede o limite configurado para este pacote.",
      400,
      {
        convidados: input.convidados,
        convidadosMaximos: pacote.convidadosMaximos,
      },
    );
  }

  const [contexto, elegibilidade] =
    await executarConsultasCompatíveisComTransacao(
      customDb,
      () => obterContextoComercial(input, customDb),
      () =>
        buscarElegibilidadePacoteAplicavel(
          {
            pacoteId: pacote.id,
            data: input.data,
            configuracaoAgendaId: input.configuracaoAgendaId,
          },
          customDb,
        ),
    );

  if (!elegibilidade) {
    throw new PricingServiceError(
      "ELEGIBILIDADE_NAO_CONFIGURADA",
      "Não existe regra de elegibilidade comercial para este pacote na data e período selecionados.",
      503,
      {
        pacoteId: pacote.id,
        data: input.data,
        configuracaoAgendaId: input.configuracaoAgendaId,
      },
    );
  }

  if (elegibilidade.estado === "INDISPONIVEL") {
    throw new PricingServiceError(
      "PACOTE_INDISPONIVEL",
      "Este pacote não está disponível comercialmente para a data e período selecionados.",
      409,
      {
        pacoteId: pacote.id,
        regraElegibilidadeId: elegibilidade.id,
      },
    );
  }

  if (elegibilidade.estado === "SOB_CONSULTA") {
    throw new PricingServiceError(
      "PACOTE_SOB_CONSULTA",
      "Este pacote exige consulta e aprovação da Kidmais antes de continuar.",
      409,
      {
        pacoteId: pacote.id,
        regraElegibilidadeId: elegibilidade.id,
      },
    );
  }

  const convidadosFaturados = Math.max(
    input.convidados,
    pacote.convidadosMinimos ?? input.convidados,
  );

  const [precoRegra, regrasDesconto] =
    await executarConsultasCompatíveisComTransacao(
      customDb,
      () =>
        buscarPrecoPacoteAplicavel(
          {
            tabelaPrecoId: contexto.tabelaPreco.id,
            pacoteId: pacote.id,
            categoriaHorario: contexto.categoriaHorario,
            convidados: convidadosFaturados,
          },
          customDb,
        ),
      () =>
        listarDescontosPacoteAplicaveis(
          {
            pacoteId: pacote.id,
            data: input.data,
            configuracaoAgendaId: input.configuracaoAgendaId,
          },
          customDb,
        ),
    );

  if (!precoRegra) {
    if (pacote.codigo === "COMPACTA") {
      throw new PricingServiceError(
        "PACOTE_SOB_CONSULTA",
        "A Festa Compacta possui preço automático somente para a condição comercial configurada. Consulte a Kidmais para outra quantidade de convidados.",
        409,
        {
          pacoteId: pacote.id,
          tabelaPrecoId: contexto.tabelaPreco.id,
          categoriaHorario: contexto.categoriaHorario,
          convidados: convidadosFaturados,
        },
      );
    }
    throw new PricingServiceError(
      "PRECO_PACOTE_NAO_CONFIGURADO",
      "Não existe preço configurado para este pacote, quantidade de convidados e categoria de horário.",
      503,
      {
        pacoteId: pacote.id,
        tabelaPrecoId: contexto.tabelaPreco.id,
        categoriaHorario: contexto.categoriaHorario,
        convidados: convidadosFaturados,
      },
    );
  }

  const valorTabelaBase = arredondarDinheiro(
    precoRegra.tipoCalculo === "POR_CONVIDADO"
      ? precoRegra.valor * convidadosFaturados
      : precoRegra.valor,
  );

  const regraDesconto = selecionarDesconto(regrasDesconto);
  const percentual = regraDesconto?.percentual ?? 0;
  const valorDesconto = arredondarDinheiro(
    valorTabelaBase * (percentual / 100),
  );
  const valorTabelaAplicado = arredondarDinheiro(
    valorTabelaBase - valorDesconto,
  );

  return {
    pacote,
    tabelaPreco: contexto.tabelaPreco,
    categoriaHorario: contexto.categoriaHorario,
    elegibilidade: elegibilidade.estado,
    convidadosInformados: input.convidados,
    convidadosFaturados,
    minimoFaturavelAplicado: convidadosFaturados > input.convidados,
    precoRegra,
    valorTabelaBase,
    desconto: {
      aplicado: Boolean(regraDesconto && percentual > 0),
      regraId: regraDesconto?.id ?? null,
      codigo: regraDesconto?.codigo ?? null,
      titulo: regraDesconto?.titulo ?? null,
      percentual,
      valor: valorDesconto,
    },
    valorTabelaAplicado,
  };
}

export async function listarCatalogoAdicionais(
  input: CatalogoAdicionaisInput,
  customDb?: DbExecutor,
): Promise<CatalogoAdicionais> {
  validarDataIso(input.data);
  validarConvidados(input.convidados);

  const tabelaPreco = await buscarTabelaPrecoVigente(input.data, customDb);

  if (!tabelaPreco) {
    throw new PricingServiceError(
      "TABELA_PRECO_NAO_CONFIGURADA",
      "Não existe tabela de preço vigente para a data selecionada.",
      503,
      { data: input.data },
    );
  }

  const itens = await listarAdicionaisAtivosComPreco(
    {
      tabelaPrecoId: tabelaPreco.id,
      convidados: input.convidados,
      codigos: input.codigos,
    },
    customDb,
  );

  return {
    tabelaPreco,
    convidados: input.convidados,
    itens,
  };
}

function normalizarSelecoesAdicionais(
  itens: AdicionalSelecionadoInput[],
): AdicionalSelecionadoInput[] {
  const vistos = new Set<string>();

  return itens.map((item) => {
    const codigo = item.codigo?.trim().toUpperCase();
    const quantidade = item.quantidade ?? 1;

    if (!codigo) {
      throw new PricingServiceError(
        "DADOS_INVALIDOS",
        "O código do adicional é obrigatório.",
        400,
      );
    }

    if (vistos.has(codigo)) {
      throw new PricingServiceError(
        "ADICIONAL_DUPLICADO",
        `O adicional ${codigo} foi informado mais de uma vez.`,
        400,
        { codigo },
      );
    }
    vistos.add(codigo);

    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      throw new PricingServiceError(
        "DADOS_INVALIDOS",
        `A quantidade do adicional ${codigo} deve ser maior que zero.`,
        400,
        { codigo, quantidade },
      );
    }

    return { codigo, quantidade };
  });
}

function calcularValorAdicional(
  adicional: AdicionalComPrecoRecord,
  quantidade: number,
  convidados: number,
): AdicionalPrecificado {
  if (!adicional.preco) {
    throw new PricingServiceError(
      "PRECO_ADICIONAL_NAO_CONFIGURADO",
      `O adicional ${adicional.nome} não possui preço configurado para esta quantidade de convidados.`,
      503,
      { adicionalId: adicional.id, codigo: adicional.codigo, convidados },
    );
  }

  let quantidadeCobrada = quantidade;

  // Reservado para futuros adicionais precificados literalmente por convidado.
  // Os adicionais atuais de buffet estão cadastrados como PACOTE, pois o valor da
  // faixa já representa o total daquele adicional para o evento.
  if (adicional.unidadeCobranca === "CONVIDADO") {
    quantidadeCobrada = convidados * quantidade;
  }

  const valorTotal = arredondarDinheiro(
    adicional.preco.valor * quantidadeCobrada,
  );

  return {
    adicionalId: adicional.id,
    codigo: adicional.codigo,
    nome: adicional.nome,
    categoria: adicional.categoria,
    unidadeCobranca: adicional.unidadeCobranca,
    precoRegraId: adicional.preco.id,
    quantidade,
    valorUnitarioAplicado: adicional.preco.valor,
    valorTotal,
  };
}

export async function precificarAdicionais(
  input: PrecificarAdicionaisInput,
  customDb?: DbExecutor,
): Promise<ResultadoAdicionais> {
  validarDataIso(input.data);
  validarConvidados(input.convidados);

  const selecoes = normalizarSelecoesAdicionais(input.itens ?? []);
  const tabelaPreco = await buscarTabelaPrecoVigente(input.data, customDb);

  if (!tabelaPreco) {
    throw new PricingServiceError(
      "TABELA_PRECO_NAO_CONFIGURADA",
      "Não existe tabela de preço vigente para a data selecionada.",
      503,
      { data: input.data },
    );
  }

  if (selecoes.length === 0) {
    return {
      tabelaPreco,
      convidados: input.convidados,
      itens: [],
      valorTotal: 0,
    };
  }

  const catalogo = await listarAdicionaisAtivosComPreco(
    {
      tabelaPrecoId: tabelaPreco.id,
      convidados: input.convidados,
      codigos: selecoes.map((item) => item.codigo),
    },
    customDb,
  );

  const porCodigo = new Map(catalogo.map((item) => [item.codigo, item]));

  const faltantes = selecoes
    .map((item) => item.codigo)
    .filter((codigo) => !porCodigo.has(codigo));

  if (faltantes.length > 0) {
    throw new PricingServiceError(
      "ADICIONAL_NAO_ENCONTRADO",
      "Um ou mais adicionais informados não existem ou estão inativos.",
      404,
      { codigos: faltantes },
    );
  }

  const itens = selecoes.map((selecao) =>
    calcularValorAdicional(
      porCodigo.get(selecao.codigo)!,
      selecao.quantidade ?? 1,
      input.convidados,
    ),
  );

  return {
    tabelaPreco,
    convidados: input.convidados,
    itens,
    valorTotal: arredondarDinheiro(
      itens.reduce((total, item) => total + item.valorTotal, 0),
    ),
  };
}

export async function calcularResumoComercial(
  input: CalcularResumoComercialInput,
  customDb?: DbExecutor,
): Promise<ResumoComercial> {
  const pacote = await precificarPacote(input, customDb);
  const adicionais = await precificarAdicionais(
    {
      data: input.data,
      convidados: input.convidados,
      itens: input.adicionais ?? [],
    },
    customDb,
  );

  if (adicionais.itens.length) {
    const vinculos = await (customDb ?? db()).query<{codigo:string}>(`
      SELECT a.codigo FROM pacote_adicionais pa
      JOIN adicionais a ON a.id=pa.adicional_id
      WHERE pa.pacote_id=$1 AND pa.ativo AND pa.modalidade='EXTRA'
        AND a.ativo AND a.codigo=ANY($2::text[])`,
      [pacote.pacote.id, adicionais.itens.map(item=>item.codigo)]);
    const permitidos = new Set(vinculos.rows.map(item=>item.codigo));
    if (adicionais.itens.some(item=>!permitidos.has(item.codigo))) {
      throw new PricingServiceError('ADICIONAL_NAO_ENCONTRADO',
        'Um ou mais adicionais não estão disponíveis para este pacote.',409);
    }
  }

  if (adicionais.tabelaPreco.id !== pacote.tabelaPreco.id) {
    throw new PricingServiceError(
      "TABELA_PRECO_NAO_CONFIGURADA",
      "O pacote e os adicionais não foram resolvidos pela mesma tabela de preço.",
      503,
    );
  }

  return {
    pacote,
    adicionais,
    valorTabelaPacoteBase: pacote.valorTabelaBase,
    valorDescontoPacote: pacote.desconto.valor,
    valorTabelaPacoteAplicado: pacote.valorTabelaAplicado,
    valorAdicionais: adicionais.valorTotal,
    valorTotalTabela: arredondarDinheiro(
      pacote.valorTabelaAplicado + adicionais.valorTotal,
    ),
  };
}
