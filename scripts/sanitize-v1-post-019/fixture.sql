-- B5B-2B: fixture exclusivamente sintética. Nenhum valor veio de banco, dump ou clone.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO usuarios_administrativos
  (id,email,nome,cargo,senha_hash,papel,criado_em,atualizado_em,senha_alterada_em)
VALUES
  ('bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','admin-fixture@example.invalid',
   'SINTETICO_USUARIO_001','TESTE_DESCARTAVEL',
   'scrypt$v=1$N=131072$r=8$p=1$AAAAAAAAAAAAAAAAAAAAAA==$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==',
   'REPRESENTANTE_AUTORIZADO','2030-01-02 11:50:00+00','2030-01-02 11:50:00+00','2030-01-02 11:50:00+00');

INSERT INTO sessoes_administrativas
  (id,usuario_id,token_hash,csrf_hash,criado_em,autenticado_em,ultima_atividade_em,expira_em,ip,user_agent)
VALUES
  ('771e6378-ad5e-5213-aae7-d15002dabf36','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7',
   repeat('a',64),repeat('b',64),'2030-01-02 11:50:00+00','2030-01-02 12:00:00+00',
   '2030-01-02 12:00:00+00','2030-01-02 13:00:00+00','192.0.2.10','SYNTHETIC_AGENT');

INSERT INTO limites_autenticacao
  (chave_hash,tipo,tentativas,janela_iniciada_em,atualizado_em)
VALUES (repeat('c',64),'IDENTIFICADOR',1,'2030-01-02 11:55:00+00','2030-01-02 12:00:00+00');

INSERT INTO clientes
  (id,nome_completo,cpf,telefone,whatsapp,email,cep,logradouro,numero,complemento,bairro,cidade,uf,rg,
   observacoes,criado_por_usuario_id,atualizado_por_usuario_id)
VALUES
  ('87f9dcfd-0651-5e6a-a3ab-cae8919cedad','SINTETICO_SANITIZER_CLIENTE_001','00000000000',
   '5500000000000','5500000000000','sanitizer-fixture@example.invalid','00000000','RUA SINTETICA','0',
   'SEM VALIDADE','BAIRRO SINTETICO','CIDADE SINTETICA','DF','RG-SINTETICO','SYNTHETIC_PRIVATE_CANARY_019',
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');

INSERT INTO responsaveis_adicionais
  (id,cliente_id,nome,cpf,telefone,whatsapp,email,relacao,observacoes,criado_por_usuario_id,atualizado_por_usuario_id)
VALUES
  ('ab3abcc6-25e5-5fa3-a1be-115b13fcdf26','87f9dcfd-0651-5e6a-a3ab-cae8919cedad',
   'SINTETICO_RESPONSAVEL_001','11111111111','5511111111111','5511111111111','responsavel@example.invalid',
   'SINTETICO','CAMPO LIVRE SINTETICO','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');

INSERT INTO aniversariantes
  (id,cliente_id,nome,data_nascimento,tema_padrao,observacoes,criado_por_usuario_id,atualizado_por_usuario_id)
VALUES
  ('481608e1-7a0d-5100-a013-837056da6148','87f9dcfd-0651-5e6a-a3ab-cae8919cedad',
   'SINTETICO_ANIVERSARIANTE_001','2020-01-02','TEMA SINTETICO','SEM DADO REAL',
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');

INSERT INTO fechamentos
  (id,cliente_id,aniversariante_id,responsavel_adicional_id,data_evento,horario_inicio,horario_fim,
   configuracao_agenda_id,pacote_id,tabela_preco_id,preco_pacote_id,categoria_horario,categoria_preco_aplicada,
   convidados,convidados_faturados,valor_pacote_base,desconto_percentual,valor_desconto_pacote,
   valor_pacote_aplicado,valor_adicionais,valor_tabela,status,origem_fechamento,iniciado_por_usuario_id,
   usuario_responsavel_id,observacoes_equipe,buffet_status,idade_aniversariante_evento,tema_festa,
   forma_pagamento_pretendida,alteracoes_pacote,observacoes_cliente,buffet_salgados,buffet_bebidas,
   buffet_doces,buffet_bolo,buffet_outros,condicao_pagamento,buffet_lembrancinha,buffet_empratado,buffet_bombom)
SELECT
  '689a441e-fb29-5e97-aa6f-ca2b356aedcb','87f9dcfd-0651-5e6a-a3ab-cae8919cedad',
  '481608e1-7a0d-5100-a013-837056da6148','ab3abcc6-25e5-5fa3-a1be-115b13fcdf26',
  '2030-01-04','11:00','15:00',ca.id,p.id,tp.id,pp.id,'PADRAO','GERAL',20,20,3800,0,0,3800,0,3800,
  'CONFIRMADO','ATENDIMENTO_KIDMAIS','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7',
  'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','EQUIPE SINTETICA','DEFINIDO',11,'TEMA SINTETICO',
  'PIX_AVISTA','ALTERACAO SINTETICA','OBSERVACAO SINTETICA','SALGADOS SINTETICOS','BEBIDAS SINTETICAS',
  'DOCES SINTETICOS','BOLO SINTETICO','OUTROS SINTETICOS','{"schemaVersao":1,"forma":"PIX_AVISTA","revisaoStatus":"DISPENSADA","sintetico":true}'::jsonb,
  'LEMBRANCINHA SINTETICA','EMPRATADO SINTETICO','BOMBOM SINTETICO'
FROM configuracao_agenda ca
JOIN pacotes p ON p.codigo='POCKET'
JOIN tabelas_preco tp ON tp.codigo='COMERCIAL_2026_09'
JOIN precos_pacote pp ON pp.tabela_preco_id=tp.id AND pp.pacote_id=p.id
 AND pp.categoria_horario='GERAL' AND pp.convidados_min<=20 AND pp.convidados_max>=20
WHERE ca.codigo='TURNO_1';

INSERT INTO contratos
  (id,fechamento_id,status,versao_atual,criado_por_usuario_id,assinado_em)
VALUES
  ('49b5f13b-3cc2-50ed-a5a1-cdc81eaca382','689a441e-fb29-5e97-aa6f-ca2b356aedcb','ASSINADO',1,
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','2030-01-02 12:03:00+00');

INSERT INTO contrato_versoes
  (id,contrato_id,numero_versao,status,snapshot_schema_versao,snapshot,snapshot_hash,gerado_por_usuario_id,
   assinado_em,documento_template_versao,documento_pdf_hash,aceite_metodo)
VALUES
  ('ef9bb759-4235-5978-a05a-842a7a6136b6','49b5f13b-3cc2-50ed-a5a1-cdc81eaca382',1,'ASSINADA',1,
   '{"schemaVersao":1,"comercial":{"valorFinalContrato":3800,"formaPagamentoPretendida":"PIX_AVISTA"},"sintetico":true}'::jsonb,
   repeat('1',64),'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','2030-01-02 12:03:00+00',1,
   '7b0a05d4504319e84db39a3f3747ca3083caf3084e0805dc202626aaf0c8f1f0','OTP');

INSERT INTO contrato_fluxos (contrato_id,versao_vigente_id)
VALUES ('49b5f13b-3cc2-50ed-a5a1-cdc81eaca382','ef9bb759-4235-5978-a05a-842a7a6136b6');

INSERT INTO contrato_documentos
  (id,contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,pdf_hash,
   tamanho_bytes,conteudo_pdf,gerado_por_usuario_id)
VALUES
  ('1a8c8069-85a4-5688-a6e6-54f15f0d4760','ef9bb759-4235-5978-a05a-842a7a6136b6','CONTRATO',1,repeat('1',64),
   'SINTETICO',1,'7b0a05d4504319e84db39a3f3747ca3083caf3084e0805dc202626aaf0c8f1f0',27,
   decode('255044462d312e342053594e54484554494320434f4e5452414354','hex'),'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7'),
  ('cb20f9f4-7b3e-50ea-aa41-919eb8f8e802','ef9bb759-4235-5978-a05a-842a7a6136b6','COMPROVANTE_ASSINATURA',1,repeat('1',64),
   'SINTETICO',1,'a260d583c14f78934b3cd15884cc06d7df3b424b4a297a5f7bb217cc914c6483',27,
   decode('53594e544845544943205349474e4154555245204b49444d414953','hex'),NULL),
  ('d8c61f27-ebc2-53b9-a59d-6ea22935c1c9','ef9bb759-4235-5978-a05a-842a7a6136b6','COMPROVANTE_ASSINATURA',2,repeat('1',64),
   'SINTETICO',1,'873ba84b43f7dc89dfb04253348cf60b167a515983a71432c0cad12e0dd90000',26,
   decode('53594e544845544943205349474e415455524520434c49454e54','hex'),NULL);

INSERT INTO contrato_edicoes
  (contrato_versao_id,contrato_id,tipo,estado,revisao,dados_fonte,alteracoes,revisao_comercial_aprovada,
   aprovado_comercial_por_usuario_id,aprovado_comercial_em,documento_revisado_id,revisado_por_usuario_id,
   revisado_em,liberado_por_usuario_id,liberado_em,criado_por_usuario_id,atualizado_por_usuario_id)
VALUES
  ('ef9bb759-4235-5978-a05a-842a7a6136b6','49b5f13b-3cc2-50ed-a5a1-cdc81eaca382','INICIAL','CONCLUIDA',1,
   '{"schemaVersao":1,"sintetico":true}'::jsonb,'{"campos":["sintetico"]}'::jsonb,1,
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','2030-01-02 12:00:00+00','1a8c8069-85a4-5688-a6e6-54f15f0d4760',
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','2030-01-02 12:00:30+00','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7',
   '2030-01-02 12:01:30+00','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');

INSERT INTO validacoes_identidade_cliente
  (id,cliente_id,finalidade,canal,status,codigo_hash,tentativas,max_tentativas,envios,max_envios,ultimo_envio_em,
   codigo_expira_em,confirmado_em,token_prova_hash,prova_expira_em,consumido_em,consumido_por_contrato_versao_id,
   criado_em,atualizado_em)
VALUES
  ('9d21b287-aa27-5a27-a8ba-41203e548071','87f9dcfd-0651-5e6a-a3ab-cae8919cedad','CONTRATO_ACEITE','WHATSAPP','CONSUMIDA',
   repeat('d',64),1,5,1,3,'2030-01-02 11:55:00+00','2030-01-02 12:30:00+00','2030-01-02 12:00:00+00',
   repeat('e',64),'2030-01-02 13:00:00+00','2030-01-02 12:02:00+00','ef9bb759-4235-5978-a05a-842a7a6136b6',
   '2030-01-02 11:50:00+00','2030-01-02 12:02:00+00');

INSERT INTO contrato_assinaturas
  (id,contrato_versao_id,parte,documento_id,usuario_id,sessao_id,autenticacao_metodo,autenticado_em,
   validacao_identidade_id,identidade_snapshot,snapshot_hash,pdf_hash,metodo,provider,assinado_em,ip,user_agent,
   request_id,chave_idempotencia,comprovante_documento_id)
VALUES
  ('04b9cf1c-4307-58c6-a227-f0b639650950','ef9bb759-4235-5978-a05a-842a7a6136b6','KIDMAIS',
   '1a8c8069-85a4-5688-a6e6-54f15f0d4760','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','771e6378-ad5e-5213-aae7-d15002dabf36',
   'SENHA','2030-01-02 12:00:00+00',NULL,
   '{"usuarioId":"bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7","papel":"REPRESENTANTE_AUTORIZADO","nome":"SINTETICO_USUARIO_001","cargo":"TESTE_DESCARTAVEL"}'::jsonb,
   repeat('1',64),'7b0a05d4504319e84db39a3f3747ca3083caf3084e0805dc202626aaf0c8f1f0',
   'SESSAO_REAUTENTICADA','INTERNAL','2030-01-02 12:01:00+00','192.0.2.10','SYNTHETIC_AGENT',
   '26279c1c-346b-512f-aa74-46f0a485123d','c22e5597-c68b-5c6e-a244-c1b22cba83e0','cb20f9f4-7b3e-50ea-aa41-919eb8f8e802'),
  ('1a826e89-e625-561f-a789-a7a93e1b9aee','ef9bb759-4235-5978-a05a-842a7a6136b6','CLIENTE',
   '1a8c8069-85a4-5688-a6e6-54f15f0d4760',NULL,NULL,NULL,NULL,'9d21b287-aa27-5a27-a8ba-41203e548071',
   '{"ator":"CLIENTE_SINTETICO","prova":"OTP"}'::jsonb,repeat('1',64),
   '7b0a05d4504319e84db39a3f3747ca3083caf3084e0805dc202626aaf0c8f1f0','OTP','INTERNAL',
   '2030-01-02 12:03:00+00','192.0.2.11','SYNTHETIC_AGENT','dde14c76-8700-5f3a-a090-1a2b41747bef',
   '9cab75f0-c8a4-5a73-aaeb-1fdef59b190c','d8c61f27-ebc2-53b9-a59d-6ea22935c1c9');

INSERT INTO festas
  (id,contrato_id,versao_contratual_criacao_id,revisao,chave_criacao,payload_hash,criado_por,origem_criacao)
VALUES
  ('94c160f2-0c69-5346-a954-2ba9d6aafbba','49b5f13b-3cc2-50ed-a5a1-cdc81eaca382',
   'ef9bb759-4235-5978-a05a-842a7a6136b6',1,'a5b6985c-642c-5072-a727-25ea4643ceaf',repeat('2',64),NULL,'AUTOMATICA_FORMALIZACAO');

INSERT INTO festa_buffet
  (festa_id,salgados,doces,bolo,bebidas,lembrancinha,empratado,bombom,versao_contratual_id,atualizado_por)
VALUES
  ('94c160f2-0c69-5346-a954-2ba9d6aafbba','SALGADOS SINTETICOS','DOCES SINTETICOS','BOLO SINTETICO',
   'BEBIDAS SINTETICAS','LEMBRANCINHA SINTETICA','EMPRATADO SINTETICO','BOMBOM SINTETICO',
   'ef9bb759-4235-5978-a05a-842a7a6136b6','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');

INSERT INTO festa_contagens_convidados
  (id,festa_id,total_presentes,observado_em,versao_contratual_id,convidados_contratados,criado_por,chave_idempotencia)
VALUES
  ('d42ac029-8af6-53bf-a70e-5df886d1d65e','94c160f2-0c69-5346-a954-2ba9d6aafbba',20,
   '2030-01-04 14:00:00+00','ef9bb759-4235-5978-a05a-842a7a6136b6',20,
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','ef3124f5-d538-5edb-a55f-72e18c5c5c15');

INSERT INTO festa_eventos
  (id,festa_id,tipo,entidade_id,usuario_id,identidade_snapshot,origem_iniciadora,modulo_executor,
   request_id,chave_idempotencia,payload_hash,versao_contratual_id,dados_antes,dados_depois,motivo,ator_tipo)
VALUES
  ('95aa796c-6405-5f6e-a4cc-2aeebedd32d2','94c160f2-0c69-5346-a954-2ba9d6aafbba','FESTA_CRIADA',
   '94c160f2-0c69-5346-a954-2ba9d6aafbba',NULL,'{"ator":"SISTEMA","origem":"FIXTURE_SINTETICA"}'::jsonb,
   'SISTEMA','FESTA','2b96b7fa-36e5-5267-a7ed-127d613937f6','f272d073-20eb-5bb7-a6ea-a8bb9cf5f35e',
   repeat('3',64),'ef9bb759-4235-5978-a05a-842a7a6136b6',NULL,
   '{"estado":"CRIADA","sintetico":true,"campoLivre":"SYNTHETIC_PRIVATE_CANARY_JSON"}'::jsonb,
   'FORMALIZACAO SINTETICA','SISTEMA');

INSERT INTO pagamentos
  (id,contrato_versao_id,valor_total_contratado,status,reserva_status,reserva_confirmada_em,criado_por_usuario_id)
VALUES
  ('2f1f743c-b263-5a39-ae7e-81c465238f03','ef9bb759-4235-5978-a05a-842a7a6136b6',3800,'PARCIALMENTE_PAGO',
   'CONFIRMADA','2030-01-02 12:04:00+00','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');
INSERT INTO pagamento_planos
  (id,pagamento_id,numero_versao,status,meio_pagamento,modalidade,quantidade_parcelas,provedor_preferido,observacoes,criado_por_usuario_id)
VALUES
  ('0fd7812c-aad8-5342-a9e2-79f8d769247f','2f1f743c-b263-5a39-ae7e-81c465238f03',1,'ATIVO','PIX','AVISTA',1,
   'SINTETICO','PLANO SINTETICO','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');
INSERT INTO pagamento_parcelas
  (id,plano_id,numero,valor_previsto,vencimento,confirma_reserva,status)
VALUES
  ('ac48869b-2a42-5459-a1a7-4cfac1f8a8c5','0fd7812c-aad8-5342-a9e2-79f8d769247f',1,3800,'2030-01-10',true,'PARCIALMENTE_PAGA');
INSERT INTO pagamento_recebimentos
  (id,pagamento_id,status,meio_pagamento,valor_bruto,recebido_em,confirmado_em,provedor_codigo,
   referencia_externa,chave_idempotencia,metadata_provedor,registrado_por_usuario_id,observacoes)
VALUES
  ('7cfa928b-cece-5b79-ad1d-88cf8046df0e','2f1f743c-b263-5a39-ae7e-81c465238f03','CONFIRMADO','PIX',50,
   '2030-01-02 12:04:00+00','2030-01-02 12:04:00+00','SYNTHETIC','SYNTHETIC-REFERENCE',
   'SYNTHETIC-IDEMPOTENCY','{"provider":"SYNTHETIC","token":"ARTIFICIAL_ONLY"}'::jsonb,
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','RECEBIMENTO SINTETICO');
INSERT INTO pagamento_recebimento_alocacoes (id,recebimento_id,parcela_id,valor_alocado)
VALUES
  ('97fc51e2-b742-5138-a24b-909311f642f6','7cfa928b-cece-5b79-ad1d-88cf8046df0e',
   'ac48869b-2a42-5459-a1a7-4cfac1f8a8c5',50);

-- Malha 015: gestão, eventos sequenciados, autoria econômica e cronograma coerente.
INSERT INTO pagamento_gestoes (pagamento_id,contrato_id,sequencia)
VALUES ('2f1f743c-b263-5a39-ae7e-81c465238f03','49b5f13b-3cc2-50ed-a5a1-cdc81eaca382',0);
INSERT INTO pagamento_eventos
  (id,pagamento_id,sequencia,tipo,chave_idempotencia,pedido_hash,usuario_id,ator_tipo,
   identidade_snapshot,request_id,dados_antes,dados_depois,resultado)
VALUES
  ('8d6aa77f-e375-5905-9e27-a179c1450a11','2f1f743c-b263-5a39-ae7e-81c465238f03',1,
   'RECEBIMENTO_CONFIRMADO','6dc0e6e5-48da-54fa-962d-fd64dd01e23c',repeat('5',64),
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','USUARIO','{"sintetico":true}'::jsonb,
   'bc9ea18a-86a9-5c21-b196-e7fb0371247c','{}'::jsonb,'{"recebido":50}'::jsonb,'{"ok":true}'::jsonb),
  ('65fd4e40-d15b-553e-a145-92221befd1fd','2f1f743c-b263-5a39-ae7e-81c465238f03',2,
   'CRONOGRAMA_REPROGRAMADO','59cad5f0-dc61-5c31-87f0-2863498996a8',repeat('6',64),
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','USUARIO','{"sintetico":true}'::jsonb,
   'fbc91be4-2f54-53ed-8c94-1817dd25cc19','{}'::jsonb,'{"cronograma":"SINTETICO"}'::jsonb,'{"ok":true}'::jsonb);
UPDATE pagamento_gestoes SET sequencia=1 WHERE pagamento_id='2f1f743c-b263-5a39-ae7e-81c465238f03';
UPDATE pagamento_gestoes SET sequencia=2 WHERE pagamento_id='2f1f743c-b263-5a39-ae7e-81c465238f03';
INSERT INTO pagamento_movimentos_contextos
  (id,pagamento_id,recebimento_id,evento_id,versao_financeira_id,pagador_cliente_id,identidade_economica_snapshot)
VALUES ('f71b9bed-2e6e-5e2d-b77e-f4094d8d8eee','2f1f743c-b263-5a39-ae7e-81c465238f03',
 '7cfa928b-cece-5b79-ad1d-88cf8046df0e','8d6aa77f-e375-5905-9e27-a179c1450a11',
 'ef9bb759-4235-5978-a05a-842a7a6136b6','87f9dcfd-0651-5e6a-a3ab-cae8919cedad',
 '{"sintetico":true,"pagador":"ARTIFICIAL"}'::jsonb);
INSERT INTO pagamento_cronogramas
  (id,pagamento_id,evento_id,plano_id,versao_referencia_id,estado,modo,saldo_inicial_centavos,data_festa_referencia)
VALUES ('7c1ac444-eec2-597a-af90-6e4dbc95a164','2f1f743c-b263-5a39-ae7e-81c465238f03',
 '65fd4e40-d15b-553e-a145-92221befd1fd','0fd7812c-aad8-5342-a9e2-79f8d769247f',
 'ef9bb759-4235-5978-a05a-842a7a6136b6','ATIVO','REPROGRAMAR',380000,'2030-01-04');
INSERT INTO pagamento_cronograma_itens
  (id,cronograma_id,parcela_id,ordem,origem,saldo_inicial_centavos,recebido_base_centavos,
   estornado_base_centavos,vencimento_referencia)
VALUES ('b90118de-239c-534d-9bbf-9ad92579cfba','7c1ac444-eec2-597a-af90-6e4dbc95a164',
 'ac48869b-2a42-5459-a1a7-4cfac1f8a8c5',1,'REPROGRAMADA',380000,0,0,'2030-01-10');
INSERT INTO pagamento_comprovantes
  (id,recebimento_id,nome_arquivo,mime_type,tamanho_bytes,sha256,localizador_arquivo,registrado_por_usuario_id)
VALUES
  ('bdd6893f-358d-555a-aa9a-d2f7dbeb9a94','7cfa928b-cece-5b79-ad1d-88cf8046df0e','sintetico.pdf',
   'application/pdf',27,repeat('4',64),'synthetic://discardable/proof',
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7');

INSERT INTO eventos_historico_cliente
  (id,cliente_id,tipo_evento,origem,entidade_tipo,entidade_id,usuario_id,detalhe,metadata,critico)
VALUES
  ('3d56dde6-9f3e-5e7b-a701-baa7e3530930','87f9dcfd-0651-5e6a-a3ab-cae8919cedad','FIXTURE_SINTETICA','B5B2B',
   'CONTRATO','49b5f13b-3cc2-50ed-a5a1-cdc81eaca382','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7',
   'HISTORICO SINTETICO','{"sintetico":true,"campoLivre":"SYNTHETIC_PRIVATE_CANARY_HISTORY"}'::jsonb,true);
INSERT INTO auditoria
  (id,cliente_id,ator_tipo,usuario_id,acao,entidade_tipo,entidade_id,dados_antes,dados_depois,justificativa,origem,request_id,ip,user_agent)
VALUES
  ('3ed4608e-394b-5437-a19c-d7f80b349026','87f9dcfd-0651-5e6a-a3ab-cae8919cedad','USUARIO',
   'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','FIXTURE_SINTETICA','FESTA','94c160f2-0c69-5346-a954-2ba9d6aafbba',
   '{"estado":"ANTES"}'::jsonb,'{"estado":"DEPOIS","sintetico":true}'::jsonb,'JUSTIFICATIVA SINTETICA','B5B2B',
   '26279c1c-346b-512f-aa74-46f0a485123d','192.0.2.12','SYNTHETIC_AGENT');

INSERT INTO whatsapp_conexoes
  (id,ambiente,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,
   coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,
   credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,
   sessao_referencia_id,criada_em,atualizada_em)
VALUES
  ('1e4b9906-bdee-57bf-ae31-9c831387d354','STAGING','1000001','2000002','3000003','4000004',
   '+00000000000','SINTETICO_WHATSAPP',true,'CONFIGURADA',ARRAY['synthetic_scope'],decode('010203','hex'),
   decode('000102030405060708090a0b','hex'),decode('000102030405060708090a0b0c0d0e0f','hex'),1,'SYNTHETIC_TOKEN',
   '2030-01-03 12:00:00+00','2030-01-02 12:01:00+00','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7',
   '5d0848de-21f6-5fe0-a8bc-f04dab6426a8','2030-01-02 12:00:00+00','2030-01-02 12:01:00+00');
INSERT INTO whatsapp_onboarding_tentativas
  (id,ambiente,usuario_id,sessao_referencia_id,state_hash,status,expira_em,consumida_em,business_id,waba_id,
   phone_number_id,conexao_id,criada_em,atualizada_em)
VALUES
  ('12bce397-c98b-5530-a8a2-0c9cb73cb5cd','STAGING','bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7',
   '5d0848de-21f6-5fe0-a8bc-f04dab6426a8',decode(repeat('55',32),'hex'),'CONCLUIDA',
   '2030-01-02 12:10:00+00','2030-01-02 12:05:00+00','2000002','3000003','4000004',
   '1e4b9906-bdee-57bf-ae31-9c831387d354','2030-01-02 12:00:00+00','2030-01-02 12:05:00+00');

-- Segundo ciclo contratual e financeiro inteiramente sintético para exercitar
-- os ramos avançados da 015. Nenhuma origem externa nem credencial utilizável.
INSERT INTO contrato_versoes
  (id,contrato_id,numero_versao,status,snapshot_schema_versao,snapshot,snapshot_hash,
   motivo_nova_versao,gerado_por_usuario_id,assinado_em,documento_template_versao,documento_pdf_hash,aceite_metodo)
SELECT 'b70640ca-6b11-5ed5-b809-4158f9bb1c44',contrato_id,2,'ASSINADA',snapshot_schema_versao,
 jsonb_set(snapshot,'{comercial,valorFinalContrato}','3790'::jsonb),repeat('7',64),
 'AJUSTE FINANCEIRO SINTETICO',gerado_por_usuario_id,'2030-01-02 12:08:00+00',
 documento_template_versao,documento_pdf_hash,aceite_metodo
FROM contrato_versoes WHERE id='ef9bb759-4235-5978-a05a-842a7a6136b6';
INSERT INTO contrato_documentos
  (id,contrato_versao_id,categoria,revisao,snapshot_hash,template_codigo,template_versao,pdf_hash,
   tamanho_bytes,conteudo_pdf,gerado_por_usuario_id)
SELECT CASE id
 WHEN '1a8c8069-85a4-5688-a6e6-54f15f0d4760' THEN '34ed290c-118c-5570-88a5-82672c2169a7'::uuid
 WHEN 'cb20f9f4-7b3e-50ea-aa41-919eb8f8e802' THEN '8a49fafd-4690-528b-b375-367865612955'::uuid
 ELSE '25904423-8338-54b3-aa38-8528899c29de'::uuid END,
 'b70640ca-6b11-5ed5-b809-4158f9bb1c44',categoria,revisao,repeat('7',64),
 template_codigo,template_versao,pdf_hash,tamanho_bytes,conteudo_pdf,gerado_por_usuario_id
FROM contrato_documentos WHERE contrato_versao_id='ef9bb759-4235-5978-a05a-842a7a6136b6';
INSERT INTO contrato_edicoes
  (contrato_versao_id,contrato_id,tipo,origem_versao_id,estado,revisao,dados_fonte,alteracoes,
   revisao_comercial_aprovada,aprovado_comercial_por_usuario_id,aprovado_comercial_em,
   documento_revisado_id,revisado_por_usuario_id,revisado_em,liberado_por_usuario_id,liberado_em,
   criado_por_usuario_id,atualizado_por_usuario_id)
SELECT 'b70640ca-6b11-5ed5-b809-4158f9bb1c44',contrato_id,'NOVA_VERSAO',
 'ef9bb759-4235-5978-a05a-842a7a6136b6','CONCLUIDA',revisao,dados_fonte,alteracoes,
 revisao_comercial_aprovada,aprovado_comercial_por_usuario_id,'2030-01-02 12:04:00+00',
 '34ed290c-118c-5570-88a5-82672c2169a7',revisado_por_usuario_id,'2030-01-02 12:04:30+00',
 liberado_por_usuario_id,'2030-01-02 12:05:00+00',criado_por_usuario_id,atualizado_por_usuario_id
FROM contrato_edicoes WHERE contrato_versao_id='ef9bb759-4235-5978-a05a-842a7a6136b6';
INSERT INTO validacoes_identidade_cliente
  (id,cliente_id,finalidade,canal,status,codigo_hash,tentativas,max_tentativas,envios,max_envios,
   ultimo_envio_em,codigo_expira_em,confirmado_em,token_prova_hash,prova_expira_em,consumido_em,
   consumido_por_contrato_versao_id,criado_em,atualizado_em)
SELECT '8cf2e7aa-f920-57dc-b0a6-dab97083c98a',cliente_id,finalidade,canal,status,
 repeat('8',64),tentativas,max_tentativas,envios,max_envios,'2030-01-02 12:04:00+00',
 '2030-01-02 12:30:00+00','2030-01-02 12:06:00+00',repeat('9',64),
 '2030-01-02 13:00:00+00','2030-01-02 12:08:00+00',
 'b70640ca-6b11-5ed5-b809-4158f9bb1c44','2030-01-02 12:03:00+00','2030-01-02 12:08:00+00'
FROM validacoes_identidade_cliente WHERE id='9d21b287-aa27-5a27-a8ba-41203e548071';
INSERT INTO contrato_assinaturas
  (id,contrato_versao_id,parte,documento_id,usuario_id,sessao_id,autenticacao_metodo,autenticado_em,
   validacao_identidade_id,identidade_snapshot,snapshot_hash,pdf_hash,metodo,provider,assinado_em,ip,user_agent,
   request_id,chave_idempotencia,comprovante_documento_id)
SELECT 'd8a6e9ca-c3d5-5a4d-b544-09cc9c46b773','b70640ca-6b11-5ed5-b809-4158f9bb1c44',parte,
 '34ed290c-118c-5570-88a5-82672c2169a7',usuario_id,sessao_id,autenticacao_metodo,autenticado_em,
 NULL,identidade_snapshot,repeat('7',64),pdf_hash,metodo,provider,'2030-01-02 12:04:00+00',ip,user_agent,
 'a22b3dd2-bbeb-589a-995c-aa5bb396fd73','95ca7e74-b252-5e68-aac2-f8aa62c0fa49',
 '8a49fafd-4690-528b-b375-367865612955'
FROM contrato_assinaturas WHERE id='04b9cf1c-4307-58c6-a227-f0b639650950';
INSERT INTO contrato_assinaturas
  (id,contrato_versao_id,parte,documento_id,usuario_id,sessao_id,autenticacao_metodo,autenticado_em,
   validacao_identidade_id,identidade_snapshot,snapshot_hash,pdf_hash,metodo,provider,assinado_em,ip,user_agent,
   request_id,chave_idempotencia,comprovante_documento_id)
SELECT 'ff57e229-aa77-59c5-a208-7f5d43791731','b70640ca-6b11-5ed5-b809-4158f9bb1c44',parte,
 '34ed290c-118c-5570-88a5-82672c2169a7',NULL,NULL,NULL,NULL,
 '8cf2e7aa-f920-57dc-b0a6-dab97083c98a',identidade_snapshot,repeat('7',64),pdf_hash,
 metodo,provider,'2030-01-02 12:08:00+00',ip,user_agent,
 'ae783b2e-cd29-5370-a87c-c88487916e52','f2f4f610-5d3d-5a54-b9c4-3d51658ad34d',
 '25904423-8338-54b3-aa38-8528899c29de'
FROM contrato_assinaturas WHERE id='1a826e89-e625-561f-a789-a7a93e1b9aee';
UPDATE contratos SET versao_atual=2 WHERE id='49b5f13b-3cc2-50ed-a5a1-cdc81eaca382';
UPDATE contrato_fluxos SET versao_vigente_id='b70640ca-6b11-5ed5-b809-4158f9bb1c44'
WHERE contrato_id='49b5f13b-3cc2-50ed-a5a1-cdc81eaca382';

INSERT INTO contrato_pendencias_financeiras
  (id,contrato_id,versao_anterior_id,versao_nova_id,pagamento_id,motivo,diferencas)
VALUES ('0f047fe2-f3bd-56c6-9184-c51fb3c2f4d4','49b5f13b-3cc2-50ed-a5a1-cdc81eaca382',
 'ef9bb759-4235-5978-a05a-842a7a6136b6','b70640ca-6b11-5ed5-b809-4158f9bb1c44',
 '2f1f743c-b263-5a39-ae7e-81c465238f03','MOTIVO SINTETICO','{"deltaCentavos":-1000}'::jsonb);
INSERT INTO pagamento_tratamentos
  (id,pendencia_id,pagamento_id,tentativa,estado,posicao_base_hash,iniciado_por_usuario_id,
   iniciado_em,encerrado_em)
VALUES ('e03d9f93-16e2-58f8-8bd7-22c870de4419','0f047fe2-f3bd-56c6-9184-c51fb3c2f4d4',
 '2f1f743c-b263-5a39-ae7e-81c465238f03',1,'RESOLVIDA',repeat('a',64),
 'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','2030-01-02 12:09:00+00','2030-01-02 12:10:00+00');

INSERT INTO pagamento_eventos
  (id,pagamento_id,sequencia,pendencia_id,tratamento_id,tipo,chave_idempotencia,pedido_hash,
   usuario_id,ator_tipo,identidade_snapshot,request_id,dados_antes,dados_depois,resultado)
VALUES
 ('274bb297-5960-54fb-a29f-2a56071561bb','2f1f743c-b263-5a39-ae7e-81c465238f03',3,
  '0f047fe2-f3bd-56c6-9184-c51fb3c2f4d4','e03d9f93-16e2-58f8-8bd7-22c870de4419',
  'ALTERACAO_RESOLVIDA','03083d09-e8ae-5e6a-b5ba-b6d08e992d21',repeat('b',64),
  'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','USUARIO','{"sintetico":true}'::jsonb,
  '65b277cf-f38c-5f88-b187-aaf0fc80e1f4','{}'::jsonb,'{"ajuste":"SINTETICO"}'::jsonb,'{"ok":true}'::jsonb),
 ('65503016-974c-5e7a-ad0d-07932f5976a2','2f1f743c-b263-5a39-ae7e-81c465238f03',4,
  NULL,NULL,'DEVOLUCAO_SOLICITADA','f61e9cab-418f-5c9e-af50-c3c4c1680c04',repeat('c',64),
  'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','USUARIO','{"sintetico":true}'::jsonb,
  '46726e32-74cd-581d-85eb-25c9371a1fe1','{}'::jsonb,'{"devolucao":"SINTETICA"}'::jsonb,'{"ok":true}'::jsonb),
 ('6ea2a2dd-5ed6-5bee-8983-d00b1cb143b7','2f1f743c-b263-5a39-ae7e-81c465238f03',5,
  NULL,NULL,'DEVOLUCAO_CONCLUIDA','5334b3ae-b3b7-523a-ac44-231e199148fe',repeat('d',64),
  'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','USUARIO',
  '{"sintetico":true,"papel":"REPRESENTANTE_AUTORIZADO"}'::jsonb,
  '6262d84d-c634-5cf3-87b9-084110b158e1','{}'::jsonb,'{"estado":"CONCLUIDA"}'::jsonb,'{"ok":true}'::jsonb),
 ('d8e6e247-3314-5c8a-ad8d-5afed20e943e','2f1f743c-b263-5a39-ae7e-81c465238f03',6,
  NULL,NULL,'COMPROVANTE_DEVOLUCAO_ANEXADO','06580672-89e8-592a-8436-39fed57096ce',repeat('e',64),
  'bb7e2e48-76cf-50b4-a501-ddc2ba5e45c7','USUARIO','{"sintetico":true}'::jsonb,
  '0f9d2804-6a62-5afa-9f87-374c5dc8ffcf','{}'::jsonb,'{"comprovante":"SINTETICO"}'::jsonb,'{"ok":true}'::jsonb);
UPDATE pagamento_gestoes SET sequencia=3 WHERE pagamento_id='2f1f743c-b263-5a39-ae7e-81c465238f03';
UPDATE pagamento_gestoes SET sequencia=4 WHERE pagamento_id='2f1f743c-b263-5a39-ae7e-81c465238f03';
UPDATE pagamento_gestoes SET sequencia=5 WHERE pagamento_id='2f1f743c-b263-5a39-ae7e-81c465238f03';
UPDATE pagamento_gestoes SET sequencia=6 WHERE pagamento_id='2f1f743c-b263-5a39-ae7e-81c465238f03';

INSERT INTO pagamento_ajustes_contratuais
 (id,pagamento_id,tratamento_id,evento_id,versao_base_financeira_id,versao_reconhecida_id,
  obrigacao_antes_centavos,delta_centavos,obrigacao_depois_centavos,credito_aproveitado_centavos,
  tratamento_saldo,decisao_contratante,justificativa)
VALUES
 ('bcf202b2-e2ef-59b8-af1f-c56616408965','2f1f743c-b263-5a39-ae7e-81c465238f03',
  'e03d9f93-16e2-58f8-8bd7-22c870de4419','274bb297-5960-54fb-a29f-2a56071561bb',
  'ef9bb759-4235-5978-a05a-842a7a6136b6','b70640ca-6b11-5ed5-b809-4158f9bb1c44',
  380000,-1000,379000,4000,'REPROGRAMAR','DEVOLUCAO_AO_PAGADOR_ANTERIOR','AJUSTE SINTETICO');
INSERT INTO pagamento_ajuste_bases
 (id,ajuste_id,recebimento_id,valor_centavos,fato_em)
VALUES ('229e3f4c-0cae-5c5f-9e6c-1a58739a5d29','bcf202b2-e2ef-59b8-af1f-c56616408965',
 '7cfa928b-cece-5b79-ad1d-88cf8046df0e',5000,'2030-01-02 12:02:00+00');
UPDATE pagamento_cronogramas SET estado='SUBSTITUIDO',substituido_em='2030-01-02 12:10:00+00'
WHERE id='7c1ac444-eec2-597a-af90-6e4dbc95a164';
INSERT INTO pagamento_cronogramas
 (id,pagamento_id,evento_id,ajuste_id,cronograma_anterior_id,versao_referencia_id,
  estado,modo,saldo_inicial_centavos,data_festa_referencia)
VALUES ('7227c12a-935c-565f-8f46-d11e068a7729','2f1f743c-b263-5a39-ae7e-81c465238f03',
 '274bb297-5960-54fb-a29f-2a56071561bb','bcf202b2-e2ef-59b8-af1f-c56616408965',
 '7c1ac444-eec2-597a-af90-6e4dbc95a164','b70640ca-6b11-5ed5-b809-4158f9bb1c44',
 'ATIVO','REPROGRAMAR',380000,'2030-01-04');
INSERT INTO pagamento_cronograma_itens
 (id,cronograma_id,parcela_id,item_anterior_id,ordem,origem,saldo_inicial_centavos,
  recebido_base_centavos,estornado_base_centavos,vencimento_referencia)
VALUES ('713e3cc9-f57a-5e8b-8718-548cfd96c640','7227c12a-935c-565f-8f46-d11e068a7729',
 'ac48869b-2a42-5459-a1a7-4cfac1f8a8c5','b90118de-239c-534d-9bbf-9ad92579cfba',
 1,'REPROGRAMADA',380000,0,0,'2030-01-10');

INSERT INTO pagamento_credito_reservas
 (id,pagamento_id,evento_criacao_id,evento_encerramento_id,valor_centavos,estado,encerrado_em)
VALUES ('ae6f4e25-12c3-5edf-a92e-d71a206534f2','2f1f743c-b263-5a39-ae7e-81c465238f03',
 '65503016-974c-5e7a-ad0d-07932f5976a2','6ea2a2dd-5ed6-5bee-8983-d00b1cb143b7',
 1000,'CONSUMIDA','2030-01-02 12:12:00+00');
INSERT INTO pagamento_devolucoes
 (id,pagamento_id,reserva_id,evento_solicitacao_id,evento_conclusao_id,estado,valor_centavos,
  beneficiario_cliente_id,beneficiario_snapshot,motivo,devolvido_em,meio_devolucao,observacao_execucao)
VALUES ('a6028991-2691-5c6f-99ab-ea5123884ebf','2f1f743c-b263-5a39-ae7e-81c465238f03',
 'ae6f4e25-12c3-5edf-a92e-d71a206534f2','65503016-974c-5e7a-ad0d-07932f5976a2',
 '6ea2a2dd-5ed6-5bee-8983-d00b1cb143b7','CONCLUIDA',1000,
 '87f9dcfd-0651-5e6a-a3ab-cae8919cedad','{"sintetico":true}'::jsonb,
 'MOTIVO SINTETICO','2030-01-02 12:12:00+00','PIX','EXECUCAO SINTETICA');
INSERT INTO pagamento_devolucao_alocacoes
 (id,devolucao_id,recebimento_alocacao_id,valor_centavos)
VALUES ('0bb1491f-7c82-5d2a-a52a-a749769e599f','a6028991-2691-5c6f-99ab-ea5123884ebf',
 '97fc51e2-b742-5138-a24b-909311f642f6',1000);
INSERT INTO pagamento_devolucao_comprovantes
 (id,devolucao_id,evento_id,nome_arquivo,mime_type,tamanho_bytes,sha256,conteudo)
SELECT '9966b394-313f-5011-b23a-c00c4ec6a0d6','a6028991-2691-5c6f-99ab-ea5123884ebf',
 'd8e6e247-3314-5c8a-ad8d-5afed20e943e','sintetico.pdf','application/pdf',
 octet_length(convert_to('SYNTHETIC_PRIVATE_CANARY_REFUND_PROOF','UTF8')),
 encode(sha256(convert_to('SYNTHETIC_PRIVATE_CANARY_REFUND_PROOF','UTF8')),'hex'),
 convert_to('SYNTHETIC_PRIVATE_CANARY_REFUND_PROOF','UTF8');
SET CONSTRAINTS ALL IMMEDIATE;

COMMIT;
