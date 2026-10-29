import { createHash } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { processarEventoCreditos, processarPedido, type ContextoProvedor } from '../creditos/pagamento.ts';
import type { ProvedorCreditos } from './asaas.ts';
import { aplicarCaso, LimpezaDoCasoFalhou, proporCaso, type DepsCaso } from './recuperacao-caso.ts';
import { fotografar, regravarDoInstante } from './recuperacao-fotografia.ts';
import type { Proposta } from './recuperacao-hash.ts';
import { provedorSomenteLeitura } from './recuperacao-provedor.ts';
import { codigoErro, processarEvento, sincronizarEmpresa, type ContextoCreditos, type ProvedorLeitura } from './sincronizacao.ts';
import type { Fotografia } from './recuperacao-efeitos.ts';

/**
 * B-14 (plano rev. 8.1, §3.1, §3.4, §4): liga o caso ao processamento normal. O mesmo serviço de web/cron roda em cada
 * caso, sempre com o provedor SOMENTE LEITURA da lista fechada:
 *   - EMPRESA → `sincronizarEmpresa`;
 *   - EVENTO (`PENDENTE`/`FALHOU`) → `processarEvento`;
 *   - PEDIDO de créditos → `processarPedido`;
 *   - COBRANCA não canônica (duplicidade) → `processarExtra`, pelo mesmo ponto do webhook (`processarEventoCreditos`): revisão do
 *     Astra do incremento 4 (P2-1) — a cobrança extra paga é lida mesmo sem evento na janela.
 * No RESTORE os créditos usam a data do pagamento como base da validade (D-B14-15); na JANELA, as regras da candidata.
 * A auditoria sai com origem `RECUPERACAO_B14` (requestId = execução; caso = identidade estável), também no caminho do evento.
 */
export type TipoCaso = 'EMPRESA' | 'EVENTO' | 'PEDIDO' | 'COBRANCA';
export type Caso = { tipo: TipoCaso; id: string; empresaId: string };
export type ModoRecuperacao = 'JANELA' | 'RESTORE';

/** Identidade estável (§3.5): sha-256 de tipo + id interno, sem o motivo. Também é o `caso` gravado na auditoria. */
export function identidadeDoCaso(tipo: string, id: string) {
    return createHash('sha256').update(`${tipo}:${id}`).digest('hex');
}

export type ContextoRecuperacao = {
    tx: DbExecutor;
    /** Id da execução (uuid): vira `request_id` da auditoria. */
    execucao: string;
    modo: ModoRecuperacao;
    /** Cliente Asaas real ou dublê: só os métodos da lista fechada chegam aos serviços. */
    cliente: object;
    creditos?: ContextoCreditos;
    /** Tabelas presentes no schema (lidas uma vez por execução). */
    presentes?: readonly string[];
};

type ProvedorDoCaso = ProvedorLeitura & Partial<ProvedorCreditos>;

/** Monta as dependências do caso. Falta de leitura obrigatória ou de contexto de créditos é falha de configuração. */
export function depsDoCaso(ctx: ContextoRecuperacao, caso: Caso): DepsCaso<ProvedorDoCaso> {
    const provedor = provedorSomenteLeitura(ctx.cliente) as unknown as ProvedorDoCaso;
    if (!provedor.obterAssinatura || !provedor.listarCobrancasDaAssinatura) throw new Error('Provedor sem as leituras da assinatura.');
    const creditos: ContextoCreditos | undefined = ctx.creditos && (ctx.modo === 'RESTORE' ? { ...ctx.creditos, baseValidade: 'PAGAMENTO' } : { ...ctx.creditos });
    const id = identidadeDoCaso(caso.tipo, caso.id);
    const origem = { tipo: 'RECUPERACAO_B14' as const, requestId: ctx.execucao, caso: id };
    const executar = (p: ProvedorDoCaso): Promise<unknown> => {
        if (caso.tipo === 'EMPRESA') return sincronizarEmpresa(ctx.tx, caso.id, { provedor: p }, origem);
        if (caso.tipo === 'EVENTO') return processarEvento(ctx.tx, caso.id, { provedor: p, creditos, origem });
        if (!creditos || !p.obterCobranca || !p.listarCobrancasPorReferencia) throw new Error('Caso de créditos sem contexto ou sem leituras de cobrança.');
        const c: ContextoProvedor = { provedor: { obterCobranca: p.obterCobranca, listarCobrancasPorReferencia: p.listarCobrancasPorReferencia }, ...creditos };
        if (caso.tipo === 'COBRANCA') return processarEventoCreditos(ctx.tx, { cobrancaProvedorId: null, referenciaExterna: null }, { pedidoId: '', cobrancaId: caso.id, canonica: false }, c);
        return processarPedido(ctx.tx, caso.id, c);
    };
    return {
        tx: ctx.tx,
        caso: id,
        provedor,
        fotografar: () => fotografar(ctx.tx, { empresaId: caso.empresaId, eventoIds: caso.tipo === 'EVENTO' ? [caso.id] : [] }, ctx.presentes),
        executar,
    };
}

export type PropostaDoCaso =
    | { caso: Caso; identidade: string; falha: null; proposta: Proposta; hash: string; semEfeito: boolean; resultado: unknown; antes: Fotografia }
    /** O serviço recusou o caso com erro (ex.: FUNDADOR_DIVERGENTE): nada a propor; o SAVEPOINT já foi desfeito. */
    | { caso: Caso; identidade: string; falha: string; proposta: null; hash: null; semEfeito: false; resultado: null; antes: null };

/** Inventário de um caso: proposta completa ou a falha do serviço (código sanitizado, sem mensagem). Nada fica gravado. */
export async function proporCasoReal(ctx: ContextoRecuperacao, caso: Caso): Promise<PropostaDoCaso> {
    const deps = depsDoCaso(ctx, caso);
    try {
        const r = await proporCaso(deps);
        return { caso, identidade: deps.caso, falha: null, ...r };
    }
    catch (error) {
        // Falha da limpeza do SAVEPOINT não é falha do caso: sobe para o chamador desfazer a transação externa (D1).
        if (error instanceof LimpezaDoCasoFalhou) throw error;
        return { caso, identidade: deps.caso, falha: codigoErro(error), proposta: null, hash: null, semEfeito: false, resultado: null, antes: null };
    }
}

/** `aplicar-caso` (§3.4): T2 com os valores do instante aprovados; só fica gravado com hash idêntico. */
export async function aplicarCasoReal(ctx: ContextoRecuperacao, caso: Caso, aprovado: { hash: string; proposta: Proposta }) {
    const deps = depsDoCaso(ctx, caso);
    return aplicarCaso({ ...deps, regravar: (valores) => regravarDoInstante(ctx.tx, valores) }, aprovado);
}
