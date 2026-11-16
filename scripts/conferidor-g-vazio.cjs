/* eslint-disable @typescript-eslint/no-require-imports */
// B-26 do plano de promoção (§9.2.2 a §9.2.5, rodada 32/33): conferidor G-VAZIO, SOMENTE LEITURA.
// Arquivo único, só com node:* e `pg`, porque até o E5 chega a `bb65640a` por colagem conferida (scripts/bloco-shell-conferidor-g-vazio.cjs).
//   node scripts/conferidor-g-vazio.cjs --plano                    matriz e assinaturas, sem conectar
//   node scripts/conferidor-g-vazio.cjs --l1                       rótulos de L1 deste serviço, sem valor e sem conectar
//   node scripts/conferidor-g-vazio.cjs --declaracao=<arquivo>     uma leitura no ponto declarado
// Códigos: 0 PASS, S-PASS, S-REG ou CONFORME; 1 recusa ou leitura impossível (INCONCLUSIVO, nunca vira zero); 3 FALHA, S-FALHA, S-HIST ou NAO_CONFORME.
// S-HIST sai com 3 porque só reabre com decisão escrita de Felipe (§9.2.5). Detector, não barreira: o resultado vale só para aquele ponto.
// Versão do PostgreSQL: as assinaturas foram medidas no 18.6 (staging e production rodam 18). A versão sai em identidade.versao e NÃO é
// guarda: em outra versão, assinatura igual passa e diferente reprova (no restore, INCONCLUSIVO). Outra versão não foi validada.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const VERSAO = 1;
const SERVICO_PRODUCAO = 'srv-dak77m2d0e5s73b8rkkg';
const BANCO_PRODUCAO = 'kidmais_production';
const PONTOS = Object.freeze(['P1', 'P2', 'P3', 'P4', 'P5', 'S', 'P7', 'P8', 'P9', 'R1', 'R2', 'R3']);
const ANTES_DO_S = Object.freeze(['P1', 'P2', 'P3', 'P4', 'P5']);
const DO_P3_EM_DIANTE = Object.freeze(PONTOS.slice(2));

const reg = t => `to_regclass('public.${t}') IS NOT NULL`;
const proc = f => `to_regprocedure('public.${f}') IS NOT NULL`;
const coluna = (t, c) => `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.${t}') AND attname='${c}' AND NOT attisdropped)`;
/** A guarda só conta presente, na relação certa e habilitada no modo normal. A definição inteira (eventos, nível, condição e função) é conferida pela âncora da relação, presa ao prefixo. */
const gatilho = (t, g) => `EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='${g}' AND tgrelid=to_regclass('public.${t}') AND NOT tgisinternal AND tgenabled='O')`;
const restricao = (t, r, trecho) => `EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${r}' AND conrelid=to_regclass('public.${t}')${trecho ? ` AND pg_get_constraintdef(oid) LIKE '%${trecho}%'` : ''})`;
const corpoTem = (f, trecho) => `coalesce((SELECT prosrc LIKE '%${trecho}%' FROM pg_proc WHERE oid=to_regprocedure('public.${f}')), false)`;
const FUNCAO_CONFLITO = 'kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)';
const CORPO_094 = 'b6aac1c0b99ed64f4dca94fe5d886e5d5892b82888325010e02adc850def8cf6';
const CORPO_100 = '805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb';
const def = (t, r, trecho) => `coalesce((SELECT pg_get_constraintdef(oid) LIKE '%${trecho}%' FROM pg_constraint WHERE conname='${r}' AND conrelid=to_regclass('public.${t}')), false)`;

/** Base: sempre no prefixo. Sequência: a ordem de aplicação da §9.2.2 (091 pode ficar adiada, por ser a última). */
const BASE = Object.freeze(['067', '068', '069', '074a', '075', '087', '099', '105']);
const SEQUENCIA = Object.freeze(['089', '092', '093', '090', '094', '095', '096', '097', '100', '091']);
/** Assinatura de cada migration no catálogo: todas verdadeiras = completa; nenhuma = ausente; o resto = parcial. A 100 só troca corpo e é tratada à parte. */
const ASSINATURAS_CATALOGO = Object.freeze({
  '067': {tabela_assinaturas: reg('empresa_assinaturas'), tabela_excecoes: reg('empresa_excecoes_comerciais'), tabela_representacoes: reg('empresa_representacoes'), guarda: proc('kidmais_067_excecao_guarda()')},
  '068': {tabela: reg('cobranca_eventos'), guarda: proc('kidmais_068_assinatura_guarda()')},
  '069': {publicos: reg('cadastros_publicos'), empresas: reg('cadastros_empresas'), aceites: reg('aceites_documentos_legais'), guarda: proc('kidmais_069_cadastro_guarda()')},
  '074a': {isencoes: reg('assinatura_isencoes'), fundadores: reg('assinatura_fundadores'), contratacoes: reg('assinatura_contratacoes'), guarda: proc('kidmais_074_registro_guarda()')},
  '075': {tabela: reg('assinatura_renovacoes'), guarda: proc('kidmais_075_renovacao_guarda()')},
  '087': {tabela: reg('assinatura_avisos'), guarda: proc('kidmais_087_aviso_guarda()'), indice: reg('assinatura_avisos_087_fila_idx')},
  '089': {tabela: reg('assinatura_encerramentos'), guarda: proc('kidmais_089_encerramento_guarda()'), indice_cobranca: reg('assinatura_encerramentos_cobranca_uk'), indice_garantia: reg('assinatura_encerramentos_garantia_uk'), indice_empresa: reg('assinatura_encerramentos_empresa_idx'), indice_abertos: reg('assinatura_encerramentos_abertos_idx')},
  '090': {tabela: reg('assinatura_campanhas'), guarda: proc('kidmais_090_campanha_guarda()'), guarda_fundador: proc('kidmais_090_fundador_guarda()'), origem: coluna('assinatura_fundadores', 'origem'), indice_legado: reg('assinatura_fundadores_vaga_legado_uk'), indice_pos: reg('assinatura_fundadores_vaga_pos_uk'), indice_ativa: reg('assinatura_campanhas_ativa_uk')},
  '091': {funcao: proc('kidmais_091_documento_valido(text)'), guarda: proc('kidmais_091_documento_guarda()'), formato_cadastro: def('cadastros_empresas', 'cadastros_empresas_documento_check', '[0-9]{11}|'), qualificacao: def('empresa_representacoes', 'empresa_representacoes_qualificacao_check', 'TITULAR_PF'), continuidades: reg('empresa_documento_continuidades'), guarda_continuidade: proc('kidmais_091_continuidade_guarda()')},
  '092': {ponto: restricao('precos_pacote', 'precos_pacote_092_ponto_check'), tipo_preco: restricao('precos_pacote', 'precos_pacote_tipo_calculo_check', 'PONTO'), tipo_fotografia: restricao('fechamento_pacote_snapshots', 'fechamento_pacote_snapshots_tipo_check', 'PONTO'), lacunas: corpoTem('kidmais_047_lacunas_escopo(uuid)', 'PONTO_DECRESCENTE')},
  '093': {escopo: reg('agenda_escopo_config'), saloes: reg('agenda_saloes'), horario: reg('configuracao_agenda_saloes'), pacote: reg('pacote_saloes'), indice: reg('agenda_saloes_nome_uk'), dias: coluna('configuracao_agenda', 'dias_semana'), capacidade: coluna('configuracao_agenda', 'capacidade'), funcao: proc('kidmais093_mesma_empresa()')},
  '094': {salao_festa: coluna('fechamentos', 'salao_id'), salao_revisao: coluna('fechamento_revisoes', 'salao_id'), funcao_festa: proc('kidmais094_salao_fechamento()'), funcao_revisao: proc('kidmais094_salao_revisao()'), ocupacoes: proc('kidmais094_ocupacoes(date,date)'), conflito: proc(FUNCAO_CONFLITO), destino: corpoTem('kidmais019_validar_destino(uuid)', 'kidmais094_conflito_ocupacao')},
  '095': {carteiras: reg('ia_credito_carteiras'), pedidos: reg('ia_credito_pedidos'), lotes: reg('ia_credito_lotes'), lancamentos: reg('ia_credito_lancamentos'), reservas: reg('ia_credito_reservas'), reserva_lotes: reg('ia_credito_reserva_lotes'), cobrancas: reg('ia_credito_cobrancas'), devolucoes: reg('ia_credito_devolucoes'), cortesias: reg('ia_credito_cortesias'), cortes: reg('ia_credito_cortes'), notificacoes: reg('ia_credito_notificacoes'), guarda: proc('kidmais_095_guarda()')},
  '096': {versoes: reg('documentos_legais_versoes'), comprovantes: reg('assinatura_comprovantes'), guarda: proc('kidmais_096_guarda()')},
  '097': {tabela: reg('assinatura_arrependimentos'), guarda: proc('kidmais_097_guarda()')},
  '099': {restricao: restricao('convites', 'convite_avulso_vinculo_completo'), indice: reg('convites_empresa_atualizado')},
  '105': {clientes: reg('mcp_oauth_clientes'), pedidos: reg('mcp_oauth_pedidos'), concessoes: reg('mcp_oauth_concessoes'), codigos: reg('mcp_oauth_codigos'), tokens: reg('mcp_oauth_tokens'), auditoria: reg('mcp_auditoria'), funcao: `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='mcp_oauth_concessao_revogacao_imutavel')`},
});

const sv = (lista, dominio, grupo, migracao) => lista.map(objeto => ({objeto, migracao, dominio, grupo}));
const CREDITOS_PAGOS = ['ia_credito_pedidos', 'ia_credito_cobrancas', 'ia_credito_devolucoes'];
const CREDITOS_GERAIS = ['ia_credito_carteiras', 'ia_credito_lotes', 'ia_credito_lancamentos', 'ia_credito_reservas', 'ia_credito_reserva_lotes', 'ia_credito_cortesias', 'ia_credito_cortes', 'ia_credito_notificacoes'];
/** Matriz fechada da §9.2.2, com a migration que cria cada objeto. */
const MATRIZ = Object.freeze([
  ...sv(['empresa_assinaturas'], 'VAZIA', 'nucleo', '067'), ...sv(['cobranca_eventos'], 'VAZIA', 'nucleo', '068'),
  ...sv(['assinatura_fundadores', 'assinatura_contratacoes'], 'VAZIA', 'nucleo', '074a'), ...sv(['assinatura_renovacoes'], 'VAZIA', 'nucleo', '075'), ...sv(['assinatura_avisos'], 'VAZIA', 'nucleo', '087'),
  ...sv(['assinatura_encerramentos'], 'VAZIA', 'encerramento', '089'), ...sv(['assinatura_comprovantes'], 'VAZIA', 'encerramento', '096'), ...sv(['assinatura_arrependimentos'], 'VAZIA', 'encerramento', '097'),
  ...sv(['assinatura_campanhas'], 'VAZIA', 'campanha', '090'), ...sv(CREDITOS_PAGOS, 'VAZIA', 'creditos_pagos', '095'), ...sv(CREDITOS_GERAIS, 'VAZIA', 'creditos_gerais', '095'),
  ...sv(['assinatura_isencoes'], 'CLASSIFICADA', 'isencoes', '074a'), ...sv(['empresa_excecoes_comerciais'], 'CLASSIFICADA', 'excecoes', '067'),
  ...sv(['empresa_documento_continuidades'], 'CLASSIFICADA', 'continuidades', '091'), ...sv(['cadastros_empresas'], 'CLASSIFICADA', 'cadastro_historico', '069'), ...sv(['cadastros_publicos'], 'CLASSIFICADA', 'cadastro_andamento', '069'),
].map(Object.freeze));
const FORA_DO_ESCOPO = Object.freeze(['ia_credito_franquias_ciclo', 'ia_credito_franquia_pendencias']);
const ADMITIDOS_LDT = Object.freeze(['empresa_assinaturas', 'cobranca_eventos', 'assinatura_fundadores', 'assinatura_contratacoes', 'assinatura_renovacoes', 'assinatura_avisos', 'assinatura_encerramentos', 'assinatura_comprovantes', 'assinatura_arrependimentos']);
/** Colunas estáveis, sem dado pessoal (fora: documentos, e-mail, nomes, textos livres, mensagens, identificadores do provedor). Só estas entram no hash. */
const COLUNAS_HASH = Object.freeze({
  assinatura_isencoes: ['empresa_id', 'concedida_por', 'concedida_em'],
  empresa_excecoes_comerciais: ['id', 'empresa_id', 'tipo', 'valida_ate', 'criado_em', 'revogada_em', 'revogada_por'],
  empresa_documento_continuidades: ['id', 'empresa_id', 'tipo', 'situacao', 'data_efetiva', 'provedor_conferido_em', 'registrada_em'],
  cadastros_empresas: ['usuario_id', 'chave', 'empresa_id', 'criado_em'],
  empresa_assinaturas: ['empresa_id', 'plano', 'ciclo', 'situacao', 'teste_fim', 'periodo_atual_fim', 'cancelada_em', 'encerrada_em', 'versao', 'atualizado_em'],
  cobranca_eventos: ['id', 'provedor', 'tipo', 'empresa_id', 'situacao', 'recebido_em', 'processado_em'],
  assinatura_fundadores: ['id', 'empresa_id', 'estado', 'reservada_em', 'confirmada_em', 'beneficio_fim', 'liberada_em'],
  assinatura_contratacoes: ['id', 'empresa_id', 'plano', 'ciclo', 'estado', 'valor_final_centavos', 'criada_em', 'confirmada_em', 'cancelada_em'],
  assinatura_renovacoes: ['id', 'empresa_id', 'contratacao_id', 'primeiro_vencimento', 'estado', 'aviso_enviado_em', 'preco_aplicado_em', 'atualizado_em'],
  assinatura_avisos: ['id', 'empresa_id', 'tipo', 'marco', 'estado', 'enviado_em', 'atualizado_em'],
  assinatura_encerramentos: ['id', 'protocolo', 'empresa_id', 'tipo', 'solicitado_em', 'valor_devolucao_centavos', 'estorno_situacao', 'estorno_concluido_em'],
  assinatura_comprovantes: ['contratacao_id', 'empresa_id', 'registrado_em', 'email_enviado_em', 'email_falhou_em'],
  assinatura_arrependimentos: ['id', 'protocolo', 'empresa_id', 'solicitado_em', 'situacao', 'concluido_em', 'valor_restituido_centavos'],
});
const SITUACAO = Object.freeze({empresa_assinaturas: 'situacao', cobranca_eventos: 'situacao', assinatura_fundadores: 'estado', assinatura_contratacoes: 'estado', assinatura_renovacoes: 'estado', assinatura_avisos: 'estado', assinatura_encerramentos: 'tipo', assinatura_arrependimentos: 'situacao'});
/** Colunas que o leitor usa além do hash (a de situação de cada objeto com hash já está nele). */
const COLUNAS_EXTRAS = Object.freeze({empresa_excecoes_comerciais: ['tipo', 'revogada_em', 'valida_ate'], empresa_documento_continuidades: ['tipo', 'situacao'], cadastros_publicos: ['situacao', 'expira_em'], ia_credito_lotes: ['origem', 'pedido_id']});
const colunasLidas = objeto => [...new Set([...(COLUNAS_HASH[objeto] ?? []), ...(COLUNAS_EXTRAS[objeto] ?? [])])];
const colunasPresentes = (t, colunas) => `(SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('public.${t}') AND NOT attisdropped AND attname = ANY(ARRAY[${colunas.map(c => `'${c}'`).join(', ')}]::name[]))=${colunas.length}`;
/** Toda guarda das tabelas da matriz e das auxiliares, por migration: [tabela, gatilho, função]. */
const GATILHOS = Object.freeze({
  '067': [['empresa_excecoes_comerciais', 'empresa_excecoes_067_guarda_trg', 'kidmais_067_excecao_guarda()'], ['empresa_representacoes', 'empresa_representacoes_067_guarda_trg', 'kidmais_067_representacao_guarda()']],
  '068': [['empresa_assinaturas', 'empresa_assinaturas_068_guarda_trg', 'kidmais_068_assinatura_guarda()'], ['empresa_assinaturas', 'empresa_assinaturas_068_sem_truncate_trg', 'kidmais_068_sem_truncate()'], ['cobranca_eventos', 'cobranca_eventos_068_guarda_trg', 'kidmais_068_evento_guarda()'], ['cobranca_eventos', 'cobranca_eventos_068_sem_truncate_trg', 'kidmais_068_sem_truncate()']],
  '069': [['cadastros_publicos', 'cadastros_publicos_069_guarda_trg', 'kidmais_069_cadastro_guarda()'], ['aceites_documentos_legais', 'aceites_069_somente_insercao_trg', 'kidmais_069_somente_insercao()'], ['cadastros_empresas', 'cadastros_empresas_069_somente_insercao_trg', 'kidmais_069_somente_insercao()'], ['empresa_socios', 'empresa_socios_069_somente_insercao_trg', 'kidmais_069_somente_insercao()']],
  '074a': [['assinatura_isencoes', 'assinatura_isencoes_074_guarda', 'kidmais_074_registro_guarda()'], ['assinatura_fundadores', 'assinatura_fundadores_074_guarda', 'kidmais_074_registro_guarda()'], ['assinatura_contratacoes', 'assinatura_contratacoes_074_guarda', 'kidmais_074_registro_guarda()'], ['assinatura_isencoes', 'assinatura_isencoes_074_truncate', 'kidmais_074_registro_guarda()'], ['assinatura_fundadores', 'assinatura_fundadores_074_truncate', 'kidmais_074_registro_guarda()'], ['assinatura_contratacoes', 'assinatura_contratacoes_074_truncate', 'kidmais_074_registro_guarda()']],
  '075': [['assinatura_renovacoes', 'assinatura_renovacoes_075_guarda', 'kidmais_075_renovacao_guarda()'], ['assinatura_renovacoes', 'assinatura_renovacoes_075_truncate', 'kidmais_075_renovacao_guarda()']],
  '087': [['assinatura_avisos', 'assinatura_avisos_087_guarda', 'kidmais_087_aviso_guarda()'], ['assinatura_avisos', 'assinatura_avisos_087_truncate', 'kidmais_087_aviso_guarda()']],
  '089': [['assinatura_encerramentos', 'assinatura_encerramentos_089_guarda_trg', 'kidmais_089_encerramento_guarda()'], ['assinatura_encerramentos', 'assinatura_encerramentos_089_sem_truncate_trg', 'kidmais_089_encerramento_guarda()']],
  '090': [['assinatura_campanhas', 'assinatura_campanhas_090_guarda', 'kidmais_090_campanha_guarda()'], ['assinatura_campanhas', 'assinatura_campanhas_090_truncate', 'kidmais_090_campanha_guarda()'], ['assinatura_fundadores', 'assinatura_fundadores_090_campanha', 'kidmais_090_fundador_guarda()']],
  '091': [['empresa_assinaturas', 'empresa_assinaturas_091_documento', 'kidmais_091_documento_guarda()'], ['assinatura_fundadores', 'assinatura_fundadores_091_documento', 'kidmais_091_documento_guarda()'], ['empresa_documento_continuidades', 'empresa_documento_continuidades_091_guarda', 'kidmais_091_continuidade_guarda()']],
  '093': [['configuracao_agenda_saloes', 'configuracao_agenda_saloes_093_empresa_trg', 'kidmais093_mesma_empresa()'], ['pacote_saloes', 'pacote_saloes_093_empresa_trg', 'kidmais093_mesma_empresa()']],
  '094': [['fechamentos', 'fechamentos_094_salao_trg', 'kidmais094_salao_fechamento()'], ['fechamento_revisoes', 'fechamento_revisoes_094_salao_trg', 'kidmais094_salao_revisao()']],
  '095': [...CREDITOS_PAGOS, ...CREDITOS_GERAIS].flatMap(t => [[t, `${t}_095_guarda_trg`, 'kidmais_095_guarda()'], [t, `${t}_095_sem_truncate_trg`, 'kidmais_095_guarda()']]),
  '096': [['documentos_legais_versoes', 'documentos_legais_versoes_096_guarda', 'kidmais_096_guarda()'], ['assinatura_comprovantes', 'assinatura_comprovantes_096_guarda', 'kidmais_096_guarda()']],
  '097': [['assinatura_arrependimentos', 'assinatura_arrependimentos_097_guarda', 'kidmais_097_guarda()']],
  '105': [['mcp_oauth_concessoes', 'mcp_oauth_concessoes_revogacao_imutavel', 'mcp_oauth_concessao_revogacao_imutavel()']],
});
/**
 * Estado esperado de cada item em cada prefixo da sequência (k = quantas migrations da SEQUENCIA aplicadas), medido nas migrations reais:
 * [k a partir do qual vale, hash ou null = ausente]. Um hash só vale no prefixo em que a migration o produz: estado antecipado ou revertido reprova.
 */
const TRAJETORIA = Object.freeze({
  'funcao:kidmais019_validar_contrato': [[0, '173c0f8b7c1831014e514c65c0885f9ab1e612294f22c9a11b6f31bf4a6ae4e6'], [5, 'a38c2c56d9caf122810b1a723b59c670bf854efc30c3baf0344645aca1c434f1']],
  'funcao:kidmais019_validar_destino': [[0, 'c68d84c4814dcd9e53943025c42dfc43e91e0f220cee193b5b1586798273f696'], [5, '4e8f709b747a5bfb506cc45c20d4c3387e97cd2e58789c1680996b3c1f32ec84']],
  'funcao:kidmais093_mesma_empresa': [[0, null], [3, '33b0fddb953f59cc6ceb4650e3b77ecd900debdf97f3479ca393147eeed6c288']],
  'funcao:kidmais094_conflito_ocupacao': [[0, null], [5, '20c346b718c1ae41d592ef96f97347dc64f7a0fbdb4120d52fed9c39afa04333'], [9, '636b09131c1ca4cb3b7c92d66f80a3d63bdf2680478a59bcf94597ded1fb9da6']],
  'funcao:kidmais094_ocupacoes': [[0, null], [5, 'f78133f271c95c6b872503fcc08ec18c2a6d499768c080b4b41b891b47dcd6e6']],
  'funcao:kidmais094_salao_fechamento': [[0, null], [5, '9c47eb298be516987dade26740c6430704990ef8eef1ee5fa33c2bb51c2e911d']],
  'funcao:kidmais094_salao_revisao': [[0, null], [5, '962bb15b7969ffbdeb669c939846fef5727961613731940cfce6885bce07f175']],
  'funcao:kidmais_047_lacunas_escopo': [[0, '46ea5e4704ac64c946d0c1f0bfbe5bee5bf2914a5393b137a7170037f85e9a1b'], [2, '21ce4ffa70c7fae82b8401ba33fd81a114537863e863c88add39549e97569c39']],
  'funcao:kidmais_067_excecao_guarda': [[0, '40642afc5c41829a58dae900d2ec307aebffd8c63a064d30b0e0a538f807cfd0']],
  'funcao:kidmais_067_representacao_guarda': [[0, '372baed3314aabc3d51c70453a603b3e5c5510ee109e09c2c59e6fd48bbb7b89']],
  'funcao:kidmais_068_assinatura_guarda': [[0, 'b56edd1c907e153789c9c2bf16e45e7f53ddd7331f277c6948b6873be903a7b9']],
  'funcao:kidmais_068_evento_guarda': [[0, '6e0a4ea690b7978acd73feb4daf94c3420102506c89ef1761c003f8223648971']],
  'funcao:kidmais_068_sem_truncate': [[0, '71541d6cb472a679ab5bdcf4c0b2b4957c6a0461a5e27579af359a19f63a7d1a']],
  'funcao:kidmais_069_cadastro_guarda': [[0, '4499dd6533936a61674b4e77c7939ad28f5056babd7bfd092e8f6e829778b600']],
  'funcao:kidmais_069_somente_insercao': [[0, 'cfe8f415381a79494da46c569ac6870c1536dd3af01e60c55ef1aab972fd0c8f']],
  'funcao:kidmais_074_registro_guarda': [[0, 'c962fed06f6f32b545fe256a8d9aa5ca8985411f0006541c3808a6170ec81646']],
  'funcao:kidmais_075_renovacao_guarda': [[0, '9832611d455acc5c67ac1abbb7ff13305c599e70b0626c794f8db21e56ce42f5']],
  'funcao:kidmais_087_aviso_guarda': [[0, 'ab066ab5c5ec4dc5613421a592e88836086077501950ea8c6bfd6dab1aa252e3']],
  'funcao:kidmais_089_encerramento_guarda': [[0, null], [1, '03f81d09c890c242d1b5f7f8f0b476dfb01d4186a73d12d651ee994a2458107e']],
  'funcao:kidmais_090_campanha_guarda': [[0, null], [4, 'c58d0de555f71bb946569d600dd97958b8bc9b8c7833e5136ff881b105d51952']],
  'funcao:kidmais_090_fundador_guarda': [[0, null], [4, 'cdc2200f1f19e6735c8c1bcb8fbdcb5487cec06a91bb8c5f6c7215de7397b6ef']],
  'funcao:kidmais_091_continuidade_guarda': [[0, null], [10, 'a5bb3d958ab8eb2d2831db98408428131480e4ca2bc43b4cc942f16411a77c8f']],
  'funcao:kidmais_091_documento_guarda': [[0, null], [10, '66e433c075041c72b06c6718f58d5eb1b346d3b304d4fe4388c87693fd2fcddf']],
  'funcao:kidmais_091_documento_valido': [[0, null], [10, '00d0f282fdb5474d4870f9d37f22a041d0d599a8c570511f1429afe9c29ed929']],
  'funcao:kidmais_095_guarda': [[0, null], [6, '91fcb8f299eaa18d0de25d4eba41d41b92a3cf71470fae8f0edacb668feb2443']],
  'funcao:kidmais_096_guarda': [[0, null], [7, 'd0c8085921a7f63c03da81231f40cbc6cac038d6c3d73759a3686c204ac52d7f']],
  'funcao:kidmais_097_guarda': [[0, null], [8, '58a9242b50e50b8059294a1df39a8a8b3882e966f9f64995fe9d92f1d02ad235']],
  'funcao:kidmais_validar_agenda_revisao': [[0, '409d5a37c90a1f216f472b4c89aee2d2b39aeb3f3d6b337329603304e230b761'], [5, 'ffabf75a32df3ea22a30c8f8cf45ccf4a4b9d2b741f03b799b6fc2396a81f1bc']],
  'funcao:mcp_oauth_concessao_revogacao_imutavel': [[0, '0aa673a31338e392686fbb7a217bd8f310d081570ffab2f85cc22ba6c533184e']],
  'relacao:aceites_documentos_legais': [[0, 'c4e525dea66b043bc1c99b2690c094bfae73350ed282f5d5a6c572f32315e36c']],
  'relacao:agenda_escopo_config': [[0, null], [3, '82e1cb3024a299400d9d3b30d93f89ca29474a5225fd3608c96cf6e0f8bd6752']],
  'relacao:agenda_saloes': [[0, null], [3, '188d89c240e5d0f154c0275d9e6305521bbb0728aea368af4799b645d6ce875b']],
  'relacao:assinatura_arrependimentos': [[0, null], [8, 'cb682ef59f039582f8181a137c6e5cbb9ab2c05d78c8be698e8ed9251c618d15']],
  'relacao:assinatura_avisos': [[0, '34d52ed56c50bc623ed60fe17fb3821b006693c05bf54de8f3ac5fd03d0b32ef']],
  'relacao:assinatura_campanhas': [[0, null], [4, '7aa579193b84c24c4e847bf137bbf5db40a06bfb1765a7ae0b3067bfda6b1bbe']],
  'relacao:assinatura_comprovantes': [[0, null], [7, 'f4affa3b34d23eecf2c92cb2f028016e719e5a8d5c7d7525a09fc2162396a4a3']],
  'relacao:assinatura_contratacoes': [[0, '1909186b46a5a6a28381a1f1f1f92cc647e2328211a33e94d0f3561e22b0a6ef']],
  'relacao:assinatura_encerramentos': [[0, null], [1, '5b008ad63911323d22c6720062c358736e1a95910b4119f39f834c344a21fc54']],
  'relacao:assinatura_fundadores': [[0, '502e73ab071fc722520e1120662c5c8454d71707b22fcbd60f2e785f041c81ad'], [4, 'c5965abbca41813a1ce6028531e03eb63ad9ca0f207d122dbf5b0f344cf8328d'], [10, 'd9c9d193b1be163c550f85db141fec4aab96fb29c285360d837f32e162f29e00']],
  'relacao:assinatura_isencoes': [[0, 'c77f8fea9172ee5a9553e38e47ac3640baa33fba58c0c32556c95542d294cb4f']],
  'relacao:assinatura_renovacoes': [[0, '2eb1964750cffa38ac31824229a000991d592a3d5e3046519b384cbf3aa5fb80']],
  'relacao:cadastros_empresas': [[0, 'ed863efd8d192aced2e3539fb31159f222b3395447fff9d923610d233bf3b62c'], [10, '3556f929f2b8f616190568a0466e9a57308c5e7f810877dd2d8a555fe821b00b']],
  'relacao:cadastros_publicos': [[0, 'cfc14f85aaad9274913b0df48f863c7e428ea96df3abd9fa5101ed6197c35c54']],
  'relacao:cobranca_eventos': [[0, '32b174c84ae6baecd1cfe8ccea1196e0ea0d202dd472ca358524e4e3ea68de58']],
  'relacao:configuracao_agenda': [[0, 'e1042f5a2fe0e4e4e173d4a4306ed87f4f6efdfbf243e262d6d3ad8a6a18698d'], [3, '76face1ceec6b135d6841543731df156aaa53ee35962417fdf40f0d26ca5b763']],
  'relacao:configuracao_agenda_saloes': [[0, null], [3, 'd4f5e1ce608a7ab1c8b35cb679707e89feb75b562ba999b6a72592127c2cbc8d']],
  'relacao:documentos_legais_versoes': [[0, null], [7, 'f082258c4adf712849c3bb04cbbd5f01973633d4a885ce5e6adf93c1b5855c90']],
  'relacao:empresa_assinaturas': [[0, 'd41a852880d23d33679938ce16dae081e8b862edf661be966aecb47aab3675da'], [10, '0e383ea50987e892e42139dcd7cf36836f4dcf4cc461676644b92c07d308f417']],
  'relacao:empresa_documento_continuidades': [[0, null], [10, 'cf34477675109a015317322a42615918541e4a18cde2c54131978c635abb3651']],
  'relacao:empresa_excecoes_comerciais': [[0, 'b5dae90cfe6b8e3ede58b93e837febb56fb0be88e1116881fb982eecd3655eeb']],
  'relacao:empresa_representacoes': [[0, '6248c47491e31ca6b2ee0d75db619c4d435dc790f678612402dd012bf023e82e'], [10, 'adc1e021f5ac79a0b8e300d036f37f7382eb07888b97e7c2de6b7dee28c94a51']],
  'relacao:empresa_socios': [[0, '457c2a4030e196cd174f90120937539f361e380c431809bf9dee6e53b8565176']],
  'relacao:fechamento_pacote_snapshots': [[0, '8a8e1f5697a15eb912000ba96c15577a0a537ac589ec6a1dec8041223fae2562'], [2, 'cbafc5a80890c886f970cfd4fcfe3c59b84cf7e9c812cb4fb30c2a2843c1daca']],
  'relacao:fechamento_revisoes': [[0, '86c23837c65f198c4a1971bbcd565dcc381c91f35ad69d35e0d623dc1fde744c'], [5, '08e7b0d0802d0ccd0685179b42ffc3d8f6ba70639ecb9585b1a91a41b60d5af0']],
  'relacao:fechamentos': [[0, 'fa1160beeb4b675d664d49ec2e36a3d64c484138a8ac3c5eb0cf2e9f892a65c4'], [5, 'b2862fdb4f5b8f1dcf95e17032b91b2ca43490ed6d7badb4db9a42597df22e9a']],
  'relacao:ia_credito_carteiras': [[0, null], [6, '7e21487907440753399eec41cef2bad4c3dbec4c62f7165d25e4c9f5ce0afaf5']],
  'relacao:ia_credito_cobrancas': [[0, null], [6, '9208e4e2beb5335f2762720a22b343bd783a9df578de3984eb024acb519c95d2']],
  'relacao:ia_credito_cortes': [[0, null], [6, '8203468fc044ff5394a99edde976cb7458e865df0488e5bf9b6f078b21fc539d']],
  'relacao:ia_credito_cortesias': [[0, null], [6, '1b27500fee81ca3a546ab5daf94ee64ece042c11fa74c3603b9cc64cf6131ce6']],
  'relacao:ia_credito_devolucoes': [[0, null], [6, 'a9d739c33fa1097c5209fa27c56d50dfe0d2c507c9595f88cbc39b3176083c76']],
  'relacao:ia_credito_lancamentos': [[0, null], [6, 'a6f69165dedac84b8efb10a8653d8c6b99b39e0268205b1c2c5ec3d96d4ee7b5']],
  'relacao:ia_credito_lotes': [[0, null], [6, '9ed1953d472a63227eb45c07cc59a5b89eb7f8ca42456ab4c69e86480de05de2']],
  'relacao:ia_credito_notificacoes': [[0, null], [6, '6b9f5cc4950f153e38611714b0a2d498523b109058204949ae9905a7f2a8d03d']],
  'relacao:ia_credito_pedidos': [[0, null], [6, '945b26b803ffcfa6adbd38a56e72a073e3c032a08e357a0ff927ea0989081ecb']],
  'relacao:ia_credito_reserva_lotes': [[0, null], [6, 'ac0700e24dbee7f02ff75743959e4ee2b69a3644e929a301114ec431e3afa4a3']],
  'relacao:ia_credito_reservas': [[0, null], [6, 'd20e5149b3dd0659ed4bdbb171627f4828a931885a7e2b3327ec9d95f1c62581']],
  'relacao:mcp_oauth_concessoes': [[0, '8eaa56836b26c3207867959a0188d45e6411ad6eadbc8d63daa37f45ed9f5b3a']],
  'relacao:pacote_saloes': [[0, null], [3, '2f0d72702610806b71f5a37fba0ecfa066046ba04182ef8bca03f61be4668e40']],
  'relacao:precos_pacote': [[0, '723aaeb5781df028e30c97f6db6919914cd5f3d1f65abb451e618bac02e7b77e'], [2, '60e8a55d1b95958fd2c2a865aba8d498ae808c75e2deb4f0c468fac2d8cc366c']],
  'relacao:solicitacoes_acesso_empresa': [[0, 'edff73b8bcf7bbe6ac1645e025eb0350b244b9c41caa108e74ece2156e595746'], [10, '55a42250c40af2c0ccddce91d1588b767f04c45250f939bf3df84b44dc12279b']],
});
const valoresMedidos = item => [...new Set((TRAJETORIA[item] ?? []).map(([, h]) => h).filter(Boolean))];
/** Estrutura inteira de cada objeto da matriz, em qualquer prefixo em que a medição o encontrou (o estado por prefixo é conferido à parte, pelas âncoras). */
const ESTRUTURA_OBJETOS = Object.freeze(Object.fromEntries(MATRIZ.map(m => [m.objeto, Object.freeze(valoresMedidos(`relacao:${m.objeto}`))])));
/** Funções que as guardas ou restrições chamam, fora dos gatilhos. */
const FUNCOES_AUXILIARES = Object.freeze({'091': ['kidmais_091_documento_valido(text)']});
/**
 * Estrutura de um objeto, em linhas de texto reconstruídas pelo banco. Nomes, tipos e definições, nunca dados. NOT NULL entra pela coluna.
 * Gatilho com o modo de habilitação e a definição inteira. Chave estrangeira com as verificações que o banco executa nos DOIS lados (gatilhos
 * internos ligados à restrição: no referenciador e no referenciado), identificadas pela restrição, pela relação e pela função, nunca pelo nome
 * gerado do gatilho. Índice com validade, regra de reescrita, herança e persistência da tabela. R4-04: a sequência da coluna identity ou
 * serial, com tipo, início, incremento, limites, cache e ciclo (um MAXVALUE reduzido deixa a tabela sem escrita sem mudar mais nada).
 */
const linhasEstrutura = rel => `SELECT 'coluna|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || '|' || a.attidentity::text || '|' || a.attgenerated::text || '|' || coalesce((SELECT co.collname::text FROM pg_collation co WHERE co.oid=a.attcollation), '') AS linha
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=${rel} AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT 'tabela|' || t.relkind::text || '|' || t.relpersistence::text FROM pg_class t WHERE t.oid=${rel}
  UNION ALL SELECT 'heranca|' || (SELECT hp.relname FROM pg_class hp WHERE hp.oid=h.inhparent) || '>' || (SELECT hf.relname FROM pg_class hf WHERE hf.oid=h.inhrelid) FROM pg_inherits h WHERE h.inhrelid=${rel} OR h.inhparent=${rel}
  UNION ALL SELECT 'restricao|' || r.conname || '|' || r.contype::text || '|' || pg_get_constraintdef(r.oid) FROM pg_constraint r WHERE r.conrelid=${rel} AND r.contype <> 'n'
  UNION ALL SELECT 'indice|' || i.relname || '|' || pg_get_indexdef(i.oid) || '|' || ix.indisvalid::text || '|' || ix.indisready::text FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid WHERE ix.indrelid=${rel}
  UNION ALL SELECT 'gatilho|' || g.tgname || '|' || g.tgenabled::text || '|' || pg_get_triggerdef(g.oid, false) FROM pg_trigger g WHERE g.tgrelid=${rel} AND NOT g.tgisinternal
  UNION ALL SELECT 'verificacao_fk|' || r.conname || '|' || cg.relname || '|' || p.proname || '|' || g.tgtype::text || '|' || g.tgenabled::text
    FROM pg_constraint r JOIN pg_trigger g ON g.tgconstraint=r.oid AND g.tgisinternal JOIN pg_class cg ON cg.oid=g.tgrelid JOIN pg_proc p ON p.oid=g.tgfoid WHERE r.conrelid=${rel}
  UNION ALL SELECT 'regra|' || w.rulename || '|' || w.ev_enabled::text || '|' || pg_get_ruledef(w.oid) FROM pg_rewrite w WHERE w.ev_class=${rel}
  UNION ALL SELECT 'sequencia|' || a.attname || '|' || d.deptype::text || '|' || sq.relname || '|' || sq.relpersistence::text || '|' || format_type(s.seqtypid, NULL) || '|' || s.seqstart || '|' || s.seqincrement || '|' || s.seqmax || '|' || s.seqmin || '|' || s.seqcache || '|' || s.seqcycle::text
    FROM pg_depend d JOIN pg_class sq ON sq.oid=d.objid JOIN pg_sequence s ON s.seqrelid=sq.oid JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass AND d.refobjid=${rel} AND d.deptype IN ('a', 'i')`;
/**
 * R5-01: projeção canônica de cada linha antes do hash. Um restore fiel (pg_dump/pg_restore) faz o PostgreSQL reler o texto das definições,
 * e duas formas voltam reescritas com o mesmo valor; depois do restore, as migrations seguintes gravam as suas na forma original, e a relação
 * mistura as duas. A projeção leva toda linha à forma que o restore devolve (ponto fixo), então o hash não depende de onde houve restore.
 * Só as duas reanálises medidas, só em linha de restrição ou de índice com nome simples, e nunca dentro de literal ou identificador entre aspas:
 *   (ARRAY['A'::character varying, …])::text[]  →  ARRAY[('A'::character varying)::text, …]   (todos os elementos literais varchar)
 *   ((a) AND (b)) AND (c)  →  (a) AND (b) AND (c)   (só o E que é o primeiro operando de outro E, como o parser; todos os operandos
 *                                                     dos dois níveis entre parênteses. (a) AND ((b) AND (c)) fica como está, como no restore)
 * Qualquer outra diferença (valor, coluna, operador, OR, outra conversão) continua mudando o hash; texto que não se deixa ler fica como está.
 */
const VARCHAR = `'(?:[^']|'')*'::character varying`;
const ARRAY_VARCHAR = new RegExp(`'(?:[^']|'')*'|"(?:[^"]|"")*"|\\(ARRAY\\[(${VARCHAR}(?:, ${VARCHAR})*)\\]\\)::text\\[\\]`, 'g');
const semConversaoDoArray = def => def.replace(ARRAY_VARCHAR, (trecho, itens) => (itens === undefined ? trecho : `ARRAY[${itens.match(new RegExp(VARCHAR, 'g')).map(e => `(${e})::text`).join(', ')}]`));
/** Parênteses como árvore (grupo = lista de texto e grupos), com literais e identificadores entre aspas inteiros no texto. Desbalanceado = null. */
function grupos(def) {
  const raiz = [], pilha = [raiz], peca = /'(?:[^']|'')*'|"(?:[^"]|"")*"|[()]|[^'"()]+/y;
  for (let i = 0; i < def.length; i = peca.lastIndex) {
    peca.lastIndex = i;
    const m = peca.exec(def);
    if (!m) return null;
    const topo = pilha.at(-1);
    if (m[0] === '(') { const g = []; topo.push(g); pilha.push(g); }
    else if (m[0] === ')') { if (pilha.length === 1) return null; pilha.pop(); }
    else if (typeof topo.at(-1) === 'string') topo[topo.length - 1] += m[0];
    else topo.push(m[0]);
  }
  return pilha.length === 1 ? raiz : null;
}
/**
 * Operandos de um grupo `(G AND G …)`; outro grupo = null. Como texto vizinho se funde num só pedaço, um grupo cujos pedaços ímpares são
 * exatamente ' AND ' tem todo operando entre parênteses (`(flag AND (x))` é um texto só seguido de um grupo, e não casa).
 */
const operandosDoE = g => (g.length >= 3 && g.length % 2 === 1 && g.every((x, i) => i % 2 === 0 || x === ' AND ') ? g.filter((x, i) => i % 2 === 0) : null);
/** Como o parser ao reler (makeAndExpr): só o E que é o PRIMEIRO operando de outro E se funde; E aninhado depois dele fica como está. */
const achatar = nos => nos.map(n => {
  if (typeof n === 'string') return n;
  const g = achatar(n), ops = operandosDoE(g), primeiro = ops && operandosDoE(ops[0]);
  return primeiro ? [...primeiro, ...ops.slice(1)].flatMap((o, i) => (i ? [' AND ', o] : [o])) : g;
});
const comoTexto = nos => nos.map(n => (typeof n === 'string' ? n : `(${comoTexto(n)})`)).join('');
function canonica(linha) {
  const m = /^((?:restricao|indice)\|[a-z0-9_]+\|)([^]*)$/.exec(linha);
  if (!m) return linha;
  const nos = grupos(semConversaoDoArray(m[2]));
  return nos ? m[1] + comoTexto(achatar(nos)) : linha;
}
const ordemC = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
/** Hash da estrutura de uma relação: linhas canônicas na ordem do COLLATE "C", unidas por \n. Relação ausente = null. */
const hashLinhas = linhas => (linhas?.length ? sha(linhas.map(canonica).sort(ordemC).join('\n')) : null);
/** Identidade de uma função pelo texto que o banco reconstrói: corpo, linguagem, SECURITY DEFINER, volatilidade, STRICT, SET (search_path e outros), argumentos e retorno. Sem CR. */
const impressaoFuncao = oid => `encode(sha256(convert_to(replace(pg_get_functiondef(${oid}), E'\\r', ''), 'UTF8')), 'hex')`;
const semArgs = f => f.replace(/\(.*\)$/, '');
/** Todas as versões (sobrecargas) de um nome no esquema public; nenhuma = NULL. */
const hashFuncao = f => `(SELECT encode(sha256(convert_to(string_agg(${impressaoFuncao('p.oid')}, E'\\n' ORDER BY pg_get_function_identity_arguments(p.oid) COLLATE "C"), 'UTF8')), 'hex') FROM pg_proc p WHERE p.pronamespace = to_regnamespace('public') AND p.proname = '${f}')`;
/** Identidade de cada guarda e auxiliar: o hash de todas as versões do nome, como na âncora. Corpo igual com SET search_path, SECURITY DEFINER, volatilidade ou linguagem trocados não é a mesma função, e outra sobrecarga com o mesmo nome também muda o hash. */
const DEFS_FUNCAO = Object.freeze(Object.fromEntries([...new Set([...Object.values(GATILHOS).flat().map(g => g[2]), ...Object.values(FUNCOES_AUXILIARES).flat()])].map(f => [f, Object.freeze(valoresMedidos(`funcao:${semArgs(f)}`))])));
const funcaoConhecida = (f, shas) => `coalesce(${hashFuncao(semArgs(f))} = ANY(ARRAY[${shas.map(h => `'${h}'`).join(', ')}]::text[]), false)`;
/**
 * Assinatura final: catálogo, guardas (definição do gatilho e corpo) e colunas lidas, tudo verificado com a tabela vazia ou não. A estrutura
 * inteira de cada objeto entra na leitura (estrutura_<objeto>): o hash canônico das linhas, conferido no JS contra ESTRUTURA_OBJETOS.
 */
const ASSINATURAS = Object.freeze(Object.fromEntries(Object.entries(ASSINATURAS_CATALOGO).map(([id, itens]) => {
  const guardas = GATILHOS[id] ?? [];
  const funcoes = [...new Set([...guardas.map(g => g[2]), ...(FUNCOES_AUXILIARES[id] ?? [])])];
  return [id, Object.freeze({
    ...itens,
    ...Object.fromEntries(guardas.map(([t, g]) => [`gatilho_${g}`, gatilho(t, g)])),
    ...Object.fromEntries(funcoes.map(f => [`funcao_${f.replace(/\(.*\)$/, '')}`, funcaoConhecida(f, DEFS_FUNCAO[f] ?? [])])),
    ...Object.fromEntries(MATRIZ.filter(m => m.migracao === id && colunasLidas(m.objeto).length).map(m => [`colunas_${m.objeto}`, colunasPresentes(m.objeto, colunasLidas(m.objeto))])),
    ...Object.fromEntries(MATRIZ.filter(m => m.migracao === id).map(m => [`estrutura_${m.objeto}`, Object.freeze({estrutura: m.objeto})])),
  })];
})));

/**
 * O que cada migration da sequência cria ou altera, pelo SQL dela (inclusive relações auxiliares fora da matriz e funções trocadas por
 * CREATE OR REPLACE). A suíte PG confere, passo a passo, que nenhuma outra relação ou função do esquema muda; a unitária confere o texto.
 */
const RELACOES_DA_SEQUENCIA = Object.freeze({
  '089': ['assinatura_encerramentos'],
  '090': ['assinatura_campanhas', 'assinatura_fundadores'],
  '091': ['assinatura_fundadores', 'cadastros_empresas', 'empresa_assinaturas', 'empresa_documento_continuidades', 'empresa_representacoes', 'solicitacoes_acesso_empresa'],
  '092': ['fechamento_pacote_snapshots', 'precos_pacote'],
  '093': ['agenda_escopo_config', 'agenda_saloes', 'configuracao_agenda', 'configuracao_agenda_saloes', 'pacote_saloes'],
  '094': ['fechamento_revisoes', 'fechamentos'],
  '095': [...CREDITOS_PAGOS, ...CREDITOS_GERAIS],
  '096': ['assinatura_comprovantes', 'documentos_legais_versoes'],
  '097': ['assinatura_arrependimentos'],
  '100': [],
});
const FUNCOES_DA_SEQUENCIA = Object.freeze({
  '089': ['kidmais_089_encerramento_guarda'],
  '090': ['kidmais_090_campanha_guarda', 'kidmais_090_fundador_guarda'],
  '091': ['kidmais_091_continuidade_guarda', 'kidmais_091_documento_guarda', 'kidmais_091_documento_valido'],
  '092': ['kidmais_047_lacunas_escopo'],
  '093': ['kidmais093_mesma_empresa'],
  '094': ['kidmais019_validar_contrato', 'kidmais019_validar_destino', 'kidmais094_conflito_ocupacao', 'kidmais094_ocupacoes', 'kidmais094_salao_fechamento', 'kidmais094_salao_revisao', 'kidmais_validar_agenda_revisao'],
  '095': ['kidmais_095_guarda'],
  '096': ['kidmais_096_guarda'],
  '097': ['kidmais_097_guarda'],
  '100': ['kidmais094_conflito_ocupacao'],
});
/** Itens ancorados: toda relação da matriz, das guardas e da sequência; toda função de guarda, auxiliar e da sequência. */
const ANCORAS = Object.freeze([...new Set([
  ...[...MATRIZ.map(m => m.objeto), ...Object.values(GATILHOS).flat().map(g => g[0]), ...Object.values(RELACOES_DA_SEQUENCIA).flat()].map(t => `relacao:${t}`),
  ...[...Object.values(GATILHOS).flat().map(g => semArgs(g[2])), ...Object.values(FUNCOES_AUXILIARES).flat().map(semArgs), ...Object.values(FUNCOES_DA_SEQUENCIA).flat()].map(f => `funcao:${f}`),
])].sort());
/** Âncoras de função pelo SQL; as de relação saem do hash canônico das linhas (lerAncoras). */
const sqlAncoras = (itens = ANCORAS) => itens.filter(i => i.startsWith('funcao:')).map(i => `SELECT '${i}'::text AS item, ${hashFuncao(i.slice('funcao:'.length))} AS h`).join('\nUNION ALL ');
const estadoNa = (t, k) => { let v; for (const [desde, h] of t ?? []) if (desde <= k) v = h; return v; };
function estadoEsperado(item, k) {
  const t = TRAJETORIA[item];
  if (!t) return undefined;
  return estadoNa(t, k);
}

const REGRA_FECHAMENTO = /assinatura|cobranca|credito|contrat|fundador|arrepend|comprovante|renovac|plano|campanh|excec|isenc|continuid|devolu|encerr|aviso|cadastro|asaas|checkout|pedido|fatura/i;
const EXCLUIDOS = Object.freeze(['contratos', 'modelos_contrato_empresa', 'marketing_campanhas', 'mcp_oauth_pedidos', 'plataforma_empresas_cadastro', 'empresa_representacoes', 'aceites_documentos_legais']);
const excluido = t => EXCLUIDOS.includes(t) || /^contrato_/.test(t) || /^pagamento_/.test(t);

const L1_DESLIGADAS = Object.freeze(['CADASTRO_PUBLICO_ATIVO', 'ASSINATURA_PLANOS_ATIVOS', 'ASSINATURA_CAMPANHA_FUNDADOR_ATIVA', 'CREDITOS_CATALOGO_ATIVO', 'CREDITOS_COMPRA_ATIVA', 'CREDITOS_FRANQUIA_PLANO_ATIVO', 'CREDITOS_CONVITES_CONSUMO_ATIVO', 'CREDITOS_WALLE_CONSUMO_ATIVO', 'ASSINATURA_CONTINUIDADE_ATIVA']);
const L1_AUSENTES = Object.freeze(['ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN']);
const SERVICOS_L1 = Object.freeze(['web', 'cron-avisos', 'cron-reconciliacao']);

const AUD_RECUSADA = Object.freeze(['COBRANCA_WEBHOOK_RECUSADO', 'ASSINATURA_SINCRONIZACAO_RECUSADA']);
const AUD_EXATAS = Object.freeze(['ARREPENDIMENTO_REGISTRADO', 'ENCERRADA', 'EMPRESA_CADASTRADA_PUBLICO', 'CADASTRO_CONFIRMADO']);
const AUD_PREFIXOS = /^(ASSINATURA_|COBRANCA_|CREDITOS_|COMERCIAL_|RENOVACAO_|AVISO_ASSINATURA_)/;
/** Três classes, com precedência das duas últimas sobre os padrões amplos (§9.2.2). `null` = fora das listas. */
function classeAuditoria(acao) {
  if (AUD_RECUSADA.includes(acao)) return 'TENTATIVA_RECUSADA';
  if (/_SEM_CONFIRMACAO$/.test(acao)) return 'EFEITO_INCERTO';
  if (AUD_EXATAS.includes(acao) || AUD_PREFIXOS.test(acao)) return 'EFEITO_ACEITO';
  return null;
}

class Recusa extends Error {}
const recusar = codigo => { throw new Recusa(codigo); };
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
const eObjeto = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const exatas = (o, permitidas, codigo) => { if (!eObjeto(o) || Object.keys(o).some(k => !permitidas.includes(k))) recusar(codigo); };
const ehData = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s) && !Number.isNaN(Date.parse(s));
const ehTexto = (s, min = 3) => typeof s === 'string' && s.trim().length >= min;

/** Rótulos deste serviço, nunca o valor. Só `true` liga (§6); chave vazia conta como ausente. */
function rotulosL1(env = process.env) {
  const r = {};
  for (const k of L1_DESLIGADAS) r[k] = env[k] === 'true' ? 'LIGADA' : env[k] === undefined || env[k] === '' ? 'AUSENTE' : 'DESLIGADA';
  for (const k of L1_AUSENTES) r[k] = env[k] && env[k].trim() ? 'PRESENTE' : 'AUSENTE';
  return r;
}
const l1Fechada = rotulos => eObjeto(rotulos)
  && L1_DESLIGADAS.every(k => ['DESLIGADA', 'AUSENTE'].includes(rotulos[k])) && L1_AUSENTES.every(k => rotulos[k] === 'AUSENTE');

function validarDeclaracao(d) {
  exatas(d, ['versao', 'ponto', 'alvo', 'corte_p1', 'prefixo', 'ldt', 'linha_base', 'leitura_anterior', 'cadastros_referencia', 'barreira', 'provedor', 'historico', 'marcador_perda'], 'DECLARACAO_CAMPO_DESCONHECIDO');
  if (d.versao !== VERSAO) recusar('DECLARACAO_VERSAO');
  if (!PONTOS.includes(d.ponto)) recusar('DECLARACAO_PONTO');
  if (!['production', 'isolado', 'teste'].includes(d.alvo)) recusar('DECLARACAO_ALVO');
  if (!ehData(d.corte_p1) || Date.parse(d.corte_p1) > Date.now()) recusar('DECLARACAO_CORTE');
  if (!eObjeto(d.prefixo) || !['marcadores', 'restore', 'indeclaravel'].includes(d.prefixo.fonte)) recusar('DECLARACAO_PREFIXO');
  if (d.ldt != null && ANTES_DO_S.includes(d.ponto)) recusar('LDT_ANTES_DO_S');
  if (d.prefixo.fonte === 'restore' && d.alvo === 'production') recusar('RESTORE_SO_EM_DESTINO_ISOLADO');
}

/** Prefixo efetivo pelos marcadores, comparado depois com o catálogo; nunca deduzido do que se encontrar. */
function resolverPrefixo(pref, lerArquivo = fs.readFileSync, listar = fs.readdirSync) {
  if (pref.fonte === 'indeclaravel') return {situacao: 'INDECLARAVEL', ids: null, evidencias: []};
  const itens = pref.itens ?? [];
  if (!Array.isArray(itens)) recusar('PREFIXO_ITENS');
  const evidencias = [];
  const ler = (arquivo, codigo) => {
    let txt; try { txt = String(lerArquivo(arquivo)); } catch { return {falha: codigo}; }
    try { return {json: JSON.parse(txt), sha256: sha(txt)}; } catch { return {falha: codigo}; }
  };
  if (pref.fonte === 'restore') {
    if (!eObjeto(pref.registro) || !ehData(pref.registro.ponto) || !ehTexto(pref.registro.origem)) return {situacao: 'INCONCLUSIVO', motivo: 'RESTORE_SEM_REGISTRO', ids: null, evidencias};
    const ids = itens.map(i => i.migracao);
    return validarOrdem(ids) ? {situacao: 'DECLARADO', ids, evidencias, restore: pref.registro} : {situacao: 'INCONCLUSIVO', motivo: 'PREFIXO_FORA_DE_ORDEM', ids: null, evidencias};
  }
  const downs = new Set();
  for (const d of pref.downs ?? []) {
    const m = ler(d.marcador, 'DOWN_SEM_MARCADOR');
    if (m.falha || m.json?.situacao !== 'CONCLUIDA') return {situacao: 'INCONCLUSIVO', motivo: 'DOWN_SEM_MARCADOR', ids: null, evidencias};
    downs.add(d.migracao); evidencias.push({migracao: d.migracao, tipo: 'down', sha256: m.sha256});
  }
  const ids = [];
  for (const i of itens) {
    if (downs.has(i.migracao)) continue;
    const m = ler(i.marcador, 'PREFIXO_SEM_MARCADOR');
    if (m.falha) return {situacao: 'INCONCLUSIVO', motivo: 'PREFIXO_SEM_MARCADOR', ids: null, evidencias};
    if (m.json?.situacao !== 'CONCLUIDA' || !/^(JA_)?APLICADA_POSTCHECK_PASS$/.test(String(m.json?.resultado))) return {situacao: 'INCONCLUSIVO', motivo: 'MARCADOR_NAO_CONCLUIDO', ids: null, evidencias};
    ids.push(i.migracao); evidencias.push({migracao: i.migracao, tipo: 'aplicacao', sha256: m.sha256});
  }
  if (!validarOrdem(ids)) return {situacao: 'INCONCLUSIVO', motivo: 'PREFIXO_FORA_DE_ORDEM', ids: null, evidencias};
  // Marcador no disco que a declaração não cita: a declaração esconderia uma etapa.
  if (!Array.isArray(pref.pastas_marcadores) || !pref.pastas_marcadores.length) return {situacao: 'INCONCLUSIVO', motivo: 'PASTAS_DE_MARCADORES_NAO_DECLARADAS', ids: null, evidencias};
  for (const pasta of pref.pastas_marcadores) {
    let nomes; try { nomes = listar(pasta); } catch { return {situacao: 'INCONCLUSIVO', motivo: 'PASTA_DE_MARCADORES_ILEGIVEL', ids: null, evidencias}; }
    for (const nome of nomes) {
      const achado = /^migration-(\d{3}a?(?:-\d{3})?)\.json$/.exec(nome);
      if (!achado) continue;
      for (const id of idsDoMarcador(achado[1])) if (SEQUENCIA.includes(id) && !ids.includes(id) && !downs.has(id)) return {situacao: 'INCONCLUSIVO', motivo: 'MARCADOR_NAO_DECLARADO', ids: null, evidencias};
    }
  }
  return {situacao: 'DECLARADO', ids, evidencias};
}
/** `092-094` é o nome do escopo `todas`, com as três; `092-093` só com as duas. */
function idsDoMarcador(nome) {
  if (nome === '092-094') return ['092', '093', '094'];
  if (nome === '092-093') return ['092', '093'];
  return [nome];
}
const validarOrdem = ids => Array.isArray(ids) && ids.length <= SEQUENCIA.length && ids.every((id, i) => id === SEQUENCIA[i]);

const SQL_SELETOR_ESTRUTURA = () => `SELECT jsonb_build_object(${Object.entries(ASSINATURAS).map(([id, itens]) =>
  `'${id}', jsonb_build_object(${Object.entries(itens).filter(([, expr]) => typeof expr === 'string').map(([k, expr]) => `'${k}', (${expr})`).join(', ')})`).join(', ')},
  '_corpo_conflito', (SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid=to_regprocedure('public.${FUNCAO_CONFLITO}'))) AS estrutura`;
const SQL_IDENTIDADE = `SELECT current_database() AS banco, version() AS versao, inet_server_addr()::text AS servidor, inet_server_port() AS porta, session_user AS papel_sessao, current_user AS papel,
  r.rolsuper, r.rolbypassrls, current_setting('transaction_read_only') AS somente_leitura, current_setting('transaction_isolation') AS isolamento, now() AS agora
  FROM pg_roles r WHERE r.rolname = current_user`;
const SQL_OBJETOS = `SELECT c.relname AS objeto, c.relkind AS tipo, c.relrowsecurity, c.relforcerowsecurity, has_table_privilege(current_user, c.oid, 'SELECT') AS leitura,
  row_security_active(c.oid::regclass) AS rls_ativa FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname = ANY($1::text[])`;
const SQL_CATALOGO = `SELECT n.nspname AS esquema, c.relname AS objeto FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','f','v','m') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`;
const SQL_CONTADORES = `SELECT relname AS objeto, n_tup_ins::bigint AS ins, n_tup_del::bigint AS del FROM pg_stat_user_tables WHERE schemaname='public' AND relname = ANY($1::text[])`;
const SQL_RESET = `SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`;
const SQL_AUDITORIA = `SELECT acao, origem = 'COBRANCA' AS de_cobranca, count(*)::bigint AS n FROM public.auditoria WHERE criado_em >= $1::timestamptz GROUP BY 1, 2`;
const SQL_AUDITORIA_LINHAS = `SELECT id::text AS id, acao, to_char(criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS hora FROM public.auditoria WHERE criado_em >= $1::timestamptz AND acao = ANY($2::text[])`;
const sqlContagem = t => `SELECT count(*)::bigint AS n FROM public.${t}`;
const sqlSituacao = (t, c) => `SELECT ${c}::text AS chave, count(*)::bigint AS n FROM public.${t} GROUP BY 1`;
const textoDaLinha = colunas => colunas.map(c => `coalesce(${c}::text, '~')`).join(` || '|' || `);
const sqlHash = (t, colunas) => `SELECT count(*)::bigint AS n, encode(sha256(convert_to(coalesce(string_agg(linha, E'\\n' ORDER BY linha COLLATE "C"), ''), 'UTF8')), 'hex') AS hash
  FROM (SELECT ${textoDaLinha(colunas)} AS linha FROM public.${t}) x`;
/** Impressão de cada linha pelas mesmas colunas estáveis do hash. Fica fora do relatório, que só leva agregados; quem classifica roda este SELECT (ele sai no --plano). */
const sqlLinhasClassificadas = t => `SELECT encode(sha256(convert_to(${textoDaLinha(COLUNAS_HASH[t])}, 'UTF8')), 'hex') AS linha, ${COLUNAS_HASH[t].join(', ')} FROM public.${t} ORDER BY 1`;
/** Linhas de estrutura das relações ancoradas: dão o hash canônico de cada uma e, se divergir, o relato do objeto. */
const SQL_ESTRUTURA_OBJETOS = `SELECT c.relname AS objeto, x.linha FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public' CROSS JOIN LATERAL (${linhasEstrutura('c.oid')}) x WHERE c.relname = ANY($1::text[])`;
const RELACOES_ANCORADAS = Object.freeze(ANCORAS.filter(i => i.startsWith('relacao:')).map(i => i.slice('relacao:'.length)));
const SQL_ANCORAS = sqlAncoras();
/** Todas as âncoras na mesma transação: funções pelo SQL, relações pelo hash canônico das linhas (ausente = null). */
async function lerAncoras(db) {
  const ancoras = Object.fromEntries((await db.query(SQL_ANCORAS)).rows.map(r => [r.item, r.h ?? null]));
  const linhas = {};
  for (const {objeto, linha} of (await db.query(SQL_ESTRUTURA_OBJETOS, [RELACOES_ANCORADAS])).rows) (linhas[objeto] ??= []).push(linha);
  for (const t of RELACOES_ANCORADAS) ancoras[`relacao:${t}`] = hashLinhas(linhas[t]);
  return {ancoras, linhas};
}
const SQL_EXCECOES = `SELECT tipo, revogada_em IS NOT NULL AS revogada, valida_ate <= now() AS vencida, count(*)::bigint AS n FROM public.empresa_excecoes_comerciais GROUP BY 1, 2, 3`;
const SQL_CONTINUIDADES = `SELECT tipo, situacao, count(*)::bigint AS n FROM public.empresa_documento_continuidades GROUP BY 1, 2`;
const SQL_CADASTROS = `SELECT situacao, situacao = 'PENDENTE' AND expira_em > now() AS nao_expirado, count(*)::bigint AS n FROM public.cadastros_publicos GROUP BY 1, 2`;
const SQL_LOTES = `SELECT origem, pedido_id IS NOT NULL AS com_pedido, count(*)::bigint AS n FROM public.ia_credito_lotes GROUP BY 1, 2`;

const estadoMigracao = (id, valores, corpo) => {
  if (id === '100') {
    if (corpo === CORPO_100) return 'completa';
    return corpo === CORPO_094 || corpo === null || corpo === undefined ? 'ausente' : 'parcial';
  }
  const v = Object.values(valores ?? {});
  if (!v.length) return 'parcial';
  return v.every(Boolean) ? 'completa' : v.some(Boolean) ? 'parcial' : 'ausente';
};

/** Só leitura de agregados, numa fotografia REPEATABLE READ READ ONLY. Qualquer erro aborta tudo: nunca vira zero. */
async function lerBanco(db, corte) {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    for (const s of ["SET LOCAL statement_timeout = '60s'", "SET LOCAL lock_timeout = '5s'", "SET LOCAL TIME ZONE 'UTC'", "SET LOCAL DateStyle = 'ISO, YMD'", 'SET LOCAL search_path = pg_catalog']) await db.query(s);
    const identidade = (await db.query(SQL_IDENTIDADE)).rows[0];
    if (!identidade) recusar('PAPEL_NAO_ENCONTRADO');
    if (identidade.somente_leitura !== 'on' || identidade.isolamento !== 'repeatable read') recusar('TRANSACAO_NAO_E_SOMENTE_LEITURA');
    const bruto = (await db.query(SQL_SELETOR_ESTRUTURA())).rows[0].estrutura;
    const corpoConflito = bruto._corpo_conflito;
    const {ancoras, linhas: estruturaObjetos} = await lerAncoras(db);
    for (const [id, itens] of Object.entries(ASSINATURAS)) for (const [k, v] of Object.entries(itens)) if (v.estrutura) bruto[id][k] = ESTRUTURA_OBJETOS[v.estrutura].includes(ancoras[`relacao:${v.estrutura}`]);
    const migracoes = Object.fromEntries(Object.keys(ASSINATURAS).map(id => [id, estadoMigracao(id, bruto[id])]));
    migracoes['100'] = estadoMigracao('100', null, corpoConflito);
    const faltas = Object.fromEntries(Object.keys(ASSINATURAS).filter(id => migracoes[id] === 'parcial').map(id => [id, Object.entries(bruto[id]).filter(([, v]) => !v).map(([k]) => k).sort()]));
    const nomes = [...MATRIZ.map(m => m.objeto), ...FORA_DO_ESCOPO, 'auditoria'];
    const catalogoObj = new Map((await db.query(SQL_OBJETOS, [nomes])).rows.map(r => [r.objeto, r]));
    for (const linhas of Object.values(estruturaObjetos)) linhas.sort();
    const legivel = o => o && ['r', 'p'].includes(o.tipo) && o.leitura === true && o.rls_ativa === false;
    // Coluna ausente já é FALHA estrutural pela assinatura: a leitura não pode virar erro que a esconda nem ler o que não existe.
    const colunasOk = objeto => { const m = MATRIZ.find(x => x.objeto === objeto); return bruto[m?.migracao]?.[`colunas_${objeto}`] !== false; };
    const dominio = {};
    const linhasClassificadas = {};
    for (const {objeto} of MATRIZ) {
      const o = catalogoObj.get(objeto);
      const e = {presente: Boolean(o), tipo: o?.tipo ?? null, leitura: o?.leitura ?? null, rls: o ? {ativa: o.rls_ativa, habilitada: o.relrowsecurity, forcada: o.relforcerowsecurity} : null};
      if (o && legivel(o)) {
        e.contagem = Number((await db.query(sqlContagem(objeto))).rows[0].n);
        const colunas = COLUNAS_HASH[objeto];
        if (colunas && colunasOk(objeto) && e.contagem > 0) e.hash = (await db.query(sqlHash(objeto, colunas))).rows[0].hash;
        if (colunas && colunasOk(objeto) && e.contagem === 0) e.hash = sha('');
        if (OBJETOS_HASHEADOS_CLASSIFICADOS.includes(objeto) && colunasOk(objeto) && e.contagem > 0) linhasClassificadas[objeto] = (await db.query(sqlLinhasClassificadas(objeto))).rows.map(r => r.linha);
        if (SITUACAO[objeto] && colunasOk(objeto) && e.contagem > 0) e.situacoes = Object.fromEntries((await db.query(sqlSituacao(objeto, SITUACAO[objeto]))).rows.map(r => [r.chave, Number(r.n)]));
      }
      dominio[objeto] = e;
    }
    const ler = async (objeto, sql) => (legivel(catalogoObj.get(objeto)) && colunasOk(objeto) ? (await db.query(sql)).rows : null);
    const excecoes = await ler('empresa_excecoes_comerciais', SQL_EXCECOES);
    const continuidades = await ler('empresa_documento_continuidades', SQL_CONTINUIDADES);
    const cadastros = await ler('cadastros_publicos', SQL_CADASTROS);
    const lotes = await ler('ia_credito_lotes', SQL_LOTES);
    const aud = catalogoObj.get('auditoria');
    let auditoria = {legivel: false, por_acao: []}, linhasProibidas = [];
    if (legivel(aud)) {
      const linhas = (await db.query(SQL_AUDITORIA, [corte])).rows.map(r => ({acao: r.acao, de_cobranca: r.de_cobranca, n: Number(r.n)}));
      auditoria = {legivel: true, por_acao: linhas};
      const proibidas = [...new Set(linhas.filter(l => classeAuditoria(l.acao) !== null).map(l => l.acao))];
      if (proibidas.length) linhasProibidas = (await db.query(SQL_AUDITORIA_LINHAS, [corte, proibidas])).rows;
    }
    const catalogo = (await db.query(SQL_CATALOGO)).rows;
    const contadores = Object.fromEntries((await db.query(SQL_CONTADORES, [MATRIZ.map(m => m.objeto)])).rows.map(r => [r.objeto, {ins: Number(r.ins), del: Number(r.del)}]));
    const reset = (await db.query(SQL_RESET)).rows[0]?.stats_reset ?? null;
    return {identidade, migracoes, faltas, ancoras, estruturaObjetos, linhasClassificadas, corpoConflito, dominio, excecoes, continuidades, cadastros, lotes, auditoria, linhasProibidas, catalogo, foraDoEscopo: FORA_DO_ESCOPO.filter(t => catalogoObj.has(t)), contadores, statsReset: reset ? new Date(reset).toISOString() : null};
  } finally { await db.query('ROLLBACK').catch(() => undefined); }
}

/** Parte comum a todas as bases: estrutura no prefixo, papel e RLS, regra de fechamento e estados terminais. */
function avaliarComum(leitura, prefixoIds) {
  const motivos = [];
  const esperadas = new Set([...BASE, ...prefixoIds]);
  const estrutura = {};
  for (const id of [...BASE, ...SEQUENCIA]) {
    const estado = leitura.migracoes[id];
    const quer = esperadas.has(id);
    if (quer && estado === 'completa') estrutura[id] = 'PRESENTE_ESPERADA';
    else if (!quer && estado === 'ausente') estrutura[id] = 'AUSENTE_ESPERADA_COMPROVADA';
    else { estrutura[id] = 'FALHA/INCONCLUSIVO'; motivos.push(`MIGRATION_${id}_${String(estado).toUpperCase()}_${quer ? 'ESPERADA' : 'NAO_DECLARADA'}`); }
  }
  const k = prefixoIds.length;
  const foraDoPrefixo = [];
  for (const item of ANCORAS) {
    const esperado = estadoEsperado(item, k);
    const medido = Object.hasOwn(leitura.ancoras ?? {}, item) ? leitura.ancoras[item] : undefined;
    if (esperado === undefined || medido === undefined || medido !== esperado) foraDoPrefixo.push({item, medido: medido ?? null, esperado: esperado ?? null});
  }
  for (const {item} of foraDoPrefixo) motivos.push(`FORA_DO_PREFIXO:${item}`);
  for (const t of leitura.foraDoEscopo) motivos.push(`FORA_DO_ESCOPO_PRESENTE:${t}`);
  const objetos = {};
  for (const {objeto, migracao} of MATRIZ) {
    const e = leitura.dominio[objeto];
    const quer = esperadas.has(migracao);
    let r;
    if (quer && e.presente && ['r', 'p'].includes(e.tipo) && e.leitura === true && e.rls?.ativa === false && Number.isInteger(e.contagem)) r = 'PRESENTE_ESPERADA';
    else if (!quer && !e.presente) r = 'AUSENTE_ESPERADA_COMPROVADA';
    else {
      r = 'FALHA/INCONCLUSIVO';
      if (e.presente && e.rls?.ativa !== false) motivos.push(`RLS_PODE_INDUZIR_ZERO:${objeto}`);
      else if (e.presente && e.leitura !== true) motivos.push(`SEM_PRIVILEGIO:${objeto}`);
      else if (e.presente && !['r', 'p'].includes(e.tipo)) motivos.push(`TIPO_INESPERADO:${objeto}`);
      else motivos.push(`OBJETO_${e.presente ? 'NAO_DECLARADO' : 'AUSENTE'}:${objeto}`);
    }
    objetos[objeto] = r;
  }
  if (!leitura.auditoria.legivel) motivos.push('AUDITORIA_ILEGIVEL_OU_RLS');
  const conhecidos = new Set([...MATRIZ.map(m => m.objeto), ...FORA_DO_ESCOPO]);
  const fechamento = leitura.catalogo.filter(({esquema, objeto}) => REGRA_FECHAMENTO.test(objeto) && !(esquema === 'public' && (conhecidos.has(objeto) || excluido(objeto))))
    .map(({esquema, objeto}) => `${esquema}.${objeto}`).sort();
  for (const t of fechamento) motivos.push(`TABELA_FORA_DA_MATRIZ:${t}`);
  const vigentes = (leitura.excecoes ?? []).filter(l => !l.revogada && !l.vencida && l.tipo !== 'EXTENSAO_TESTE').reduce((s, l) => s + Number(l.n), 0);
  if (vigentes) motivos.push('EXCECAO_VIGENTE_NAO_TERMINAL');
  const continuidadesAbertas = (leitura.continuidades ?? []).filter(l => l.situacao !== 'CONCLUIDA').reduce((s, l) => s + Number(l.n), 0);
  if (continuidadesAbertas) motivos.push('CONTINUIDADE_NAO_CONCLUIDA');
  const estruturaDetalhe = Object.fromEntries(Object.entries(leitura.faltas ?? {}).filter(([id]) => estrutura[id] === 'FALHA/INCONCLUSIVO'));
  // Só o objeto que divergiu, para a revisão ver o que mudou sem outra leitura: nomes, tipos e definições, nenhum dado.
  const divergentes = [...new Set([...Object.values(estruturaDetalhe).flat().filter(i => i.startsWith('estrutura_')).map(i => i.slice('estrutura_'.length)),
    ...foraDoPrefixo.filter(f => f.item.startsWith('relacao:')).map(f => f.item.slice('relacao:'.length))])].sort();
  const estruturaDivergente = Object.fromEntries(divergentes.map(o => [o, leitura.estruturaObjetos?.[o] ?? []]));
  return {motivos, estrutura, estrutura_detalhe: estruturaDetalhe, estrutura_divergente: estruturaDivergente, fora_do_prefixo: foraDoPrefixo, objetos, fechamento};
}

const OBJETOS_HASHEADOS_CLASSIFICADOS = Object.freeze(['assinatura_isencoes', 'empresa_excecoes_comerciais', 'empresa_documento_continuidades', 'cadastros_empresas']);
/** Objetos CLASSIFICADA: cada linha exige a sua classificação de Felipe; depois do P1, a referência é obrigatória mesmo com a tabela vazia, e qualquer mudança de hash ou contagem = FALHA. */
function avaliarClassificados(leitura, d) {
  const motivos = [];
  const classificados = {};
  const base = d.linha_base;
  if (d.ponto !== 'P1' && !eObjeto(base)) motivos.push('LINHA_DE_BASE_AUSENTE');
  for (const objeto of OBJETOS_HASHEADOS_CLASSIFICADOS) {
    const e = leitura.dominio[objeto];
    if (!e.presente || !Number.isInteger(e.contagem)) continue;
    const ref = base?.[objeto];
    // Sem referência, o sumiço de todas as linhas passaria: a tabela vazia não dispensa a comparação.
    if (!ref && d.ponto !== 'P1' && eObjeto(base)) motivos.push(`LINHA_DE_BASE_SEM_OBJETO:${objeto}`);
    if (ref && (ref.contagem !== e.contagem || ref.hash !== e.hash)) motivos.push(`LINHA_DE_BASE_MUDOU:${objeto}`);
    const declaradas = Array.isArray(ref?.classificacoes) ? ref.classificacoes : [];
    if (e.contagem > 0) {
      const lidas = leitura.linhasClassificadas?.[objeto] ?? [];
      if (!declaradas.length || declaradas.some(c => !ehTexto(c?.classificacao))) motivos.push(`CLASSIFICACAO_PENDENTE:${objeto}`);
      else if (JSON.stringify(declaradas.map(c => c.linha).sort()) !== JSON.stringify([...lidas].sort())) motivos.push(`CLASSIFICACAO_DIVERGENTE:${objeto}`);
    }
    classificados[objeto] = {contagem: e.contagem, linhas_classificadas: declaradas.length};
  }
  const situacoes = {};
  for (const l of leitura.cadastros ?? []) situacoes[l.situacao] = (situacoes[l.situacao] ?? 0) + Number(l.n);
  const pendentesValidos = (leitura.cadastros ?? []).filter(l => l.nao_expirado).reduce((s, l) => s + Number(l.n), 0);
  if (DO_P3_EM_DIANTE.includes(d.ponto)) {
    if (pendentesValidos) motivos.push('CADASTRO_PENDENTE_NAO_EXPIRADO');
    if (d.ponto !== 'P3') {
      if (!eObjeto(d.cadastros_referencia)) motivos.push('REFERENCIA_DE_CADASTROS_AUSENTE');
      else if (JSON.stringify(ordenar(d.cadastros_referencia)) !== JSON.stringify(ordenar(situacoes))) motivos.push('CADASTROS_MUDARAM_DESDE_P3');
    }
  }
  return {motivos, classificados, cadastros: {por_situacao: situacoes, pendentes_nao_expirados: pendentesValidos}};
}
const ordenar = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Domínio VAZIA da matriz. Com LDT, "exatamente as linhas da LDT" substitui a matriz só nos objetos nominais. */
function avaliarDominio(leitura, ldt) {
  const motivos = [];
  for (const {objeto, dominio} of MATRIZ) {
    if (dominio !== 'VAZIA') continue;
    const e = leitura.dominio[objeto];
    if (!e.presente || !Number.isInteger(e.contagem)) continue;
    const ref = ldt?.objetos?.[objeto];
    if (ref) {
      if (ref.contagem !== e.contagem || ref.hash !== e.hash || JSON.stringify(ordenar(ref.situacoes ?? {})) !== JSON.stringify(ordenar(e.situacoes ?? {}))) motivos.push(`LDT_DIVERGENTE:${objeto}`);
    } else if (e.contagem !== 0) motivos.push(`OBJETO_COM_LINHA:${objeto}`);
  }
  for (const l of leitura.lotes ?? []) {
    if (Number(l.n) > 0) motivos.push(l.com_pedido || l.origem === 'COMPRA' ? 'CREDITO_COM_DADOS' : 'CREDITO_BARREIRA_PERDIDA');
  }
  return motivos;
}

/** Ocorrência proibida desde o corte reprova, exceto a identificada uma a uma na LDT. Nunca exige auditoria = 0. */
function avaliarAuditoria(leitura, ldt) {
  const motivos = [];
  const classes = {EFEITO_ACEITO: 0, EFEITO_INCERTO: 0, TENTATIVA_RECUSADA: 0};
  let semClasse = 0, deCobranca = 0;
  for (const l of leitura.auditoria.por_acao) {
    const c = classeAuditoria(l.acao);
    if (c) classes[c] += l.n;
    if (l.de_cobranca) { deCobranca += l.n; if (!c) semClasse += l.n; }
  }
  if (semClasse) motivos.push('AUDITORIA_COBRANCA_SEM_CLASSE');
  const tratadas = new Map((ldt?.auditoria ?? []).map(o => [o.id, o]));
  // A ocorrência tratada é a mesma só com identificador, ação e hora iguais aos da linha lida (§9.2.5).
  const naoTratadas = leitura.linhasProibidas.filter(l => tratadas.get(l.id)?.acao !== l.acao || tratadas.get(l.id)?.hora !== l.hora);
  if (naoTratadas.length) motivos.push('AUDITORIA_PROIBIDA');
  const presentes = new Set(leitura.linhasProibidas.map(l => l.id));
  const ausentesDaLeitura = [...tratadas.keys()].filter(id => !presentes.has(id));
  if (ausentesDaLeitura.length) motivos.push('LDT_AUDITORIA_NAO_ENCONTRADA');
  return {motivos, relatorio: {classes, linhas_origem_cobranca: deCobranca, cobranca_sem_classe: semClasse, proibidas_nao_tratadas: naoTratadas.length, ocorrencias_nao_tratadas: naoTratadas.map(({id, acao, hora}) => ({id, acao, hora})), por_acao: leitura.auditoria.por_acao}};
}

/** Barreira: L1 por rótulo em cada serviço, C2 reafirmado, crons suspensos, provedor, artefato em execução. */
function avaliarBarreira(d, env = {}) {
  const motivos = [];
  const b = d.barreira;
  if (!eObjeto(b)) return ['BARREIRA_NAO_DECLARADA'];
  for (const s of SERVICOS_L1) if (!l1Fechada(b.l1?.[s])) motivos.push(`L1_NAO_FECHADA:${s}`);
  if (d.alvo === 'production' && JSON.stringify(ordenar(rotulosL1(env))) !== JSON.stringify(ordenar(b.l1?.web ?? {}))) motivos.push('L1_WEB_DIVERGE_DESTE_SERVICO');
  if (!ehTexto(b.c2?.quem_tem_acesso) || !ehData(b.c2?.em)) motivos.push('C2_NAO_REAFIRMADO');
  if (b.crons_suspensos !== true) motivos.push('CRONS_NAO_SUSPENSOS');
  if (!ehTexto(b.artefato, 7)) motivos.push('ARTEFATO_NAO_DECLARADO');
  else if (env.RENDER_GIT_COMMIT && !env.RENDER_GIT_COMMIT.startsWith(b.artefato)) motivos.push('ARTEFATO_DIVERGENTE');
  if (!['PROVADA_NO_ARTEFATO', 'ARTEFATO_SEM_L2'].includes(b.l2)) motivos.push('L2_NAO_DECLARADA');
  return motivos;
}

/** Registro por ponto. "Ainda não" ou "chave ausente" não provam nada; a conta existindo, o registro cobre a listagem completa. */
function avaliarProvedor(p) {
  if (!eObjeto(p) || !ehData(p.em) || !ehTexto(p.declarante)) return ['PROVEDOR_SEM_REGISTRO'];
  if (p.conta_existe === false) return ehTexto(p.o_que_foi_olhado, 10) ? [] : ['PROVEDOR_DECLARACAO_INCOMPLETA'];
  if (p.conta_existe !== true) return ['PROVEDOR_SEM_REGISTRO'];
  const faltam = ['conta', 'ambiente', 'escopo'].some(k => !ehTexto(p[k], 2))
    || p.listagem_completa !== true || p.webhooks_conferidos !== true || p.fila_conferida !== true || p.operacoes_manuais_conferidas !== true;
  if (faltam) return ['PROVEDOR_DECLARACAO_INCOMPLETA'];
  return p.objetos_capazes_de_cobrar === 0 ? [] : ['PROVEDOR_COM_OBJETO_CAPAZ_DE_COBRAR'];
}

const HORA_AUDITORIA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function validarLdt(ldt, barreira) {
  const motivos = [];
  if (ldt.td_concluido !== true || !ehTexto(ldt.td_id, 2)) motivos.push('LDT_SEM_TD');
  if (ldt.guarda_demonstrada !== true || barreira?.l2 !== 'PROVADA_NO_ARTEFATO') motivos.push('LDT_SEM_GUARDA_NO_ARTEFATO');
  const objetos = Object.keys(ldt.objetos ?? {});
  for (const o of objetos) if (!ADMITIDOS_LDT.includes(o)) motivos.push(`LDT_OBJETO_NAO_ADMITIDO:${o}`);
  // Só se registra com linha fora do vazio ou ocorrência a tratar (§9.2.5): objeto citado com zero linhas não sustenta a base LDT.
  const linhas = objetos.reduce((s, o) => s + (Number(ldt.objetos[o]?.contagem) || 0), 0);
  if (!linhas && !(ldt.auditoria ?? []).length) motivos.push('LDT_VAZIA');
  // Cada ocorrência tratada: identificador, ação e hora, ligada ao TD (§9.2.5). O booleano do TD não liga a ocorrência a ele.
  for (const o of ldt.auditoria ?? []) {
    if (!ehTexto(o?.id, 1) || !ehTexto(o?.acao, 2) || !HORA_AUDITORIA.test(String(o?.hora))) motivos.push('LDT_AUDITORIA_INCOMPLETA');
    else if (!ehTexto(ldt.td_id, 2) || o.td !== ldt.td_id) motivos.push('LDT_AUDITORIA_SEM_VINCULO_TD');
  }
  return motivos;
}

/** Função única de conformidade (§9.2.5), para S, P7, P8, P9, R1, R2 e R3. P1 a P5 usam a mesma, sempre com base VAZIO. */
function conformidade(leitura, d, prefixoIds, env = {}) {
  const ldt = d.ldt ?? null;
  const base = ldt ? 'LDT' : 'VAZIO';
  const comum = avaliarComum(leitura, prefixoIds);
  const classificados = avaliarClassificados(leitura, d);
  const motivosBarreira = [...avaliarBarreira(d, env), ...avaliarProvedor(d.provedor)];
  const motivosLdt = ldt ? validarLdt(ldt, d.barreira) : [];
  const motivosDominio = avaliarDominio(leitura, ldt);
  const auditoria = avaliarAuditoria(leitura, ldt);
  const motivos = [...comum.motivos, ...classificados.motivos, ...motivosBarreira, ...motivosLdt, ...motivosDominio, ...auditoria.motivos];
  const atual = motivos.length ? 'A-FALHA' : base === 'VAZIO' ? 'A-VAZIO' : 'A-LDT';
  return {base, atual, motivos, comum, classificados, auditoria: auditoria.relatorio};
}

/** H-COBERTO exige ponto inicial conforme, contenção contínua e, com F-C ou perda de barreira, o critério de cobertura. */
function avaliarHistorico(h) {
  if (!eObjeto(h) || !ehTexto(h.ponto_inicial, 2) || h.contencao_continua !== true) return 'H-NAO';
  if (h.houve_fc_ou_perda_de_barreira !== false && h.criterio_de_cobertura !== true) return 'H-NAO';
  return 'H-COBERTO';
}
function resultadoDoPonto(ponto, atual, historico) {
  if (ANTES_DO_S.includes(ponto)) return atual === 'A-VAZIO' ? 'PASS' : 'FALHA';
  if (ponto !== 'S') return atual === 'A-FALHA' ? 'NAO_CONFORME' : 'CONFORME';
  if (atual === 'A-FALHA') return 'S-FALHA';
  if (historico !== 'H-COBERTO') return 'S-HIST';
  return atual === 'A-VAZIO' ? 'S-PASS' : 'S-REG';
}
const CODIGO_DO_RESULTADO = Object.freeze({PASS: 0, 'S-PASS': 0, 'S-REG': 0, CONFORME: 0, FALHA: 3, 'S-FALHA': 3, 'S-HIST': 3, NAO_CONFORME: 3, INCONCLUSIVO: 1});

/** n_tup_ins/del entre pontos: acusa linha criada e apagada. Reset ou leitura sem par é lacuna relatada, não prova. */
function compararContadores(atual, reset, anterior, ponto) {
  if (!eObjeto(anterior?.contadores)) return {situacao: 'SEM_LEITURA_ANTERIOR', movimentos: []};
  if (anterior.stats_reset !== reset) return {situacao: 'LACUNA_RESET_DE_ESTATISTICAS', movimentos: []};
  const movimentos = [];
  for (const {objeto, dominio} of MATRIZ) {
    const a = atual[objeto], p = anterior.contadores[objeto];
    // Classificado também: linha criada e apagada entre pontos não muda o hash. `cadastros_publicos` só depois do P3, quando a contagem deixa de poder mudar.
    const vigiado = dominio === 'VAZIA' || OBJETOS_HASHEADOS_CLASSIFICADOS.includes(objeto) || (objeto === 'cadastros_publicos' && DO_P3_EM_DIANTE.includes(ponto) && ponto !== 'P3');
    if (!a || !p || !vigiado) continue;
    if (a.ins > p.ins || a.del > p.del) movimentos.push(objeto);
  }
  return {situacao: 'COMPARADO', movimentos};
}

/** Alvo por sinais; sinais contraditórios recusam antes de conectar. */
function validarAlvo(d, env) {
  const eProducao = env.RENDER_SERVICE_ID === SERVICO_PRODUCAO || env.KIDMAIS_DEPLOY_ENV === 'production';
  if (d.alvo === 'production' && !(env.RENDER === 'true' && env.RENDER_SERVICE_ID === SERVICO_PRODUCAO && env.KIDMAIS_DEPLOY_ENV === 'production')) recusar('ALVO_PRODUCTION_SEM_SINAIS');
  if (d.alvo === 'isolado' && eProducao) recusar('ALVO_ISOLADO_EM_PRODUCTION');
}
function validarBanco(d, banco) {
  if (d.alvo === 'production' && banco !== BANCO_PRODUCAO) recusar('BANCO_DIVERGENTE');
  if (d.alvo !== 'production' && banco === BANCO_PRODUCAO) recusar('BANCO_DE_PRODUCTION_EM_OUTRO_ALVO');
}
/** Campos explícitos: nada de connectionString, e nenhum parâmetro da URL troca o destino. */
function parametrosDaUrl(env) {
  let u; try { u = new URL(String(env.DATABASE_URL ?? '')); } catch { recusar('URL_ILEGIVEL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname || !u.pathname.slice(1)) recusar('URL_INVALIDA');
  if ([...u.searchParams.keys()].some(k => !['sslmode', 'ssl'].includes(k))) recusar('URL_COM_PARAMETROS');
  let usuario, senha; try { usuario = decodeURIComponent(u.username); senha = decodeURIComponent(u.password); } catch { recusar('URL_ILEGIVEL'); }
  const ssl = env.DATABASE_SSL === 'true' ? {rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'} : false;
  return {host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: usuario, password: senha, ssl, application_name: 'kidmais-conferidor-g-vazio', connectionTimeoutMillis: 10000};
}

const resumoInconclusivo = (d, motivo, extra = {}) => ({conferidor: 'G-VAZIO', versao: VERSAO, ponto: d?.ponto ?? null, resultado: 'INCONCLUSIVO', motivos: [motivo], marcador_perda_nao_descartada: d?.marcador_perda === true || d?.leitura_anterior?.marcador_perda_nao_descartada === true, ...extra});

/** Uma leitura. Devolve o relatório; só agregados, sem linha nem dado pessoal. */
async function conferir(d, {env = process.env, Client, lerMarcador, listarPasta, agora = () => new Date()} = {}) {
  validarDeclaracao(d);
  validarAlvo(d, env);
  const inicio = agora().toISOString();
  const prefixo = resolverPrefixo(d.prefixo, lerMarcador, listarPasta);
  const opcoes = d.alvo === 'teste' ? {} : parametrosDaUrl(env);
  const db = new (Client ?? require('pg').Client)(opcoes);
  db.on?.('error', () => undefined);
  let leitura;
  try {
    await db.connect();
    leitura = await lerBanco(db, d.corte_p1);
    validarBanco(d, leitura.identidade.banco);
  } catch (e) {
    if (e instanceof Recusa) throw e;
    return resumoInconclusivo(d, `LEITURA_IMPOSSIVEL:${/^[A-Z0-9_]{1,12}$/.test(String(e?.code ?? '')) ? e.code : 'SEM_CODIGO'}`, {inicio, fim: agora().toISOString()});
  } finally { await db.end?.().catch?.(() => undefined); }

  const identidade = {banco: leitura.identidade.banco, servidor: leitura.identidade.servidor, porta: leitura.identidade.porta, versao: leitura.identidade.versao, artefato: env.RENDER_GIT_COMMIT ?? null, prefixo_declarado: prefixo.ids, fonte_do_prefixo: d.prefixo.fonte, marcadores: prefixo.evidencias};
  const papel = {session_user: leitura.identidade.papel_sessao, current_user: leitura.identidade.papel, rolsuper: leitura.identidade.rolsuper, rolbypassrls: leitura.identidade.rolbypassrls, somente_leitura: leitura.identidade.somente_leitura, isolamento: leitura.identidade.isolamento};
  const marcadorAntes = d.marcador_perda === true || d.leitura_anterior?.marcador_perda_nao_descartada === true;
  const comum = {inicio, fim: agora().toISOString(), conferidor: 'G-VAZIO', versao: VERSAO, ponto: d.ponto, identidade, papel, migracoes: leitura.migracoes, dominio: leitura.dominio, contadores: leitura.contadores, stats_reset: leitura.statsReset, l1: d.barreira?.l1 ?? null, provedor: d.provedor ?? null};
  // Prefixo impossível de declarar ou sem marcador: só relata o catálogo, nunca emite PASS (§9.2.2).
  if (prefixo.situacao !== 'DECLARADO') return {...comum, resultado: 'INCONCLUSIVO', motivos: [prefixo.motivo ?? 'PREFIXO_INDECLARAVEL'], catalogo_relatado: leitura.catalogo.filter(({objeto}) => REGRA_FECHAMENTO.test(objeto)).map(({esquema, objeto}) => `${esquema}.${objeto}`).sort(), marcador_perda_nao_descartada: marcadorAntes};

  const c = conformidade(leitura, d, prefixo.ids, env);
  const historico = d.ponto === 'S' || d.historico ? avaliarHistorico(d.historico) : null;
  const resultado = resultadoDoPonto(d.ponto, c.atual, historico);
  const marcador = marcadorAntes || resultado === 'S-HIST';
  const movimento = compararContadores(leitura.contadores, leitura.statsReset, d.leitura_anterior, d.ponto);
  // Restore: catálogo diferente do prefixo registrado é INCONCLUSIVO (§9.2.2), nunca PASS e nem conclusão sobre o domínio.
  if (d.prefixo.fonte === 'restore' && (Object.values(c.comum.estrutura).includes('FALHA/INCONCLUSIVO') || c.comum.fora_do_prefixo.length)) return {...comum, resultado: 'INCONCLUSIVO', motivos: ['RESTORE_DIVERGENTE', ...c.comum.motivos.filter(m => /^(MIGRATION_|FORA_DO_PREFIXO:)/.test(m))], estrutura: c.comum.estrutura, estrutura_detalhe: c.comum.estrutura_detalhe, estrutura_divergente: c.comum.estrutura_divergente, fora_do_prefixo: c.comum.fora_do_prefixo, marcador_perda_nao_descartada: marcadorAntes};
  const motivos = [...c.motivos];
  let final = resultado;
  if (movimento.movimentos.length) {
    motivos.push(...movimento.movimentos.map(o => `MOVIMENTO_ENTRE_PONTOS:${o}`));
    if (!['FALHA', 'S-FALHA', 'NAO_CONFORME'].includes(final)) final = ANTES_DO_S.includes(d.ponto) ? 'FALHA' : d.ponto === 'S' ? 'S-FALHA' : 'NAO_CONFORME';
  }
  return {...comum, base: c.base, estado_atual: motivos.length ? 'A-FALHA' : c.atual, historico, estrutura: c.comum.estrutura, estrutura_detalhe: c.comum.estrutura_detalhe, estrutura_divergente: c.comum.estrutura_divergente, fora_do_prefixo: c.comum.fora_do_prefixo, objetos: c.comum.objetos, classificados: c.classificados.classificados, regra_de_fechamento: c.comum.fechamento, cadastros: c.classificados.cadastros, auditoria: c.auditoria, comparacao_contadores: movimento, excecoes: leitura.excecoes, continuidades: leitura.continuidades, creditos_lotes: leitura.lotes, resultado: final, motivos, marcador_perda_nao_descartada: marcador};
}

/** Saída completa com SHA-256 dela; a última linha é o código. */
function imprimir(relatorio, escrever = s => process.stdout.write(s)) {
  const texto = JSON.stringify(relatorio, null, 2);
  escrever(texto + '\n');
  escrever(`SHA256_SAIDA=${sha(texto)}\n`);
  const codigo = CODIGO_DO_RESULTADO[relatorio.resultado] ?? 1;
  escrever(`CODIGO_SAIDA=${codigo}\n`);
  return codigo;
}

async function main(argv = process.argv.slice(2), env = process.env, {Client} = {}) {
  if (argv.length !== 1) { console.error('USO: --plano | --l1 | --declaracao=<arquivo>'); return 1; }
  if (argv[0] === '--plano') { console.log(JSON.stringify({matriz: MATRIZ, fora_do_escopo: FORA_DO_ESCOPO, base: BASE, sequencia: SEQUENCIA, admitidos_ldt: ADMITIDOS_LDT, ancoras: ANCORAS, colunas_hash: COLUNAS_HASH, sql_preparacao_das_linhas: "SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, YMD';", sql_linhas_classificadas: Object.fromEntries(OBJETOS_HASHEADOS_CLASSIFICADOS.map(t => [t, sqlLinhasClassificadas(t)]))}, null, 2)); return 0; }
  if (argv[0] === '--l1') { console.log(JSON.stringify({servico: env.RENDER_SERVICE_ID ?? null, rotulos: rotulosL1(env)}, null, 2)); return 0; }
  const m = /^--declaracao=(.+)$/.exec(argv[0]);
  if (!m) { console.error('USO: --plano | --l1 | --declaracao=<arquivo>'); return 1; }
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path.resolve(m[1]), 'utf8'));
    if (d?.alvo === 'teste') recusar('ALVO_TESTE_SO_EM_TESTE');
    return imprimir(await conferir(d, {env, Client}));
  } catch (e) {
    return imprimir(resumoInconclusivo(eObjeto(d) ? d : null, e instanceof Recusa ? e.message : 'DECLARACAO_ILEGIVEL'));
  }
}

module.exports = {ASSINATURAS, GATILHOS, DEFS_FUNCAO, RELACOES_DA_SEQUENCIA, FUNCOES_DA_SEQUENCIA, ANCORAS, TRAJETORIA, estadoEsperado, sqlAncoras, lerAncoras, canonica, hashLinhas, linhasEstrutura, ESTRUTURA_OBJETOS, FUNCOES_AUXILIARES, sqlLinhasClassificadas, OBJETOS_HASHEADOS_CLASSIFICADOS, colunasLidas, MATRIZ, BASE, SEQUENCIA, FORA_DO_ESCOPO, ADMITIDOS_LDT, COLUNAS_HASH, REGRA_FECHAMENTO, EXCLUIDOS, L1_DESLIGADAS, L1_AUSENTES, SERVICOS_L1, CODIGO_DO_RESULTADO, Recusa,
  classeAuditoria, rotulosL1, l1Fechada, validarDeclaracao, resolverPrefixo, idsDoMarcador, estadoMigracao, lerBanco, avaliarComum, avaliarClassificados, avaliarDominio, avaliarAuditoria, avaliarBarreira, avaliarProvedor, validarLdt, conformidade, avaliarHistorico, resultadoDoPonto, compararContadores, validarAlvo, validarBanco, parametrosDaUrl, conferir, imprimir, main, excluido};

if (require.main === module) main().then(c => { process.exitCode = c; }, () => { process.exitCode = 1; });
