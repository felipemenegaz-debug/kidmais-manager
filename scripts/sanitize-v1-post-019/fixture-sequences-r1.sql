-- R1: exclusivamente sintética, sem pessoa/contrato/festa ou origem externa.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
INSERT INTO limites_autenticacao (chave_hash,tipo,tentativas,janela_iniciada_em,atualizado_em)
VALUES (repeat('d',64),'IDENTIFICADOR',1,'2030-01-02 11:55:00+00','2030-01-02 12:00:00+00');
SELECT nextval('public.festa_contagens_convidados_sequencia_seq');
SELECT nextval('public.festa_eventos_sequencia_seq');
COMMIT;
