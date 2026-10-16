'use client';
import { createContext, useContext } from 'react';
import type { PermissoesNavegacao } from '@/lib/admin/navegacao';

/** Permissões de navegação já calculadas pelo AdminShell (D7), para telas que listam destinos (hub de Configurações). */
export const PermissoesAdminContext = createContext<PermissoesNavegacao | null>(null);

export function usePermissoesAdmin() {
    return useContext(PermissoesAdminContext);
}
