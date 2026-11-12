/**
 * Diagnóstico de lacunas dos aceites (revisão 9b84bd9): consulta SOMENTE LEITURA que lista, agrupado e sem identificar
 * pessoas ou empresas, os aceites e pedidos de cadastro cuja versão/hash NÃO está no catálogo conhecido (versões
 * publicadas reconstruídas do Git + vigentes). Hash fora do catálogo = texto não comprovado: localizar pelo hash ou
 * documentar como irrecuperável; nunca trocar pelo vigente nem fabricar aceite. Gerado para
 * database/checks/diagnostico_lacunas_aceites.sql (scripts/gerar-diagnostico-lacunas.mjs); a execução fora do banco
 * descartável exige autorização própria. Com a 096 instalada, comparar também com documentos_legais_versoes.
 */
import { VERSOES_PUBLICADAS } from './documentos-legais-historico.ts';
import { DOCUMENTOS, hashDocumento } from './documentos-legais.ts';

export function sqlDiagnosticoLacunas() {
    const conhecidos = [...VERSOES_PUBLICADAS.map((v) => [v.documento, v.versao, v.hash]),
        ...Object.values(DOCUMENTOS).map((d) => [d.documento, d.versao, hashDocumento(d)])];
    for (const linha of conhecidos) for (const v of linha) if (!/^[A-Za-z0-9_.-]+$/.test(v)) throw new Error('valor inesperado no catálogo: ' + v);
    return `-- SOMENTE LEITURA. Gerado por scripts/gerar-diagnostico-lacunas.mjs a partir do catálogo das versões publicadas e das
-- vigentes; não editar à mão. Execução fora do PostgreSQL descartável exige autorização própria.
-- Resultado: aceites e pedidos de cadastro com versão/hash FORA do catálogo (agrupados, sem pessoas nem empresas).
-- Com a 096 instalada, conferir também se o hash está em documentos_legais_versoes antes de declarar lacuna.
BEGIN TRANSACTION READ ONLY;
WITH conhecidos(documento, versao, hash) AS (VALUES
${conhecidos.map(([d, v, h]) => `  ('${d}', '${v}', '${h}')`).join(',\n')}
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
`;
}
