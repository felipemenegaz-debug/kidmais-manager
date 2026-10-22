import { EMPRESA_SAAS_DO_PERFIL } from '../perfil/autorizacao.ts';

/**
 * Inventário da exportação verificável (formato 1). Cada entidade é UMA tabela do schema, filtrada SÓ pela empresa
 * comprovada ($1): diretamente por `empresa_id` ou pela cadeia de posse até uma tabela que tem `empresa_id`
 * (cliente → empresa; fechamento → empresa; contrato → fechamento; versão → contrato; pagamento → versão; festa →
 * contrato…). Os aliases são sempre qualificados: uma coluna ausente na subconsulta nunca cai na tabela de fora.
 *
 * As colunas NÃO são fixadas aqui: são lidas do schema no momento da exportação (o pacote acompanha o banco de cada
 * ambiente), menos as exclusões declaradas e as do padrão de segredos (SEGREDO). Binários (bytea) viram tamanho e
 * SHA-256; só o PDF dos contratos entra como arquivo. Uma suíte PostgreSQL confere que TODA tabela do schema está aqui
 * ou em FORA_DO_ESCOPO, e as colunas exportadas contra um retrato (colunas-esperadas.json): migration nova = revisão.
 */
export type Entidade = {
    /** Caminho do CSV no pacote, sem extensão (dados/<grupo>/<nome>). */
    arquivo: string;
    tabela: string;
    grupo: string;
    descricao: string;
    /** Condição sobre a tabela (alias t) com $1 = empresa comprovada. */
    onde: string;
    /** Colunas excluídas e o motivo (além do padrão SEGREDO). */
    excluir?: Readonly<Record<string, string>>;
    /** Só estas colunas (lista de permissão), quando a tabela é compartilhada com dados que não são da empresa. */
    somente?: readonly string[];
    /** Coluna bytea exportada como arquivo do pacote (PDFs dos contratos). As demais bytea viram tamanho + SHA-256. */
    arquivoBinario?: { coluna: string; pasta: string; extensao: string };
};

/** Defesa em profundidade: nenhum nome de coluna que case com este padrão sai no pacote, mesmo sem exclusão declarada. */
export const SEGREDO = /(senha|password|token_hash|^token$|publico_token|editor_hash|codigo_hash|token_prova|csrf|credencial|secret|segredo|posse_token|token_verificacao|state_hash|chave_hash)/i;

const EMP = 't.empresa_id = $1::uuid';
const CLIENTES = 'SELECT c.id FROM clientes c WHERE c.empresa_id = $1::uuid';
const FECHAMENTOS = 'SELECT f.id FROM fechamentos f WHERE f.empresa_id = $1::uuid';
const CONTRATOS = `SELECT ct.id FROM contratos ct WHERE ct.fechamento_id IN (${FECHAMENTOS})`;
const VERSOES = `SELECT cv.id FROM contrato_versoes cv WHERE cv.contrato_id IN (${CONTRATOS})`;
const PAGAMENTOS = `SELECT pg.id FROM pagamentos pg WHERE pg.contrato_versao_id IN (${VERSOES})`;
const PLANOS = `SELECT pp.id FROM pagamento_planos pp WHERE pp.pagamento_id IN (${PAGAMENTOS})`;
const RECEBIMENTOS = `SELECT pr.id FROM pagamento_recebimentos pr WHERE pr.pagamento_id IN (${PAGAMENTOS})`;
const AJUSTES = `SELECT pa.id FROM pagamento_ajustes_contratuais pa WHERE pa.pagamento_id IN (${PAGAMENTOS})`;
const CRONOGRAMAS = `SELECT pc.id FROM pagamento_cronogramas pc WHERE pc.pagamento_id IN (${PAGAMENTOS})`;
const DEVOLUCOES = `SELECT pd.id FROM pagamento_devolucoes pd WHERE pd.pagamento_id IN (${PAGAMENTOS})`;
const FESTAS = `SELECT fe.id FROM festas fe WHERE fe.contrato_id IN (${CONTRATOS})`;
const PACOTES = 'SELECT pa.id FROM pacotes pa WHERE pa.empresa_id = $1::uuid';
const TABELAS = 'SELECT tp.id FROM tabelas_preco tp WHERE tp.empresa_id = $1::uuid';
const ESCOPOS = `SELECT te.id FROM tabela_preco_escopos te WHERE te.tabela_preco_id IN (${TABELAS})`;
const AGENDAS = 'SELECT ca.id FROM configuracao_agenda ca WHERE ca.empresa_id = $1::uuid';
const REVISOES = `SELECT fr.id FROM fechamento_revisoes fr WHERE fr.fechamento_id IN (${FECHAMENTOS})`;
const SNAP_PACOTE = `SELECT sp.id FROM fechamento_pacote_snapshots sp WHERE sp.fechamento_id IN (${FECHAMENTOS})`;
const SNAP_BUFFET = `SELECT sb.id FROM fechamento_buffet_snapshots sb WHERE sb.fechamento_id IN (${FECHAMENTOS})`;
const CONVITES = 'SELECT cn.id FROM convites cn WHERE cn.empresa_id = $1::uuid';
/** Perfil legado ↔ empresa SaaS: a mesma associação de lib/perfil/autorizacao.ts (um único candidato). */
const PERFIS = `SELECT p.id FROM perfil_empresas p JOIN LATERAL (${EMPRESA_SAAS_DO_PERFIL}) e ON e.candidatos = 1 WHERE e.id = $1::uuid`;
const USUARIOS = 'SELECT m.usuario_id FROM memberships m WHERE m.empresa_id = $1::uuid';

const em = (sub: string, coluna: string) => `t.${coluna} IN (${sub})`;
const TECNICO = 'credencial ou segredo técnico';

/** Exclusões declaradas por tabela (o padrão SEGREDO também as cobriria; ficam explícitas para o documento). */
const EXCLUSOES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    convites: { publico_token: TECNICO, editor_hash: TECNICO },
    convite_familias: { token_hash: TECNICO },
    convites_acesso: { token_hash: TECNICO },
    validacoes_identidade_cliente: { codigo_hash: TECNICO, token_prova_hash: TECNICO },
    whatsapp_atendimento_arquivos: { token: 'link de acesso ao arquivo' },
    whatsapp_conexoes: { credencial_cifrada: TECNICO, credencial_iv: TECNICO, credencial_tag: TECNICO, credencial_chave_versao: TECNICO },
    marketing_dominios: { token_verificacao: TECNICO },
    marketing_automacao_execucoes: { posse_token: 'trava interna do processamento' },
    convite_respostas: { chave: 'identificador do convidado no link público (permite alterar a resposta)' },
    // Dados de segurança da sessão de quem operou (não são prova do contrato; a prova do aceite do cliente fica em
    // contrato_assinaturas, com IP e navegador, por ser a evidência do contrato da própria empresa).
    aceites_documentos_legais: { ip: 'dado de segurança da sessão', user_agent: 'dado de segurança da sessão' },
    pagamento_eventos: { ip: 'dado de segurança da sessão', user_agent: 'dado de segurança da sessão', sessao_id: 'dado de segurança da sessão' },
    // A prova do aceite é método, data, IP, navegador e hashes; o id interno da sessão administrativa não prova nada (P3-1).
    contrato_assinaturas: { sessao_id: 'identificador interno da sessão (não é prova do aceite)' },
    // 089 (devolução): a chave de repetição da tela é técnica; a situação do aviso interno é controle da operação da
    // plataforma (se a equipe Kidmais foi avisada), não dado do pedido. Protocolo, valores, prazos, situação do
    // cancelamento e do estorno e o e-mail de confirmação da própria empresa saem.
    assinatura_encerramentos: { chave_idempotencia: 'identificador técnico de repetição da tela', aviso_interno_situacao: 'controle interno da plataforma (aviso à equipe Kidmais)' },
    // 095 (créditos de IA): saem saldo, lotes (origem, quantidade, preço, vencimento), extrato, reservas, pedidos (oferta, valor,
    // termos, protocolo), cobranças, devoluções, cortesias e o corte do legado. Ficam fora chaves técnicas de repetição e
    // deduplicação, a URL da fatura (contém token de acesso), a conta do provedor, controles internos de risco e a
    // identidade/motivo do operador da plataforma.
    ia_credito_lotes: { chave_origem: 'identificador técnico de deduplicação da concessão' },
    ia_credito_lancamentos: { operacao: 'identificador técnico de deduplicação do lançamento' },
    ia_credito_reservas: { operacao_id: 'identificador técnico da operação (geração/chamada)' },
    ia_credito_pedidos: { chave_idempotencia: 'identificador técnico de repetição da tela', payload_sha256: 'hash técnico de repetição da tela' },
    ia_credito_cobrancas: { conta: 'metadado técnico da conta do provedor', url_fatura: 'link de pagamento com token de acesso', referencia_externa: 'correlação técnica com o provedor',
        exposicao_centavos: 'controle interno de risco da plataforma', revisao_motivo: 'controle interno da plataforma',
        conferida_em: 'controle interno da reconciliação' },
    ia_credito_devolucoes: { chave_idempotencia: 'identificador técnico de repetição da tela' },
    ia_credito_cortesias: { chave_idempotencia: 'identificador técnico de repetição', motivo: 'registro interno da plataforma', concedida_por: 'identidade do operador da plataforma' },
    ia_credito_cortes: { referencia_autorizacao: 'registro interno da autorização da plataforma' },
};

const BASE: readonly Entidade[] = [
    // Empresa, cadastro e pessoas com acesso
    { arquivo: 'empresa/empresa', tabela: 'empresas', grupo: 'Empresa', descricao: 'A própria empresa (código, nome, situação).', onde: 't.id = $1::uuid' },
    { arquivo: 'empresa/perfil_empresa', tabela: 'perfil_empresas', grupo: 'Empresa', descricao: 'Perfil cadastral (nome comercial, razão social, CNPJ, sede).', onde: em(PERFIS, 'id') },
    { arquivo: 'empresa/perfil_unidades', tabela: 'perfil_unidades', grupo: 'Empresa', descricao: 'Unidades do perfil.', onde: em(PERFIS, 'empresa_id') },
    { arquivo: 'empresa/perfil_revisoes', tabela: 'perfil_empresa_revisoes', grupo: 'Empresa', descricao: 'Revisões do perfil cadastral.', onde: em(PERFIS, 'empresa_id') },
    { arquivo: 'empresa/perfil_concessoes', tabela: 'perfil_empresa_concessoes', grupo: 'Empresa', descricao: 'Concessões de edição do perfil.', onde: em(PERFIS, 'empresa_id') },
    { arquivo: 'empresa/cadastro', tabela: 'cadastros_empresas', grupo: 'Empresa', descricao: 'Cadastro feito pela própria empresa.', onde: EMP },
    { arquivo: 'empresa/socios', tabela: 'empresa_socios', grupo: 'Empresa', descricao: 'Sócios declarados.', onde: EMP },
    { arquivo: 'empresa/representacoes', tabela: 'empresa_representacoes', grupo: 'Empresa', descricao: 'Representações da empresa.', onde: EMP },
    { arquivo: 'empresa/estabelecimentos', tabela: 'estabelecimentos', grupo: 'Empresa', descricao: 'Estabelecimentos (unidades) da empresa.', onde: EMP },
    { arquivo: 'empresa/aceites_documentos_legais', tabela: 'aceites_documentos_legais', grupo: 'Empresa', descricao: 'Aceites dos Termos e do Aviso pelas pessoas da empresa.', onde: EMP },
    { arquivo: 'empresa/assinatura', tabela: 'empresa_assinaturas', grupo: 'Empresa', descricao: 'Assinatura do Kidmais Manager (situação e ciclo).', onde: EMP },
    { arquivo: 'empresa/assinatura_contratacoes', tabela: 'assinatura_contratacoes', grupo: 'Empresa', descricao: 'Contratações da assinatura.', onde: EMP },
    { arquivo: 'empresa/assinatura_renovacoes', tabela: 'assinatura_renovacoes', grupo: 'Empresa', descricao: 'Avisos de renovação da assinatura.', onde: EMP },
    { arquivo: 'empresa/assinatura_encerramentos', tabela: 'assinatura_encerramentos', grupo: 'Empresa', descricao: 'Pedidos de cancelamento e devolução da assinatura (protocolo).', onde: EMP },
    {
        arquivo: 'empresa/usuarios', tabela: 'usuarios_administrativos', grupo: 'Empresa', descricao: 'Pessoas com vínculo nesta empresa (sem senha nem papel global).',
        onde: em(USUARIOS, 'id'), somente: ['id', 'nome', 'email', 'cargo', 'ativo', 'criado_em'],
    },
    { arquivo: 'empresa/vinculos', tabela: 'memberships', grupo: 'Empresa', descricao: 'Vínculos (papel e situação de cada pessoa nesta empresa).', onde: EMP },
    { arquivo: 'empresa/vinculo_estabelecimentos', tabela: 'membership_estabelecimentos', grupo: 'Empresa', descricao: 'Estabelecimentos de cada vínculo.', onde: EMP },
    { arquivo: 'empresa/vinculo_capacidades', tabela: 'empresa_membership_capacidades', grupo: 'Empresa', descricao: 'Capacidades concedidas por vínculo.', onde: EMP },
    { arquivo: 'empresa/vinculo_capacidades_festa', tabela: 'festa_membership_capacidades', grupo: 'Empresa', descricao: 'Capacidades de Festa por vínculo.', onde: EMP },
    { arquivo: 'empresa/vinculo_capacidades_marketing', tabela: 'marketing_membership_capacidades', grupo: 'Empresa', descricao: 'Capacidades de Marketing por vínculo.', onde: EMP },
    { arquivo: 'empresa/convites_de_acesso', tabela: 'convites_acesso', grupo: 'Empresa', descricao: 'Convites de acesso enviados a pessoas.', onde: EMP },
    { arquivo: 'empresa/solicitacoes_de_acesso', tabela: 'solicitacoes_acesso_empresa', grupo: 'Empresa', descricao: 'Pedidos de acesso à empresa.', onde: EMP },

    // Clientes
    { arquivo: 'clientes/clientes', tabela: 'clientes', grupo: 'Clientes', descricao: 'Clientes (responsáveis contratantes).', onde: EMP },
    { arquivo: 'clientes/aniversariantes', tabela: 'aniversariantes', grupo: 'Clientes', descricao: 'Aniversariantes de cada cliente.', onde: em(CLIENTES, 'cliente_id') },
    { arquivo: 'clientes/responsaveis_adicionais', tabela: 'responsaveis_adicionais', grupo: 'Clientes', descricao: 'Outros responsáveis do cliente.', onde: em(CLIENTES, 'cliente_id') },
    { arquivo: 'clientes/historico', tabela: 'eventos_historico_cliente', grupo: 'Clientes', descricao: 'Histórico de eventos do cliente.', onde: em(CLIENTES, 'cliente_id') },
    { arquivo: 'clientes/mesclagens', tabela: 'mesclagens_clientes', grupo: 'Clientes', descricao: 'Mesclagens de cadastros duplicados.', onde: em(CLIENTES, 'cliente_principal_id') },
    { arquivo: 'clientes/possiveis_duplicidades', tabela: 'possiveis_duplicidades_cliente', grupo: 'Clientes', descricao: 'Possíveis duplicidades apontadas.', onde: `${em(CLIENTES, 'cliente_a_id')} AND ${em(CLIENTES, 'cliente_b_id')}` },
    { arquivo: 'clientes/validacoes_identidade', tabela: 'validacoes_identidade_cliente', grupo: 'Clientes', descricao: 'Validações de identidade do cliente (sem código nem prova).', onde: em(CLIENTES, 'cliente_id') },

    // Fechamentos e contratos
    { arquivo: 'contratos/fechamentos', tabela: 'fechamentos', grupo: 'Contratos', descricao: 'Fechamentos (negociação da festa).', onde: EMP },
    { arquivo: 'contratos/fechamento_adicionais', tabela: 'fechamento_adicionais', grupo: 'Contratos', descricao: 'Adicionais de cada fechamento.', onde: em(FECHAMENTOS, 'fechamento_id') },
    { arquivo: 'contratos/fechamento_revisoes', tabela: 'fechamento_revisoes', grupo: 'Contratos', descricao: 'Revisões de fechamento.', onde: em(FECHAMENTOS, 'fechamento_id') },
    { arquivo: 'contratos/fechamento_revisao_adicionais', tabela: 'fechamento_revisao_adicionais', grupo: 'Contratos', descricao: 'Adicionais das revisões.', onde: em(REVISOES, 'fechamento_revisao_id') },
    { arquivo: 'contratos/aprovacoes_negociacao', tabela: 'aprovacoes_negociacao', grupo: 'Contratos', descricao: 'Aprovações de negociação.', onde: em(FECHAMENTOS, 'fechamento_id') },
    { arquivo: 'contratos/fechamento_pacote_snapshots', tabela: 'fechamento_pacote_snapshots', grupo: 'Contratos', descricao: 'Pacote congelado no fechamento.', onde: em(FECHAMENTOS, 'fechamento_id') },
    { arquivo: 'contratos/fechamento_pacote_composicao', tabela: 'fechamento_pacote_composicao', grupo: 'Contratos', descricao: 'Composição do pacote congelado.', onde: em(SNAP_PACOTE, 'snapshot_id') },
    { arquivo: 'contratos/fechamento_pacote_itens_especificos', tabela: 'fechamento_pacote_itens_especificos', grupo: 'Contratos', descricao: 'Itens específicos do pacote congelado.', onde: em(SNAP_PACOTE, 'snapshot_id') },
    { arquivo: 'contratos/fechamento_buffet_snapshots', tabela: 'fechamento_buffet_snapshots', grupo: 'Contratos', descricao: 'Buffet congelado no fechamento.', onde: em(FECHAMENTOS, 'fechamento_id') },
    { arquivo: 'contratos/fechamento_buffet_escolhas', tabela: 'fechamento_buffet_escolhas', grupo: 'Contratos', descricao: 'Escolhas do buffet congelado.', onde: em(SNAP_BUFFET, 'snapshot_id') },
    { arquivo: 'contratos/contratos', tabela: 'contratos', grupo: 'Contratos', descricao: 'Contratos.', onde: em(FECHAMENTOS, 'fechamento_id') },
    { arquivo: 'contratos/contrato_versoes', tabela: 'contrato_versoes', grupo: 'Contratos', descricao: 'Versões de cada contrato (com o retrato contratual).', onde: em(CONTRATOS, 'contrato_id') },
    {
        arquivo: 'contratos/contrato_documentos', tabela: 'contrato_documentos', grupo: 'Contratos', descricao: 'Documentos (PDF) de cada versão; o arquivo está em arquivos/contratos/.',
        onde: em(VERSOES, 'contrato_versao_id'), arquivoBinario: { coluna: 'conteudo_pdf', pasta: 'arquivos/contratos', extensao: 'pdf' },
    },
    { arquivo: 'contratos/contrato_assinaturas', tabela: 'contrato_assinaturas', grupo: 'Contratos', descricao: 'Assinaturas e aceites (evidência: método, data, IP e navegador).', onde: em(VERSOES, 'contrato_versao_id') },
    { arquivo: 'contratos/contrato_edicoes', tabela: 'contrato_edicoes', grupo: 'Contratos', descricao: 'Edições de versão.', onde: em(VERSOES, 'contrato_versao_id') },
    { arquivo: 'contratos/contrato_fluxos', tabela: 'contrato_fluxos', grupo: 'Contratos', descricao: 'Versão vigente e em preparação.', onde: em(CONTRATOS, 'contrato_id') },
    { arquivo: 'contratos/contrato_pendencias_financeiras', tabela: 'contrato_pendencias_financeiras', grupo: 'Contratos', descricao: 'Pendências financeiras entre versões.', onde: em(CONTRATOS, 'contrato_id') },
    { arquivo: 'contratos/importacoes', tabela: 'contrato_importacoes', grupo: 'Contratos', descricao: 'Contratos importados.', onde: EMP },
    { arquivo: 'contratos/importacao_financeiro', tabela: 'contrato_importacao_financeiro', grupo: 'Contratos', descricao: 'Financeiro dos contratos importados.', onde: EMP },

    // Festas
    { arquivo: 'festas/festas', tabela: 'festas', grupo: 'Festas', descricao: 'Festas.', onde: em(CONTRATOS, 'contrato_id') },
    { arquivo: 'festas/buffet', tabela: 'festa_buffet', grupo: 'Festas', descricao: 'Buffet da festa.', onde: em(FESTAS, 'festa_id') },
    { arquivo: 'festas/contagens_convidados', tabela: 'festa_contagens_convidados', grupo: 'Festas', descricao: 'Contagens de convidados.', onde: em(FESTAS, 'festa_id') },
    { arquivo: 'festas/eventos', tabela: 'festa_eventos', grupo: 'Festas', descricao: 'Eventos da festa.', onde: em(FESTAS, 'festa_id') },
    { arquivo: 'festas/pendencias', tabela: 'festa_pendencias', grupo: 'Festas', descricao: 'Pendências da festa.', onde: em(FESTAS, 'festa_id') },
    { arquivo: 'festas/solicitacoes', tabela: 'festa_solicitacoes', grupo: 'Festas', descricao: 'Solicitações da festa.', onde: em(FESTAS, 'festa_id') },
    { arquivo: 'festas/tarefas', tabela: 'festa_tarefas', grupo: 'Festas', descricao: 'Tarefas da festa.', onde: em(FESTAS, 'festa_id') },
    { arquivo: 'festas/areas', tabela: 'festa_areas', grupo: 'Festas', descricao: 'Áreas da equipe.', onde: EMP },

    // Financeiro: a receber (pagamentos dos contratos) e a pagar
    { arquivo: 'financeiro/pagamentos', tabela: 'pagamentos', grupo: 'Financeiro', descricao: 'Pagamentos de cada versão de contrato.', onde: em(VERSOES, 'contrato_versao_id') },
    { arquivo: 'financeiro/pagamento_planos', tabela: 'pagamento_planos', grupo: 'Financeiro', descricao: 'Planos de pagamento.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/parcelas', tabela: 'pagamento_parcelas', grupo: 'Financeiro', descricao: 'Parcelas a receber.', onde: em(PLANOS, 'plano_id') },
    { arquivo: 'financeiro/recebimentos', tabela: 'pagamento_recebimentos', grupo: 'Financeiro', descricao: 'Recebimentos.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/recebimento_alocacoes', tabela: 'pagamento_recebimento_alocacoes', grupo: 'Financeiro', descricao: 'Alocação dos recebimentos nas parcelas.', onde: em(RECEBIMENTOS, 'recebimento_id') },
    { arquivo: 'financeiro/comprovantes', tabela: 'pagamento_comprovantes', grupo: 'Financeiro', descricao: 'Comprovantes de recebimento (metadados).', onde: em(RECEBIMENTOS, 'recebimento_id') },
    { arquivo: 'financeiro/estornos', tabela: 'pagamento_estornos', grupo: 'Financeiro', descricao: 'Estornos.', onde: em(RECEBIMENTOS, 'recebimento_id') },
    { arquivo: 'financeiro/gestoes', tabela: 'pagamento_gestoes', grupo: 'Financeiro', descricao: 'Gestão de cada pagamento.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/pagamento_eventos', tabela: 'pagamento_eventos', grupo: 'Financeiro', descricao: 'Eventos do pagamento.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/tratamentos', tabela: 'pagamento_tratamentos', grupo: 'Financeiro', descricao: 'Tratamentos de pendência.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/ajustes_contratuais', tabela: 'pagamento_ajustes_contratuais', grupo: 'Financeiro', descricao: 'Ajustes contratuais.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/ajuste_bases', tabela: 'pagamento_ajuste_bases', grupo: 'Financeiro', descricao: 'Bases dos ajustes.', onde: em(AJUSTES, 'ajuste_id') },
    { arquivo: 'financeiro/credito_reservas', tabela: 'pagamento_credito_reservas', grupo: 'Financeiro', descricao: 'Reservas de crédito.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/cronogramas', tabela: 'pagamento_cronogramas', grupo: 'Financeiro', descricao: 'Cronogramas.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/cronograma_itens', tabela: 'pagamento_cronograma_itens', grupo: 'Financeiro', descricao: 'Itens dos cronogramas.', onde: em(CRONOGRAMAS, 'cronograma_id') },
    { arquivo: 'financeiro/devolucoes', tabela: 'pagamento_devolucoes', grupo: 'Financeiro', descricao: 'Devoluções ao cliente.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/devolucao_alocacoes', tabela: 'pagamento_devolucao_alocacoes', grupo: 'Financeiro', descricao: 'Alocação das devoluções.', onde: em(DEVOLUCOES, 'devolucao_id') },
    { arquivo: 'financeiro/devolucao_comprovantes', tabela: 'pagamento_devolucao_comprovantes', grupo: 'Financeiro', descricao: 'Comprovantes de devolução (tamanho e SHA-256).', onde: em(DEVOLUCOES, 'devolucao_id') },
    { arquivo: 'financeiro/movimentos_contextos', tabela: 'pagamento_movimentos_contextos', grupo: 'Financeiro', descricao: 'Contexto econômico dos movimentos.', onde: em(PAGAMENTOS, 'pagamento_id') },
    { arquivo: 'financeiro/categorias', tabela: 'financeiro_categorias', grupo: 'Financeiro', descricao: 'Categorias do contas a pagar.', onde: EMP },
    { arquivo: 'financeiro/contas_pagar', tabela: 'financeiro_contas_pagar', grupo: 'Financeiro', descricao: 'Contas a pagar.', onde: EMP },
    { arquivo: 'financeiro/saidas', tabela: 'financeiro_saidas', grupo: 'Financeiro', descricao: 'Pagamentos das contas (saídas).', onde: EMP },
    { arquivo: 'financeiro/recorrencias', tabela: 'financeiro_recorrencias', grupo: 'Financeiro', descricao: 'Recorrências do contas a pagar.', onde: EMP },
    { arquivo: 'financeiro/entradas_manuais', tabela: 'financeiro_entradas_manuais', grupo: 'Financeiro', descricao: 'Entradas manuais.', onde: EMP },
    { arquivo: 'financeiro/auditoria_financeira', tabela: 'financeiro_auditoria', grupo: 'Financeiro', descricao: 'Auditoria do financeiro da empresa.', onde: EMP },

    // Agenda
    { arquivo: 'agenda/configuracao_agenda', tabela: 'configuracao_agenda', grupo: 'Agenda', descricao: 'Horários e configuração da agenda.', onde: EMP },
    { arquivo: 'agenda/regras_categoria_horario', tabela: 'regras_categoria_horario', grupo: 'Agenda', descricao: 'Regras de categoria por horário.', onde: em(AGENDAS, 'configuracao_agenda_id') },
    { arquivo: 'agenda/bloqueios', tabela: 'bloqueios_agenda', grupo: 'Agenda', descricao: 'Bloqueios da agenda.', onde: EMP },

    // Pacotes, catálogo e preços
    { arquivo: 'catalogo/pacotes', tabela: 'pacotes', grupo: 'Catálogo', descricao: 'Pacotes.', onde: EMP },
    { arquivo: 'catalogo/pacote_adicionais', tabela: 'pacote_adicionais', grupo: 'Catálogo', descricao: 'Adicionais de cada pacote.', onde: em(PACOTES, 'pacote_id') },
    { arquivo: 'catalogo/pacote_buffet_categorias', tabela: 'pacote_buffet_categorias', grupo: 'Catálogo', descricao: 'Categorias de buffet do pacote.', onde: em(PACOTES, 'pacote_id') },
    { arquivo: 'catalogo/pacote_buffet_itens', tabela: 'pacote_buffet_itens', grupo: 'Catálogo', descricao: 'Itens de buffet do pacote.', onde: em(PACOTES, 'pacote_id') },
    { arquivo: 'catalogo/pacote_itens_especificos', tabela: 'pacote_itens_especificos', grupo: 'Catálogo', descricao: 'Itens específicos do pacote.', onde: em(PACOTES, 'pacote_id') },
    { arquivo: 'catalogo/regras_desconto_pacote', tabela: 'regras_desconto_pacote', grupo: 'Catálogo', descricao: 'Descontos por pacote.', onde: em(PACOTES, 'pacote_id') },
    { arquivo: 'catalogo/regras_disponibilidade_pacote', tabela: 'regras_disponibilidade_pacote', grupo: 'Catálogo', descricao: 'Disponibilidade por pacote.', onde: em(PACOTES, 'pacote_id') },
    { arquivo: 'catalogo/adicionais', tabela: 'adicionais', grupo: 'Catálogo', descricao: 'Adicionais.', onde: EMP },
    { arquivo: 'catalogo/buffet_categorias', tabela: 'buffet_categorias', grupo: 'Catálogo', descricao: 'Categorias do buffet.', onde: EMP },
    { arquivo: 'catalogo/buffet_itens', tabela: 'buffet_itens', grupo: 'Catálogo', descricao: 'Itens do buffet.', onde: EMP },
    { arquivo: 'catalogo/tabelas_preco', tabela: 'tabelas_preco', grupo: 'Catálogo', descricao: 'Tabelas de preço.', onde: EMP },
    { arquivo: 'catalogo/precos_pacote', tabela: 'precos_pacote', grupo: 'Catálogo', descricao: 'Preços de pacote.', onde: em(TABELAS, 'tabela_preco_id') },
    { arquivo: 'catalogo/precos_adicional', tabela: 'precos_adicional', grupo: 'Catálogo', descricao: 'Preços de adicional.', onde: em(TABELAS, 'tabela_preco_id') },
    { arquivo: 'catalogo/tabela_preco_escopos', tabela: 'tabela_preco_escopos', grupo: 'Catálogo', descricao: 'Escopos das tabelas.', onde: em(TABELAS, 'tabela_preco_id') },
    { arquivo: 'catalogo/tabela_preco_escopo_faixas', tabela: 'tabela_preco_escopo_faixas', grupo: 'Catálogo', descricao: 'Faixas dos escopos.', onde: em(ESCOPOS, 'escopo_id') },
    { arquivo: 'catalogo/parametros_consumo', tabela: 'operacional_parametros_consumo', grupo: 'Catálogo', descricao: 'Parâmetros operacionais de consumo.', onde: EMP },
    { arquivo: 'catalogo/regras_pagamento', tabela: 'empresa_regras_pagamento', grupo: 'Catálogo', descricao: 'Regras de pagamento da empresa.', onde: EMP },
    { arquivo: 'catalogo/pix_recebimento', tabela: 'empresa_pix_recebimento', grupo: 'Catálogo', descricao: 'Chave Pix de recebimento da empresa.', onde: EMP },
    { arquivo: 'catalogo/modelos_contrato', tabela: 'modelos_contrato_empresa', grupo: 'Catálogo', descricao: 'Modelos de contrato da empresa.', onde: EMP },
    { arquivo: 'catalogo/importacoes_comerciais', tabela: 'importacoes_comerciais', grupo: 'Catálogo', descricao: 'Importações de tabela de preços e modelo (arquivo: tamanho e SHA-256).', onde: EMP },

    // Convites
    { arquivo: 'convites/convites', tabela: 'convites', grupo: 'Convites', descricao: 'Convites (sem o código do link público).', onde: EMP },
    { arquivo: 'convites/familias', tabela: 'convite_familias', grupo: 'Convites', descricao: 'Famílias convidadas (sem o código do link).', onde: EMP },
    { arquivo: 'convites/respostas', tabela: 'convite_respostas', grupo: 'Convites', descricao: 'Respostas (confirmação de presença).', onde: em(CONVITES, 'convite_id') },
    { arquivo: 'convites/eventos', tabela: 'convite_eventos', grupo: 'Convites', descricao: 'Eventos do convite.', onde: em(CONVITES, 'convite_id') },
    { arquivo: 'convites/artes', tabela: 'convite_artes', grupo: 'Convites', descricao: 'Artes do convite (imagem: tamanho e SHA-256).', onde: EMP },
    { arquivo: 'convites/geracoes', tabela: 'convite_geracoes', grupo: 'Convites', descricao: 'Gerações com IA (resultado: tamanho e SHA-256).', onde: EMP },
    { arquivo: 'convites/autorizacoes_ia', tabela: 'convite_ia_autorizacoes', grupo: 'Convites', descricao: 'Autorizações do responsável para IA.', onde: EMP },

    // Créditos de IA (095; ausentes enquanto a migration não for aplicada — o pacote registra a ausência)
    { arquivo: 'creditos/carteiras', tabela: 'ia_credito_carteiras', grupo: 'Créditos de IA', descricao: 'Saldo de créditos por recurso (Convites, Wall-e).', onde: EMP },
    { arquivo: 'creditos/lotes', tabela: 'ia_credito_lotes', grupo: 'Créditos de IA', descricao: 'Lotes de crédito: origem, quantidade, preço pago e vencimento.', onde: EMP },
    { arquivo: 'creditos/extrato', tabela: 'ia_credito_lancamentos', grupo: 'Créditos de IA', descricao: 'Extrato de créditos (entradas, reservas, usos, vencimentos e cancelamentos).', onde: EMP },
    { arquivo: 'creditos/reservas', tabela: 'ia_credito_reservas', grupo: 'Créditos de IA', descricao: 'Reservas de crédito por geração/chamada.', onde: EMP },
    { arquivo: 'creditos/reserva_lotes', tabela: 'ia_credito_reserva_lotes', grupo: 'Créditos de IA', descricao: 'Lotes usados em cada reserva.', onde: EMP },
    { arquivo: 'creditos/pedidos', tabela: 'ia_credito_pedidos', grupo: 'Créditos de IA', descricao: 'Pedidos de compra de pacotes (oferta, valor, termos e protocolo).', onde: EMP },
    { arquivo: 'creditos/cobrancas', tabela: 'ia_credito_cobrancas', grupo: 'Créditos de IA', descricao: 'Cobranças dos pacotes no provedor (sem link de pagamento).', onde: EMP },
    { arquivo: 'creditos/devolucoes', tabela: 'ia_credito_devolucoes', grupo: 'Créditos de IA', descricao: 'Devoluções de pacotes (cálculo, valor, prazo e resultado).', onde: EMP },
    { arquivo: 'creditos/cortesias', tabela: 'ia_credito_cortesias', grupo: 'Créditos de IA', descricao: 'Cortesias recebidas (quantidade, campanha e protocolo).', onde: EMP },
    { arquivo: 'creditos/corte_legado', tabela: 'ia_credito_cortes', grupo: 'Créditos de IA', descricao: 'Conversão do saldo do modelo anterior (mês, limite, usado e lote criado).', onde: EMP },

    // Marketing
    { arquivo: 'marketing/sites', tabela: 'marketing_sites', grupo: 'Marketing', descricao: 'Sites.', onde: EMP },
    { arquivo: 'marketing/site_versoes', tabela: 'marketing_site_versoes', grupo: 'Marketing', descricao: 'Versões publicadas dos sites.', onde: EMP },
    { arquivo: 'marketing/site_imagens', tabela: 'marketing_site_imagens', grupo: 'Marketing', descricao: 'Imagens dos sites (tamanho e SHA-256).', onde: EMP },
    { arquivo: 'marketing/dominios', tabela: 'marketing_dominios', grupo: 'Marketing', descricao: 'Domínios (sem o código de verificação).', onde: EMP },
    { arquivo: 'marketing/campanhas', tabela: 'marketing_campanhas', grupo: 'Marketing', descricao: 'Campanhas.', onde: EMP },
    { arquivo: 'marketing/origens_opcoes', tabela: 'marketing_origens_opcoes', grupo: 'Marketing', descricao: 'Opções de origem.', onde: EMP },
    { arquivo: 'marketing/contatos', tabela: 'marketing_contatos', grupo: 'Marketing', descricao: 'Contatos (leads).', onde: EMP },
    { arquivo: 'marketing/contato_autorizacoes', tabela: 'marketing_contato_autorizacoes', grupo: 'Marketing', descricao: 'Autorizações de contato.', onde: EMP },
    { arquivo: 'marketing/contato_preferencias', tabela: 'marketing_contato_preferencias', grupo: 'Marketing', descricao: 'Preferências de contato.', onde: EMP },
    { arquivo: 'marketing/contato_preferencias_eventos', tabela: 'marketing_contato_preferencias_eventos', grupo: 'Marketing', descricao: 'Histórico das preferências.', onde: EMP },
    { arquivo: 'marketing/atribuicoes', tabela: 'marketing_atribuicoes', grupo: 'Marketing', descricao: 'Atribuição de origem.', onde: EMP },
    { arquivo: 'marketing/eventos', tabela: 'marketing_eventos', grupo: 'Marketing', descricao: 'Eventos de Marketing.', onde: EMP },
    { arquivo: 'marketing/automacao_regras', tabela: 'marketing_automacao_regras', grupo: 'Marketing', descricao: 'Regras de automação.', onde: EMP },
    { arquivo: 'marketing/automacao_execucoes', tabela: 'marketing_automacao_execucoes', grupo: 'Marketing', descricao: 'Execuções das automações.', onde: EMP },
    { arquivo: 'marketing/automacao_eventos', tabela: 'marketing_automacao_eventos', grupo: 'Marketing', descricao: 'Eventos das execuções.', onde: EMP },
    { arquivo: 'marketing/tarefas', tabela: 'marketing_tarefas', grupo: 'Marketing', descricao: 'Tarefas de Marketing.', onde: EMP },

    // Atendimento WhatsApp
    { arquivo: 'whatsapp/conexoes', tabela: 'whatsapp_conexoes', grupo: 'WhatsApp', descricao: 'Conexões do número (sem credenciais).', onde: EMP },
    { arquivo: 'whatsapp/configuracao', tabela: 'whatsapp_atendimento_config', grupo: 'WhatsApp', descricao: 'Configuração do atendimento.', onde: EMP },
    { arquivo: 'whatsapp/retencao', tabela: 'whatsapp_atendimento_retencao_config', grupo: 'WhatsApp', descricao: 'Prazo de retenção definido.', onde: EMP },
    { arquivo: 'whatsapp/conversas', tabela: 'whatsapp_atendimento_conversas', grupo: 'WhatsApp', descricao: 'Conversas.', onde: EMP },
    { arquivo: 'whatsapp/mensagens', tabela: 'whatsapp_atendimento_mensagens', grupo: 'WhatsApp', descricao: 'Mensagens.', onde: EMP },
    { arquivo: 'whatsapp/arquivos', tabela: 'whatsapp_atendimento_arquivos', grupo: 'WhatsApp', descricao: 'Arquivos e mídias (tamanho e SHA-256, sem o link).', onde: EMP },
    { arquivo: 'whatsapp/mensagens_prontas', tabela: 'whatsapp_atendimento_mensagens_prontas', grupo: 'WhatsApp', descricao: 'Mensagens prontas.', onde: EMP },
    { arquivo: 'whatsapp/mensagens_prontas_favoritas', tabela: 'whatsapp_atendimento_mensagens_prontas_favoritas', grupo: 'WhatsApp', descricao: 'Favoritas por pessoa.', onde: EMP },
    { arquivo: 'whatsapp/controles_contato', tabela: 'whatsapp_atendimento_controles_contato', grupo: 'WhatsApp', descricao: 'Controles por contato (não contatar, sem automático).', onde: EMP },
    { arquivo: 'whatsapp/privacidade', tabela: 'whatsapp_atendimento_privacidade', grupo: 'WhatsApp', descricao: 'Pedidos de privacidade atendidos.', onde: EMP },
    { arquivo: 'whatsapp/auditoria', tabela: 'whatsapp_atendimento_auditoria', grupo: 'WhatsApp', descricao: 'Auditoria do atendimento.', onde: EMP },

    // Importação de documentos e skills (IA)
    { arquivo: 'ia/documentos', tabela: 'ia_documentos', grupo: 'Importações', descricao: 'Documentos enviados para leitura.', onde: EMP },
    { arquivo: 'ia/documento_originais', tabela: 'ia_documento_originais', grupo: 'Importações', descricao: 'Originais (tamanho e SHA-256).', onde: EMP },
    { arquivo: 'ia/extracoes', tabela: 'ia_extracoes', grupo: 'Importações', descricao: 'Extrações dos documentos.', onde: EMP },
    { arquivo: 'ia/evidencias', tabela: 'ia_evidencias', grupo: 'Importações', descricao: 'Evidências das extrações.', onde: EMP },
    { arquivo: 'ia/importacoes', tabela: 'ia_importacoes', grupo: 'Importações', descricao: 'Importações a partir das extrações.', onde: EMP },
    { arquivo: 'ia/skills', tabela: 'ia_skills', grupo: 'Importações', descricao: 'Instruções (skills) da empresa.', onde: EMP },
];

export const ENTIDADES: readonly Entidade[] = BASE.map((e) => ({ ...e, excluir: { ...EXCLUSOES[e.tabela], ...e.excluir } }));


/** Tabelas do schema que NÃO entram no pacote, com o motivo (conferido pela suíte PostgreSQL: nada fica sem decisão). */
export const FORA_DO_ESCOPO: Readonly<Record<string, string>> = {
    auditoria: 'Auditoria geral da plataforma (segurança e prova de operações, com IP); atendida por pedido específico.',
    sessoes_administrativas: 'Sessões de login: credenciais (hashes de token) e dados de segurança.',
    recuperacoes_senha: 'Recuperação de senha: credenciais.',
    limites_autenticacao: 'Limites de tentativa de login: segurança da plataforma.',
    cadastros_publicos: 'Cadastro público em andamento: contém hash de senha e de token.',
    plataforma_desenvolvedores: 'Acesso de desenvolvedores da plataforma.',
    plataforma_interessadas: 'Registro interno da plataforma sobre interessadas.',
    plataforma_empresas_cadastro: 'Registro interno da plataforma (inclui observações internas); os dados cadastrais da empresa saem em empresa/perfil_empresa e empresa/cadastro.',
    festa_usuario_capacidades: 'Capacidades por pessoa, sem empresa (não são dados de uma empresa).',
    cobranca_eventos: 'Eventos brutos do provedor de cobrança (Asaas).',
    assinatura_fundadores: 'Controle interno de vagas do plano Fundador.',
    assinatura_isencoes: 'Concessões internas da plataforma.',
    empresa_excecoes_comerciais: 'Decisões comerciais internas da plataforma.',
    ia_operacoes: 'Telemetria das operações de IA.',
    ia_orcamento_reservas: 'Reservas de orçamento de IA (telemetria de custo).',
    ia_uso_modelo: 'Uso de modelos de IA (telemetria de custo).',
    convite_carteiras: 'Créditos de geração de convites (controle de consumo da plataforma).',
    convite_consumos: 'Consumo de créditos de convites (controle da plataforma).',
    convite_limites_http: 'Limites de requisição dos links públicos: segurança.',
    convite_orcamento_global: 'Orçamento global de IA dos convites (todas as empresas).',
    ia_credito_notificacoes: 'Fila técnica de e-mails dos créditos (controle de entrega; a situação útil está no pedido e na devolução).',
    documentos_publicos: 'Textos legais publicados (iguais para todas as empresas).',
    adicional_categorias: 'Categorias de referência globais (iguais para todas as empresas).',
    marketing_dns_simulado: 'Simulação técnica local de DNS.',
    marketing_transporte_simulado: 'Simulação técnica local de envio.',
    whatsapp_atendimento_status: 'Recibos técnicos de entrega do provedor.',
    whatsapp_atendimento_eventos_excluidos: 'Lista técnica de eventos já excluídos (impede reprocessamento).',
    whatsapp_atendimento_retencao_execucoes: 'Execuções da rotina de retenção (todas as empresas).',
    whatsapp_onboarding_tentativas: 'Tentativas técnicas de conexão com a Meta.',
    agenda_062_bloqueios_resolucao: 'Tabela técnica da migração da agenda (062).',
    agenda_062_fechamentos_resolucao: 'Tabela técnica da migração da agenda (062).',
    agenda_062_unidades_habilitacao: 'Tabela técnica da migração da agenda (062).',
};
