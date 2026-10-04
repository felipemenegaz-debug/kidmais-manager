import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

/**
 * Só para testes unitários: carrega um módulo TypeScript real (transpilado para CommonJS) com dependências
 * dubladas por caminho. Mesma técnica de lib/autenticacao/usuarios.test.ts. Nunca abre banco: qualquer import de
 * lib/db/postgres sem dublê falha de propósito.
 */
const req = createRequire(import.meta.url);

export function carregarModulo(arquivo: string, dubles: Record<string, unknown>, cache = new Map<string, Record<string, unknown>>()): Record<string, unknown> {
    const absoluto = path.resolve(arquivo).replace(/\\/g, '/');
    const existente = cache.get(absoluto);
    if (existente)
        return existente;
    const exports: Record<string, unknown> = {};
    cache.set(absoluto, exports);
    const code = ts.transpileModule(readFileSync(absoluto, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const dir = path.dirname(absoluto);
    const raiz = process.cwd().replace(/\\/g, '/');
    new Function('require', 'exports', 'module', code)((nome: string) => {
        if (nome.startsWith('node:') || nome === 'zod' || nome === 'typescript')
            return req(nome);
        let resolvido: string | null = null;
        if (nome.startsWith('.'))
            resolvido = path.join(dir, nome).replace(/\\/g, '/');
        else if (nome.startsWith('@/'))
            resolvido = `${raiz}/${nome.slice(2)}`;
        const chave = resolvido ? resolvido.replace(/\.(ts|tsx)$/, '') : nome;
        for (const [padrao, duble] of Object.entries(dubles)) {
            if (chave === padrao || chave.endsWith(`/${padrao}`))
                return duble;
        }
        if (resolvido) {
            if (/\/db\/postgres$/.test(chave))
                throw new Error(`teste sem dublê para o banco: ${nome}`);
            for (const ext of ['.ts', '.tsx']) {
                try {
                    readFileSync(`${chave}${ext}`);
                    return carregarModulo(`${chave}${ext}`, dubles, cache);
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
            }
        }
        return req(nome);
    }, exports, { exports });
    return exports;
}

/** Executor falso: responde por expressão regular sobre o SQL e registra tudo o que foi executado. */
export function executorFalso(respostas: Array<[RegExp, (params: unknown[]) => unknown[]]>) {
    const executados: Array<{ sql: string; params: unknown[] }> = [];
    return {
        executados,
        async query(sql: string, params: unknown[] = []) {
            executados.push({ sql, params });
            for (const [padrao, resposta] of respostas) {
                if (padrao.test(sql))
                    return { rows: resposta(params), rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        },
    };
}
