import { adicionais, ancora, comercial, planos, precoExibido, valorPlano, type Ciclo } from '@/lib/site/catalogo';
import type { ConfiguracaoSite } from '@/lib/site/configuracao';
import { Cadastro, Contato, Recurso } from './elementos';
import { cx } from './estilos';
import CicloPlanos from './CicloPlanos';

export default function Planos({ publicado, aberto, contato }: { publicado: boolean; aberto: boolean; contato: Pick<ConfiguracaoSite, 'contato' | 'fundador'> }) {
    const moeda = (centavos: number | null) => precoExibido(centavos, publicado);
    const premium = planos.find(plano => plano.id === 'premium')!;
    return <section className={cx('block')} id="planos" aria-labelledby="t-planos"><div className={cx('wrap')}>
        <CicloPlanos cabecalho={<div className={cx('head')} style={{ marginBottom: 0 }}><div className={cx('eyebrow')}>Planos</div><h2 id="t-planos">Escolha pelo tamanho do seu buffet.</h2><p className={cx('lead')}>Preço por empresa (uma unidade). Sem taxa sobre as festas. Condições de mudança de plano a definir.</p></div>}>
        <div className={cx('plans')} aria-live="polite">{planos.map(plano => <article key={plano.id} className={cx('plan', plano.destaque ? 'featured' : '')} aria-labelledby={`plano-${plano.id}`}>
            {plano.destaque && <span className={cx('flag')}>Profissional em destaque</span>}
            <h3 id={`plano-${plano.id}`}>{plano.nome}</h3><p className={cx('for')}>{plano.descricao}</p>
            {(['mensal', 'anual'] as Ciclo[]).map(ciclo => <div key={ciclo} data-valor-ciclo={ciclo} className={cx('cycleValue')}>
                <div className={cx('price', !publicado ? 'priceUndefined' : '')}><span>{moeda(valorPlano(plano, ciclo))}</span>{publicado && <small>/{ciclo === 'anual' ? 'ano' : 'mês'}</small>}</div>
                <p className={cx('price-sub')}>{publicado ? ciclo === 'anual' ? <>Equivale a {moeda(Math.round(valorPlano(plano, ciclo) / 12))}/mês · <b>implantação assistida grátis</b></> : <>Fundador: <b>{moeda(valorPlano(plano, ciclo, true))}/mês</b> por {comercial.fundador.meses} meses</> : <>Fundador: <b>Preço a definir</b></>}</p>
            </div>)}
            <ul className={cx('feat')}>{plano.itens.map(item => <li key={item.texto} className={cx(item.excluido ? 'no' : item.introducao ? 'lead-in' : '')}><Recurso ids={item.recursos}>{item.excluido && <span className={cx('srOnly')}>Não incluído: </span>}{item.texto}</Recurso></li>)}</ul>
            <Cadastro aberto={aberto} destaque={plano.destaque}>Testar o {plano.nome}{plano.destaque && <span aria-hidden="true">↗</span>}</Cadastro>
        </article>)}</div></CicloPlanos>
        <div className={cx('extras')}><div className={cx('panel')} role="group" aria-labelledby="t-add"><h3 id="t-add">Adicionais</h3><div className={cx('addons')}>{adicionais.map((adicional, i) => <div key={adicional.nome} className={cx('addon')} style={i === adicionais.length - 1 ? { gridColumn: '1/-1' } : undefined}>
            <b><Recurso ids={adicional.recursos}>{adicional.nome}</Recurso></b><span className={cx('v')}>{adicional.nome === 'Wall-e publicitário' ? 'A definir' : moeda(adicional.centavos)}{publicado && adicional.centavos !== null && <small> {adicional.periodo}</small>}</span><p>{adicional.descricao}</p>
        </div>)}</div></div>
            <div className={cx('receipt')} role="group" aria-labelledby="t-rec"><h4 id="t-rec">Se fosse comprar separado</h4>{ancora.map(item => <div key={item.nome} className={cx('line')}><Recurso ids={item.recursos}>{item.nome}</Recurso><span>{moeda(item.centavos)}</span></div>)}<div className={cx('sum')}><span>Total por mês</span><s>{moeda(ancora.reduce((soma, item) => soma + item.centavos, 0))}</s></div><div className={cx('deal')}><span>Tudo no Premium</span><b>{moeda(premium.mensalCentavos)}{publicado && '/mês'}</b></div></div>
        </div>
        <div className={cx('founder')} id="fundador"><div className={cx('pct')}>{comercial.fundador.descontoPercentual}%<small>por {comercial.fundador.meses} meses</small></div><div><h3>Plano Fundador: {comercial.fundador.vagas} vagas para os primeiros buffets.</h3><p>Desconto travado por {comercial.fundador.meses} meses em qualquer plano. Em troca, pedimos sua opinião sobre o sistema e um depoimento depois de usar.</p></div><Contato config={contato} fundador /></div>
        <div className={cx('trial-line')} role="group" aria-label="Como funciona o teste grátis"><div><b>HOJE</b><p>Crie a conta, confirme o e-mail e cadastre a empresa pelo CNPJ. Sem cartão.</p></div><div><b>DIAS 1 A {comercial.testeDias}</b><p>Experimente os recursos disponíveis, com implantação guiada. Os itens Em breve ainda não estão liberados.</p></div><div><b>SE ASSINAR</b><p>Confira as condições de assinatura na sua conta. Nada do que você cadastrou muda.</p></div><div><b>SE NÃO ASSINAR</b><p>A empresa passa a somente leitura e depois fica suspensa. Seus dados não são apagados por vencimento e podem ser exportados.</p></div></div>
    </div></section>;
}
