/**
 * Cortesia de créditos (090): só o operador autorizado da plataforma (concessão de desenvolvedor travada na transação +
 * senha recente, lib/desenvolvedor/creditos.ts), com motivo, campanha, protocolo e idempotência. A Gestão do buffet não
 * fabrica saldo. Cortesia não gera valor a devolver, não contorna gates jurídicos e não eleva tetos de custo.
 * Campanhas e tetos abaixo são PROPOSTA (piloto de 10 gerações por 60 dias); Wall-e fica fora até a liberação.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import type { Recurso } from './catalogo.ts';
import { gerarProtocolo, PROTOCOLO, vencimentoEmDias } from './dominio.ts';
import { creditarLote, exigirInstalados, lerCarteira } from './ledger.ts';
import { auditarCreditos } from './auditoria.ts';

export type Campanha = { recurso: Recurso; porEmpresa: number; totalCampanha: number; validadeDias: number; proposta: true };
export const CAMPANHAS: Readonly<Record<string, Campanha>> = Object.freeze({
    'PILOTO-CONVITES-20261022': Object.freeze({ recurso: 'CONVITES', porEmpresa: 10, totalCampanha: 200, validadeDias: 60, proposta: true }),
});

export class CortesiaRecusada extends Error {
    readonly motivo: string;
    constructor(motivo: string) { super(`Cortesia recusada: ${motivo}`); this.name = 'CortesiaRecusada'; this.motivo = motivo; }
}

export async function concederCortesia(tx: DbExecutor, operadorId: string, c: { empresaId: string; campanha: string; quantidade: number; motivo: string; chave: string }) {
    await exigirInstalados(tx);
    const campanha = Object.hasOwn(CAMPANHAS, c.campanha) ? CAMPANHAS[c.campanha] : null;
    if (!campanha) throw new CortesiaRecusada('CAMPANHA_DESCONHECIDA');
    if (!Number.isSafeInteger(c.quantidade) || c.quantidade <= 0 || c.quantidade > campanha.porEmpresa) throw new CortesiaRecusada('QUANTIDADE_FORA_DO_TETO');
    const motivo = c.motivo.trim();
    if (motivo.length < 5 || motivo.length > 300) throw new CortesiaRecusada('MOTIVO_OBRIGATORIO');
    const anterior = (await tx.query<{ protocolo: string }>('SELECT protocolo FROM ia_credito_cortesias WHERE empresa_id = $1::uuid AND chave_idempotencia = $2::uuid',
        [c.empresaId, c.chave])).rows[0];
    if (anterior) return { repetida: true, protocolo: anterior.protocolo };
    // Teto da campanha (todas as empresas) e por empresa: trava consultiva por campanha serializa concessões concorrentes.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('ia_credito_cortesia:' || $1::text))", [c.campanha]);
    const uso = (await tx.query<{ total: string; empresa: string }>(`SELECT coalesce(sum(quantidade), 0) AS total,
        coalesce(sum(quantidade) FILTER (WHERE empresa_id = $2::uuid), 0) AS empresa FROM ia_credito_cortesias WHERE campanha = $1`, [c.campanha, c.empresaId])).rows[0];
    if (Number(uso.empresa) + c.quantidade > campanha.porEmpresa) throw new CortesiaRecusada('TETO_DA_EMPRESA');
    if (Number(uso.total) + c.quantidade > campanha.totalCampanha) throw new CortesiaRecusada('TETO_DA_CAMPANHA');
    if (!await lerCarteira(tx, c.empresaId, campanha.recurso, true)) throw new CortesiaRecusada('CARTEIRA_SEM_CORTE');
    const agora = Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
    const id = randomUUID();
    const protocolo = gerarProtocolo(agora, randomBytes(8));
    if (!PROTOCOLO.test(protocolo)) throw new Error('Protocolo inválido.');
    const { loteId } = await creditarLote(tx, { empresaId: c.empresaId, recurso: campanha.recurso, origem: 'CORTESIA', chaveOrigem: `CORTESIA:${id}`, quantidade: c.quantidade,
        venceEm: vencimentoEmDias(agora, campanha.validadeDias), protocolo, ator: 'PLATAFORMA' });
    await tx.query(`INSERT INTO ia_credito_cortesias (id, empresa_id, recurso, lote_id, protocolo, campanha, quantidade, validade_dias, motivo, concedida_por, chave_idempotencia)
        VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10::uuid, $11::uuid)`,
    [id, c.empresaId, campanha.recurso, loteId, protocolo, c.campanha, c.quantidade, campanha.validadeDias, motivo, operadorId, c.chave]);
    await auditarCreditos(tx, { usuarioId: operadorId, acao: 'CREDITOS_CORTESIA_CONCEDIDA', entidadeTipo: 'IA_CREDITO_CORTESIA', entidadeId: id,
        dados: { protocolo, campanha: c.campanha, recurso: campanha.recurso, quantidade: c.quantidade, empresa: c.empresaId } });
    return { repetida: false, protocolo };
}
