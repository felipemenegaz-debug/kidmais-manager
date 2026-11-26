-- SOMENTE LEITURA. Gerado por scripts/gerar-diagnostico-lacunas.mjs a partir do catálogo das versões publicadas e das
-- vigentes; não editar à mão. Execução fora do PostgreSQL descartável exige autorização própria.
-- Resultado: aceites e pedidos de cadastro com versão/hash FORA do catálogo (agrupados, sem pessoas nem empresas).
-- Com a 096 instalada, conferir também se o hash está em documentos_legais_versoes antes de declarar lacuna.
BEGIN TRANSACTION READ ONLY;
WITH conhecidos(documento, versao, hash) AS (VALUES
  ('DPA', '2026-10-22-minuta2', '17615a3e43e94bf6b18c1f5b0f26d438e443a8339c1df25572bd8d3ef0d5205a'),
  ('DPA', '2026-11-15-dpa', '6e656df23759f462e083977094b6e5aa77730a6998d8be0467906f0e8e22aca4'),
  ('PRIVACIDADE', '2026-10-07-minuta', '4243d589c1a47ddeff5eebee197ba9600f94c334fa2f85bd964b779d398e6cf0'),
  ('PRIVACIDADE', '2026-10-13-minuta', 'f86da4d4521931af5221a2268a3291967fd5f04c7016e309ddb17d8879d69940'),
  ('PRIVACIDADE', '2026-10-15-minuta4', '0b2e6d8cd7aa76672c757fc8b1537cd77baaea0bb8c5675bcb6a986c81780ae4'),
  ('PRIVACIDADE', '2026-10-20-minuta5', '06e7b9a5098bd8f6325bca15a67cb472668a7fa5f487df2e08e957e365c2bfcf'),
  ('PRIVACIDADE', '2026-10-21-minuta5a', 'fda552f33b3c5cdd3a211feab1a86e071f25b8676f8110123b70aac0ecc60514'),
  ('PRIVACIDADE', '2026-10-22-minuta7', '56bb53751aad6ee1d87f54c6c7c5e6e26748858e8e6e5c824938433a3db1d6fe'),
  ('PRIVACIDADE', '2026-11-15-privacidade', '73912002038a4e1e5573203c7392ee84c747fc2ea35c33ee2cd145bcf96ee9a3'),
  ('TERMOS_USO', '2026-10-07-minuta', 'a87f57c1171e03930cf0b0d10f846d571370264372791d27efa20fa7c02f5918'),
  ('TERMOS_USO', '2026-10-13-minuta', 'b79f469969a540bd7a644565745756bf3ccc62e0c470be1a3b6a398805d3b37d'),
  ('TERMOS_USO', '2026-10-20-minuta', '8568c1afe40d681e7b32de5b093c6e015cea791b482df188d7433fe9487dfb6b'),
  ('TERMOS_USO', '2026-10-23-minuta4', '63e8f8f4ada7b764c3960b311668f6e24f32d39c49b5a37d838c8ca1b36ff0e3'),
  ('TERMOS_USO', '2026-11-15-termos', '738588abe9f6177d8db5faa708697b31a69faeefb2ba5a6fcd956383c8b8fb21'),
  ('TERMOS_USO', '2026-11-17-termos', '5d9e561433abfc3ff63620221c9e51d848c9136999df24058c6d2db5bf4df918'),
  ('TERMOS_USO', '2026-11-25-termos', 'aaf1725fd0475a73bf4717fb551e8d54d271811556105be73cce669fcf1f33bc'),
  ('PRIVACIDADE', '2026-11-17-privacidade', 'a2b4994f3272e88f20ee695c949cae5532dc243ee1d69d4e9da2afae3da20e43'),
  ('DPA', '2026-11-17-dpa', '3b78ffa320658f58ec8277f9385a42908cfeb8618632a00a50a4da9e4e6f5fde')
), usados AS (
  SELECT 'ACEITE'::text AS origem, documento, versao, hash_conteudo::text AS hash FROM aceites_documentos_legais
  UNION ALL SELECT 'PEDIDO_TERMOS', 'TERMOS_USO', termos_versao, termos_hash::text FROM cadastros_publicos
  UNION ALL SELECT 'PEDIDO_PRIVACIDADE', 'PRIVACIDADE', privacidade_versao, privacidade_hash::text FROM cadastros_publicos
)
SELECT u.origem, u.documento, u.versao, u.hash, count(*)::int AS ocorrencias
  FROM usados u
 WHERE NOT EXISTS (SELECT 1 FROM conhecidos c WHERE c.documento = u.documento AND c.versao = u.versao AND c.hash = u.hash)
 GROUP BY u.origem, u.documento, u.versao, u.hash
 ORDER BY 1, 2, 3, 4;
ROLLBACK;
