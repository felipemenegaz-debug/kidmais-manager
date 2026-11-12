import AbaDocumento from './modelo-contrato/AbaDocumento';
import ImportacaoTabelaPrecos from './ImportacaoTabelaPrecos';
import ModeloContrato from './ModeloContrato';
import ImportacaoContrato from './importacao/ImportacaoContrato';
import css from './importar-documentos.module.css';

/**
 * Importar documentos (pedido de Felipe, 23/10/2026): a tabela de preços, o modelo de contrato e o contrato antigo de
 * uma festa chegam em PDF, são lidos pela IA e revisados antes de valer — a mesma entrada em Configurações, uma aba por
 * documento. Cada aba é a tela que já existia (mesmos serviços e permissões): "Contrato de festa" é o mesmo fluxo de
 * Contratos › Importar contrato antigo. As rotas antigas de tabela e modelo redirecionam para cá.
 */
export type DocumentoImportado = 'tabela' | 'contrato' | 'festa';

export const ABAS: ReadonlyArray<{ documento: DocumentoImportado; rotulo: string; descricao: string }> = [
  { documento: 'tabela', rotulo: 'Tabela de preços', descricao: 'Pacotes, preços e adicionais' },
  { documento: 'contrato', rotulo: 'Modelo de contrato', descricao: 'O contrato no padrão da empresa' },
  { documento: 'festa', rotulo: 'Contrato de festa', descricao: 'Contrato antigo de uma festa' },
];

export function documentoDaUrl(valor: string | string[] | undefined): DocumentoImportado {
  return valor === 'contrato' || valor === 'festa' ? valor : 'tabela';
}

export default function ImportarDocumentos({ documento }: { documento: DocumentoImportado }) {
  return <>
    <nav className={css.abas} aria-label="Importar documentos" data-importar-documentos>
      <span className={css.titulo}>Importar documentos</span>
      <div className={css.lista}>
        {ABAS.map((aba) => <AbaDocumento key={aba.documento} href={`/admin/configuracoes/importar-documentos?documento=${aba.documento}`}
          className={css.aba} aria-current={aba.documento === documento ? 'page' : undefined}>
          <strong>{aba.rotulo}</strong><span>{aba.descricao}</span>
        </AbaDocumento>)}
      </div>
    </nav>
    {documento === 'contrato' ? <ModeloContrato /> : documento === 'festa' ? <ImportacaoContrato /> : <ImportacaoTabelaPrecos />}
  </>;
}
