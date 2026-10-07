'use client';
import Link from 'next/link';
import estilos from './AvisoComercial.module.css';

/**
 * Situação comercial da empresa ativa no topo do Admin (E4). Só informa: a barreira é o 402 das APIs.
 * Empresa sem cobrança (Kidmais e as atuais) não mostra nada.
 */
export type ComercialCliente = {
    cobrado: boolean; situacao: string | null; ciclo: 'MENSAL' | 'ANUAL' | null; testeFim: string | null; periodoAtualFim: string | null;
    nivel: 'COMPLETO' | 'SOMENTE_LEITURA' | 'BLOQUEADO'; motivo: string; ate: string | null; agora: string;
};

const DIA = 86_400_000;
export function dataCurta(iso: string | null) {
    if (!iso)
        return '—';
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
}
export function diasAte(ate: string | null, agora: string) {
    if (!ate)
        return null;
    return Math.max(0, Math.ceil((Date.parse(ate) - Date.parse(agora)) / DIA));
}

export function textoComercial(c: ComercialCliente): { tom: 'info' | 'alerta'; texto: string } | null {
    if (!c.cobrado)
        return null;
    const dias = diasAte(c.ate, c.agora);
    const quando = `${dataCurta(c.ate)}${dias !== null ? ` (${dias === 0 ? 'hoje' : dias === 1 ? '1 dia' : `${dias} dias`})` : ''}`;
    if (c.nivel === 'COMPLETO') {
        if (c.motivo === 'TESTE')
            return { tom: dias !== null && dias <= 3 ? 'alerta' : 'info', texto: `Teste grátis até ${quando}.` };
        if (c.motivo === 'REGULARIZACAO')
            return { tom: 'alerta', texto: `Pagamento da assinatura pendente. Regularize até ${quando} para não entrar em modo somente leitura.` };
        if (c.motivo === 'CANCELADA_NO_PERIODO')
            return { tom: 'info', texto: `Assinatura cancelada. O acesso completo continua até ${quando}.` };
        if (c.motivo === 'EXCECAO_COMERCIAL')
            return { tom: 'info', texto: `Acesso liberado pela Kidmais até ${quando}.` };
        return null;
    }
    if (c.nivel === 'SOMENTE_LEITURA')
        return { tom: 'alerta', texto: `Modo somente leitura até ${quando}: consulte e exporte seus dados. Para voltar a editar, assine.` };
    return { tom: 'alerta', texto: 'O acesso aos dados está suspenso até a assinatura. Seus dados continuam guardados.' };
}

export default function AvisoComercial({ comercial }: { comercial: ComercialCliente | null }) {
    const aviso = comercial ? textoComercial(comercial) : null;
    if (!aviso)
        return null;
    const cor = aviso.tom === 'alerta' ? '#FF7A3D' : '#2DD4BF';
    // padding inline: o shell aplica padding-top de 72px aos filhos do conteúdo no celular (espaço do botão do menu).
    return <div role={aviso.tom === 'alerta' ? 'alert' : 'status'} data-aviso-comercial={comercial?.nivel} className={estilos.aviso} style={{ padding: '12px 16px', border: `1px solid color-mix(in srgb, ${cor} 35%, transparent)`, background: `color-mix(in srgb, ${cor} 8%, transparent)` }}>
        <span>{aviso.texto}</span>
        <Link href="/admin/assinatura">Ver assinatura</Link>
    </div>;
}
