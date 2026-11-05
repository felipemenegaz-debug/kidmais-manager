import Link from "next/link";
import ContatoEmpresa from "@/components/fechamento/ContatoEmpresa";
import FestaDecoracao from "@/components/fechamento/FestaDecoracao";
import { MarcaPublicaCabecalho, MarcaPublicaProvider } from "@/components/fechamento/MarcaPublica";
import { paginaPublica } from "@/lib/fechamentos/rota-publica";
import base from "@/components/disponibilidade/DisponibilidadePublica.module.css";
import styles from "./pagina-buffet.module.css";
import { exigirEmpresaPublica, metadataEmpresaPublica } from "./empresa-publica";

export const dynamic = "force-dynamic";
export const metadata = metadataEmpresaPublica;

/**
 * Página inicial do buffet: /b/<código>. Abre só quando o servidor atenderia a cotação da empresa (mesma regra das
 * demais páginas /b/); qualquer recusa é 404. O pedido de orçamento (/b/<código>/orcamento) sempre começa pela
 * consulta de datas (a tela de orçamento devolve para ela sem data escolhida), então a página leva para lá.
 * O login da equipe é o compartilhado do produto; o endereço público nunca dá acesso ao painel.
 */
export default async function PaginaDoBuffet({ params }: { params: Promise<{ empresa: string }> }) {
  const empresa = await exigirEmpresaPublica(params);
  return (
    <MarcaPublicaProvider nome={empresa.nome} pagamento={empresa.pagamento} contato={empresa.contato}>
      <main className={base.page}>
        <FestaDecoracao />
        <div className={base.shell}>
          <header className={base.header}>
            <MarcaPublicaCabecalho subtitle="Festas e eventos" />
          </header>

          <section className={base.hero}>
            <p className={base.eyebrow}>Planeje sua comemoração</p>
            <h1>{empresa.nome}</h1>
            <p>Consulte as datas livres na agenda do buffet e peça o orçamento da sua festa por aqui.</p>
          </section>

          <section className={styles.cartao} aria-labelledby="como-funciona">
            <h2 id="como-funciona">Como funciona</h2>
            <ol className={styles.passos}>
              <li><strong>Convidados e data</strong><span>Diga quantos convidados e veja os dias e horários livres.</span></li>
              <li><strong>Pacote</strong><span>Escolha o pacote que cabe na sua festa.</span></li>
              <li><strong>Pedido de orçamento</strong><span>Envie seus dados; o buffet confirma com você.</span></li>
            </ol>
            <Link className={styles.principal} href={paginaPublica("/disponibilidade", empresa.codigo)}>Ver datas e pedir orçamento →</Link>
            <ContatoEmpresa nome={empresa.nome} contato={empresa.contato} titulo="Fale com o buffet" />
          </section>
        </div>
      </main>
    </MarcaPublicaProvider>
  );
}
