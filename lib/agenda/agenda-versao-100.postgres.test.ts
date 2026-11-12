/**
 * Mesma matriz de agenda-versao.postgres.test.ts no estado do staging (modelo 097 + migration 100 aplicada pela suíte).
 * 098 + 100 não é estado suportado; a 098 roda na variante do modelo 098 da suíte principal.
 * Conexão só pelo cluster descartável (../comercial/postgres-descartavel.ts), como a suíte principal.
 */
import "../comercial/postgres-descartavel.ts";

process.env.KIDMAIS_AGENDA_VERSAO_COM_100 = "1";
await import("./agenda-versao.postgres.test.ts");
