-- H0 (homologação do painel do desenvolvedor, PR #104) — leitura SOMENTE LEITURA da associação do perfil legado.
-- Executar em staging por quem tem credencial própria (psql/PowerShell), ANTES do deploy da PR, e registrar a saída
-- no documento de homologação. Não altera nada: a transação é READ ONLY e termina em ROLLBACK.
--
-- Regra de associação: a MESMA da aplicação (EMPRESA_SAAS_DO_PERFIL em lib/perfil/autorizacao.ts), repetida nos
-- blocos (3) e (4) porque uma transação READ ONLY não cria view temporária. Uma empresa é candidata de um perfil quando:
--   a) empresa.id = perfil.id (UUID) ou empresa.codigo = lower(perfil.codigo);
--   b) instalação única: existe exatamente UMA empresa e exatamente UM perfil;
--   c) órfão único da Kidmais: a empresa é a 'kidmais', o perfil não casa com nenhuma empresa por UUID/código e ele é
--      o ÚNICO perfil nessa situação.
-- A aplicação só usa a associação quando há exatamente UMA candidata (candidatas = 1). Este script NUNCA escolhe uma
-- empresa quando há mais de uma: marca AMBIGUO_VARIAS_EMPRESAS e deixa empresa/administradores nulos.
--
-- Leitura esperada antes do deploy:
--   (1) exatamente UMA empresa com codigo = 'kidmais' e status ATIVA;
--   (2) perfis órfãos (sem empresa por UUID nem por código): ZERO ou UM. Com dois ou mais, a regra (c) não vale para
--       nenhum e o acesso ao Perfil da Kidmais fecha (PERFIL_ESTRUTURA_AUSENTE) até a plataforma corrigir;
--   (3) nenhum perfil com situacao <> 'OK' (SEM_EMPRESA / AMBIGUO_VARIAS_EMPRESAS) e nenhum com
--       perfis_na_mesma_empresa > 1 (a Gestão dessa empresa não abre nem assume o Perfil: PERFIL_LIMITE_V1/AMBIGUO);
--       perfis com administradores_elegiveis = 0 são os casos em que a Gestão verá "Assumir a administração do perfil";
--   (4) lista as empresas com mais de um perfil associado (vazia no estado esperado).
-- Administrador elegível (mesma definição de lib/perfil/criacao.ts): concessão ativa de PERFIL_ADMINISTRAR_CONCESSOES
-- no perfil, identidade ativa, vínculo ATIVA com papel REPRESENTANTE_AUTORIZADO NA empresa associada.
-- Nada aqui lê cadastro, senha, token ou dado pessoal: só ids, códigos, status e contagens.
BEGIN READ ONLY;

-- (0) Estrutura presente e contagens gerais.
SELECT to_regclass('public.perfil_empresas') AS perfil_empresas,
       to_regclass('public.perfil_empresa_concessoes') AS perfil_empresa_concessoes,
       (SELECT count(*) FROM empresas) AS empresas,
       (SELECT count(*) FROM empresas WHERE status = 'ATIVA') AS empresas_ativas,
       (SELECT count(*) FROM public.perfil_empresas) AS perfis;

-- (1) Empresa legada.
SELECT id, codigo, status FROM empresas WHERE codigo = 'kidmais';

-- (2) Perfis órfãos (sem empresa pelo UUID nem pelo código).
SELECT p.id, p.codigo, p.versao
  FROM public.perfil_empresas p
 WHERE NOT EXISTS (SELECT 1 FROM empresas e WHERE e.id = p.id OR e.codigo = lower(p.codigo))
 ORDER BY p.id;

-- (3) Um perfil por linha: candidatas pela regra da aplicação, situação, empresa associada (só quando única),
--     quantos perfis apontam para a mesma empresa, concessões ativas e administradores elegíveis.
WITH candidatas AS (
  SELECT p.id AS perfil_id, e.id AS empresa_id, e.codigo AS empresa_codigo, e.status AS empresa_status
    FROM public.perfil_empresas p
    JOIN empresas e ON (
      e.id = p.id OR e.codigo = lower(p.codigo) OR (
        (SELECT count(*) FROM empresas) = 1 AND (SELECT count(*) FROM public.perfil_empresas) = 1
      ) OR (
        e.codigo = 'kidmais'
        AND NOT EXISTS (SELECT 1 FROM empresas x WHERE x.id = p.id OR x.codigo = lower(p.codigo))
        AND (SELECT count(*) FROM public.perfil_empresas q
              WHERE NOT EXISTS (SELECT 1 FROM empresas y WHERE y.id = q.id OR y.codigo = lower(q.codigo))) = 1
      )
    )
), associacao AS (
  SELECT p.id AS perfil_id, p.codigo AS perfil_codigo,
         count(c.empresa_id) AS candidatas,
         CASE WHEN count(c.empresa_id) = 1 THEN min(c.empresa_id::text)::uuid END AS empresa_id,
         CASE WHEN count(c.empresa_id) = 1 THEN min(c.empresa_codigo) END AS empresa_codigo,
         CASE WHEN count(c.empresa_id) = 1 THEN min(c.empresa_status) END AS empresa_status,
         string_agg(c.empresa_codigo, ', ' ORDER BY c.empresa_codigo) AS candidatas_codigos
    FROM public.perfil_empresas p
    LEFT JOIN candidatas c ON c.perfil_id = p.id
   GROUP BY p.id, p.codigo
)
SELECT a.perfil_id, a.perfil_codigo,
       CASE WHEN a.candidatas = 0 THEN 'SEM_EMPRESA'
            WHEN a.candidatas > 1 THEN 'AMBIGUO_VARIAS_EMPRESAS'
            ELSE 'OK' END AS situacao,
       a.candidatas, a.candidatas_codigos,
       a.empresa_id, a.empresa_codigo, a.empresa_status,
       CASE WHEN a.empresa_id IS NOT NULL
            THEN (SELECT count(*) FROM associacao b WHERE b.empresa_id = a.empresa_id) END AS perfis_na_mesma_empresa,
       (SELECT count(*) FROM public.perfil_empresa_concessoes c
         WHERE c.empresa_id = a.perfil_id AND c.revogado_em IS NULL) AS concessoes_ativas,
       CASE WHEN a.empresa_id IS NOT NULL THEN (
         SELECT count(*) FROM public.perfil_empresa_concessoes c
           JOIN usuarios_administrativos u ON u.id = c.usuario_id
           JOIN memberships m ON m.usuario_id = c.usuario_id AND m.empresa_id = a.empresa_id
          WHERE c.empresa_id = a.perfil_id AND c.revogado_em IS NULL AND c.capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES'
            AND u.ativo AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO'
       ) END AS administradores_elegiveis
  FROM associacao a
 ORDER BY a.perfil_id;

-- (4) Empresas com mais de um perfil associado de forma inequívoca (vários perfis → mesma empresa).
WITH candidatas AS (
  SELECT p.id AS perfil_id, e.id AS empresa_id, e.codigo AS empresa_codigo
    FROM public.perfil_empresas p
    JOIN empresas e ON (
      e.id = p.id OR e.codigo = lower(p.codigo) OR (
        (SELECT count(*) FROM empresas) = 1 AND (SELECT count(*) FROM public.perfil_empresas) = 1
      ) OR (
        e.codigo = 'kidmais'
        AND NOT EXISTS (SELECT 1 FROM empresas x WHERE x.id = p.id OR x.codigo = lower(p.codigo))
        AND (SELECT count(*) FROM public.perfil_empresas q
              WHERE NOT EXISTS (SELECT 1 FROM empresas y WHERE y.id = q.id OR y.codigo = lower(q.codigo))) = 1
      )
    )
), associacao AS (
  SELECT perfil_id, min(empresa_id::text)::uuid AS empresa_id, min(empresa_codigo) AS empresa_codigo
    FROM candidatas GROUP BY perfil_id HAVING count(*) = 1
)
SELECT empresa_id, empresa_codigo, count(*) AS perfis, string_agg(perfil_id::text, ', ' ORDER BY perfil_id) AS perfil_ids
  FROM associacao
 GROUP BY empresa_id, empresa_codigo
HAVING count(*) > 1
 ORDER BY empresa_codigo;

ROLLBACK;
