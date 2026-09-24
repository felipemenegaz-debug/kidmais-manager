import type { Papel } from './service.ts';

export type NivelSistema = 'GESTAO' | 'EQUIPE';

export function nomePapelSistema(papel: Papel | string) {
    return papel === 'REPRESENTANTE_AUTORIZADO' ? 'Gestão' : 'Equipe';
}

export function papelDeNivel(nivel: NivelSistema): Papel {
    return nivel === 'GESTAO' ? 'REPRESENTANTE_AUTORIZADO' : 'ADMINISTRATIVO';
}
