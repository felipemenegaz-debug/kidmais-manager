import type { DbExecutor } from '../db/contracts.ts';
import { AvailabilityServiceError } from './services/errors.ts';

/**
 * E2 (venda por assinatura) — regras comerciais e descontos de data em `data/disponibilidade.json`.
 *
 * O arquivo é UM SÓ para a instalação e alimenta a agenda pública (app/api/disponibilidade), que atende uma única
 * empresa (AGENDA_PUBLICA_EMPRESA_ID). Antes, qualquer vínculo de qualquer empresa lia e gravava esse arquivo pela
 * agenda administrativa. Agora só a empresa DONA da agenda pública o vê e altera; para as demais a configuração é
 * vazia e a gravação é recusada.
 *
 * Dona, nesta ordem: AGENDA_PUBLICA_EMPRESA_ID (se for uma empresa existente); a empresa de código `kidmais`; a única
 * empresa não desativada da instalação (ambientes de uma empresa só). Sem nenhuma delas, ninguém altera.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function empresaDonaDaConfigLegada(tx: DbExecutor, env: Record<string, string | undefined> = process.env): Promise<string | null> {
    const configurada = env.AGENDA_PUBLICA_EMPRESA_ID?.trim();
    if (configurada && UUID.test(configurada)) {
        const existe = (await tx.query<{ id: string }>('SELECT id FROM empresas WHERE id = $1::uuid', [configurada])).rows[0];
        if (existe)
            return existe.id;
    }
    const kidmais = (await tx.query<{ id: string }>("SELECT id FROM empresas WHERE codigo = 'kidmais'")).rows[0];
    if (kidmais)
        return kidmais.id;
    const unicas = (await tx.query<{ id: string }>("SELECT id FROM empresas WHERE status <> 'DESATIVADA' LIMIT 2")).rows;
    return unicas.length === 1 ? unicas[0].id : null;
}

export async function ehDonaDaConfigLegada(tx: DbExecutor, empresaComprovada: string, env?: Record<string, string | undefined>) {
    return (await empresaDonaDaConfigLegada(tx, env)) === empresaComprovada;
}

export async function exigirDonaDaConfigLegada(tx: DbExecutor, empresaComprovada: string, env?: Record<string, string | undefined>) {
    if (!await ehDonaDaConfigLegada(tx, empresaComprovada, env)) {
        throw new AvailabilityServiceError(
            'AGENDA_CONFIG_DA_INSTALACAO',
            'Estas regras e descontos valem para a agenda pública da instalação e só podem ser alterados pela empresa dona dela.',
            403,
        );
    }
}
