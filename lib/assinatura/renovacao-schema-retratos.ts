import type { Retrato } from './renovacao-schema.ts';

/**
 * Retratos APROVADOS de assinatura_renovacoes — GERADOS por scripts/capturar-retratos-renovacao.mjs no PG DESCARTÁVEL
 * (PostgreSQL 180006): 075 = cadeia do repositório até a 108 (sem a 098); 109 = a mesma com a 109. Não editar à mão.
 * A conferência contra o catálogo real (staging/production, versão do PG, CRLF) é gate futuro e nunca aprova desvio.
 */
export const RETRATO_075: Retrato = {
    "colunas": [
        {
            "nome": "atualizado_em",
            "tipo": "timestamp with time zone",
            "default": "clock_timestamp()",
            "notnull": true
        },
        {
            "nome": "aviso_dias",
            "tipo": "smallint",
            "default": "30",
            "notnull": true
        },
        {
            "nome": "aviso_enviado_em",
            "tipo": "timestamp with time zone",
            "default": null,
            "notnull": false
        },
        {
            "nome": "aviso_id_externo",
            "tipo": "text",
            "default": null,
            "notnull": false
        },
        {
            "nome": "aviso_tentado_em",
            "tipo": "timestamp with time zone",
            "default": null,
            "notnull": false
        },
        {
            "nome": "contratacao_id",
            "tipo": "uuid",
            "default": null,
            "notnull": true
        },
        {
            "nome": "criado_em",
            "tipo": "timestamp with time zone",
            "default": "clock_timestamp()",
            "notnull": true
        },
        {
            "nome": "destinatario_id",
            "tipo": "uuid",
            "default": null,
            "notnull": true
        },
        {
            "nome": "empresa_id",
            "tipo": "uuid",
            "default": null,
            "notnull": true
        },
        {
            "nome": "estado",
            "tipo": "text",
            "default": "'PENDENTE'::text",
            "notnull": true
        },
        {
            "nome": "id",
            "tipo": "uuid",
            "default": "public.gen_random_uuid()",
            "notnull": true
        },
        {
            "nome": "mensagem",
            "tipo": "jsonb",
            "default": null,
            "notnull": true
        },
        {
            "nome": "preco_aplicado_em",
            "tipo": "timestamp with time zone",
            "default": null,
            "notnull": false
        },
        {
            "nome": "primeira_data_regular",
            "tipo": "date",
            "default": null,
            "notnull": true
        },
        {
            "nome": "primeiro_vencimento",
            "tipo": "date",
            "default": null,
            "notnull": true
        },
        {
            "nome": "ultimo_erro",
            "tipo": "text",
            "default": null,
            "notnull": false
        }
    ],
    "funcoes": [
        {
            "nome": "public.kidmais_075_renovacao_guarda",
            "corpo": "df43f58f894cabfb5d939ba62075f267e042dc005cbc12a062f3b51cb54abffe",
            "config": "search_path=pg_catalog, pg_temp",
            "secdef": false
        }
    ],
    "indices": [
        {
            "def": "CREATE UNIQUE INDEX assinatura_renovacoes_contratacao_id_key ON public.assinatura_renovacoes USING btree (contratacao_id)",
            "nome": "assinatura_renovacoes_contratacao_id_key",
            "unico": true,
            "pronto": true,
            "valido": true
        },
        {
            "def": "CREATE INDEX assinatura_renovacoes_pendentes_idx ON public.assinatura_renovacoes USING btree (estado, primeira_data_regular)",
            "nome": "assinatura_renovacoes_pendentes_idx",
            "unico": false,
            "pronto": true,
            "valido": true
        },
        {
            "def": "CREATE UNIQUE INDEX assinatura_renovacoes_pkey ON public.assinatura_renovacoes USING btree (id)",
            "nome": "assinatura_renovacoes_pkey",
            "unico": true,
            "pronto": true,
            "valido": true
        }
    ],
    "gatilhos": [
        {
            "def": "CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR DELETE OR UPDATE ON public.assinatura_renovacoes FOR EACH ROW EXECUTE FUNCTION public.kidmais_075_renovacao_guarda()",
            "nome": "assinatura_renovacoes_075_guarda",
            "funcao": "public.kidmais_075_renovacao_guarda",
            "semWhen": true,
            "diferido": false,
            "deferivel": false,
            "constraint": null,
            "habilitado": "O",
            "semUpdateOf": true
        },
        {
            "def": "CREATE TRIGGER assinatura_renovacoes_075_truncate BEFORE TRUNCATE ON public.assinatura_renovacoes FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais_075_renovacao_guarda()",
            "nome": "assinatura_renovacoes_075_truncate",
            "funcao": "public.kidmais_075_renovacao_guarda",
            "semWhen": true,
            "diferido": false,
            "deferivel": false,
            "constraint": null,
            "habilitado": "O",
            "semUpdateOf": true
        }
    ],
    "constraints": [
        {
            "def": "NOT NULL atualizado_em",
            "nome": "assinatura_renovacoes_atualizado_em_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK ((aviso_dias = 30))",
            "nome": "assinatura_renovacoes_aviso_dias_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL aviso_dias",
            "nome": "assinatura_renovacoes_aviso_dias_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK ((primeira_data_regular > primeiro_vencimento))",
            "nome": "assinatura_renovacoes_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((jsonb_typeof(mensagem) = 'object'::text) AND (mensagem ?& ARRAY['para'::text, 'assunto'::text, 'texto'::text, 'html'::text, 'idempotencia'::text]) AND (jsonb_typeof((mensagem -> 'para'::text)) = 'string'::text) AND (jsonb_typeof((mensagem -> 'texto'::text)) = 'string'::text) AND ((mensagem ->> 'idempotencia'::text) = ('kidmais-renovacao/'::text || (id)::text))))",
            "nome": "assinatura_renovacoes_check1",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((aviso_enviado_em IS NULL) OR ((aviso_tentado_em IS NOT NULL) AND (aviso_enviado_em >= aviso_tentado_em) AND (aviso_id_externo IS NOT NULL))))",
            "nome": "assinatura_renovacoes_check2",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((aviso_enviado_em IS NULL) OR (((aviso_enviado_em AT TIME ZONE 'America/Sao_Paulo'::text))::date <= (primeira_data_regular - (aviso_dias)::integer))))",
            "nome": "assinatura_renovacoes_check3",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((estado <> ALL (ARRAY['AVISADA'::text, 'APLICANDO'::text, 'REGULAR'::text])) OR (aviso_enviado_em IS NOT NULL)))",
            "nome": "assinatura_renovacoes_check4",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((estado <> 'REGULAR'::text) OR (preco_aplicado_em IS NOT NULL)))",
            "nome": "assinatura_renovacoes_check5",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((preco_aplicado_em IS NULL) OR ((aviso_enviado_em IS NOT NULL) AND (preco_aplicado_em >= aviso_enviado_em))))",
            "nome": "assinatura_renovacoes_check6",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "UNIQUE (contratacao_id)",
            "nome": "assinatura_renovacoes_contratacao_id_key",
            "tipo": "u",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL contratacao_id",
            "nome": "assinatura_renovacoes_contratacao_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL criado_em",
            "nome": "assinatura_renovacoes_criado_em_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "FOREIGN KEY (destinatario_id) REFERENCES public.usuarios_administrativos(id)",
            "nome": "assinatura_renovacoes_destinatario_id_fkey",
            "tipo": "f",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL destinatario_id",
            "nome": "assinatura_renovacoes_destinatario_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "FOREIGN KEY (empresa_id, contratacao_id) REFERENCES public.assinatura_contratacoes(empresa_id, id)",
            "nome": "assinatura_renovacoes_empresa_id_contratacao_id_fkey",
            "tipo": "f",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "FOREIGN KEY (empresa_id) REFERENCES public.empresas(id)",
            "nome": "assinatura_renovacoes_empresa_id_fkey",
            "tipo": "f",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL empresa_id",
            "nome": "assinatura_renovacoes_empresa_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK ((estado = ANY (ARRAY['PENDENTE'::text, 'AVISANDO'::text, 'AVISADA'::text, 'APLICANDO'::text, 'REGULAR'::text, 'REVISAO'::text, 'CANCELADA'::text])))",
            "nome": "assinatura_renovacoes_estado_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL estado",
            "nome": "assinatura_renovacoes_estado_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL id",
            "nome": "assinatura_renovacoes_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL mensagem",
            "nome": "assinatura_renovacoes_mensagem_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "PRIMARY KEY (id)",
            "nome": "assinatura_renovacoes_pkey",
            "tipo": "p",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL primeira_data_regular",
            "nome": "assinatura_renovacoes_primeira_data_regular_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL primeiro_vencimento",
            "nome": "assinatura_renovacoes_primeiro_vencimento_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((ultimo_erro IS NULL) OR (ultimo_erro ~ '^[A-Z0-9_]{1,80}$'::text)))",
            "nome": "assinatura_renovacoes_ultimo_erro_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        }
    ]
};

export const RETRATO_109: Retrato = {
    "colunas": [
        {
            "nome": "atualizado_em",
            "tipo": "timestamp with time zone",
            "default": "clock_timestamp()",
            "notnull": true
        },
        {
            "nome": "aviso_dias",
            "tipo": "smallint",
            "default": "30",
            "notnull": true
        },
        {
            "nome": "aviso_enviado_em",
            "tipo": "timestamp with time zone",
            "default": null,
            "notnull": false
        },
        {
            "nome": "aviso_id_externo",
            "tipo": "text",
            "default": null,
            "notnull": false
        },
        {
            "nome": "aviso_tentado_em",
            "tipo": "timestamp with time zone",
            "default": null,
            "notnull": false
        },
        {
            "nome": "contratacao_id",
            "tipo": "uuid",
            "default": null,
            "notnull": true
        },
        {
            "nome": "criado_em",
            "tipo": "timestamp with time zone",
            "default": "clock_timestamp()",
            "notnull": true
        },
        {
            "nome": "destinatario_id",
            "tipo": "uuid",
            "default": null,
            "notnull": true
        },
        {
            "nome": "empresa_id",
            "tipo": "uuid",
            "default": null,
            "notnull": true
        },
        {
            "nome": "estado",
            "tipo": "text",
            "default": "'PENDENTE'::text",
            "notnull": true
        },
        {
            "nome": "id",
            "tipo": "uuid",
            "default": "public.gen_random_uuid()",
            "notnull": true
        },
        {
            "nome": "mensagem",
            "tipo": "jsonb",
            "default": null,
            "notnull": true
        },
        {
            "nome": "preco_aplicado_em",
            "tipo": "timestamp with time zone",
            "default": null,
            "notnull": false
        },
        {
            "nome": "primeira_data_regular",
            "tipo": "date",
            "default": null,
            "notnull": true
        },
        {
            "nome": "primeiro_vencimento",
            "tipo": "date",
            "default": null,
            "notnull": true
        },
        {
            "nome": "substitui_id",
            "tipo": "uuid",
            "default": null,
            "notnull": false
        },
        {
            "nome": "ultimo_erro",
            "tipo": "text",
            "default": null,
            "notnull": false
        }
    ],
    "funcoes": [
        {
            "nome": "public.kidmais_109_renovacao_guarda",
            "corpo": "2b8847b30d352797e7a7146c5d81fec73ad536553392668a226b609782e3ef32",
            "config": "search_path=pg_catalog, pg_temp",
            "secdef": false
        },
        {
            "nome": "public.kidmais_109_renovacao_sucessor",
            "corpo": "96bae8fe138c320fb7741d80f5b218100565ec747fee00864588fa7ad262a76d",
            "config": "search_path=pg_catalog, pg_temp",
            "secdef": false
        }
    ],
    "indices": [
        {
            "def": "CREATE UNIQUE INDEX assinatura_renovacoes_109_cadeia_alvo_uq ON public.assinatura_renovacoes USING btree (empresa_id, contratacao_id, id)",
            "nome": "assinatura_renovacoes_109_cadeia_alvo_uq",
            "unico": true,
            "pronto": true,
            "valido": true
        },
        {
            "def": "CREATE UNIQUE INDEX assinatura_renovacoes_109_substitui_uq ON public.assinatura_renovacoes USING btree (substitui_id)",
            "nome": "assinatura_renovacoes_109_substitui_uq",
            "unico": true,
            "pronto": true,
            "valido": true
        },
        {
            "def": "CREATE UNIQUE INDEX assinatura_renovacoes_109_vigente_uq ON public.assinatura_renovacoes USING btree (contratacao_id) WHERE (estado <> 'SUBSTITUIDA'::text)",
            "nome": "assinatura_renovacoes_109_vigente_uq",
            "unico": true,
            "pronto": true,
            "valido": true
        },
        {
            "def": "CREATE INDEX assinatura_renovacoes_pendentes_idx ON public.assinatura_renovacoes USING btree (estado, primeira_data_regular)",
            "nome": "assinatura_renovacoes_pendentes_idx",
            "unico": false,
            "pronto": true,
            "valido": true
        },
        {
            "def": "CREATE UNIQUE INDEX assinatura_renovacoes_pkey ON public.assinatura_renovacoes USING btree (id)",
            "nome": "assinatura_renovacoes_pkey",
            "unico": true,
            "pronto": true,
            "valido": true
        }
    ],
    "gatilhos": [
        {
            "def": "CREATE TRIGGER assinatura_renovacoes_075_guarda BEFORE INSERT OR DELETE OR UPDATE ON public.assinatura_renovacoes FOR EACH ROW EXECUTE FUNCTION public.kidmais_109_renovacao_guarda()",
            "nome": "assinatura_renovacoes_075_guarda",
            "funcao": "public.kidmais_109_renovacao_guarda",
            "semWhen": true,
            "diferido": false,
            "deferivel": false,
            "constraint": null,
            "habilitado": "O",
            "semUpdateOf": true
        },
        {
            "def": "CREATE TRIGGER assinatura_renovacoes_075_truncate BEFORE TRUNCATE ON public.assinatura_renovacoes FOR EACH STATEMENT EXECUTE FUNCTION public.kidmais_109_renovacao_guarda()",
            "nome": "assinatura_renovacoes_075_truncate",
            "funcao": "public.kidmais_109_renovacao_guarda",
            "semWhen": true,
            "diferido": false,
            "deferivel": false,
            "constraint": null,
            "habilitado": "O",
            "semUpdateOf": true
        },
        {
            "def": "CREATE CONSTRAINT TRIGGER assinatura_renovacoes_109_sucessor AFTER UPDATE ON public.assinatura_renovacoes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.kidmais_109_renovacao_sucessor()",
            "nome": "assinatura_renovacoes_109_sucessor",
            "funcao": "public.kidmais_109_renovacao_sucessor",
            "semWhen": true,
            "diferido": true,
            "deferivel": true,
            "constraint": "assinatura_renovacoes_109_sucessor",
            "habilitado": "O",
            "semUpdateOf": true
        }
    ],
    "constraints": [
        {
            "def": "UNIQUE (empresa_id, contratacao_id, id)",
            "nome": "assinatura_renovacoes_109_cadeia_alvo_uq",
            "tipo": "u",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "FOREIGN KEY (empresa_id, contratacao_id, substitui_id) REFERENCES public.assinatura_renovacoes(empresa_id, contratacao_id, id)",
            "nome": "assinatura_renovacoes_109_cadeia_fk",
            "tipo": "f",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK ((estado = ANY (ARRAY['PENDENTE'::text, 'AVISANDO'::text, 'AVISADA'::text, 'APLICANDO'::text, 'REGULAR'::text, 'REVISAO'::text, 'CANCELADA'::text, 'SUBSTITUIDA'::text])))",
            "nome": "assinatura_renovacoes_109_estado_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "UNIQUE (substitui_id)",
            "nome": "assinatura_renovacoes_109_substitui_uq",
            "tipo": "u",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((estado <> 'SUBSTITUIDA'::text) OR ((aviso_tentado_em IS NULL) AND (aviso_enviado_em IS NULL) AND (aviso_id_externo IS NULL) AND (preco_aplicado_em IS NULL))))",
            "nome": "assinatura_renovacoes_109_substituida_sem_evidencia",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL atualizado_em",
            "nome": "assinatura_renovacoes_atualizado_em_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK ((aviso_dias = 30))",
            "nome": "assinatura_renovacoes_aviso_dias_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL aviso_dias",
            "nome": "assinatura_renovacoes_aviso_dias_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK ((primeira_data_regular > primeiro_vencimento))",
            "nome": "assinatura_renovacoes_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((jsonb_typeof(mensagem) = 'object'::text) AND (mensagem ?& ARRAY['para'::text, 'assunto'::text, 'texto'::text, 'html'::text, 'idempotencia'::text]) AND (jsonb_typeof((mensagem -> 'para'::text)) = 'string'::text) AND (jsonb_typeof((mensagem -> 'texto'::text)) = 'string'::text) AND ((mensagem ->> 'idempotencia'::text) = ('kidmais-renovacao/'::text || (id)::text))))",
            "nome": "assinatura_renovacoes_check1",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((aviso_enviado_em IS NULL) OR ((aviso_tentado_em IS NOT NULL) AND (aviso_enviado_em >= aviso_tentado_em) AND (aviso_id_externo IS NOT NULL))))",
            "nome": "assinatura_renovacoes_check2",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((aviso_enviado_em IS NULL) OR (((aviso_enviado_em AT TIME ZONE 'America/Sao_Paulo'::text))::date <= (primeira_data_regular - (aviso_dias)::integer))))",
            "nome": "assinatura_renovacoes_check3",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((estado <> ALL (ARRAY['AVISADA'::text, 'APLICANDO'::text, 'REGULAR'::text])) OR (aviso_enviado_em IS NOT NULL)))",
            "nome": "assinatura_renovacoes_check4",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((estado <> 'REGULAR'::text) OR (preco_aplicado_em IS NOT NULL)))",
            "nome": "assinatura_renovacoes_check5",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((preco_aplicado_em IS NULL) OR ((aviso_enviado_em IS NOT NULL) AND (preco_aplicado_em >= aviso_enviado_em))))",
            "nome": "assinatura_renovacoes_check6",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL contratacao_id",
            "nome": "assinatura_renovacoes_contratacao_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL criado_em",
            "nome": "assinatura_renovacoes_criado_em_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "FOREIGN KEY (destinatario_id) REFERENCES public.usuarios_administrativos(id)",
            "nome": "assinatura_renovacoes_destinatario_id_fkey",
            "tipo": "f",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL destinatario_id",
            "nome": "assinatura_renovacoes_destinatario_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "FOREIGN KEY (empresa_id, contratacao_id) REFERENCES public.assinatura_contratacoes(empresa_id, id)",
            "nome": "assinatura_renovacoes_empresa_id_contratacao_id_fkey",
            "tipo": "f",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "FOREIGN KEY (empresa_id) REFERENCES public.empresas(id)",
            "nome": "assinatura_renovacoes_empresa_id_fkey",
            "tipo": "f",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL empresa_id",
            "nome": "assinatura_renovacoes_empresa_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL estado",
            "nome": "assinatura_renovacoes_estado_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL id",
            "nome": "assinatura_renovacoes_id_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL mensagem",
            "nome": "assinatura_renovacoes_mensagem_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "PRIMARY KEY (id)",
            "nome": "assinatura_renovacoes_pkey",
            "tipo": "p",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL primeira_data_regular",
            "nome": "assinatura_renovacoes_primeira_data_regular_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "NOT NULL primeiro_vencimento",
            "nome": "assinatura_renovacoes_primeiro_vencimento_not_null",
            "tipo": "n",
            "diferida": false,
            "validada": true,
            "deferivel": false
        },
        {
            "def": "CHECK (((ultimo_erro IS NULL) OR (ultimo_erro ~ '^[A-Z0-9_]{1,80}$'::text)))",
            "nome": "assinatura_renovacoes_ultimo_erro_check",
            "tipo": "c",
            "diferida": false,
            "validada": true,
            "deferivel": false
        }
    ]
};
