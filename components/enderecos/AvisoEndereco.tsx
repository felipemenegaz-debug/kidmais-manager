'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { assinarAviso, estadoAviso, iniciarAcompanhamento, resultadosDaTelaMantida, type EstadoAviso } from '@/lib/enderecos/cliente';
import { AVISO_SEM_RESPOSTA, varianteDaRota } from './variante-aviso';

const faixa = { position: 'sticky', top: 0, zIndex: 1000, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 16px', background: '#151B2E', color: '#F4F4F8', borderBottom: '2px solid #F59E0B', fontSize: 14, lineHeight: 1.4 } as const;
const botaoEstilo = { padding: '8px 14px', borderRadius: 8, border: '1px solid #F59E0B', background: 'transparent', color: '#F4F4F8', font: 'inherit', cursor: 'pointer' } as const;

/**
 * Montado só nas árvores que dependem da origem do painel; nunca no layout raiz. Falha na consulta = nenhum aviso, e o
 * aviso não navega sozinho: quem atualiza é a pessoa, depois de copiar o que precisar.
 */
export default function AvisoEndereco() {
    const caminho = usePathname();
    const [estado, setEstado] = useState<EstadoAviso>('NENHUM');
    const [resultados, setResultados] = useState<string[]>([]);
    useEffect(() => {
        const atualizar = () => { setEstado(estadoAviso()); setResultados(resultadosDaTelaMantida()); };
        const cancelar = assinarAviso(atualizar);
        const parar = iniciarAcompanhamento();
        atualizar();
        return () => { cancelar(); parar(); };
    }, []);
    if (estado === 'NENHUM') return null;
    const doResultado = resultados.map((r) => <span key={r} data-aviso-endereco-resultado style={{ flex: '1 1 100%' }}>{r}</span>);
    if (estado === 'SEM_RESPOSTA') return <div role="status" data-aviso-endereco="sem-resposta" style={faixa}><span>{AVISO_SEM_RESPOSTA}</span>{doResultado}</div>;
    const { texto, botao } = varianteDaRota(caminho);
    return <div role="alert" data-aviso-endereco="mudou" style={faixa}>
        <span style={{ flex: '1 1 240px' }}>{texto}</span>
        {botao && <button type="button" style={botaoEstilo} onClick={() => window.location.reload()}>Atualizar página</button>}
        {doResultado}
    </div>;
}
