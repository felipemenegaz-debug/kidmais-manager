import type { Medida } from "./plano-lote.ts";

/**
 * Guarda fase 3 (20/11/2026): mapa FECHADO dos dados por tabela e coluna, para a anonimização (fase 4) saber o que cada
 * medida alcança. Só classificação: nada aqui lê ou altera o banco.
 *
 * Toda coluna de texto, binária, JSON, enum ou endereço IP do schema public está aqui (inventário do modelo 130, todas
 * as migrations menos a 098). O teste lib/guarda/mapa-dados.postgres.test.ts FALHA se aparecer coluna nova sem
 * classificação ou se o mapa citar coluna que não existe. Coluna numérica, data e uuid ficam fora: não guardam texto
 * pessoal (os vínculos por id são resolvidos pela fase 4 a partir das tabelas classificadas).
 *
 * Classes (cada prazo vale para a sua finalidade, DPA 2026-11-17):
 *   CLIENTE          identificação e contato do cliente e de quem está no cadastro dele (aniversariantes, responsáveis
 *                    adicionais). Sai só na anonimização completa.
 *   CONTRATO         dado pessoal que só serve à festa contratada: snapshot e PDF do contrato, assinaturas, pagamentos e
 *                    comprovantes, convites e convidados, observações da negociação. Sai ao vencer o contrato (salvo
 *                    valor em aberto ou disputa) e na anonimização completa.
 *   CAMPANHA         contato para campanhas e atendimento: formulário do site, conversas do WhatsApp, pesquisa de
 *                    satisfação, funil de oportunidades, automações. Sai ao vencer o contato para campanhas.
 *   HISTORICO        registro de evento ou auditoria com cópia de dado do cliente (antes/depois, identidade, motivo). Vai
 *                    junto com a medida do registro a que se refere; a fase 4 filtra pela entidade.
 *   PRESERVAR_SAIDA  marca de saída das campanhas (127): fica para respeitar o pedido mesmo depois da anonimização.
 *   EMPRESA          dado do buffet, dos seus usuários ou da plataforma (assinatura, financeiro próprio, acessos). Fora
 *                    da guarda dos clientes.
 *   SEM_DADO_PESSOAL códigos, estados, hashes, catálogo e configuração.
 */
export type Classe = "CLIENTE" | "CONTRATO" | "CAMPANHA" | "HISTORICO" | "PRESERVAR_SAIDA" | "EMPRESA" | "SEM_DADO_PESSOAL";
export const CLASSES: readonly Classe[] = Object.freeze(["CLIENTE", "CONTRATO", "CAMPANHA", "HISTORICO", "PRESERVAR_SAIDA", "EMPRESA", "SEM_DADO_PESSOAL"]);

/** O que cada medida do lote alcança. HISTORICO acompanha o registro de origem; EMPRESA, saída e sem dado nunca. */
export const CLASSES_POR_MEDIDA: Readonly<Record<Medida, readonly Classe[]>> = Object.freeze({
  PARAR_CAMPANHA: Object.freeze(["CAMPANHA", "HISTORICO"] as Classe[]),
  ELIMINAR_SO_CONTRATO: Object.freeze(["CONTRATO", "HISTORICO"] as Classe[]),
  ANONIMIZAR_TUDO: Object.freeze(["CLIENTE", "CONTRATO", "CAMPANHA", "HISTORICO"] as Classe[]),
});

/** Tipos do information_schema conferidos pelo teste de guarda (escalares em data_type; vetores pelo udt_name). */
export const TIPOS_CONFERIDOS = Object.freeze({
  escalares: ["text", "character varying", "character", "bytea", "json", "jsonb", "inet", "USER-DEFINED"],
  vetores: ["_text", "_varchar", "_bpchar", "_jsonb", "_bytea"],
});

/** Tabela → classe → colunas separadas por espaço. Gerado do inventário do modelo 130 e revisado à mão. */
const BRUTO: Record<string, Partial<Record<Classe, string>>> = {
// <mapa>
  pre_reserva_aceites: { EMPRESA: "recebedor chave_pix", CONTRATO: "termos_aceitos", SEM_DADO_PESSOAL: "termos_versao" },
  pre_reserva_recebimentos: { CONTRATO: "end_to_end_id referencia_devolucao", SEM_DADO_PESSOAL: "encerramento" },
  aceites_documentos_legais: { EMPRESA: "documento hash_conteudo ip origem user_agent versao" },
  adicionais: { SEM_DADO_PESSOAL: "categoria codigo descricao nome observacoes unidade_cobranca" },
  adicional_categorias: { SEM_DADO_PESSOAL: "codigo nome" },
  agenda_062_bloqueios_resolucao: { EMPRESA: "decidido_por motivo" },
  agenda_062_fechamentos_resolucao: { EMPRESA: "decidido_por motivo" },
  agenda_062_unidades_habilitacao: { EMPRESA: "habilitada_papel motivo_habilitacao motivo_revogacao revogada_papel" },
  agenda_escopo_config: { SEM_DADO_PESSOAL: "capacidade_tipo modo" },
  agenda_salao_fotos: { EMPRESA: "conteudo legenda mime origem origem_sha256 sha256" },
  agenda_salao_itens: { SEM_DADO_PESSOAL: "detalhe grupo item_codigo item_proprio" },
  agenda_salao_itens_catalogo: { SEM_DADO_PESSOAL: "codigo grupo nome" },
  agenda_saloes: { SEM_DADO_PESSOAL: "exclusivos frase nome" },
  aniversariantes: { CLIENTE: "nome observacoes", SEM_DADO_PESSOAL: "tema_padrao" },
  aprovacoes_negociacao: { CONTRATO: "condicao_pagamento motivo observacoes", SEM_DADO_PESSOAL: "fechamento_revisao_hash status" },
  area_familia_aviso_empresa: { EMPRESA: "texto" },
  area_familia_avisos_pagamento: { CONTRATO: "observacao", SEM_DADO_PESSOAL: "estado" },
  area_familia_eventos: { HISTORICO: "motivo", SEM_DADO_PESSOAL: "tipo" },
  area_familia_sessoes: { CONTRATO: "aparelho motivo_revogacao", SEM_DADO_PESSOAL: "token_hash" },
  assinatura_arrependimentos: { EMPRESA: "aviso_interno canal conclusao_referencia email_conclusao email_confirmacao intermediador_referencia motivo protocolo provedor_assinatura_id restituicao_assinatura_id restituicao_cobranca_ids situacao situacao_assinatura" },
  assinatura_avisos: { EMPRESA: "estado id_externo mensagem tipo ultimo_erro" },
  assinatura_campanhas: { EMPRESA: "autorizacao codigo contagem elegibilidade estado fuso motivo_encerramento versao_regra" },
  assinatura_comprovantes: { EMPRESA: "condicoes contratante dpa_versao prestadora privacidade_versao termos_versao" },
  assinatura_contratacoes: { EMPRESA: "catalogo_versao ciclo estado motivo_cancelamento pagamento_confirmacao_id plano provedor_assinatura_id" },
  assinatura_encerramentos: { EMPRESA: "aviso_interno_situacao cancelamento_provedor ciclo cobranca_provedor_id email_situacao estorno_modo estorno_referencia estorno_situacao estorno_status_provedor forma_pagamento motivo protocolo provedor_assinatura_id regra situacao_anterior tipo" },
  assinatura_fundadores: { EMPRESA: "documento_beneficiario estado evidencia_liberacao origem pagamento_confirmacao_id regra_versao" },
  assinatura_isencoes: { EMPRESA: "documento_verificado motivo" },
  assinatura_renovacoes: { EMPRESA: "aviso_id_externo estado mensagem ultimo_erro" },
  auditoria: { HISTORICO: "dados_antes dados_depois justificativa", EMPRESA: "ip user_agent", SEM_DADO_PESSOAL: "acao ator_tipo entidade_tipo origem" },
  bloqueios_agenda: { EMPRESA: "motivo observacoes" },
  buffet_categorias: { SEM_DADO_PESSOAL: "codigo descricao nome" },
  buffet_itens: { SEM_DADO_PESSOAL: "codigo descricao nome" },
  cadastros_empresas: { EMPRESA: "documento" },
  cadastros_publicos: { EMPRESA: "email nome privacidade_hash privacidade_versao senha_hash situacao termos_hash termos_versao token_hash" },
  clientes: { CLIENTE: "bairro cep cidade cnpj complemento cpf email logradouro nome_completo nome_fantasia numero observacoes razao_social representante_cpf representante_nome rg telefone uf whatsapp", SEM_DADO_PESSOAL: "status tipo_pessoa" },
  cobranca_eventos: { EMPRESA: "assinatura_provedor_id checkout_provedor_id cobranca_provedor_id criado_no_provedor evento_id provedor referencia_externa situacao tipo ultimo_erro" },
  configuracao_agenda: { SEM_DADO_PESSOAL: "codigo nome" },
  contrato_assinaturas: { CONTRATO: "identidade_snapshot ip user_agent", SEM_DADO_PESSOAL: "autenticacao_metodo metodo parte pdf_hash provider snapshot_hash" },
  contrato_assinaturas_papel: { CONTRATO: "arquivo observacao", SEM_DADO_PESSOAL: "arquivo_sha256 arquivo_tipo payload_hash" },
  contrato_documentos: { CONTRATO: "conteudo_pdf", SEM_DADO_PESSOAL: "categoria pdf_hash snapshot_hash template_codigo" },
  contrato_edicoes: { CONTRATO: "alteracoes dados_fonte", SEM_DADO_PESSOAL: "estado tipo" },
  contrato_importacao_financeiro: { CONTRATO: "decisoes", SEM_DADO_PESSOAL: "conferido_papel payload_hash situacao" },
  contrato_importacoes: { CONTRATO: "decisoes declaracao financeiro_declarado", SEM_DADO_PESSOAL: "conferido_papel documento_sha256 payload_hash situacao_contrato" },
  contrato_pendencias_financeiras: { CONTRATO: "diferencas motivo" },
  contrato_versoes: { CONTRATO: "motivo_nova_versao snapshot", SEM_DADO_PESSOAL: "aceite_metodo documento_pdf_hash snapshot_hash status" },
  contratos: { SEM_DADO_PESSOAL: "status" },
  convite_artes: { CONTRATO: "imagem", SEM_DADO_PESSOAL: "origem" },
  convite_eventos: { HISTORICO: "detalhe", SEM_DADO_PESSOAL: "acao ator" },
  convite_familias: { CONTRATO: "nome", SEM_DADO_PESSOAL: "token_hash" },
  convite_geracoes: { CONTRATO: "falha_detalhes falha_diagnostico resolucao_evidencia resultado_pendente", SEM_DADO_PESSOAL: "ator estado falha_classe modelo payload_hash resolucao_resultado uso" },
  convite_ia_autorizacoes: { CONTRATO: "responsavel_nome responsavel_vinculo revogacao_motivo revogada_por", SEM_DADO_PESSOAL: "finalidade meio operador_tipo provedor texto_hash texto_versao" },
  convite_limites_http: { SEM_DADO_PESSOAL: "chave" },
  convite_respostas: { CONTRATO: "nome" },
  convites: { CONTRATO: "publicado rascunho", SEM_DADO_PESSOAL: "editor_hash publico_token" },
  convites_acesso: { EMPRESA: "email nome_sugerido papel status token_hash" },
  documentos_legais_versoes: { SEM_DADO_PESSOAL: "conteudo documento hash versao" },
  disponibilidade_config_legada: { SEM_DADO_PESSOAL: "conteudo origem" },
  documentos_publicos: { EMPRESA: "conteudo chave_armazenamento mime_type nome_arquivo sha256 tipo" },
  empresa_assinaturas: { EMPRESA: "ciclo documento_teste plano provedor provedor_assinatura_id provedor_cliente_id provedor_situacao situacao" },
  empresa_documento_continuidades: { EMPRESA: "condicoes documento_anterior documento_novo evidencias instrumento nome_novo provedor_nota situacao tipo" },
  empresa_excecoes_comerciais: { EMPRESA: "motivo motivo_revogacao tipo" },
  empresa_membership_capacidades: { EMPRESA: "capacidade motivo motivo_revogacao" },
  empresa_pix_recebimento: { EMPRESA: "chave cidade_recebedor nome_recebedor tipo_chave" },
  empresa_regras_pagamento: { EMPRESA: "cartao_rotulo motivo" },
  empresa_representacoes: { EMPRESA: "descricao_evidencia motivo_decisao qualificacao situacao" },
  empresa_socios: { EMPRESA: "fonte nome qualificacao" },
  empresas: { EMPRESA: "codigo nome status" },
  estabelecimentos: { EMPRESA: "codigo nome status" },
  eventos_historico_cliente: { HISTORICO: "detalhe metadata", SEM_DADO_PESSOAL: "entidade_tipo origem tipo_evento" },
  fechamento_adicionais: { CONTRATO: "observacoes", SEM_DADO_PESSOAL: "nome_aplicado unidade_cobranca_aplicada" },
  fechamento_buffet_escolhas: { SEM_DADO_PESSOAL: "categoria_nome_aplicado item_nome_aplicado" },
  fechamento_pacote_composicao: { SEM_DADO_PESSOAL: "codigo_aplicado modo_itens nome_aplicado tipo" },
  fechamento_pacote_itens_especificos: { SEM_DADO_PESSOAL: "codigo_aplicado nome_aplicado" },
  fechamento_pacote_snapshots: { CONTRATO: "motivo", SEM_DADO_PESSOAL: "categoria_horario categoria_preco_aplicada categoria_preco_linha codigo_aplicado codigo_regra_desconto descricao_aplicada nome_aplicado tabela_codigo_aplicado tabela_nome_aplicado tipo_calculo titulo_regra_desconto" },
  fechamento_revisao_adicionais: { CONTRATO: "observacoes", SEM_DADO_PESSOAL: "nome_aplicado unidade_cobranca_aplicada" },
  fechamento_revisoes: { CONTRATO: "alteracoes_pacote condicao_pagamento motivo motivo_cancelamento motivo_negociacao observacoes_cliente observacoes_equipe observacoes_negociacao tema_festa", SEM_DADO_PESSOAL: "buffet_bebidas buffet_bolo buffet_bombom buffet_doces buffet_empratado buffet_lembrancinha buffet_outros buffet_salgados buffet_status categoria_horario categoria_preco_aplicada congelado_snapshot_hash conteudo_hash estado fonte_base_hash forma_pagamento_pretendida origem" },
  fechamentos: { CONTRATO: "alteracoes_pacote condicao_pagamento motivo_negociacao observacoes_cliente observacoes_equipe observacoes_negociacao perda_motivo perda_observacao tema_festa", SEM_DADO_PESSOAL: "buffet_bebidas buffet_bolo buffet_bombom buffet_doces buffet_empratado buffet_lembrancinha buffet_outros buffet_salgados buffet_status categoria_horario categoria_preco_aplicada forma_pagamento_pretendida origem_fechamento status" },
  festa_areas: { SEM_DADO_PESSOAL: "nome" },
  festa_buffet: { SEM_DADO_PESSOAL: "bebidas bolo bombom doces empratado lembrancinha salgados" },
  festa_contagens_convidados: { CONTRATO: "motivo" },
  festa_eventos: { HISTORICO: "dados_antes dados_depois identidade_snapshot motivo", SEM_DADO_PESSOAL: "ator_tipo modulo_executor origem_iniciadora payload_hash tipo" },
  festa_links_area: { CONTRATO: "motivo_revogacao", SEM_DADO_PESSOAL: "token_hash" },
  festa_membership_capacidades: { EMPRESA: "capacidade motivo motivo_revogacao" },
  festa_pendencias: { CONTRATO: "descricao", SEM_DADO_PESSOAL: "categoria estado natureza prioridade" },
  festa_pendencias_familia: { CONTRATO: "texto" },
  festa_pessoas: { CONTRATO: "documento_hash email nome whatsapp", SEM_DADO_PESSOAL: "papel" },
  festa_solicitacoes: { CONTRATO: "conteudo_solicitado descricao motivo_cancelamento", SEM_DADO_PESSOAL: "tipo" },
  festa_tarefas: { CONTRATO: "descricao titulo", SEM_DADO_PESSOAL: "categoria estado prioridade" },
  festa_usuario_capacidades: { EMPRESA: "capacidade motivo motivo_revogacao" },
  festas: { CONTRATO: "motivo_invalidacao", SEM_DADO_PESSOAL: "origem_criacao payload_hash" },
  financeiro_abertura_conferencias: { EMPRESA: "atributos_hash chave_idempotencia modo origem_tipo" },
  financeiro_aberturas: { EMPRESA: "chave_idempotencia conjunto_hash justificativa" },
  financeiro_auditoria: { EMPRESA: "acao detalhe entidade" },
  financeiro_categorias: { EMPRESA: "nome tipo" },
  financeiro_contas_pagar: { EMPRESA: "chave_criacao descricao favorecido forma observacao" },
  financeiro_entradas_liquidacoes: { EMPRESA: "chave_idempotencia forma observacao" },
  financeiro_entradas_manuais: { EMPRESA: "chave_criacao contraparte descricao forma observacao" },
  financeiro_recorrencias: { EMPRESA: "chave_idempotencia periodicidade" },
  financeiro_saidas: { EMPRESA: "chave_idempotencia forma observacao" },
  financeiro_saidas_reversoes: { EMPRESA: "chave_idempotencia motivo" },
  ia_credito_carteiras: { EMPRESA: "recurso" },
  ia_credito_cobrancas: { EMPRESA: "ambiente conta disputa forma_provedor pagamento_id provedor referencia_externa retencao_motivo revisao_motivo situacao_provedor url_fatura" },
  ia_credito_cortes: { EMPRESA: "recurso referencia_autorizacao" },
  ia_credito_cortesias: { EMPRESA: "campanha motivo protocolo recurso" },
  ia_credito_devolucoes: { EMPRESA: "estado forma modo origem protocolo referencia regra status_provedor tipo" },
  ia_credito_franquia_pendencias: { EMPRESA: "ultimo_motivo" },
  ia_credito_franquias_ciclo: { EMPRESA: "chave historico recurso tipo versao_tabela" },
  ia_credito_lancamentos: { EMPRESA: "ator operacao protocolo recurso tipo" },
  ia_credito_lotes: { EMPRESA: "chave_origem origem recurso" },
  ia_credito_notificacoes: { EMPRESA: "dedupe protocolo situacao tipo" },
  ia_credito_pedidos: { EMPRESA: "ambiente catalogo_versao estado forma oferta oferta_codigo payload_sha256 protocolo recurso revisao_motivo termos_sha256 termos_versao" },
  ia_credito_reserva_lotes: { EMPRESA: "recurso" },
  ia_credito_reservas: { EMPRESA: "estado operacao_id recurso versao_precos" },
  ia_documento_originais: { CONTRATO: "conteudo nome_original", SEM_DADO_PESSOAL: "content_type sha256" },
  ia_documentos: { SEM_DADO_PESSOAL: "status tipo" },
  ia_evidencias: { CONTRATO: "trecho", SEM_DADO_PESSOAL: "campo" },
  ia_extracoes: { CONTRATO: "erro resultado", SEM_DADO_PESSOAL: "correlation_id metodo modelo provedor status" },
  ia_importacao_usos: { SEM_DADO_PESSOAL: "estado periodo sha256" },
  ia_importacoes: { CONTRATO: "dados resultado", SEM_DADO_PESSOAL: "status" },
  ia_operacoes: { HISTORICO: "payload resultado", SEM_DADO_PESSOAL: "capacidade correlation_id estado ferramenta payload_hash" },
  ia_orcamento_reservas: { SEM_DADO_PESSOAL: "capacidade correlation_id estado moeda periodo_mes" },
  ia_skills: { SEM_DADO_PESSOAL: "definicao hash nivel skill_id status versao" },
  ia_uso_modelo: { SEM_DADO_PESSOAL: "capacidade correlation_id erro modelo moeda periodo_mes provedor tier workload" },
  importacoes_comerciais: { EMPRESA: "arquivo_bytes arquivo_nome arquivo_sha256 avisos leitura metodo modelo provedor resultado revisao situacao tipo" },
  kidmais107_reparos: { SEM_DADO_PESSOAL: "acao definicao nome_anterior nome_novo tabela" },
  limites_autenticacao: { SEM_DADO_PESSOAL: "chave_hash tipo" },
  limites_contadores: { SEM_DADO_PESSOAL: "chave" },
  marketing_atribuicoes: { CAMPANHA: "detalhe motivo", SEM_DADO_PESSOAL: "alvo_tipo canal_atendimento metodo origem_codigo utm" },
  marketing_automacao_eventos: { HISTORICO: "detalhe", SEM_DADO_PESSOAL: "estado_anterior estado_novo" },
  marketing_automacao_execucoes: { CAMPANHA: "conteudo destinatario_mascarado motivo", SEM_DADO_PESSOAL: "acao alvo_tipo chave_idempotencia estado provedor_mensagem_id" },
  marketing_automacao_regras: { EMPRESA: "acao canais fuso status template_lembrete_provedor template_lembrete_texto template_provedor template_texto tipo" },
  marketing_campanhas: { EMPRESA: "canal codigo nome objetivo origem_codigo status utm_medium utm_source" },
  marketing_contato_autorizacoes: { CAMPANHA: "confirmacao destino evidencia motivo_revogacao", SEM_DADO_PESSOAL: "canal estado origem" },
  marketing_contato_preferencias: { CAMPANHA: "observacao", SEM_DADO_PESSOAL: "descadastro_origem" },
  marketing_contato_preferencias_eventos: { CAMPANHA: "observacao", SEM_DADO_PESSOAL: "origem" },
  marketing_contatos: { CAMPANHA: "email mensagem nome perda_motivo perda_observacao telefone", SEM_DADO_PESSOAL: "canal_atendimento chave_idempotencia status vinculo_cliente" },
  marketing_dns_simulado: { EMPRESA: "host nome tipo valor" },
  marketing_dominios: { EMPRESA: "host provedor status token_verificacao ultima_verificacao" },
  marketing_eventos: { SEM_DADO_PESSOAL: "tipo" },
  marketing_membership_capacidades: { EMPRESA: "capacidade motivo motivo_revogacao" },
  marketing_origens_opcoes: { SEM_DADO_PESSOAL: "codigo rotulo" },
  marketing_saidas_contato: { PRESERVAR_SAIDA: "valor", SEM_DADO_PESSOAL: "motivo_encerramento origem tipo" },
  marketing_site_imagens: { EMPRESA: "conteudo descricao mime sha256" },
  marketing_site_versoes: { EMPRESA: "conteudo" },
  marketing_sites: { EMPRESA: "estado rascunho slug" },
  marketing_tarefas: { EMPRESA: "descricao status titulo" },
  marketing_transporte_simulado: { CAMPANHA: "destinatario_mascarado texto", SEM_DADO_PESSOAL: "idempotencia provedor_mensagem_id status template_provedor" },
  mcp_auditoria: { EMPRESA: "capacidade client_id codigo evento resultado" },
  mcp_oauth_clientes: { EMPRESA: "client_id nome redirect_uris" },
  mcp_oauth_codigos: { EMPRESA: "code_challenge codigo_hash redirect_uri" },
  mcp_oauth_concessoes: { EMPRESA: "client_id cliente_nome escopos motivo_revogacao recurso redirect_uri" },
  mcp_oauth_pedidos: { EMPRESA: "chave_hash client_id cliente_nome code_challenge escopos recurso redirect_uri state" },
  mcp_oauth_tokens: { EMPRESA: "escopos tipo token_hash" },
  membership_estabelecimentos: { EMPRESA: "status" },
  memberships: { EMPRESA: "papel status" },
  mesclagens_clientes: { HISTORICO: "motivo resolucao_campos" },
  modelos_contrato_empresa: { EMPRESA: "conteudo conteudo_sha256 situacao" },
  operacional_parametros_consumo: { SEM_DADO_PESSOAL: "arredondamento base categoria distribuicao origem" },
  oportunidades_acoes: { CAMPANHA: "observacao resultado", SEM_DADO_PESSOAL: "tipo" },
  oportunidades_marcos: { SEM_DADO_PESSOAL: "etapa" },
  oportunidades_resumos: { CAMPANHA: "mensagem", SEM_DADO_PESSOAL: "estado" },
  pacote_adicionais: { SEM_DADO_PESSOAL: "modalidade" },
  pacote_buffet_categorias: { SEM_DADO_PESSOAL: "modo_itens" },
  pacotes: { SEM_DADO_PESSOAL: "codigo descricao nome" },
  pagamento_ajustes_contratuais: { CONTRATO: "decisao_contratante justificativa tratamento_saldo" },
  pagamento_comprovantes: { CONTRATO: "localizador_arquivo nome_arquivo", SEM_DADO_PESSOAL: "mime_type sha256" },
  pagamento_credito_reservas: { SEM_DADO_PESSOAL: "estado" },
  pagamento_cronograma_itens: { SEM_DADO_PESSOAL: "origem" },
  pagamento_cronogramas: { SEM_DADO_PESSOAL: "estado modo" },
  pagamento_devolucao_comprovantes: { CONTRATO: "conteudo nome_arquivo", SEM_DADO_PESSOAL: "mime_type sha256" },
  pagamento_devolucoes: { CONTRATO: "beneficiario_snapshot justificativa_sem_comprovante motivo observacao_execucao", SEM_DADO_PESSOAL: "estado meio_devolucao provedor_codigo referencia_externa" },
  pagamento_estornos: { CONTRATO: "metadata_provedor motivo", SEM_DADO_PESSOAL: "chave_idempotencia provedor_codigo referencia_externa status" },
  pagamento_eventos: { HISTORICO: "dados_antes dados_depois identidade_snapshot ip justificativa user_agent", SEM_DADO_PESSOAL: "ator_tipo pedido_hash resultado tipo" },
  pagamento_movimentos_contextos: { CONTRATO: "identidade_economica_snapshot" },
  pagamento_parcelas: { SEM_DADO_PESSOAL: "status" },
  pagamento_planos: { CONTRATO: "motivo_substituicao observacoes", SEM_DADO_PESSOAL: "meio_pagamento modalidade provedor_preferido status" },
  pagamento_recebimentos: { CONTRATO: "metadata_provedor observacoes", SEM_DADO_PESSOAL: "chave_idempotencia meio_pagamento provedor_codigo referencia_externa status" },
  pagamento_tratamentos: { CONTRATO: "motivo_encerramento", SEM_DADO_PESSOAL: "estado posicao_base_hash" },
  pagamentos: { SEM_DADO_PESSOAL: "moeda reserva_status status" },
  perfil_empresa_concessoes: { EMPRESA: "capacidade motivo motivo_revogacao referencia_autorizacao" },
  perfil_empresa_revisoes: { EMPRESA: "conteudo estado motivo" },
  perfil_empresas: { EMPRESA: "cnpj codigo nome_comercial razao_social sede_bairro sede_cep sede_cidade sede_complemento sede_logradouro sede_numero sede_pais sede_uf" },
  perfil_unidades: { EMPRESA: "bairro cep cidade codigo complemento email_comercial instagram logradouro nome numero pais referencia_chegada site telefone uf whatsapp" },
  plataforma_desenvolvedores: { EMPRESA: "concedido_por motivo motivo_revogacao revogado_por" },
  plataforma_empresas_cadastro: { EMPRESA: "documento_fiscal email implantacao nome_empresarial observacoes responsavel_nome telefone" },
  plataforma_interessadas: { EMPRESA: "documento_fiscal email nome nome_empresarial observacoes responsavel_nome status telefone" },
  possiveis_duplicidades_cliente: { CLIENTE: "motivos observacoes", SEM_DADO_PESSOAL: "status" },
  precos_adicional: { SEM_DADO_PESSOAL: "observacoes" },
  precos_pacote: { SEM_DADO_PESSOAL: "categoria_horario observacoes tipo_calculo" },
  recuperacoes_senha: { EMPRESA: "origem token_hash" },
  regras_categoria_horario: { SEM_DADO_PESSOAL: "categoria_horario observacoes" },
  regras_desconto_pacote: { SEM_DADO_PESSOAL: "base_calculo codigo observacoes titulo" },
  regras_disponibilidade_pacote: { SEM_DADO_PESSOAL: "estado observacoes" },
  responsaveis_adicionais: { CLIENTE: "cpf email nome observacoes relacao telefone whatsapp" },
  satisfacao_agregados_mensais: { SEM_DADO_PESSOAL: "periodo" },
  satisfacao_auditoria: { EMPRESA: "acao url_anterior url_nova" },
  satisfacao_capacidades: { EMPRESA: "capacidade" },
  satisfacao_email_simulado: { CAMPANHA: "assunto para_mascarado texto", SEM_DADO_PESSOAL: "idempotencia provedor_mensagem_id" },
  satisfacao_entregas: { CAMPANHA: "conteudo destinatario_mascarado motivo", SEM_DADO_PESSOAL: "canal estado etapa provedor_mensagem_id" },
  satisfacao_envios: { CAMPANHA: "motivo_revogacao", SEM_DADO_PESSOAL: "estado token_hash" },
  satisfacao_expurgos: { SEM_DADO_PESSOAL: "estado" },
  satisfacao_links_avaliacao: { EMPRESA: "url" },
  satisfacao_respostas: { CAMPANHA: "comentario" },
  satisfacao_saidas: { SEM_DADO_PESSOAL: "origem" },
  satisfacao_tarefas: { CAMPANHA: "observacao", SEM_DADO_PESSOAL: "estado" },
  sessoes_administrativas: { EMPRESA: "csrf_hash ip token_hash user_agent" },
  solicitacoes_acesso_empresa: { EMPRESA: "documento motivo_decisao situacao" },
  tabela_preco_escopos: { SEM_DADO_PESSOAL: "categoria_horario" },
  tabelas_preco: { SEM_DADO_PESSOAL: "codigo nome observacoes" },
  usuarios_administrativos: { EMPRESA: "cargo email nome papel senha_hash" },
  validacoes_identidade_cliente: { SEM_DADO_PESSOAL: "canal codigo_hash finalidade status token_prova_hash" },
  whatsapp_atendimento_arquivos: { CAMPANHA: "conteudo nome", SEM_DADO_PESSOAL: "ambiente mime sha256 tipo token" },
  whatsapp_atendimento_auditoria: { SEM_DADO_PESSOAL: "acao ambiente" },
  whatsapp_atendimento_config: { EMPRESA: "ambiente configuracao" },
  whatsapp_atendimento_controles_contato: { CAMPANHA: "contato", SEM_DADO_PESSOAL: "ambiente" },
  whatsapp_atendimento_conversas: { CAMPANHA: "contato contexto interesse nome_perfil passagem", SEM_DADO_PESSOAL: "ambiente estado" },
  whatsapp_atendimento_eventos_excluidos: { SEM_DADO_PESSOAL: "ambiente evento_sha256 provedor" },
  whatsapp_atendimento_mensagens: { CAMPANHA: "midia_nome midia_url texto", SEM_DADO_PESSOAL: "ambiente direcao estado externa_id fonte midia_tipo motivo_cancelamento provedor_id" },
  whatsapp_atendimento_mensagens_prontas: { EMPRESA: "ambiente atalho categoria estado finalidade link midia_url pacote_codigo texto tipo titulo" },
  whatsapp_atendimento_mensagens_prontas_favoritas: { EMPRESA: "ambiente" },
  whatsapp_atendimento_privacidade: { HISTORICO: "motivo", SEM_DADO_PESSOAL: "acao ambiente origem" },
  whatsapp_atendimento_retencao_config: { SEM_DADO_PESSOAL: "ambiente" },
  whatsapp_atendimento_retencao_execucoes: { SEM_DADO_PESSOAL: "ambiente erros estado por_empresa" },
  whatsapp_atendimento_rodizio: { SEM_DADO_PESSOAL: "ambiente" },
  whatsapp_atendimento_status: { SEM_DADO_PESSOAL: "ambiente estado provedor_id" },
  whatsapp_atendimento_status_colisoes: { SEM_DADO_PESSOAL: "ambiente provedor_id" },
  whatsapp_conexoes: { EMPRESA: "ambiente business_id credencial_cifrada credencial_iv credencial_tag escopos meta_app_id motivo_desconexao nome_verificado numero_exibicao phone_number_id status token_tipo waba_id" },
  whatsapp_onboarding_tentativas: { EMPRESA: "ambiente business_id erro_codigo phone_number_id state_hash status waba_id" },
// </mapa>
};

export const MAPA: Readonly<Record<string, Readonly<Record<string, Classe>>>> = Object.freeze(Object.fromEntries(
  Object.entries(BRUTO).map(([tabela, grupos]) => [tabela, Object.freeze(Object.fromEntries(
    (Object.entries(grupos) as [Classe, string][]).flatMap(([classe, cols]) => cols.split(" ").map((c) => [c, classe])),
  ))]),
));

/** Colunas por classe, para a fase 4 e para a simulação contarem o que cada medida alcança. */
export function colunasDaClasse(classe: Classe): { tabela: string; coluna: string }[] {
  return Object.entries(MAPA).flatMap(([tabela, cs]) => Object.entries(cs).filter(([, k]) => k === classe).map(([coluna]) => ({ tabela, coluna })));
}

/** Confere o mapa contra o inventário do banco: faltam = colunas sem classe; sobram = citadas no mapa sem existir. */
export function conferirMapa(colunas: { tabela: string; coluna: string }[]) {
  const existe = new Set(colunas.map((c) => `${c.tabela}.${c.coluna}`));
  const faltam = colunas.filter((c) => !MAPA[c.tabela]?.[c.coluna]).map((c) => `${c.tabela}.${c.coluna}`);
  const sobram = Object.entries(MAPA).flatMap(([t, cs]) => Object.keys(cs).map((c) => `${t}.${c}`)).filter((k) => !existe.has(k));
  return { faltam, sobram };
}
