/**
 * B-9 production (plano rev. 5 §2.6): captura os retratos APROVADOS de assinatura_renovacoes no PG DESCARTÁVEL — 075 = modelo
 * 108 (cadeia do repositório, sem a 098 histórica) e 109 = o mesmo com o precheck e a migration 109 (sem o postcheck, que é
 * gerado deste retrato). Grava lib/assinatura/renovacao-schema-retratos.ts e, depois, scripts/gerar-postcheck-109.mjs gera o
 * postcheck. Exige o opt-in do descartável (mesma autorização das suítes). Nunca conecta em banco real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const exigir = createRequire(import.meta.url);
const raiz = path.resolve(import.meta.dirname, '..');
const receita = exigir('./regressao-v1-postgres-receita.cjs');
const { exigirOptInDescartavel } = exigir('./regressao-v1-selecao.cjs');
const { lerRetrato } = await import('../lib/assinatura/renovacao-schema.ts');

exigirOptInDescartavel(process.env);
const ler = (r) => fs.readFileSync(path.join(raiz, r), 'utf8');
const { porta, admin } = await receita.conectarAdmin(process.env);
const [trabalho] = receita.TRABALHO;
const retratos = {};
try {
    await receita.construirModelo(admin, porta, '108');
    for (const versao of ['075', '109']) {
        await receita.removerBanco(admin, trabalho);
        await receita.restaurar(admin, trabalho, '108');
        const c = await receita.conectar(porta, trabalho);
        try {
            if (versao === '109') {
                await c.query(ler('database/checks/20261029_109_precheck.sql'));
                await c.query(ler('database/migrations/20261029_109_renovacao_substituta.sql'));
            }
            retratos[versao] = await lerRetrato(c);
            const versaoPg = (await c.query("SELECT current_setting('server_version_num') AS v")).rows[0].v;
            retratos.versaoPg = versaoPg;
        } finally { await c.end(); }
    }
    await receita.removerBanco(admin, trabalho);
} finally { await admin.end(); }
const js = (o) => JSON.stringify(o, null, 4).replace(/\n/g, '\n');
const saida = `import type { Retrato } from './renovacao-schema.ts';

/**
 * Retratos APROVADOS de assinatura_renovacoes — GERADOS por scripts/capturar-retratos-renovacao.mjs no PG DESCARTÁVEL
 * (PostgreSQL ${retratos.versaoPg}): 075 = cadeia do repositório até a 108 (sem a 098); 109 = a mesma com a 109. Não editar à mão.
 * A conferência contra o catálogo real (staging/production, versão do PG, CRLF) é gate futuro e nunca aprova desvio.
 */
export const RETRATO_075: Retrato = ${js(retratos['075'])};

export const RETRATO_109: Retrato = ${js(retratos['109'])};
`;
fs.writeFileSync(path.join(raiz, 'lib/assinatura/renovacao-schema-retratos.ts'), saida);
console.log(`retratos capturados (PG ${retratos.versaoPg}): 075 ${retratos['075'].constraints.length} constraints, 109 ${retratos['109'].constraints.length} constraints`);
