import { cx } from './estilos';
import { Recurso, Cadastro, Contato } from './elementos';
import { comercial, adicionais, precoExibido } from '@/lib/site/catalogo';
import type { ConfiguracaoSite } from '@/lib/site/configuracao';
import { dias } from '@/lib/assinatura/texto';

export function Hero({ aberto, config }: { aberto: boolean; config: ConfiguracaoSite }) { return (<section className={cx('hero')} aria-labelledby="t-hero">
    <div className={cx('blob b1')} aria-hidden="true"></div><div className={cx('blob b2')} aria-hidden="true"></div><div className={cx('blob b3')} aria-hidden="true"></div><div className={cx('caustics')} aria-hidden="true"></div>
    <div className={cx('wrap')}>
      <div className={cx('hero-grid')}>
        <div className={cx('hero-copy')}>
          <div className={cx('eyebrow')}>Para buffets infantis e espaços de festa</div>
          <h1 id="t-hero">Seu buffet vende<br />até de madrugada.<br /><em>Sem planilha.</em></h1>
          <p className={cx('lead')}>O cliente consulta a data, monta o orçamento com pacote, horário e adicionais e assina o contrato pelo celular. Você recebe por Pix ou <Recurso ids={["cartao"]}>cartão</Recurso>, direto na conta da sua empresa.</p>
          <div className={cx('actions')}>
            <Cadastro aberto={aberto} />
            <Contato config={config} />
          </div>
          <div className={cx('fineprint')}><span>{dias(comercial.testeDias)} grátis</span><span>Sem cartão de crédito</span><span>Implantação guiada</span></div>
        </div>
        <div className={cx('halo')}><div className={cx('app')} role="img" aria-label="Tela de exemplo do Kidmais Manager com as próximas festas">
          <div className={cx('app-bar')}><i></i><i></i><i></i><span>manager.kidmaisfestas.com/admin/festas</span></div>
          <div className={cx('app-body')}>
            <div className={cx('app-head')}><strong>Próximas festas</strong><small>OUTUBRO</small></div>
            <div className={cx('row')}><span className={cx('date')}><span className={cx('dateNumber')}>17</span>SÁB</span><span><b>Sofia · 6 anos</b><small>15h · Horário nobre · 60 convidados</small></span><span className={cx('pill ok')}>Contrato assinado</span></div>
            <div className={cx('row')}><span className={cx('date')}><span className={cx('dateNumber')}>18</span>DOM</span><span><b>Miguel · 4 anos</b><small>Orçamento feito pelo site às 23h40</small></span><span className={cx('pill wait')}>Aguardando assinatura</span></div>
            <div className={cx('row')}><span className={cx('date')}><span className={cx('dateNumber')}>24</span>SÁB</span><span><b>Helena · 8 anos</b><small>14h · Espaço jardim · 80 convidados</small></span><span className={cx('pill info')}>2ª parcela vence 20/10</span></div>
            <div className={cx('hero-stats')}>
              <div><b>R$ 18.400</b><small>a receber no mês</small></div>
              <div><b>3</b><small>datas livres em outubro</small></div>
              <div><b>4</b><small>orçamentos online na semana</small></div>
            </div>
            <div className={cx('caption')}>Dados fictícios</div>
          </div>
        </div></div>
      </div>
      <div className={cx('ribbon')}><span><strong>O dinheiro das festas cai direto na sua conta.</strong> O Kidmais não intermedia pagamentos nem fica com parte do valor.</span><a href="#confianca">Entenda →</a></div>
    </div>
  </section>); }

export function AntesDepois() { return (<section className={cx('block')} aria-labelledby="t-dor">
    <div className={cx('wrap')}>
      <div className={cx('head')}><div className={cx('eyebrow')}>Antes e depois</div><h2 id="t-dor">A festa está pronta.<br /><em>A gestão está espalhada.</em></h2></div>
      <div className={cx('pain')}>
        <article><span className={cx('from')}>Caderno e calendário na parede</span><h3>Agenda com disponibilidade</h3><p>Veja na hora quais datas e salões estão livres, sem risco de vender a mesma data duas vezes.</p></article>
        <article><span className={cx('from')}>Contrato impresso e assinatura na loja</span><h3>Contrato assinado pelo celular</h3><p>O cliente recebe o link, confere os dados e assina. Você acompanha quem já viu e quem já assinou.</p></article>
        <article><span className={cx('from')}>Orçamento por mensagem, um por um</span><h3>Orçamento online</h3><p>O cliente escolhe data, pacote, horário e adicionais e vê o valor na hora, a qualquer hora do dia.</p></article>
        <article><span className={cx('from')}>Planilha de parcelas e cobrança no boca a boca</span><h3><Recurso ids={["cartao"]}>Parcelas no Pix e no cartão</Recurso></h3><p><Recurso ids={["cartao"]}>Cada parcela sai com Pix copia e cola ou pagamento no cartão. Você sabe o que entrou, o que vence e o que atrasou.</Recurso></p></article>
      </div>
    </div>
  </section>); }

export function Diferenciais() { return (<section className={cx('block')} id="diferenciais" aria-labelledby="t-diff">
    <div className={cx('wrap')}>
      <div className={cx('head')}><div className={cx('eyebrow')}>Diferenciais</div><h2 id="t-diff">O que o Kidmais faz<br /><em>e uma planilha não faz.</em></h2></div>
      <div className={cx('diff')}>
        <article className={cx('hero-card')}>
          <span className={cx('n')}>01 · VENDA SEM ATENDENTE</span>
          <h3>Seu cliente faz o orçamento e assina sozinho, a qualquer hora.</h3>
          <p>Uma página do seu buffet mostra as datas livres com os seus preços oficiais. O cliente monta a festa, vê o total e segue direto para o contrato. Você acorda com a venda pronta para conferir.</p>
          <div className={cx('quote-steps')}>
            <div><b>Data</b>Só aparecem as livres</div>
            <div><b>Pacote</b>Com o seu preço</div>
            <div><b>Horário</b>Nobre ou promocional</div>
            <div><b>Adicionais</b>Somados na hora</div>
          </div>
        </article>
        <article className={cx('money')}>
          <span className={cx('n')}>02 · SEU DINHEIRO</span>
          <div className={cx('big-num')}>0%</div>
          <h3>do valor das festas fica com o Kidmais.</h3>
          <p><Recurso ids={["cartao"]}>Pix copia e cola com a chave da sua empresa e cartão pela sua própria conta de pagamento . Tudo cai direto na sua conta.</Recurso></p>
        </article>
        <article>
          <span className={cx('n')}>03 · PREÇO CERTO</span>
          <h3>Horário nobre e adicionais na cotação</h3>
          <p>Sábado à tarde não custa o mesmo que terça de manhã. Grades de horário nobre, promocional e adicionais entram no cálculo sem conta de cabeça.</p>
        </article>
        <article>
          <span className={cx('n')}>04 · IA QUE IMPLANTA</span>
          <h3><Recurso ids={["importacao_contratos","importacao_precos"]}>Mande o PDF. A IA monta o sistema.</Recurso></h3>
          <p><Recurso ids={["importacao_contratos","importacao_precos"]}>A IA lê sua tabela de preços e seus contratos antigos em PDF e prepara os pacotes. Você revisa antes de publicar.</Recurso></p>
        </article>
        <article>
          <span className={cx('n')}>05 · WALL-E</span>
          <h3><Recurso ids={["walle_whatsapp", "walle_publicitario"]}>Atendimento e marketing com IA</Recurso></h3>
          <p><Recurso ids={["walle_publicitario"]}>O Wall-e responde seus clientes no WhatsApp e cria a divulgação do seu buffet. <a href="#wall-e" style={{"color":"var(--lilac)"}}>Conheça →</a></Recurso></p>
        </article>
      </div>
    </div>
  </section>); }

export function WallE() { return (<section className={cx('block')} id="wall-e" aria-labelledby="t-walle">
    <div className={cx('wrap')}>
      <div className={cx('head')}>
        <div className={cx('eyebrow')}>Wall-e · Inteligência artificial do Kidmais</div>
        <h2 id="t-walle">Um atendente e um departamento de marketing<br /><em>que não tiram folga.</em></h2>
        <p className={cx('lead')}><Recurso ids={["walle_whatsapp"]}>O Wall-e trabalha com os dados que já estão no Kidmais: sua agenda, seus pacotes e seus preços oficiais. Ele não inventa preço e não publica nada sem a sua aprovação.</Recurso></p>
      </div>
      <div className={cx('walle')}>
        <article aria-labelledby="t-w1">
          <div className={cx('tag')}><span className={cx('bot')}>W</span><b><Recurso ids={["walle_whatsapp"]}>Wall-e no WhatsApp</Recurso></b></div>
          <h3 id="t-w1">Responde o cliente na hora, até no domingo à noite.</h3>
          <div className={cx('phone')} role="img" aria-label="Exemplo de conversa do Wall-e no WhatsApp">
            <div className={cx('top')}><span className={cx('bot')} style={{"width":"28px","height":"28px","fontSize":"12px"}}>K</span><span>Buffet Kidmais<small>Wall-e · atendimento automático</small></span></div>
            <div className={cx('msg in')}>Oi! Vocês têm data dia 24/10 à tarde?<time>21:42</time></div>
            <div className={cx('msg out')}>Oi, Juliana! Dia 24/10 está livre das 14h às 18h no Espaço Jardim. Para quantas crianças é a festa?<time>21:42</time></div>
            <div className={cx('msg in')}>Umas 40<time>21:43</time></div>
            <div className={cx('msg out')}>O Pacote Diversão atende até 40 convidados. Montei o orçamento com a data:<span className={cx('lnk')}>Orçamento 24/10 · R$ 5.200,00 · abrir</span><time>21:43</time></div>
            <div className={cx('msg in')}>Dá pra visitar o espaço?<time>21:44</time></div>
            <div className={cx('handoff')}>Wall-e passou a conversa para Carla, do atendimento</div>
          <div className={cx('caption')}>Dados fictícios</div></div>
          <ul className={cx('checks')}>
            <li>Consulta a agenda e os preços oficiais antes de responder</li>
            <li>Envia o orçamento e o link do contrato</li>
            <li>Passa a conversa para a sua equipe quando precisa</li>
            <li>Mostra quantas conversas viraram festa</li>
          </ul>
        </article>
        <article aria-labelledby="t-w2">
          <div className={cx('tag')}><span className={cx('bot')}>W</span><b><Recurso ids={["walle_publicitario"]}>Wall-e publicitário</Recurso></b></div>
          <h3 id="t-w2">O marketing de quem não tem um departamento de marketing.</h3>
          <div className={cx('cal')} role="img" aria-label="Exemplo de calendário de publicações do Wall-e. Dados fictícios.">
            <div className={cx('post')}><span className={cx('thumb')} style={{"background":"linear-gradient(135deg,#ff9fbe,#c9a8ff)"}}>Reels</span><span><b>Bastidores da festa Fundo do Mar</b><small>Sáb 17/10 · com suas fotos e a voz da marca</small></span><span className={cx('pill wait')}>Para aprovar</span></div>
            <div className={cx('post')}><span className={cx('thumb')} style={{"background":"linear-gradient(135deg,#80f5c4,#7cc4ff)"}}>Carrossel</span><span><b>3 sábados livres em novembro</b><small>Ter 20/10 · criado a partir da sua agenda</small></span><span className={cx('pill ok')}>Aprovado</span></div>
            <div className={cx('post')}><span className={cx('thumb')} style={{"background":"linear-gradient(135deg,#ffd58a,#ff9a7a)"}}>Story</span><span><b>Pacote Diversão para até 40 crianças</b><small>Qui 22/10 · oferta autorizada por você</small></span><span className={cx('pill mute')}>Agendado</span></div>
            <div className={cx('caption')}>Dados fictícios</div>
          </div>
          <ul className={cx('checks')}>
            <li>Cria posts, carrosséis, Stories e Reels com as fotos do seu buffet</li>
            <li>Sugere divulgar as datas livres da sua agenda</li>
            <li>Vídeos com legenda, música, logotipo e narração com a voz da marca</li>
            <li>Calendário de publicações. Nada sai sem a sua aprovação</li>
          </ul>
        </article>
      </div>
    </div>
  </section>); }

export function Convite() { return (<section className={cx('block')} id="convite" aria-labelledby="t-convite">
    <div className={cx('wrap convite')}>
      <div className={cx('convite-copy')}>
        <div className={cx('eyebrow')}><Recurso ids={["convite"]}>Convite da festa</Recurso></div>
        <h2 id="t-convite">O convite da festa,<br /><em>do seu jeito.</em></h2>
        <p className={cx('lead')}><Recurso ids={["convite"]}>A família personaliza o convite com modelos prontos, uma imagem própria ou arte criada por IA. Compartilha por link ou imagem, e as confirmações de presença chegam para a família e para o buffet.</Recurso></p>
        <ol className={cx('passos')}>
          <li><span><b><Recurso ids={["convite"]}>O buffet cria o convite na festa</Recurso></b> e libera um link exclusivo de edição para a família.</span></li>
          <li><span><b>A família escolhe o modelo</b>, envia uma foto ou descreve a arte para a IA, e ajusta nome, data, horário e local.</span></li>
          <li><span><b>Publica e compartilha</b> pelo WhatsApp, pelo link ou baixando a imagem do convite.</span></li>
          <li><span><b>Os convidados confirmam presença</b> sem criar conta, informando adultos e crianças.</span></li>
        </ol>
        <ul className={cx('checks')}>
          <li>Textos separados da arte: corrigir horário ou endereço não gasta crédito de IA</li>
          <li>Limites de geração por festa e por cliente protegem a franquia do buffet</li>
          <li>Tudo ligado à festa no Kidmais, com histórico do que cada um fez</li>
        </ul>
      </div>
      <div className={cx('convite-mock')}>
        <div className={cx('app')} role="img" aria-label="Exemplo do editor de convite com o modelo Uma aventura espacial">
          <div className={cx('app-bar')}><i></i><i></i><i></i><span>Convite da Sofia</span></div>
          <div className={cx('app-body')}>
            <div className={cx('modelos')}><span>Dia de celebrar</span><span>Jardim encantado</span><span className={cx('on')}>Uma aventura espacial</span></div>
            <div className={cx('invite')}>
              <div className={cx('t1')}>Você está convidado</div>
              <div><div className={cx('t2')}>Sofia<br />faz 6 anos!</div></div>
              <div className={cx('t3')}>Sábado, 17 de outubro · 15h<br />Buffet Kidmais · Salão principal</div>
              <div className={cx('acts')}><span className={cx('a1')}>Confirmar presença</span><span className={cx('a2')}>Como chegar</span></div>
            </div>
            <div className={cx('caption')}>Prévia · dados fictícios</div>
          </div>
        </div>
        <div className={cx('app')} role="img" aria-label="Exemplo da lista de confirmações de presença">
          <div className={cx('app-bar')}><i></i><i></i><i></i><span>Confirmações</span></div>
          <div className={cx('app-body')}>
            <div className={cx('rsvp-tot')}><div><b>14</b><small>famílias vão</small></div><div><b>26</b><small>adultos</small></div><div><b>19</b><small>crianças</small></div></div>
            <div className={cx('row')} style={{"gridTemplateColumns":"1fr auto"}}><span><b>Família Andrade</b><small>2 adultos · 2 crianças</small></span><span className={cx('pill ok')}>Vai</span></div>
            <div className={cx('row')} style={{"gridTemplateColumns":"1fr auto"}}><span><b>Família Lima</b><small>1 adulto · 1 criança</small></span><span className={cx('pill ok')}>Vai</span></div>
            <div className={cx('row')} style={{"gridTemplateColumns":"1fr auto"}}><span><b>Família Costa</b><small>Avisou que não vem</small></span><span className={cx('pill mute')}>Não vai</span></div>
            <p className={cx('note-sm')} style={{"marginTop":"10px"}}>Só a família e o buffet veem esta lista.</p><div className={cx('caption')}>Dados fictícios</div>
          </div>
        </div>
      </div>
    </div>
  </section>); }

export function ComoFunciona() { return (<section className={cx('block')} id="como-funciona" aria-labelledby="t-fluxo">
    <div className={cx('wrap')}>
      <div className={cx('head')}>
        <div className={cx('eyebrow')}>Como funciona</div>
        <h2 id="t-fluxo">Uma festa, do pedido ao fechamento.</h2>
        <p className={cx('lead')}>Quatro das cinco etapas o próprio cliente faz pelo celular. Cada etapa usa o que foi registrado na anterior.</p>
      </div>
      <ol className={cx('flow')}>
        <li><span className={cx('who')}>Cliente</span><h3>Consulta a data</h3><p><Recurso ids={["walle_whatsapp"]}>Pela página do buffet ou pelo WhatsApp com o Wall-e. Só aparecem as datas livres.</Recurso></p></li>
        <li><span className={cx('who')}>Cliente</span><h3>Monta o orçamento</h3><p>Escolhe pacote, horário e adicionais e vê o total calculado com os seus preços.</p></li>
        <li><span className={cx('who')}>Cliente</span><h3>Assina o contrato</h3><p>O contrato sai preenchido com o seu modelo. O cliente confere e assina pelo link.</p></li>
        <li><span className={cx('who')}>Cliente</span><h3>Paga as parcelas</h3><p><Recurso ids={["cartao"]}>Pix copia e cola ou cartão em cada parcela, direto na conta do buffet.</Recurso></p></li>
        <li className={cx('you')}><span className={cx('who')}>Você</span><h3>Fecha a festa</h3><p>O fechamento reúne recebimentos, adicionais e pendências daquele evento.</p></li>
      </ol>
      <p className={cx('flow-note')}>Você continua no controle: <b>pode atender, ajustar valores e enviar o contrato</b> você mesmo sempre que preferir.</p>
    </div>
  </section>); }

export function Confianca() { return (<section className={cx('block')} id="confianca" aria-labelledby="t-confianca">
    <div className={cx('wrap')}>
      <div className={cx('head')}><div className={cx('eyebrow')}>Por que confiar</div><h2 id="t-confianca">Seu dinheiro, seus clientes,<br /><em>seus dados.</em></h2></div>
      <div className={cx('trust')}>
        <article className={cx('wide')}>
          <div className={cx('big')}>Feito dentro de um buffet</div>
          <p>O Kidmais Manager nasceu para organizar a operação da Kidmais Festas, que usa o sistema todos os dias. Cada tela foi construída com quem atende, organiza e recebe.</p>
        </article>
        <article><div className={cx('big')}>Direto na sua conta</div><h3>Nenhum pagamento passa pelo Kidmais</h3><p><Recurso ids={["cartao"]}>Pix com a chave da sua empresa e cartão pela sua própria conta de pagamento. As taxas do cartão são as da sua conta.</Recurso></p></article>
        <article><div className={cx('big')}>CSV · PDF</div><h3>Exportação a qualquer hora</h3><p>Clientes, festas, financeiro e contratos saem do sistema quando você quiser, conforme as condições de acesso e exportação dos termos de uso.</p></article>
        <article><div className={cx('big')}>4 papéis</div><h3>Cada um vê o que precisa</h3><p>Gestão, administrativo, atendimento e visitante. Você decide quem vê valores e quem só consulta.</p></article>
      </div>
    </div>
  </section>); }

export function Duvidas({ config }: { config: ConfiguracaoSite }) { return (<section className={cx('block')} id="duvidas" aria-labelledby="t-duvidas">
    <div className={cx('wrap')}>
      <div className={cx('head')}><div className={cx('eyebrow')}>Dúvidas</div><h2 id="t-duvidas">Perguntas de quem está decidindo.</h2></div>
      <div className={cx('faq')}>
        <div>
          <details><summary>Preciso cadastrar cartão para testar?</summary><p>Não. O teste de {dias(comercial.testeDias)} começa sem cartão e nada é cobrado automaticamente quando ele termina.</p></details>
          <details><summary>O Kidmais recebe o pagamento dos meus clientes?</summary><p><Recurso ids={["cartao"]}>Não. O Pix usa a chave da sua empresa e o cartão passa pela sua própria conta de pagamento. O dinheiro vai direto para você.</Recurso></p></details>
          <details><summary>Meu cliente pode pagar no cartão?</summary><p><Recurso ids={["cartao"]}>O cartão nas parcelas está em preparação e depende da conexão da conta de pagamento do buffet. O Pix copia e cola usa a chave da empresa. As taxas do cartão são as da conta de pagamento da sua empresa.</Recurso></p></details>
          <details><summary>Meu cliente precisa instalar algum aplicativo?</summary><p>Não. Ele abre a página do buffet ou o link do contrato no celular e faz tudo por ali.</p></details>
          <details><summary>A família consegue fazer o convite sozinha?</summary><p><Recurso ids={["convite"]}>O buffet libera um link de edição e a família escolhe o modelo, troca a imagem e publica. O buffet acompanha e pode ajudar quando precisar.</Recurso></p></details>
          <details><summary>Já tenho tabela de preços e contratos em PDF. Perco o que fiz?</summary><p><Recurso ids={["importacao_contratos","importacao_precos"]}>Não. A IA lê seus PDFs e prepara os pacotes e contratos. Você confere antes de publicar.</Recurso></p></details>
        </div>
        <div>
          <details><summary>O que é o Wall-e?</summary><p><Recurso ids={["walle_whatsapp", "walle_publicitario"]}>É a inteligência artificial do Kidmais. Ele atende seus clientes no WhatsApp e cria a divulgação do buffet, sempre com os seus preços oficiais e com a sua aprovação.</Recurso></p></details>
          <details><summary>O que é o copiloto?</summary><p><Recurso ids={["copiloto"]}>É a parte da IA que trabalha dentro do sistema. Ele mostra o que precisa da sua atenção e prepara cadastros a partir de um pedido escrito. Você sempre revisa e confirma antes de gravar.</Recurso></p></details>
          <details><summary>Posso mudar de plano depois?</summary><p>As condições para mudar entre os planos estão em definição. O teste começa pelo mesmo cadastro; fale com a equipe para conhecer a oferta.</p></details>
          <details><summary>O que é o Plano Fundador?</summary><p>Uma condição para os {comercial.fundador.vagas} primeiros buffets: {comercial.fundador.descontoPercentual}% de desconto travado por {comercial.fundador.meses} meses, em troca da sua opinião sobre o sistema e de um depoimento.</p></details>
          <details><summary>Posso cancelar quando quiser?</summary><p>O cancelamento é solicitado pelos canais de atendimento. Consulte os termos para as condições de acesso, exportação e retenção de dados.</p></details>
          <details><summary>Tenho mais de uma unidade. Como fica?</summary><p>Cada unidade é uma empresa com CNPJ próprio, por {precoExibido(adicionais[0].centavos, config.precosPublicados)}{config.precosPublicados ? "/mês" : ""} a mais. Você troca de unidade sem sair da conta.</p></details>
        </div>
      </div>
    </div>
  </section>); }
