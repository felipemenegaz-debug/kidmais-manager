import { adicionais, comercial, descricaoPlano, filtrar, planos, precoExibido, valorPlano, visivel, type Ciclo } from '@/lib/site/catalogo';
import { Cadastro, Contato, type ContatoSite } from './elementos';
import { cx } from './estilos';
import CicloPlanos from './CicloPlanos';
import { Calculadora } from './interativos';
import { textoFundador, type TextoFundador } from '@/lib/site/fundador';

/** Itens do plano: "incluído no plano" (aqui) só aparece quando o recurso está disponível (catálogo). */
export function itensVisiveis(plano: (typeof planos)[number]) {
    return filtrar(plano.itens);
}

export default function Planos({ publicado, aberto, contato, fundador = textoFundador({ fase: 'LEGADO' }), cpf = false }: { publicado: boolean; aberto: boolean; contato: ContatoSite; fundador?: TextoFundador; cpf?: boolean }) {
    const moeda = (centavos: number | null) => precoExibido(centavos, publicado);
    const extras = filtrar(adicionais);
    return <section className={cx('block')} id="planos" aria-labelledby="t-planos"><div className={cx('wrap')}>
        <div className={cx('head')}><div className={cx('eyebrow')}>Planos</div><h2 id="t-planos">{publicado ? 'Quanto custa por festa no seu buffet?' : 'Escolha pelo tamanho do seu buffet.'}</h2><p className={cx('lead')}>Preço por empresa (uma unidade). Sem taxa sobre as festas.{visivel(['implantacao']) ? ' Implantação guiada incluída em todos os planos.' : ''}</p></div>
        {publicado && <div data-fundo-proteger><Calculadora planos={planos} publicado={publicado} adicionaisVisiveis={extras.length > 0} /></div>}
        <CicloPlanos>
        <div className={cx('plans')}>{planos.map(plano => <article key={plano.id} className={cx('plan', plano.destaque ? 'featured' : '')} aria-labelledby={`plano-${plano.id}`}>
            {plano.destaque && <span className={cx('flag')}>Profissional em destaque</span>}
            <h3 id={`plano-${plano.id}`}>{plano.nome}</h3><p className={cx('for')}>{descricaoPlano(plano)}</p>
            {(['mensal', 'anual'] as Ciclo[]).map(ciclo => <div key={ciclo} data-valor-ciclo={ciclo} className={cx('cycleValue')}>
                <div className={cx('price', !publicado ? 'priceUndefined' : '')}><span>{moeda(valorPlano(plano, ciclo))}</span>{publicado && <small>/{ciclo === 'anual' ? 'ano' : 'mês'}</small>}</div>
                <p className={cx('price-sub')}>{publicado && ciclo === 'anual' ? <>Total por ano. Equivale a <b>{moeda(Math.round(valorPlano(plano, ciclo) / 12))}/mês</b></>
                    : !fundador.oferta ? (publicado ? 'Valor mensal regular.' : null)
                    : publicado ? <>Fundador: <b>{moeda(valorPlano(plano, ciclo, true))}/mês</b> por {comercial.fundador.meses} meses</> : <>Fundador: <b>Preço a definir</b></>}</p>
            </div>)}
            <ul className={cx('feat')}>{itensVisiveis(plano).map(item => <li key={item.texto} className={cx(item.excluido ? 'no' : item.introducao ? 'lead-in' : '')}>{item.excluido && <span className={cx('srOnly')}>Não incluído: </span>}{item.texto}</li>)}</ul>
            <Cadastro aberto={aberto} destaque={plano.destaque} contato={contato}>Testar o {plano.nome}{plano.destaque && <span aria-hidden="true">↗</span>}</Cadastro>
        </article>)}</div></CicloPlanos>
        {extras.length > 0 && <div className={cx('extras')}><div className={cx('panel')} role="group" aria-labelledby="t-add"><h3 id="t-add">Adicionais</h3><div className={cx('addons')}>{extras.map(adicional => <div key={adicional.nome} className={cx('addon')}>
            <b>{adicional.nome}</b><span className={cx('v')}>{moeda(adicional.centavos)}{publicado && adicional.centavos !== null && <small> {adicional.periodo}</small>}</span><p>{adicional.descricao}</p>
        </div>)}</div></div></div>}
        {/* Campanha encerrada ou vagas em confirmação: só o aviso, sem percentual nem contato para "ser fundador". */}
        <div className={cx('founder')} id="fundador">{fundador.oferta && <div className={cx('pct')}>{comercial.fundador.descontoPercentual}%<small>por {comercial.fundador.meses} meses</small></div>}<div><h3>{fundador.titulo}</h3><p>{fundador.descricao}</p></div>{fundador.oferta && <Contato config={contato} fundador />}</div>
        <div className={cx('trial-line')} role="group" aria-label="Como funciona o teste grátis"><div><b>HOJE</b><p>Crie a conta, confirme o e-mail e cadastre o buffet pelo {cpf ? 'CNPJ ou pelo CPF de quem contrata' : 'CNPJ'}. Sem cartão.</p></div><div><b>DIAS 1 A {comercial.testeDias}</b><p>{visivel(['festas', 'contratos']) ? 'Use tudo do Premium com os seus pacotes e o seu contrato' : 'Use tudo do Premium com os dados do seu buffet'}{visivel(['implantacao']) ? ', com implantação guiada' : ''}.</p></div><div><b>SE ASSINAR</b><p>Confira as condições de assinatura na sua conta. Nada do que você cadastrou muda.</p></div><div><b>SE NÃO ASSINAR</b><p>A empresa passa a somente leitura e depois fica suspensa. Seus dados não são apagados por vencimento{visivel(['exportacao']) ? ' e podem ser exportados' : ''}.</p></div></div>
    </div></section>;
}
