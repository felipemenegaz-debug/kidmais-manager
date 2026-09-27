export const CAPACIDADES_PERFIL = [
    'PERFIL_CONSULTAR',
    'PERFIL_EDITAR_RASCUNHO',
    'PERFIL_APLICAR',
    'PERFIL_ADMINISTRAR_CONCESSOES',
] as const;

export type CapacidadePerfil = (typeof CAPACIDADES_PERFIL)[number];

export function capacidadePerfil(valor: string): CapacidadePerfil | null {
    return (CAPACIDADES_PERFIL as readonly string[]).includes(valor) ? valor as CapacidadePerfil : null;
}
