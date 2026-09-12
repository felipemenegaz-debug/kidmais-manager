/* eslint-disable @typescript-eslint/no-require-imports -- Script operacional CommonJS com carregamento controlado dos services TypeScript. */
const { randomUUID } = require('node:crypto');

const FLAG_DEMO = 'SIM';
const MARCADOR_DEMO = 'KIDMAIS_DEMO_STAGING_V1';
const LOCK_DEMO = 'kidmais-criar-demo-staging-v1';
const CPF_DEMO = '11144477735';
const EMAIL_DEMO = 'cliente.demonstracao.kidmais@example.invalid';

function exigirTexto(env, nome) {
  const valor = env[nome]?.trim();
  if (!valor) throw new Error(`${nome} é obrigatória.`);
  return valor;
}

function nomeDoBanco(url) {
  const partes = url.pathname.split('/').filter(Boolean);
  if (partes.length !== 1) throw new Error('DATABASE_URL deve identificar exatamente um banco de staging.');
  return decodeURIComponent(partes[0]);
}

function ehLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function destinoSemCredenciais(url) {
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}/${nomeDoBanco(url)}`;
}

function validarConfiguracao(env = process.env) {
  if (env.KIDMAIS_DEPLOY_ENV !== 'staging') {
    throw new Error('Execução recusada: KIDMAIS_DEPLOY_ENV deve ser staging.');
  }
  if (env.KIDMAIS_CRIAR_DEMO_STAGING !== FLAG_DEMO) {
    throw new Error('Execução recusada: KIDMAIS_CRIAR_DEMO_STAGING deve ser SIM.');
  }
  if (env.RENDER !== 'true') {
    throw new Error('Execução recusada: a jornada demo deve rodar no staging do Render.');
  }

  const databaseUrl = exigirTexto(env, 'DATABASE_URL');
  const databaseName = exigirTexto(env, 'KIDMAIS_STAGING_DATABASE_NAME');
  const adminEmail = exigirTexto(env, 'KIDMAIS_DEMO_ADMIN_EMAIL').toLowerCase();
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL inválida.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password) {
    throw new Error('DATABASE_URL deve ser uma conexão PostgreSQL autenticada de staging.');
  }
  const nomeReal = nomeDoBanco(url);
  const producao = /(?:^|_)(?:prod|producao|production)(?:_|$)/i;
  if (nomeReal.toLowerCase() === 'kidmais_manager' || producao.test(nomeReal)) {
    throw new Error('Execução recusada: banco de produção não é permitido.');
  }
  if (nomeReal !== databaseName || producao.test(databaseName) || databaseName.toLowerCase() === 'kidmais_manager') {
    throw new Error('O banco deve corresponder ao nome exato de staging configurado.');
  }
  if (ehLoopback(url.hostname)) {
    throw new Error('Execução recusada: a jornada demo cloud não usa localhost ou loopback.');
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(adminEmail)) {
    throw new Error('KIDMAIS_DEMO_ADMIN_EMAIL inválido.');
  }

  const productionUrl = env.KIDMAIS_PRODUCTION_DATABASE_URL?.trim();
  if (productionUrl) {
    let parsedProduction;
    try {
      parsedProduction = new URL(productionUrl);
    } catch {
      throw new Error('KIDMAIS_PRODUCTION_DATABASE_URL inválida; comparação segura impossível.');
    }
    if (destinoSemCredenciais(url) === destinoSemCredenciais(parsedProduction)) {
      throw new Error('Execução recusada: DATABASE_URL aponta para o destino configurado como produção.');
    }
  }

  return { databaseUrl, databaseName, adminEmail };
}

function adicionarDias(data, dias) {
  const proxima = new Date(data.getTime());
  proxima.setUTCDate(proxima.getUTCDate() + dias);
  return proxima.toISOString().slice(0, 10);
}

function criarInputFechamento({ data, periodo, horario, pacoteId, valorTabela }) {
  return {
    dataEvento: data,
    horarioInicio: horario.inicio,
    horarioFim: horario.fim,
    configuracaoAgendaId: periodo.configuracaoId,
    pacoteId,
    convidados: 50,
    adicionais: [],
    valorProposto: valorTabela,
    formaPagamentoPretendida: 'CARTAO_CIELO',
    condicaoPixPretendida: null,
    identidade: { tipo: 'NOVO_CLIENTE' },
    idadeAniversarianteEvento: 7,
    temaFesta: 'Demonstração Kidmais',
    cliente: {
      nomeCompleto: 'Cliente Demonstração Kidmais',
      cpf: CPF_DEMO,
      telefone: '11900000000',
      whatsapp: '11900000000',
      email: EMAIL_DEMO,
      cep: '00000000',
      logradouro: 'Rua Demonstração',
      numero: '100',
      complemento: 'Ambiente de staging',
      bairro: 'Bairro Demonstração',
      cidade: 'São Paulo',
      uf: 'SP',
    },
    aniversariante: { nome: 'Maria Demo', temaPadrao: 'Demonstração Kidmais' },
    observacoesCliente: 'Jornada demonstrativa de staging com dados integralmente fictícios.',
    observacoesEquipe: `[${MARCADOR_DEMO}] Caso sintético. Não representa contratação, aceite ou pagamento real.`,
    buffetStatus: 'PENDENTE',
    requestId: randomUUID(),
    userAgent: 'SCRIPT_OPERACIONAL_DEMO_STAGING',
  };
}

function carregarDependencias() {
  require('./pagamentos-test-support.cjs');
  return {
    Client: require('pg').Client,
    consultarDisponibilidadePeriodo: require('../lib/disponibilidade/services/availability.service.ts').consultarDisponibilidadePeriodo,
    revalidarHorarioSelecionado: require('../lib/disponibilidade/services/availability.service.ts').revalidarHorarioSelecionado,
    calcularResumoComercial: require('../lib/comercial/services/index.ts').calcularResumoComercial,
    criarFechamento: require('../lib/fechamentos/services/fechamento-publico.service.ts').criarFechamentoPublicoComIdentidade,
    gerarContrato: require('../lib/contratos/services/contrato.service.ts').gerarContrato,
    registrarAuditoria: require('../lib/clientes/repositories/auditoria.repository.ts').registrarAuditoria,
    withTransaction: require('../lib/db/postgres.ts').withTransaction,
    closeDatabasePool: require('../lib/db/postgres.ts').closeDatabasePool,
  };
}

function opcoesCliente(databaseUrl, env = process.env) {
  return {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    ssl: env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
    application_name: 'kidmais-criar-demo-staging',
  };
}

async function localizarDemo(client) {
  const result = await client.query(`
    SELECT cli.id AS cliente_id, f.id AS fechamento_id, f.status AS fechamento_status, c.id AS contrato_id,
           c.status AS contrato_status, v.id AS versao_id, v.numero_versao,
           v.status AS versao_status, e.estado AS edicao_estado, f.data_evento::text AS data_evento
      FROM fechamentos f
      JOIN clientes cli ON cli.id=f.cliente_id
      LEFT JOIN contratos c ON c.fechamento_id=f.id
      LEFT JOIN contrato_versoes v ON v.contrato_id=c.id AND v.numero_versao=c.versao_atual
      LEFT JOIN contrato_edicoes e ON e.contrato_versao_id=v.id
     WHERE f.observacoes_equipe=$1 AND cli.cpf=$2 AND lower(cli.email)=lower($3)
     ORDER BY f.criado_em
  `, [`[${MARCADOR_DEMO}] Caso sintético. Não representa contratação, aceite ou pagamento real.`, CPF_DEMO, EMAIL_DEMO]);
  if (result.rows.length > 1) throw new Error('Mais de uma jornada demo foi encontrada; correção manual é necessária.');
  return result.rows[0] ?? null;
}

async function selecionarAgenda(deps, pacoteId) {
  const hoje = new Date();
  const inicio = adicionarDias(hoje, 14);
  const fim = adicionarDias(hoje, 75);
  const calendario = await deps.consultarDisponibilidadePeriodo(inicio, fim);
  for (const dia of calendario) {
    for (const periodo of dia.periodos) {
      for (const horario of periodo.horarios.filter((item) => item.status === 'DISPONIVEL')) {
        try {
          const resumo = await deps.calcularResumoComercial({
            data: dia.data,
            configuracaoAgendaId: periodo.configuracaoId,
            pacoteId,
            convidados: 50,
            adicionais: [],
          });
          return { data: dia.data, periodo, horario, resumo };
        } catch (erro) {
          const codigosEsperados = new Set([
            'TABELA_PRECO_NAO_CONFIGURADA',
            'CATEGORIA_HORARIO_NAO_CONFIGURADA',
            'ELEGIBILIDADE_NAO_CONFIGURADA',
            'PACOTE_INDISPONIVEL',
            'PRECO_PACOTE_NAO_CONFIGURADO',
          ]);
          if (!codigosEsperados.has(erro?.code)) throw erro;
          // Datas/turnos sem regra comercial para Festa Completa são ignorados.
        }
      }
    }
  }
  throw new Error('Nenhuma data futura disponível e comercialmente válida foi encontrada para Festa Completa.');
}

async function registrarAuditoriaDemo(deps, dados) {
  await deps.withTransaction(async (tx) => {
    const existente = await tx.query(
      "SELECT id FROM auditoria WHERE acao='STAGING_DEMO_CRIADA' AND entidade_tipo='CONTRATO' AND entidade_id=$1 LIMIT 1",
      [dados.contratoId],
    );
    if (existente.rows[0]) return;
    await deps.registrarAuditoria({
      clienteId: dados.clienteId,
      atorTipo: 'USUARIO',
      usuarioId: dados.usuarioId,
      acao: 'STAGING_DEMO_CRIADA',
      entidadeTipo: 'CONTRATO',
      entidadeId: dados.contratoId,
      dadosDepois: {
        marcador: MARCADOR_DEMO,
        fechamentoId: dados.fechamentoId,
        versaoId: dados.versaoId,
        dadosSinteticos: true,
        otpRealizado: false,
        assinaturaCriada: false,
      },
      justificativa: 'Jornada fictícia criada exclusivamente para demonstração no staging.',
      origem: 'STAGING_DEMO_OPERACIONAL',
      requestId: dados.requestId,
      userAgent: 'SCRIPT_OPERACIONAL_DEMO_STAGING',
    }, tx);
  });
}

async function executar(env = process.env, dependencias) {
  const config = validarConfiguracao(env);
  const deps = dependencias ?? carregarDependencias();
  const client = new deps.Client(opcoesCliente(config.databaseUrl, env));
  let lockObtido = false;
  try {
    await client.connect();
    const destino = await client.query('SELECT current_database() AS banco');
    if (destino.rows[0]?.banco !== config.databaseName) {
      throw new Error('Conexão física diverge do banco de staging configurado.');
    }
    const estrutura = await client.query(`SELECT
      to_regclass('public.clientes') IS NOT NULL AND
      to_regclass('public.fechamentos') IS NOT NULL AND
      to_regclass('public.contratos') IS NOT NULL AND
      to_regclass('public.contrato_versoes') IS NOT NULL AND
      to_regclass('public.contrato_edicoes') IS NOT NULL AS pronta`);
    if (estrutura.rows[0]?.pronta !== true) throw new Error('Estrutura necessária para a jornada demo está incompleta.');

    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS obtido', [LOCK_DEMO]);
    if (!lock.rows[0]?.obtido) throw new Error('Outra criação da jornada demo já está em execução.');
    lockObtido = true;

    const existente = await localizarDemo(client);
    if (existente?.contrato_id) return { reutilizado: true, ...existente };

    const admin = await client.query(
      "SELECT id FROM usuarios_administrativos WHERE lower(email)=lower($1) AND ativo=true AND papel IN ('ADMINISTRATIVO','REPRESENTANTE_AUTORIZADO') LIMIT 2",
      [config.adminEmail],
    );
    if (admin.rows.length !== 1) throw new Error('O operador administrativo de staging não foi encontrado de forma única e ativa.');
    let fechamentoId = existente?.fechamento_id;
    let clienteId = existente?.cliente_id;
    if (existente) {
      if (existente.fechamento_status !== 'AGUARDANDO_CONTRATO') {
        throw new Error('A jornada demo parcial existe em estado incompatível; nenhuma mutação foi feita.');
      }
    } else {
      const conflito = await client.query(
        'SELECT id FROM clientes WHERE cpf=$1 OR lower(email)=lower($2) LIMIT 1',
        [CPF_DEMO, EMAIL_DEMO],
      );
      if (conflito.rows[0]) {
        throw new Error('CPF ou e-mail reservado da demo já existe sem o marcador esperado; execução recusada.');
      }
      const pacote = await client.query("SELECT id FROM pacotes WHERE codigo='COMPLETA' AND ativo=true LIMIT 2");
      if (pacote.rows.length !== 1) throw new Error('O pacote ativo Festa Completa não foi encontrado de forma única.');
      const agenda = await selecionarAgenda(deps, pacote.rows[0].id);
      await deps.revalidarHorarioSelecionado({
        data: agenda.data,
        codigoPeriodo: agenda.periodo.codigo,
        inicio: agenda.horario.inicio,
        fim: agenda.horario.fim,
        ajusteMinutos: agenda.horario.ajusteMinutos,
      });
      const input = criarInputFechamento({
        data: agenda.data,
        periodo: agenda.periodo,
        horario: agenda.horario,
        pacoteId: pacote.rows[0].id,
        valorTabela: agenda.resumo.valorTotalTabela,
      });
      const criado = await deps.criarFechamento(input);
      if (criado.fechamento.status !== 'AGUARDANDO_CONTRATO' || criado.aprovacaoNegociacao !== null) {
        throw new Error('A condição comercial sintética não resultou no estado seguro esperado para gerar Contrato.');
      }
      fechamentoId = criado.fechamento.id;
      clienteId = criado.fechamento.clienteId;
    }
    if (!fechamentoId || !clienteId) throw new Error('A jornada demo não possui referências suficientes para gerar o Contrato.');
    const requestId = randomUUID();
    const contrato = await deps.gerarContrato(
      { fechamentoId, motivoNovaVersao: 'Demonstração sintética exclusiva do staging.' },
      {
        usuarioId: admin.rows[0].id,
        origem: 'CONTRATO_INTERNO_DEV',
        requestId,
        userAgent: 'SCRIPT_OPERACIONAL_DEMO_STAGING',
      },
    );
    if (contrato.contrato.status !== 'AGUARDANDO_ASSINATURA' || contrato.versao.status !== 'ATIVA') {
      throw new Error('O Contrato demo não ficou no estado não assinado esperado.');
    }
    await registrarAuditoriaDemo(deps, {
      clienteId,
      usuarioId: admin.rows[0].id,
      fechamentoId,
      contratoId: contrato.contrato.id,
      versaoId: contrato.versao.id,
      requestId,
    });
    const final = await localizarDemo(client);
    if (!final) throw new Error('A jornada demo criada não pôde ser localizada pelo marcador canônico.');
    const derivados = await client.query(`SELECT
      (SELECT count(*)::int FROM contrato_assinaturas WHERE contrato_versao_id=$1) AS assinaturas,
      (SELECT count(*)::int FROM pagamentos WHERE fechamento_id=$2) AS pagamentos,
      (SELECT count(*)::int FROM festas WHERE fechamento_id=$2) AS festas`,
    [contrato.versao.id, fechamentoId]);
    if (derivados.rows[0].assinaturas !== 0 || derivados.rows[0].pagamentos !== 0 || derivados.rows[0].festas !== 0) {
      throw new Error('Execução recusada: a jornada demo criou registros posteriores à assinatura.');
    }
    return { reutilizado: false, ...final };
  } finally {
    if (lockObtido) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_DEMO]);
    await client.end().catch(() => {});
    await deps.closeDatabasePool?.().catch(() => {});
  }
}

module.exports = {
  CPF_DEMO,
  EMAIL_DEMO,
  MARCADOR_DEMO,
  criarInputFechamento,
  executar,
  validarConfiguracao,
};

if (require.main === module) {
  executar().then((resultado) => {
    console.log(JSON.stringify({ ok: true, demo: resultado }, null, 2));
  }).catch((erro) => {
    console.error(`[Kidmais Demo Staging] ${erro instanceof Error ? erro.message : 'Falha desconhecida.'}`);
    process.exitCode = 1;
  });
}
