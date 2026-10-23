import Link from 'next/link';
import ImportacaoTabelaPrecos from './ImportacaoTabelaPrecos';
import ModeloContrato from './ModeloContrato';
import css from './importar-documentos.module.css';

/**
 * Importar documentos (pedido de Felipe, 23/10/2026): a tabela de preços e o modelo de contrato chegam em PDF, são
 * lidos pela IA e revisados antes de publicar — a mesma entrada em Configurações, uma aba por documento. Cada aba é a
 * tela que já existia (mesmos serviços e permissões); as rotas antigas redirecionam para cá.
 */
export type DocumentoImportado = 'tabela' | 'contrato';

export const ABAS: ReadonlyArray<{ documento: DocumentoImportado; rotulo: string; descricao: string }> = [
  { documento: 'tabela', rotulo: 'Tabela de preços', descricao: 'Pacotes, preços e adicionais' },
  { documento: 'contrato', rotulo: 'Modelo de contrato', descricao: 'O contrato no padrão da empresa' },
];

export function documentoDaUrl(valor: string | string[] | undefined): DocumentoImportado {
  return valor === 'contrato' ? 'contrato' : 'tabela';
}

export default function ImportarDocumentos({ documento }: { documento: DocumentoImportado }) {
  return <>
    <nav className={css.abas} aria-label="Importar documentos" data-importar-documentos>
      <span className={css.titulo}>Importar documentos</span>
      <div className={css.lista}>
        {ABAS.map((aba) => <Link key={aba.documento} href={`/admin/configuracoes/importar-documentos?documento=${aba.documento}`}
          className={css.aba} aria-current={aba.documento === documento ? 'page' : undefined}>
          <strong>{aba.rotulo}</strong><span>{aba.descricao}</span>
        </Link>)}
      </div>
    </nav>
    {documento === 'contrato' ? <ModeloContrato /> : <ImportacaoTabelaPrecos />}
  </>;
}
