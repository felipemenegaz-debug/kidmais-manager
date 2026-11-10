'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { linkWhatsApp } from '@/lib/site/configuracao';
import { codigoSuporte, mensagemSuporte } from '@/lib/suporte/codigo';

/** Id da empresa ativa da sessão confirmada pelo AdminShell (null sem empresa ou na vitrine). Só serve ao código de suporte. */
export const EmpresaSuporteContext = createContext<string | null>(null);

/**
 * Código de suporte da empresa ativa (S3). Sem empresa ativa, não mostra código e o WhatsApp abre com a mensagem padrão.
 * Com `numero`, é o link do WhatsApp: começa com a mensagem sem código (funciona sem JavaScript) e ganha o código
 * quando o navegador termina o cálculo. Nenhum dado pessoal vai no link; só o código.
 */
export default function CodigoSuporte({ numero, rotulo, hrefSemCodigo, mostrarCodigo }: { numero?: string; rotulo?: string; hrefSemCodigo?: string; mostrarCodigo?: boolean }) {
    const empresaId = useContext(EmpresaSuporteContext);
    const [codigo, setCodigo] = useState<{ empresaId: string; valor: string } | null>(null);
    useEffect(() => {
        if (!empresaId) return;
        let vivo = true;
        codigoSuporte(empresaId).then((valor) => { if (vivo) setCodigo({ empresaId, valor }); }, () => {});
        return () => { vivo = false; };
    }, [empresaId]);
    // Troca de empresa: o código calculado para a anterior nunca aparece.
    const atual = codigo && codigo.empresaId === empresaId ? codigo.valor : null;
    if (numero) {
        const href = (atual && linkWhatsApp(numero, mensagemSuporte(atual))) || hrefSemCodigo;
        return href ? <a href={href} target="_blank" rel="noopener noreferrer" data-canal="whatsapp">{rotulo ?? numero}</a> : null;
    }
    if (mostrarCodigo && atual) return <p data-codigo-suporte>Código de suporte da sua empresa: <strong>{atual}</strong></p>;
    return null;
}
