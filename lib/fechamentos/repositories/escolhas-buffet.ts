import type {DbExecutor} from '../../db/contracts';
export const colunasEscolhas=['buffet_lembrancinha','buffet_empratado','buffet_bombom'];
/** Compatibilidade de leitura/escrita enquanto a 016 permanece restrita aos clones. */
export async function escolhasDisponiveis(tx:DbExecutor){return (await tx.query<{ok:boolean}>("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='buffet_lembrancinha') ok")).rows[0].ok;}
