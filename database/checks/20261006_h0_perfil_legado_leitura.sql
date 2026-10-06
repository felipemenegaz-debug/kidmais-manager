-- H0 (homologação do painel do desenvolvedor, PR #104) — leitura SOMENTE LEITURA da associação do perfil legado.
-- Executar em staging por quem tem credencial própria (psql/PowerShell), ANTES do deploy da PR, e registrar a saída
-- no documento de homologação. Não altera nada: a transação é READ ONLY e termina em ROLLBACK.
-- Resultado esperado para a regra de código (EMPRESA_SAAS_DO_PERFIL, lib/perfil/autorizacao.ts):
--   (1) exatamente UMA empresa com codigo = 'kidmais' e status ATIVA;
--   (2) os perfis "órfãos" (sem empresa pelo UUID nem pelo código) são ZERO ou UM; com um órfão, ele passa a pertencer
--       à empresa kidmais; com dois ou mais, o acesso ao Perfil da Kidmais fecha (PERFIL_ESTRUTURA_AUSENTE) e a associação
--       precisa ser corrigida pela plataforma antes da homologação H4;
--   (3) nenhuma empresa com mais de um perfil associado (candidatos > 1) — do contrário a Gestão dela não assume nem
--       cria o perfil (PERFIL_LIMITE_V1 / AMBIGUO).
-- Nada aqui lê cadastro, senha, token ou dado pessoal: só ids, códigos, status e contagens.
BEGIN READ ONLY;

-- (0) Estrutura presente?
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

-- (3) Associação perfil → empresa pela mesma regra do código; `candidatos` > 1 é ambiguidade.
SELECT p.id AS perfil_id, p.codigo AS perfil_codigo, e.id AS empresa_id, e.status AS empresa_status, e.candidatos
  FROM public.perfil_empresas p
  LEFT JOIN LATERAL (
    SELECT id, status, count(*) OVER () AS candidatos FROM empresas
     WHERE id = p.id OR codigo = lower(p.codigo) OR (
       (SELECT count(*) FROM empresas) = 1 AND (SELECT count(*) FROM public.perfil_empresas) = 1
     ) OR (
       codigo = 'kidmais'
       AND NOT EXISTS (SELECT 1 FROM empresas x WHERE x.id = p.id OR x.codigo = lower(p.codigo))
       AND (SELECT count(*) FROM public.perfil_empresas q
             WHERE NOT EXISTS (SELECT 1 FROM empresas y WHERE y.id = q.id OR y.codigo = lower(q.codigo))) = 1
     )
  ) e ON true
 ORDER BY p.id;

-- (4) Perfis sem administrador elegível (Gestão ATIVA com PERFIL_ADMINISTRAR_CONCESSOES): são os casos em que a
--     Gestão verá "Assumir a administração do perfil" depois do deploy. Só contagens.
SELECT p.id AS perfil_id, p.codigo AS perfil_codigo,
       (SELECT count(*) FROM public.perfil_empresa_concessoes c WHERE c.empresa_id = p.id AND c.revogado_em IS NULL) AS concessoes_ativas,
       (SELECT count(*) FROM public.perfil_empresa_concessoes c
          JOIN usuarios_administrativos u ON u.id = c.usuario_id
          JOIN memberships m ON m.usuario_id = c.usuario_id
          JOIN empresas e ON e.id = m.empresa_id AND (e.id = p.id OR e.codigo = lower(p.codigo))
         WHERE c.empresa_id = p.id AND c.revogado_em IS NULL AND c.capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES'
           AND u.ativo AND m.status = 'ATIVA' AND m.papel = 'REPRESENTANTE_AUTORIZADO') AS administradores_elegiveis
  FROM public.perfil_empresas p
 ORDER BY p.id;

ROLLBACK;
