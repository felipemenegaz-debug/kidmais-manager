/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador GENÉRICO de PRODUÇÃO para as migrations da promoção de 12/11/2026 que não têm aplicador próprio: 120, 121, 110,
// 111, 115, 123, 124, 125, 126, 127, 128, 130 e 131 (nessa ordem, a do inventário; scripts/promocao-production-ordem.cjs). SOMENTE no PostgreSQL do web de produção,
// no Web Shell do srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy de uma árvore que traga este arquivo e os SQL.
//   - LISTA FECHADA neste arquivo: para cada id, o sha256 (LF) fixado do precheck, da migration e do postcheck, e as
//     SENTINELAS do estado — os mesmos objetos que o precheck da própria migration usa para dizer "já presente" (o teste
//     confere cada nome contra o texto do precheck). Fora da lista = recusa antes de qualquer conexão;
//   - estado só pelo catálogo: nenhuma sentinela = ausente; todas (e as removidas ausentes) = presente; outro = PARCIAL
//     (recusa). A 115 é idempotente por desenho (CREATE INDEX IF NOT EXISTS + DROP INDEX IF EXISTS, e o precheck aceita os
//     dois estados): nela o estado intermediário (índice novo criado e o antigo ainda presente) é aplicável;
//   - alvo, identidade (TLS e rede privada provados no servidor) e disco de scripts/conexao-production.cjs, com a rigidez dos
//     adaptadores recentes (PG* herdadas, `?`/`#`, caracteres de controle, configuração explícita);
//   - CONFERIR: tudo em BEGIN TRANSACTION READ ONLY; ausente → precheck; presente → postcheck. Não grava no banco nem no disco;
//   - APLICAR: exige o registro de backup; marcador exclusivo no disco persistente (migration-<id>.json); UMA transação:
//     precheck → corpo da migration (sem o BEGIN e sem o COMMIT do arquivo) → postcheck → COMMIT só com tudo PASS → estado
//     relido (presente) → postcheck de novo em READ ONLY;
//   - falha de check = erro do servidor (todo precheck/postcheck destas migrations sinaliza por RAISE EXCEPTION; 120, 121, 123, 124 e 125
//     terminam com uma linha `aprovado`: se vier diferente de true, também é falha), como no precedente por manifesto
//     (scripts/migrations-lancamento-production.cjs), que roda os checks e deixa a exceção abortar a transação;
//   - situação do COMMIT como nos aplicadores recentes (regra da 109–118, a função é a do núcleo da 118): falha antes do
//     COMMIT = NAO_COMMITADA; falha NO COMMIT = DESFEITA_PELO_SERVIDOR (SQLSTATE de resposta fora de 08/57/58/XX e ≠ 40003)
//     ou INDETERMINADO; COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar; 2 FALHA registrada; 3 conferência RECUSARIA.
// Privilégios: lista declarada por id neste arquivo (privilegios: CREATE no schema public, posse das tabelas e funções existentes que
// a migration altera ou em que cria índice/gatilho/FK, REFERENCES nas tabelas referenciadas), lida do SQL de cada migration e
// conferida pelo teste contra o texto do SQL. Consulta só de leitura no catálogo (has_schema_privilege, has_table_privilege,
// pg_has_role sobre relowner/proowner): CONFERIR devolve RECUSARIA (3) com o nome do que falta; APLICAR recusa ANTES do marcador
// (conexão própria só de leitura) e de novo antes da transação. A proteção transacional continua: o que escapar da guarda falha
// DENTRO da transação = NAO_COMMITADA, nada fica aplicado. Nunca executa o down de nenhuma delas.
//   node scripts/migration-generico-production.cjs                                                     → plano, sem conexão
//   node scripts/migration-generico-production.cjs --conferir <id>                                     → somente leitura
//   node scripts/migration-generico-production.cjs --aplicar-autorizado <id> --backup "<registro>"     → uma vez por id
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const {commitNaFalha} = require('./migration-118-comum.cjs');
const prd = require('./conexao-production.cjs');

const FLAG_CONFERIR = '--conferir';
const FLAG_APLICAR = '--aplicar-autorizado';
const FLAG_BACKUP = '--backup';
const ALVO = prd.ALVO;
const DIR = prd.pastaRegistro('promocao-generico-producao');
const SQL_IDENTIDADE = prd.SQL_IDENTIDADE;
const PG_HERDADAS_RECUSADAS = prd.PG_HERDADAS_RECUSADAS;

const tabela = t => [t, `to_regclass('public.${t}') IS NOT NULL`];
const funcao = f => [f, `to_regprocedure('public.${f}') IS NOT NULL`];
const restricao = c => [c, `EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${c}')`];
/** Sentinela da 126: o par (tabela, restrição) com a definição EXATA da 126, CHECK e validada (não basta conter clientes:read). */
const DEF_ESCOPOS_126 = "CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 4)) AND (escopos <@ ARRAY[''agenda:read''::text, ''financeiro:read''::text, ''conhecimento:read''::text, ''clientes:read''::text])))";
const escopoComClientes = c => [c, `EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.${c.replace(/_escopos_check$/, '')}') AND conname = '${c}' AND contype = 'c' AND convalidated AND pg_get_constraintdef(oid) = '${DEF_ESCOPOS_126}')`];
const coluna = (t, c) => [`${t}.${c}`, `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}' AND column_name = '${c}')`];
const congelar = o => Object.freeze({...o, arquivos: Object.freeze(o.arquivos.map(a => Object.freeze(a))), criados: Object.freeze(o.criados), removidos: Object.freeze(o.removidos ?? []),
  privilegios: Object.freeze({criaNoSchema: o.privilegios.criaNoSchema, alteradas: Object.freeze(o.privilegios.alteradas), funcoes: Object.freeze(o.privilegios.funcoes),
    referenciadas: Object.freeze(o.privilegios.referenciadas), executadas: Object.freeze(o.privilegios.executadas ?? [])})});
/** LISTA FECHADA: [etapa, arquivo, sha256 do conteúdo com CRLF normalizado para LF]. */
const MIGRATIONS = Object.freeze({
  '120': congelar({escopo: 'financeiro P2: liquidações de entradas e reversões de saídas (aditiva; exige a 052)',
    arquivos: [['precheck', 'database/checks/20261109_120_precheck.sql', '9dfc0577c0861e303a0b9b254eb63accb621de238c5493bdd45e9e7632c8f0ad'],
      ['migration', 'database/migrations/20261109_120_financeiro_movimentos.sql', '6d2a4e54581f41bf65723ddca2bfd7f41c92cf475438c8cdb3d2ee5baf6f084c'],
      ['postcheck', 'database/checks/20261109_120_postcheck.sql', '5b5376fa562d4249d4c237d11c029dfb193c05b40f0b67726af3b4405c26a7e9']],
    criados: [tabela('financeiro_entradas_liquidacoes'), tabela('financeiro_saidas_reversoes'),
      restricao('financeiro_entradas_manuais_empresa_uk'), restricao('financeiro_saidas_empresa_uk')],
    privilegios: {criaNoSchema: true, alteradas: ['financeiro_entradas_manuais', 'financeiro_saidas'], funcoes: [],
      referenciadas: ['empresas', 'financeiro_entradas_manuais', 'financeiro_saidas']}}),
  '121': congelar({escopo: 'financeiro P2: abertura do financeiro e conferências, só de acréscimo (aditiva; exige empresas e a 052)',
    arquivos: [['precheck', 'database/checks/20261109_121_precheck.sql', '24e786410f669905260fa9d641c14b6bc01a4440a9b2ce6bffd713c52e1e1860'],
      ['migration', 'database/migrations/20261109_121_financeiro_abertura.sql', 'f9fd4c5e717e2c02440cc3d23e5a9298100fa8baf6d804cc6d9cf2f3c0900479'],
      ['postcheck', 'database/checks/20261109_121_postcheck.sql', '7bbd85fd52841b1bbdc2157155a8368d349de1ec7ba1d28e2f35bb35789b7423']],
    criados: [tabela('financeiro_aberturas'), tabela('financeiro_abertura_conferencias'), funcao('kidmais_121_somente_acrescimo()')],
    privilegios: {criaNoSchema: true, alteradas: [], funcoes: [], referenciadas: ['empresas']}}),
  '110': congelar({escopo: 'pesquisa de satisfação pós-festa (PS-1; exige 043, 054 e 086)',
    arquivos: [['precheck', 'database/checks/20261030_110_precheck.sql', 'd6bee1250665f9d0b3ae0c607ba26e275c307b74927b5507a0a929d377fcd1c5'],
      ['migration', 'database/migrations/20261030_110_satisfacao_pesquisa.sql', '8e9a9a714f6ccf1139042fd8cf8b3029ea18abc3fd8ff569e85d0e9fe69c2439'],
      ['postcheck', 'database/checks/20261030_110_postcheck.sql', 'b04dccb7cd8aafd8973a06ebb1a84717fbbe1a9f16e68c51b621e8a91f063744']],
    criados: [tabela('satisfacao_envios'), tabela('satisfacao_respostas'), tabela('satisfacao_entregas'), funcao('kidmais110_envio_guarda()'),
      coluna('marketing_automacao_regras', 'canais')],
    privilegios: {criaNoSchema: true, alteradas: ['marketing_automacao_regras', 'marketing_automacao_execucoes'], funcoes: ['kidmais086_execucao_tenant()'],
      referenciadas: ['clientes', 'empresas', 'estabelecimentos', 'fechamentos', 'marketing_automacao_execucoes', 'membership_estabelecimentos', 'memberships', 'usuarios_administrativos']}}),
  '111': congelar({escopo: 'pesquisa de satisfação: links de avaliação e auditoria só de acréscimo (PS-3; exige a 110 e PostgreSQL 15+)',
    arquivos: [['precheck', 'database/checks/20261031_111_precheck.sql', '483640b99a5a09729240dd19476b217e19ca26ce4abcc15b5b4d401bec7bb4a1'],
      ['migration', 'database/migrations/20261031_111_satisfacao_links_auditoria.sql', '030d564ff067b45fc789ca4a57f5fa99b52be234546f92494eba63b2c2e57c60'],
      ['postcheck', 'database/checks/20261031_111_postcheck.sql', 'c97fbc56872a880b705645ea3b8f83a778f5e07e90c05b2b7e895a146daf60f1']],
    criados: [tabela('satisfacao_links_avaliacao'), tabela('satisfacao_auditoria'), funcao('kidmais111_link_guarda()'),
      funcao('kidmais111_auditoria_somente_insercao()'), funcao('kidmais111_auditoria_coerencia()')],
    privilegios: {criaNoSchema: true, alteradas: [], funcoes: [], referenciadas: ['empresas', 'estabelecimentos', 'satisfacao_tarefas', 'usuarios_administrativos']}}),
  '115': congelar({escopo: 'índice (empresa_id, data_evento) em fechamentos no lugar do índice da 054 (PS-4; a criação bloqueia escritas em fechamentos enquanto dura)',
    idempotente: true,
    arquivos: [['precheck', 'database/checks/20261103_115_precheck.sql', '61d6f61e69b993e68ee2564ef9a8c6618afe2b64b742a522ef792b224b485f23'],
      ['migration', 'database/migrations/20261103_115_fechamentos_empresa_data.sql', '35e971aaa4b089331324eb198309bbd7055cf4ec265263b803b6aaa3b39dc79e'],
      ['postcheck', 'database/checks/20261103_115_postcheck.sql', '112a2e3995ba02896ca071316dc8e9aa44d0eac6f5fc2e94a3d8e695a5eec201']],
    criados: [tabela('fechamentos_115_empresa_data_idx')], removidos: [tabela('fechamentos_054_empresa_idx')],
    // CREATE INDEX e DROP INDEX exigem ser dono da tabela; o índice nasce no schema da tabela (sem CREATE no schema public).
    privilegios: {criaNoSchema: false, alteradas: ['fechamentos'], funcoes: [], referenciadas: []}}),
  '123': congelar({escopo: 'área da família F1: pessoas, links e sessões da área "Minha festa" e finalidade AREA_FAMILIA nas validações de identidade (aditiva; exige 010, 016 e 112)',
    arquivos: [['precheck', 'database/checks/20261114_123_precheck.sql', '564f948d671f3d9e07b1b3e79e9ed07fc3b6a08bdc7a52a47f0ed36e6c671436'],
      ['migration', 'database/migrations/20261114_123_area_familia.sql', '17c4b92f088bd4032dfa1debc6b5ec7e71d4ea8176ac4ba784f4b598ee5ea752'],
      ['postcheck', 'database/checks/20261114_123_postcheck.sql', '8a28fc4f99c1c795ce116ba7d349b44aca7d790e951e5d7bcca0461e709502d8']],
    criados: [tabela('festa_pessoas'), tabela('festa_links_area'), tabela('area_familia_sessoes'), tabela('limites_contadores'), tabela('area_familia_eventos'),
      coluna('validacoes_identidade_cliente', 'festa_pessoa_id'), coluna('validacoes_identidade_cliente', 'consumido_por_area_sessao_id')],
    // Gatilhos em clientes e contratos e ALTER/índices/gatilho em validacoes_identidade_cliente exigem a posse dessas tabelas.
    // CREATE TRIGGER … EXECUTE FUNCTION kidmais_set_atualizado_em() (função que já existe) exige EXECUTE nela.
    privilegios: {criaNoSchema: true, alteradas: ['clientes', 'contratos', 'validacoes_identidade_cliente'], funcoes: [], executadas: ['kidmais_set_atualizado_em()'],
      referenciadas: ['clientes', 'empresas', 'festas', 'usuarios_administrativos', 'validacoes_identidade_cliente']}}),
  '124': congelar({escopo: 'assinatura do cliente em papel: contrato_assinaturas_papel, método PAPEL_CLIENTE e formalização/validação da 061 ampliadas (aditiva; exige 061, 122 e 123)',
    arquivos: [['precheck', 'database/checks/20261115_124_precheck.sql', '43cb4b3cc846b9e58dace6ca9da281a7437359adaba847a9b2cf32a4bc1cd237'],
      ['migration', 'database/migrations/20261115_124_assinatura_papel_cliente.sql', 'a54c30c1f18200c8f1724334a961a8444f1cbe6f1d1f0ffd0fb53cefcadff8d9'],
      ['postcheck', 'database/checks/20261115_124_postcheck.sql', 'e6d9cf8f3be17db9252451266bb8dcd0bcf2a119de5ad55a825ecfb37fa9e684']],
    criados: [tabela('contrato_assinaturas_papel'), funcao('kidmais124_papel_cliente(uuid,uuid)'), funcao('kidmais124_validar_registro_papel()')],
    // Troca do CHECK de método em contrato_versoes exige a posse dela; CREATE OR REPLACE das duas funções da 061 exige a posse delas.
    privilegios: {criaNoSchema: true, alteradas: ['contrato_versoes'], funcoes: ['kidmais019_formalizacao(uuid,uuid)', 'kidmais_validar_fluxo_contrato()'],
      referenciadas: ['contrato_versoes', 'contratos', 'empresas', 'memberships', 'usuarios_administrativos']}}),
  '125': congelar({escopo: 'área da família F3: avisos de pagamento, pendências da família, aviso fixo do buffet, tipos novos de evento e autoria pela família (aditiva; exige 123)',
    arquivos: [['precheck', 'database/checks/20261115_125_precheck.sql', '270c66124d01eed656ede7f9249b97d419b3bc0dc514cff306a51dae595a5c65'],
      ['migration', 'database/migrations/20261115_125_area_familia_acoes.sql', 'dff9af31c012f73074f8294eb830a1009ce9e1fc7a19b5cacb4daa93cf015e37'],
      ['postcheck', 'database/checks/20261115_125_postcheck.sql', 'f0f6ab83c0e9b71c851b35257803c627f0e4fee82cc39fb10ec461af5ec4431c']],
    criados: [tabela('area_familia_avisos_pagamento'), tabela('festa_pendencias_familia'), tabela('area_familia_aviso_empresa')],
    // CHECK de tipo e gatilho em area_familia_eventos e gatilhos de autoria em festa_pessoas e festa_links_area exigem a posse dessas tabelas.
    // Gatilhos de atualizado_em em kidmais_set_atualizado_em() (função que já existe) exigem EXECUTE nela (achado P3 do Astra em c71bae8a).
    privilegios: {criaNoSchema: true, alteradas: ['area_familia_eventos', 'festa_links_area', 'festa_pessoas'], funcoes: [], executadas: ['kidmais_set_atualizado_em()'],
      referenciadas: ['empresas', 'festa_pendencias', 'festa_pessoas', 'pagamento_parcelas', 'usuarios_administrativos']}}),
  '126': congelar({escopo: 'escopo MCP clientes:read: troca o CHECK de escopos das 3 tabelas OAuth da 105 (1 a 4 escopos; exige 105; não cria objeto)',
    arquivos: [['precheck', 'database/checks/20261118_126_precheck.sql', '815b2b00ddfc725295729c72e60f1e72e33aec1aa1b5b342062a7884ebc1d1a3'],
      ['migration', 'database/migrations/20261118_126_mcp_escopo_clientes.sql', '4319b2ca2382bc863b6d143ed851b804d3ff6416dabbca3c6df17f19357e5f30'],
      ['postcheck', 'database/checks/20261118_126_postcheck.sql', 'f1d2ca3f5dc4b1b936b66739ac66ecfe4fc52017d252caf1a5c44fae135a114f']],
    // A 126 não cria objeto: as sentinelas são os 3 CHECKs pela DEFINIÇÃO (com clientes:read = presente; o nome existe desde a 105).
    criados: ['mcp_oauth_pedidos_escopos_check', 'mcp_oauth_concessoes_escopos_check', 'mcp_oauth_tokens_escopos_check'].map(escopoComClientes),
    // DROP/ADD CONSTRAINT nas 3 tabelas da 105 exige a posse delas; nada novo no schema.
    privilegios: {criaNoSchema: false, alteradas: ['mcp_oauth_concessoes', 'mcp_oauth_pedidos', 'mcp_oauth_tokens'], funcoes: [], referenciadas: []}}),
  '127': congelar({escopo: 'guarda dos clientes, fase 1a: marca de saída das campanhas por telefone/e-mail (marketing_saidas_contato), gatilhos e carga inicial (aditiva; exige 086 e 060)',
    arquivos: [['precheck', 'database/checks/20261119_127_precheck.sql', '98e697308dc222a369763827b845118dc9bce6faf9fe9b196c20899c441402d6'],
      ['migration', 'database/migrations/20261119_127_marketing_saidas_contato.sql', 'edefb4d1c57e47ca261a41c66d07d5d0e87fc574ea6edd57b794416179a84e12'],
      ['postcheck', 'database/checks/20261119_127_postcheck.sql', 'fa15543275354145876e952620036ef3eed048d33784f0bccb696b259c83446c']],
    // Sentinelas = o que o precheck da 127 usa para dizer "já presente": a tabela e a função do e-mail canônico.
    criados: [tabela('marketing_saidas_contato'), funcao('kidmais127_email(text)')],
    // Gatilhos novos em clientes, marketing_contato_preferencias e whatsapp_atendimento_conversas exigem a posse delas; todas as funções dos gatilhos são criadas pela 127.
    privilegios: {criaNoSchema: true, alteradas: ['clientes', 'marketing_contato_preferencias', 'whatsapp_atendimento_conversas'], funcoes: [],
      referenciadas: ['clientes', 'empresas', 'usuarios_administrativos']}}),
  '128': congelar({escopo: 'dados fora do disco: regras legadas da agenda (disponibilidade_config_legada) e bytes do PDF público (documentos_publicos.conteudo) no banco (aditiva; exige a 021)',
    arquivos: [['precheck', 'database/checks/20261120_128_precheck.sql', 'c93295f01730b883b62ce39d7affcedd39b878887b80ea6999dd81e2fe10cf44'],
      ['migration', 'database/migrations/20261120_128_dados_fora_do_disco.sql', '3c9b2825d063d67afce998baf5200ac19085000c27bc82156d39abb9007f0a5e'],
      ['postcheck', 'database/checks/20261120_128_postcheck.sql', 'ca96b35c5c2b22c14d36952b303080b19c8ce2ce0959df6fd792324b78e79c42']],
    // Sentinelas = o que o precheck da 128 usa para dizer "já presente": a tabela e a coluna conteudo.
    criados: [tabela('disponibilidade_config_legada'), coluna('documentos_publicos', 'conteudo')],
    // ADD COLUMN e ADD CONSTRAINT em documentos_publicos exigem a posse dela; a tabela nova não referencia ninguém.
    privilegios: {criaNoSchema: true, alteradas: ['documentos_publicos'], funcoes: [], referenciadas: []}}),
  '130': congelar({escopo: 'pré-reserva manual: configuração, aceites e recebimentos; os índices únicos bloqueiam escritas em fechamentos e contratos durante a instalação',
    arquivos: [['precheck', 'database/checks/20261120_130_precheck.sql', '53f95ec68a5ce4aeaebda793dc5de0400851c578191541da7a8b8a39b9356c4b'],
      ['migration', 'database/migrations/20261120_130_pre_reserva_manual.sql', 'f1333015ac9ac692f24e04d6a6fd381fba0c0b8432674863e56a97c918141411'],
      ['postcheck', 'database/checks/20261120_130_postcheck.sql', '0379143e198e88b9e599bdf5ce0908b6670063d17f17a668a67c666fefb1e250']],
    criados: ['pre_reserva_configuracoes','pre_reserva_aceites','pre_reserva_recebimentos','pre_reserva_situacoes','pre_reserva_fechamento_titular','pre_reserva_contrato_pedido','pre_reserva_um_sinal_por_pedido','pre_reserva_pendencias_por_empresa'].map(tabela),
    // Runtime do gatilho: fechamentos e contratos (SELECT/FOR UPDATE), pre_reserva_aceites,
    // contrato_fluxos, contrato_versoes, pagamentos e pagamento_recebimentos (SELECT).
    privilegios: {criaNoSchema: true, alteradas: ['fechamentos','contratos'], funcoes: [], referenciadas: ['empresas','memberships','fechamentos','estabelecimentos','agenda_saloes','contratos']}}),
  '131': congelar({escopo: 'agenda da pré-reserva: ocupação temporária e proteção do destino pago; exige a 130',
    arquivos: [['precheck', 'database/checks/20261120_131_precheck.sql', '127326b37ee9cac39ccb9cc856f707fc51079d90bbf6cdce47ccfa3138d37e38'],
      ['migration', 'database/migrations/20261120_131_pre_reserva_agenda.sql', '3b67b7867477858cea290de95b951686eea030e515c275899d81cef696d7c27e'],
      ['postcheck', 'database/checks/20261120_131_postcheck.sql', '41122734e0cc753fc56568c515f62d354ab599332a807e58dbe14409dce78e9d']],
    criados: [funcao('pre_reserva_exigir_configuracao()'), funcao('pre_reserva_preservar_destino()')],
    privilegios: {criaNoSchema: true, alteradas: ['fechamentos','pre_reserva_recebimentos','pre_reserva_aceites'], funcoes: ['kidmais094_ocupacoes(date,date)','kidmais062_ocupacoes_escopo(date,date)'], referenciadas: []}}),
  '132': congelar({escopo: 'Wall-e fatia 1a: vínculo do contato do funil com a conversa (whatsapp_atendimento_oportunidades) e pendência da captura na conversa; exige 082 e 085',
    arquivos: [['precheck', 'database/checks/20261123_132_precheck.sql', '46e0ac2b6e92c9594290a3050b9faf6b32f0a1bdbf67a61830a2f315c30bdcce'],
      ['migration', 'database/migrations/20261123_132_walle_oportunidades.sql', '20f351aa99c1829d35afedcdb49e6819a4570ef1a5e155c0ddd940c588b5f30f'],
      ['postcheck', 'database/checks/20261123_132_postcheck.sql', '592182a0f8ef0174acecfcb87220932e2eab293c9fd7939cc7d47b89c8acf30d']],
    // Sentinelas = o que o precheck da 132 usa para dizer "já presente": a tabela nova e a coluna da pendência.
    criados: [tabela('whatsapp_atendimento_oportunidades'), coluna('whatsapp_atendimento_conversas', 'oportunidade_pendente_em')],
    // ADD COLUMN e índice em whatsapp_atendimento_conversas exigem a posse dela; a função do gatilho é criada pela 132 e lê
    // marketing_contatos e whatsapp_atendimento_conversas; as chaves estrangeiras referenciam contatos, empresas e conversas.
    privilegios: {criaNoSchema: true, alteradas: ['whatsapp_atendimento_conversas'], funcoes: [],
      referenciadas: ['empresas', 'marketing_contatos', 'whatsapp_atendimento_conversas']}}),
  '133': congelar({escopo: 'ocupações da agenda recortadas por empresa antes das funções por linha (função nova; a 094 não muda); exige a 131',
    arquivos: [['precheck', 'database/checks/20261123_133_precheck.sql', '37aeb74714185551299e5642a0a74197b90ba5e699e629c413c19045cf6cfe8a'],
      ['migration', 'database/migrations/20261123_133_ocupacoes_por_empresa.sql', '6630c89ba1e4afe5167cb1744a559ad0c790d20eeb18110201b89eb2042c7eac'],
      ['postcheck', 'database/checks/20261123_133_postcheck.sql', '9dac4af97e1b3bf1df4f2a30ce02dd84bf68980f63998bf2d55f8dde3f9d44ae']],
    criados: [funcao('kidmais133_ocupacoes_escopo(date,date,uuid,uuid)')],
    // Só CREATE FUNCTION: não altera tabela nem substitui função existente.
    privilegios: {criaNoSchema: true, alteradas: [], funcoes: [], referenciadas: []}}),
  '134': congelar({escopo: 'marca Cliente/Interna da contratante (tabela nova; ausente = Cliente; o código funciona sem ela); exige a 133 no registro',
    arquivos: [['precheck', 'database/checks/20261123_134_precheck.sql', '9e85205d602d84f310d5a73130e68bea60e230107129df7c66b88d09795fc963'],
      ['migration', 'database/migrations/20261123_134_empresas_uso.sql', 'e3cfc224228ce09a13bdf8b0014b6414f5428f05509df12cd07f8f5322208c57'],
      ['postcheck', 'database/checks/20261123_134_postcheck.sql', 'be6af36afdb576f90abc52d5827a257be19a62012dbd2eecf2f0fe3946f4fba4']],
    criados: [tabela('plataforma_empresas_uso')],
    // Só CREATE TABLE (chaves para empresas e usuarios_administrativos): não altera tabela existente.
    privilegios: {criaNoSchema: true, alteradas: [], funcoes: [], referenciadas: ['empresas', 'usuarios_administrativos']}}),
});
/** Ordem do inventário (scripts/production/check-migrations.mjs, approvedFiles): 120, 121, 110, 111, 115, 123, 124, 125, 126, 127, 128.
 * A 130, a 131, a 132, a 133 e a 134 continuam em MIGRATIONS (SQL revisados e sentinelas que o registro no banco carrega e o --conferir lê), mas não
 * são aplicadas por aqui: ver SO_PELO_REGISTRO. */
const IDS = Object.freeze(['120', '121', '110', '111', '115', '123', '124', '125', '126', '127', '128']);
const definicao = id => { assert.ok(typeof id === 'string' && Object.hasOwn(MIGRATIONS, id), 'MIGRATION_FORA_DA_LISTA'); return MIGRATIONS[id]; };
const marcadorDe = id => `migration-${id}.json`;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** Estado (só catálogo): uma coluna booleana por sentinela, c<i> das criadas e r<i> das removidas. */
function sqlEstado(id) {
  const d = definicao(id);
  return `/* estado-${id} */ SELECT ${[...d.criados.map(([, e], i) => `(${e}) AS c${i}`), ...d.removidos.map(([, e], i) => `(${e}) AS r${i}`)].join(',\n  ')}`;
}
function lerEstado(id, linha) {
  const d = definicao(id);
  const criados = d.criados.map((_, i) => linha?.['c' + i]), removidos = d.removidos.map((_, i) => linha?.['r' + i]);
  for (const v of [...criados, ...removidos]) assert.equal(typeof v, 'boolean', 'ESTADO_ILEGIVEL ' + id);
  const n = criados.filter(Boolean).length, sobras = removidos.filter(Boolean).length;
  const situacao = n === 0 ? 'ausente' : n === criados.length && sobras === 0 ? 'presente' : 'parcial';
  const s = {situacao, criados: `${n}/${criados.length}`, ...(removidos.length ? {removidosAindaPresentes: `${sobras}/${removidos.length}`} : {})};
  if (situacao === 'parcial') s.divergencias = [...d.criados.filter((_, i) => !criados[i]).map(([nome]) => 'falta ' + nome), ...d.removidos.filter((_, i) => removidos[i]).map(([nome]) => 'sobra ' + nome)];
  return s;
}
/** Plano a partir do estado; parcial recusa, salvo na migration idempotente (115), em que o precheck decide. */
function planoEtapas(id, s) {
  const d = definicao(id);
  if (s.situacao === 'presente') return ['postcheck'];
  assert.ok(s.situacao === 'ausente' || d.idempotente === true, `APLICACAO_PARCIAL_${id} ${(s.divergencias ?? []).join(', ')}`);
  return ['precheck', 'migration', 'postcheck'];
}

/**
 * Privilégios (só catálogo, READ ONLY): schema_create; sem_posse = tabelas alteradas ausentes ou de que o papel não é dono (nem membro do
 * dono); sem_references = tabelas referenciadas que existem e em que o papel não tem REFERENCES (ausentes ficam para o precheck da
 * migration, que confere as dependências); sem_posse_funcoes = funções substituídas ausentes ou de outro dono; sem_execute = funções que
 * já existem e que gatilhos novos chamam (CREATE TRIGGER exige EXECUTE nelas), ausentes ou sem EXECUTE para o papel.
 */
const listaSql = l => (l.length ? `ARRAY[${l.map(x => `'${x}'`).join(', ')}]::text[]` : 'ARRAY[]::text[]');
function sqlPrivilegios(id) {
  const p = definicao(id).privilegios;
  return `/* privilegios-${id} */ SELECT ${p.criaNoSchema ? "has_schema_privilege(current_user, 'public', 'CREATE')" : 'true'} AS schema_create,
  coalesce((SELECT array_agg(t ORDER BY t) FROM unnest(${listaSql(p.alteradas)}) t WHERE to_regclass('public.' || t) IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.' || t) AND pg_has_role(current_user, c.relowner, 'USAGE'))), ARRAY[]::text[]) AS sem_posse,
  coalesce((SELECT array_agg(t ORDER BY t) FROM unnest(${listaSql(p.referenciadas)}) t WHERE to_regclass('public.' || t) IS NOT NULL
    AND NOT has_table_privilege(current_user, to_regclass('public.' || t), 'REFERENCES')), ARRAY[]::text[]) AS sem_references,
  coalesce((SELECT array_agg(f ORDER BY f) FROM unnest(${listaSql(p.funcoes)}) f WHERE to_regprocedure('public.' || f) IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_proc q WHERE q.oid = to_regprocedure('public.' || f) AND pg_has_role(current_user, q.proowner, 'USAGE'))), ARRAY[]::text[]) AS sem_posse_funcoes,
  coalesce((SELECT array_agg(f ORDER BY f) FROM unnest(${listaSql(p.executadas)}) f WHERE to_regprocedure('public.' || f) IS NULL
    OR NOT has_function_privilege(current_user, to_regprocedure('public.' || f), 'EXECUTE')), ARRAY[]::text[]) AS sem_execute`;
}
/** Linha da consulta → {ok, faltas}; formato inesperado = ILEGIVEL (nunca "tudo certo"). */
function lerPrivilegios(id, linha) {
  assert.equal(typeof linha?.schema_create, 'boolean', 'PRIVILEGIOS_ILEGIVEL ' + id);
  for (const c of ['sem_posse', 'sem_references', 'sem_posse_funcoes', 'sem_execute']) assert.ok(Array.isArray(linha[c]) && linha[c].every(x => typeof x === 'string'), `PRIVILEGIOS_ILEGIVEL ${id} ${c}`);
  const faltas = [...(linha.schema_create ? [] : ['CREATE no schema public']), ...linha.sem_posse.map(t => 'posse da tabela ' + t),
    ...linha.sem_references.map(t => 'REFERENCES em ' + t), ...linha.sem_posse_funcoes.map(f => 'posse da função ' + f),
    ...linha.sem_execute.map(f => 'EXECUTE na função ' + f)];
  return {ok: faltas.length === 0, faltas};
}
const privilegiosAtuais = async (db, id) => lerPrivilegios(id, (await somenteLeitura(db, sqlPrivilegios(id))).rows[0]);
const exigirPrivilegios = p => assert.ok(p.ok, 'PRIVILEGIO_INSUFICIENTE ' + p.faltas.join('; '));

/** O arquivo da migration sem a moldura: só comentários antes do único BEGIN; e o único COMMIT; é a última linha. */
function corpoMigration(sql, nome) {
  assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.equal((sql.match(/^(?:ROLLBACK;|START TRANSACTION|SET TRANSACTION|SAVEPOINT|RELEASE|BEGIN TRANSACTION)/gm) ?? []).length, 0, 'TRANSACAO_INESPERADA ' + nome);
  assert.ok(sql.endsWith('\nCOMMIT;\n'), 'TRANSACAO_INESPERADA ' + nome);
  const i = sql.indexOf('BEGIN;\n');
  assert.ok(sql.slice(0, i).split('\n').every(l => l === '' || l.startsWith('--')), 'TRANSACAO_INESPERADA ' + nome);
  return sql.slice(i + 'BEGIN;\n'.length, -'COMMIT;\n'.length);
}
/**
 * Precheck e postcheck: ou trazem a própria moldura (BEGIN TRANSACTION READ ONLY … ROLLBACK no fim) ou nenhuma (postchecks
 * da 110, 111 e 115); o aplicador envia só o CORPO, dentro da transação dele.
 */
function corpoCheck(sql, nome) {
  const inicio = (sql.match(/^BEGIN TRANSACTION READ ONLY;$/gm) ?? []).length, fim = (sql.match(/^ROLLBACK;$/gm) ?? []).length;
  assert.equal((sql.match(/^(?:BEGIN;|COMMIT;|START TRANSACTION|SET TRANSACTION|SAVEPOINT|RELEASE)/gm) ?? []).length, 0, 'MOLDURA_INESPERADA ' + nome);
  if (inicio === 0 && fim === 0) return sql;
  assert.ok(inicio === 1 && fim === 1 && sql.endsWith('\nROLLBACK;\n'), 'MOLDURA_INESPERADA ' + nome);
  const i = sql.indexOf('BEGIN TRANSACTION READ ONLY;\n');
  assert.ok(sql.slice(0, i).split('\n').every(l => l === '' || l.startsWith('--')), 'MOLDURA_INESPERADA ' + nome);
  return sql.slice(i + 'BEGIN TRANSACTION READ ONLY;\n'.length, -'ROLLBACK;\n'.length);
}
/** Lê os 3 arquivos revisados do id (hash conferido) e devolve os corpos prontos para enviar. */
function carregar(raiz, id) {
  const corpos = {};
  for (const [etapa, arquivo, hash] of definicao(id).arquivos) {
    const sql = lerRevisado(raiz, arquivo, hash);
    corpos[etapa] = etapa === 'migration' ? corpoMigration(sql, `migration ${id}`) : corpoCheck(sql, `${etapa} ${id}`);
  }
  return corpos;
}
/** Check que devolve linha com `aprovado` (120 e 121): só `true` passa. Sem a coluna, vale a ausência de exceção. */
function exigirAprovado(resultado, nome) {
  for (const r of [].concat(resultado ?? [])) for (const linha of r?.rows ?? [])
    if (linha && Object.hasOwn(linha, 'aprovado')) assert.ok(linha.aprovado === true, 'CHECK_REPROVADO ' + nome);
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
const estadoAtual = async (db, id) => lerEstado(id, (await somenteLeitura(db, sqlEstado(id))).rows[0]);
const checkSomenteLeitura = async (db, corpos, etapa, id) => exigirAprovado(await somenteLeitura(db, corpos[etapa]), `${etapa} ${id}`);

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e, em READ ONLY, precheck ou postcheck. */
async function conferirNoCliente(db, {id, raiz, sqlIdentidade = SQL_IDENTIDADE, identidade = prd.identidade}) {
  const corpos = carregar(raiz, id);
  const r = {modo: 'conferencia', id};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = await estadoAtual(db, id);
  try { r.plano = planoEtapas(id, r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  if (r.plano.includes('migration')) {
    r.privilegios = await privilegiosAtuais(db, id);
    if (!r.privilegios.ok) { r.resultado = 'RECUSARIA'; r.motivo = curta('PRIVILEGIO_INSUFICIENTE ' + r.privilegios.faltas.join('; ')); return r; }
  }
  const etapa = r.estado.situacao === 'presente' ? 'postcheck' : 'precheck';
  r.checks = {};
  try { await checkSomenteLeitura(db, corpos, etapa, id); r.checks[etapa] = 'PASS'; }
  catch (e) { r.checks[etapa] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = r.estado.situacao === 'presente' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/** UMA transação: precheck → corpo da migration → postcheck → COMMIT. Registra a situação do COMMIT antes de qualquer outra leitura. */
async function migrarNaTransacao(db, corpos, id, passo, registrar) {
  let fase = 'inicio';
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    passo.antesDoCommit = {};
    fase = 'precheck';
    exigirAprovado(await db.query(corpos.precheck), `precheck ${id}`);
    passo.antesDoCommit.precheck = 'PASS';
    fase = 'migration';
    await db.query(corpos.migration);
    passo.antesDoCommit.migration = 'ENVIADA';
    fase = 'postcheck';
    exigirAprovado(await db.query(corpos.postcheck), `postcheck ${id}`);
    passo.antesDoCommit.postcheck = 'PASS';
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail(`COMMIT_RESPONDIDO_COMO_ROLLBACK_${id}`); }
  } catch (e) {
    passo.faseDaFalha = fase;
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
}

/** Antes do marcador (APLICAR): identidade, estado e privilégios em READ ONLY; recusa lança e nada é gravado no disco. */
async function preflightNoCliente(db, {id, sqlIdentidade = SQL_IDENTIDADE, identidade = prd.identidade}) {
  identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  const estado = await estadoAtual(db, id);
  if (planoEtapas(id, estado).includes('migration')) exigirPrivilegios(await privilegiosAtuais(db, id));
}

/** Aplicação: o estado é relido aqui, imediatamente antes; presente = só o postcheck (READ ONLY), nada é reaplicado. */
async function aplicarNoCliente(db, {id, raiz, sqlIdentidade = SQL_IDENTIDADE, identidade = prd.identidade, registrar = () => {}}) {
  exigirForaDoRegistro(id);
  const corpos = carregar(raiz, id);
  const r = {id, etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db, id);
  r.plano = planoEtapas(id, r.estadoAntes); registrar(r);
  if (r.plano.includes('migration')) {
    r.privilegios = await privilegiosAtuais(db, id); registrar(r);
    exigirPrivilegios(r.privilegios);
    const passo = {nome: `transacao ${id}`, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    await migrarNaTransacao(db, corpos, id, passo, () => registrar(r));
    assert.equal((await estadoAtual(db, id)).situacao, 'presente', `ESTADO_DEPOIS_${id}`);
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  const final = {nome: `postcheck ${id}`, inicio: new Date().toISOString()};
  r.etapas.push(final); registrar(r);
  await checkSomenteLeitura(db, corpos, 'postcheck', id);
  Object.assign(final, {ok: true, fim: new Date().toISOString()});
  r.estadoDepois = await estadoAtual(db, id);
  assert.equal(r.estadoDepois.situacao, 'presente', `ESTADO_FINAL_${id}`);
  r.resultado = r.plano.includes('migration') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => [r.id, x.commit]));
const commitadas = r => Object.entries(situacoes(r)).filter(([, c]) => c === 'CONFIRMADO').map(([id]) => id);

const BACKUP = /^[A-Za-z0-9:._/ -]{6,120}$/;
/** 130+ só pelo registro no banco (scripts/registro-migrations-banco.cjs): aqui a definição só serve para carregar os SQL revisados. */
const SO_PELO_REGISTRO = Object.freeze(['130', '131', '132', '133', '134']);
const exigirForaDoRegistro = id => { if (SO_PELO_REGISTRO.includes(id)) assert.fail(`ID_PELO_REGISTRO ${id}: aplicar só por scripts/registro-migrations-banco.cjs`); };
function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 2 && argv[0] === FLAG_CONFERIR) { definicao(argv[1]); return {modo: 'conferir', id: argv[1]}; }
  if (argv.length === 4 && argv[0] === FLAG_APLICAR && argv[2] === FLAG_BACKUP) {
    definicao(argv[1]); exigirForaDoRegistro(argv[1]);
    assert.match(argv[3], BACKUP, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', id: argv[1], backup: argv[3]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

const raizPadrao = path.resolve(__dirname, '..');
function alvo(env, id) { definicao(id); return prd.alvoRigido(env, `kidmais-migration-${id}-production`); }
const identidade = id => prd.identidade(id);
const exigirDisco = (...a) => prd.exigirDisco(...a);

function plano({raiz = raizPadrao} = {}) {
  return {resultado: 'PLANO', conecta: false, ambiente: 'production', alvo: ALVO, registro: DIR,
    migrations: IDS.map(id => ({id, escopo: MIGRATIONS[id].escopo, idempotente: MIGRATIONS[id].idempotente === true, marcador: marcadorDe(id),
      arquivos: MIGRATIONS[id].arquivos.map(([etapa, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {etapa, arquivo, sha256: hash}; }),
      sentinelas: {criados: MIGRATIONS[id].criados.map(([n]) => n), removidos: MIGRATIONS[id].removidos.map(([n]) => n)}})),
    modos: {conferir: `${FLAG_CONFERIR} <id>`, aplicar: `${FLAG_APLICAR} <id> ${FLAG_BACKUP} <registro-do-backup>`},
    provaNoAlvo: 'precheck, corpo da migration e postcheck na MESMA transação; COMMIT só com tudo PASS; depois, estado pelo catálogo e o postcheck em READ ONLY',
    prazos: 'lock_timeout 5 s e statement_timeout 60 s (SET LOCAL do aplicador e do próprio SQL); estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO',
    ordem: ['árvore implantada no web de produção com este aplicador e os SQL; conferir commit e sha256 implantados (o bloco CONFERIR confere)',
      'uma migration por vez, na ordem 120, 121, 110, 111, 115 (a 111 exige a 110; o precheck de cada uma confere as dependências)',
      `${FLAG_CONFERIR} <id>: PRONTA_PARA_APLICAR (JA_APLICADA_POSTCHECK_PASS = não aplicar)`,
      'backup restaurável de production registrado (dump conferido + PITR; export funcional não substitui)',
      'autorização de Felipe para a migration em produção',
      'janela curta, sem DDL concorrente (a 115 bloqueia escritas em fechamentos enquanto cria o índice)',
      `${FLAG_CONFERIR} <id> de novo, imediatamente antes`, `${FLAG_APLICAR} <id>`, `${FLAG_CONFERIR} <id>: JA_APLICADA_POSTCHECK_PASS`],
    paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir nem seguir para a próxima migration',
      'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
      'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-<id>.<horario>.json'],
    recuperacao: ['down de cada migration (database/rollback/) só com autorização própria e conforme as condições do próprio arquivo',
      'em último caso, restauração do backup registrado'],
    nuncaExecuta: ['down de qualquer migration', 'migration fora da lista fechada', 'alteração de env', 'deploy', 'restart']};
}
async function conferir({env, id, raiz = raizPadrao, Client = require('pg').Client}) {
  const opts = alvo(env, id);
  const db = new Client(opts); db.on?.('error', () => undefined);
  try { await db.connect(); return await conferirNoCliente(db, {id, raiz}); }
  catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', id, resultado: 'FALHA', mensagem: curta(e)}; }
  finally { await db.end().catch(() => {}); }
}
async function executar({env, id, backup, dir = DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => exigirDisco()}) {
  exigirForaDoRegistro(id);
  const opts = alvo(env, id); disco();
  assert.match(String(backup ?? ''), BACKUP, 'BACKUP_OBRIGATORIO');
  carregar(raiz, id);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const marcador = path.join(dir, marcadorDe(id));
  if (fs.existsSync(marcador)) assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador);
  {
    const pre = new Client(opts); pre.on?.('error', () => undefined);
    try { await pre.connect(); await preflightNoCliente(pre, {id}); }
    catch (e) { await pre.query('ROLLBACK').catch(() => {}); throw e; }
    finally { await pre.end().catch(() => {}); }
  }
  const anteriores = fs.readdirSync(dir).filter(n => n.startsWith(`migration-${id}.`) && n.endsWith('.json') && n !== marcadorDe(id)).sort();
  const registro = {inicio: new Date().toISOString(), ambiente: 'production', id, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
  try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
  catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
  const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
  let ultimo = {id};
  const db = new Client(opts); db.on?.('error', () => undefined);
  try {
    await db.connect();
    const r = await aplicarNoCliente(db, {id, raiz, registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
    ultimo = JSON.parse(JSON.stringify(r));
    salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r), commitadas: commitadas(r)});
    return {resultado: r.resultado, id, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
      etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
  } catch (e) {
    // Já conectou: sempre FALHA (código 2) com a situação do COMMIT guardada em memória, mesmo que o marcador não possa
    // mais ser gravado (disco cheio): a falha de gravação nunca esconde um COMMIT confirmado nem vira recusa (código 1).
    const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
    const situacao = {commits: situacoes(ultimo), commitadas: commitadas(ultimo), reconciliar: `${FLAG_CONFERIR} ${id} antes de qualquer decisão; não repetir`};
    let marcadorAtualizado = true, erroMarcador;
    try { salvar({...ultimo, situacao: 'FALHA', falha, ...situacao}); } catch (e2) { marcadorAtualizado = false; erroMarcador = curta(e2); }
    return {resultado: 'FALHA', id, marcador, falha, ...situacao, marcadorAtualizado,
      ...(marcadorAtualizado ? {} : {erroMarcador, aviso: 'MARCADOR_DESATUALIZADO: copiar esta saída (é o único registro do COMMIT); não repetir'})};
  } finally { await db.end().catch(() => {}); }
}
/** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_POSTCHECK_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
async function principal(argv, env, deps = {}) {
  const m = modo(argv);
  if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
  const s = m.modo === 'conferir' ? await conferir({env, id: m.id, ...deps}) : await executar({env, id: m.id, backup: m.backup, ...deps});
  return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {SO_PELO_REGISTRO, ALVO, DIR, SQL_IDENTIDADE, PG_HERDADAS_RECUSADAS, MIGRATIONS, IDS, sqlPrivilegios, lerPrivilegios, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, CODIGO, marcadorDe, sqlEstado, lerEstado,
  planoEtapas, corpoMigration, corpoCheck, carregar, exigirAprovado, conferirNoCliente, aplicarNoCliente, modo, alvo, identidade, exigirDisco, plano, conferir, executar,
  principal, cli};
