/**
 * Corte do motor legado dos Convites para o motor de créditos (090), POR EMPRESA, com simulação e aplicação explícitas
 * (scripts/creditos-corte-legado.cjs). Nunca roda no startup nem no deploy. Exige autorização de dados própria.
 *
 *   - trava convite_carteiras da empresa (a mesma trava da geração legada: geração concorrente espera e, ao continuar,
 *     reconfere o motor e recusa — lib/convites/service.ts);
 *   - recusa se houver geração RESERVADA ou INCERTA (reconciliar antes; nenhuma reserva legada atravessa o corte);
 *   - fotografa o mês de São Paulo: limite (se ativo) e usado; cria a carteira CONVITES (corte_em) e o lote LEGADO de
 *     max(0, limite − usado), com vencimento no fim do mês (a franquia legada não acumulava);
 *   - registra ia_credito_cortes (uma vez por empresa: idempotente; repetir devolve o corte existente);
 *   - empresa sem linha em convite_carteiras continua sem direito (lote zero, nenhuma franquia retroativa).
 * Depois do corte, a franquia mensal seguinte vem do worker (lib/creditos/manutencao.ts) com o MESMO limite legado
 * configurado — nenhuma franquia proposta (5/15/30) é aplicada sem decisão.
 */
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { fimDoMesBrasilia, mesBrasilia } from './dominio.ts';
import { abrirCarteira, creditarLote, exigirInstalados, lerCarteira } from './ledger.ts';

export type Simulacao = { elegivel: boolean; motivo: string | null; jaCortada: boolean; mes: string; limiteMensal: number; usado: number; quantidadeLegado: number; geracoesAbertas: number };

async function fotografia(tx: DbExecutor, empresaId: string, travar: boolean) {
    const agora = Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
    const w = (await tx.query<{ limite_mensal: number; ativo: boolean }>(`SELECT limite_mensal, ativo FROM convite_carteiras WHERE empresa_id = $1::uuid ${travar ? 'FOR UPDATE' : ''}`,
        [empresaId])).rows[0];
    const mes = mesBrasilia(agora);
    const usado = Number((await tx.query<{ usado: number }>('SELECT usado FROM convite_consumos WHERE empresa_id = $1::uuid AND mes = $2::date', [empresaId, mes])).rows[0]?.usado ?? 0);
    const abertas = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM convite_geracoes WHERE empresa_id = $1::uuid AND estado IN ('RESERVADA', 'INCERTA')",
        [empresaId])).rows[0].n);
    const limite = w?.ativo ? Number(w.limite_mensal) : 0;
    return { agora, mes, limite, usado, abertas };
}

export async function simularCorte(tx: DbExecutor, empresaId: string): Promise<Simulacao> {
    await exigirInstalados(tx);
    const f = await fotografia(tx, empresaId, false);
    const jaCortada = Boolean(await lerCarteira(tx, empresaId, 'CONVITES'));
    const empresa = (await tx.query('SELECT 1 FROM empresas WHERE id = $1::uuid', [empresaId])).rows.length > 0;
    const motivo = !empresa ? 'EMPRESA_NAO_ENCONTRADA' : jaCortada ? 'JA_CORTADA' : f.abertas > 0 ? 'GERACOES_ABERTAS' : null;
    return { elegivel: motivo === null, motivo, jaCortada, mes: f.mes, limiteMensal: f.limite, usado: f.usado, quantidadeLegado: Math.max(0, f.limite - f.usado), geracoesAbertas: f.abertas };
}

export async function aplicarCorte(tx: DbExecutor, empresaId: string, referenciaAutorizacao: string) {
    await exigirInstalados(tx);
    if (!/^[A-Za-z0-9:._/ -]{6,120}$/.test(referenciaAutorizacao)) throw new Error('REFERENCIA_AUTORIZACAO_INVALIDA');
    // Trava da empresa PRIMEIRO (mesma ordem da geração: empresa → convite → convite_carteiras). A geração do cliente e a do
    // buffet (provarTenant) travam a empresa FOR UPDATE no início: com o corte segurando FOR SHARE, uma espera a outra inteira
    // e a geração seguinte já vê o motor certo. Sem esta trava, o corte seguraria convite_carteiras e só depois pediria
    // KEY SHARE na empresa (FK da carteira nova) — ordem inversa e deadlock com uma geração legada em curso.
    if (!(await tx.query('SELECT 1 FROM empresas WHERE id = $1::uuid FOR SHARE', [empresaId])).rows.length) throw new Error('EMPRESA_NAO_ENCONTRADA');
    const f = await fotografia(tx, empresaId, true);
    const existente = (await tx.query<{ id: string; quantidade_legado: string }>("SELECT id, quantidade_legado FROM ia_credito_cortes WHERE empresa_id = $1::uuid AND recurso = 'CONVITES'",
        [empresaId])).rows[0];
    if (existente) return { repetido: true, corteId: existente.id, quantidadeLegado: Number(existente.quantidade_legado) };
    if (f.abertas > 0) throw new Error('GERACOES_ABERTAS');
    const corteId = randomUUID();
    const corteEm = new Date(f.agora).toISOString();
    await abrirCarteira(tx, empresaId, 'CONVITES', corteEm);
    const quantidade = Math.max(0, f.limite - f.usado);
    let loteId: string | null = null;
    if (quantidade > 0)
        loteId = (await creditarLote(tx, { empresaId, recurso: 'CONVITES', origem: 'LEGADO', chaveOrigem: `LEGADO:${corteId}`, quantidade,
            venceEm: fimDoMesBrasilia(f.agora), ator: 'PLATAFORMA' })).loteId;
    await tx.query(`INSERT INTO ia_credito_cortes (id, empresa_id, recurso, mes, limite_mensal, usado, quantidade_legado, lote_id, referencia_autorizacao)
        VALUES ($1::uuid, $2::uuid, 'CONVITES', $3::date, $4, $5, $6, $7::uuid, $8)`, [corteId, empresaId, f.mes, f.limite, f.usado, quantidade, loteId, referenciaAutorizacao]);
    return { repetido: false, corteId, quantidadeLegado: quantidade };
}
