import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOCUMENTOS, DOCUMENTOS_COM_ACEITE, hashDocumento, MARCADORES, marcadoresPendentes, textoCanonico, versaoVigente, type TextoLegal } from './documentos-legais.ts';
import { conferirManifesto, type EntradaManifesto } from './manifesto-legal.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { rotaSemprePermitida } from '../assinatura/paywall.ts';

// publico.ts importa db/postgres (sem extensão): carregado com um banco falso que nunca é usado aqui.
const semBanco = { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } };
type Publico = typeof import('./publico.ts');
const { exigirAgendaSemBloqueioGlobal, linkConfirmacao, mensagemConfirmacao, mensagemContaExistente, situacaoCadastro, validarPedidoCadastro } = carregarModulo('lib/cadastro/publico.ts', { 'db/postgres': semBanco }, new Map()) as unknown as Publico;

const VERSAO_DB = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$/;
const pedido = (o: Record<string, unknown> = {}) => ({
    nome: 'Ana Responsável', email: 'Ana@Exemplo.test ', senha: 'senha-forte-1', confirmacao: 'senha-forte-1',
    aceiteTermos: true, aceitePrivacidade: true, termosVersao: versaoVigente('TERMOS_USO').versao, privacidadeVersao: versaoVigente('PRIVACIDADE').versao, ...o,
});
const codigo = (f: () => unknown) => { try { f(); return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };

test('documentos legais: versão no formato do banco, hash SHA-256 estável do texto exibido (tabelas incluídas), versão definitiva sem marcadores', () => {
    assert.deepEqual(Object.keys(DOCUMENTOS).sort(), ['DPA', 'PRIVACIDADE', 'TERMOS_USO']);
    assert.deepEqual([...DOCUMENTOS_COM_ACEITE], ['TERMOS_USO', 'PRIVACIDADE'], 'só estes têm linha própria na 069 (CHECK aceites_documento_check)');
    const rotas = new Set<string>();
    for (const d of Object.values(DOCUMENTOS)) {
        assert.match(d.versao, VERSAO_DB);
        assert.ok(d.versao.length <= 40, 'cabe na coluna e no schema do pedido');
        assert.match(hashDocumento(d), /^[0-9a-f]{64}$/);
        assert.equal(hashDocumento(d), hashDocumento({ ...d, secoes: d.secoes.map((s) => ({ ...s })) }), 'determinístico');
        assert.notEqual(hashDocumento(d), hashDocumento({ ...d, secoes: [...d.secoes, { titulo: 'x', paragrafos: ['y'] }] }), 'mudança no texto muda o hash');
        assert.equal(d.minuta, false, 'versão definitiva de 03/11 (R-5): sem parecer jurídico, risco assumido por Felipe');
        assert.doesNotMatch(textoCanonico(d), /\[A DEFINIR\]/, `${d.documento}: as lacunas L1–L11 viraram texto ou marcador específico`);
        assert.deepEqual(marcadoresPendentes(d), [], `${d.documento}: a versão publicada não tem marcadores`);
        assert.doesNotMatch(textoCanonico(d), /minuta|revisão jurídica/i, `${d.documento}: não promete revisão que não existe`);
        assert.equal(new Set(d.secoes.map((s) => s.titulo)).size, d.secoes.length, `${d.documento}: títulos únicos (chave da tela)`);
        const ids = d.secoes.flatMap((s) => s.id ? [s.id] : []);
        assert.equal(new Set(ids).size, ids.length, `${d.documento}: âncoras únicas`);
        for (const s of d.secoes) {
            if (!s.tabela) continue;
            const tabela = s.tabela;
            assert.ok(tabela.linhas.every((l) => l.length === tabela.colunas.length), `${d.documento}/${s.titulo}: linhas completas`);
            const semTabela = { ...d, secoes: d.secoes.map((x) => x === s ? { ...x, tabela: undefined } : x) };
            assert.notEqual(hashDocumento(d), hashDocumento(semTabela), `${d.documento}/${s.titulo}: a tabela entra no hash`);
            assert.match(textoCanonico(d), new RegExp(tabela.linhas[0].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' \\| ')));
        }
        rotas.add(d.rota);
    }
    assert.deepEqual([...rotas].sort(), ['/acordo-de-tratamento', '/privacidade', '/termos']);
    assert.match(textoCanonico(DOCUMENTOS.TERMOS_USO), /não comprova titularidade, existência da empresa ou poderes de representação/);
    // Sem tabela, o texto canônico é o mesmo formato de antes (título, versão, títulos e parágrafos).
    assert.equal(textoCanonico({ documento: 'TERMOS_USO', titulo: 'T', versao: '2026-01-01', minuta: true, rota: '/termos', secoes: [{ titulo: 'A', paragrafos: ['b', 'c'] }] }), 'T\nVersão 2026-01-01\nA\nb\nc');
});

test('documentos legais 17/11 (R-5 sobre o staging com contratante PF/PJ e guarda dos clientes do buffet): versões novas, responsável Demerzel Labs, DPA incorporado aos Termos e controles descritos', () => {
    assert.equal(DOCUMENTOS.TERMOS_USO.versao, '2026-11-17-termos');
    assert.equal(DOCUMENTOS.PRIVACIDADE.versao, '2026-11-17-privacidade');
    assert.equal(DOCUMENTOS.DPA.versao, '2026-11-17-dpa');
    for (const d of Object.values(DOCUMENTOS)) {
        const texto = textoCanonico(d);
        assert.match(texto, /contato@demerzellabs\.com\.br/, `${d.documento}: canal oficial`);
        assert.doesNotMatch(texto, /felipemenegaz@gmail\.com|glass@demerzellabs\.com\.br/, `${d.documento}: contatos anteriores removidos`);
        assert.doesNotMatch(texto, /R\$/, `${d.documento}: os textos legais não citam preços`);
        assert.doesNotMatch(texto, /Mary Marra|20\.119\.900|EPP/, `${d.documento}: o novo CNPJ substitui a EPP (decisão de Felipe, 21/10)`);
        assert.ok(texto.includes('Demerzel Labs Ltda., CNPJ 69.938.612/0001-26, com sede no SCRN 704/705, Bloco D, Loja 12, Asa Norte, Brasília/DF, CEP 70730-640 (“Demerzel Labs”)'), `${d.documento}: identifica a responsável pelo CNPJ (D-REC-1, 03/11)`);
        assert.doesNotMatch(texto, /“Kidmais”|\bKidmais\b(?! Manager| Festas)/, `${d.documento}: o termo definido é a Demerzel Labs, não o buffet`);
        for (const prefixo of Object.values(MARCADORES)) assert.ok(!texto.includes(prefixo), `${d.documento}: sem ${prefixo}`);
    }
    const termos = textoCanonico(DOCUMENTOS.TERMOS_USO), privacidade = textoCanonico(DOCUMENTOS.PRIVACIDADE), dpa = textoCanonico(DOCUMENTOS.DPA);
    // DPA aceito por incorporação: os Termos citam versão e SHA-256 completo; mudar o DPA obriga nova versão dos Termos.
    assert.ok(termos.includes(`Acordo de Tratamento de Dados, versão ${versaoVigente('DPA').versao}, impressão digital ${versaoVigente('DPA').hash}`));
    assert.match(termos, /integra estes Termos e é aceito junto com eles, pelo contratante/);
    // 7/60 continuam consistentes.
    assert.doesNotMatch(termos, /por um período/, 'somente leitura sempre com o prazo aprovado');
    assert.equal(termos.match(/somente leitura por 60 dias/g)?.length, 2, 'as duas seções citam os mesmos 60 dias');
    assert.equal(termos.match(/7 dias para regularizar/g)?.length, 2);
    // Decisões de Felipe (L1, L2) e textos da Astra.
    assert.match(termos, /15 dias de teste grátis, sem cartão e sem cobrança automática/);
    assert.match(termos, /Nos primeiros 7 dias da primeira ativação paga, devolveremos integralmente o valor pago/);
    assert.match(termos, /devolução proporcional aos dias não utilizados/);
    assert.match(termos, /nem cobramos de volta o desconto Fundador/);
    assert.match(termos, /por até 12 meses contados da suspensão/);
    assert.match(termos, /pelo menos 30 dias de antecedência da exclusão programada/);
    assert.match(termos, /continuam sendo dela/);
    assert.match(termos, /Pessoas ligadas à Demerzel Labs também atuam no mercado de buffets infantis, no buffet Kidmais Festas, que é empresa cliente da plataforma/);
    assert.match(privacidade, /__Host-kidmais_admin, com validade máxima de 8 horas/);
    assert.match(privacidade, /Os filtros reduzem a exposição, mas não garantem anonimização/);
    assert.match(privacidade, /região Virginia, Estados Unidos/);
    assert.match(privacidade, /Google Gemini e DeepSeek são integrações disponíveis no sistema e não habilitadas/);
    assert.match(privacidade, /em até 15 dias contados do pedido/);
    assert.match(privacidade, /O encarregado pelo tratamento de dados pessoais é Felipe Menegaz, que atende pelo mesmo canal, contato@demerzellabs\.com\.br/, 'L11 decidido por Felipe (21/10)');
    for (const prestador of ['Render', 'Asaas', 'Resend', 'Meta/WhatsApp', 'OpenAI', 'Google Gemini', 'ViaCEP', 'DeepSeek'])
        assert.ok(DOCUMENTOS.PRIVACIDADE.secoes.some((s) => s.tabela?.linhas.some((l) => l[0] === prestador)), `relação de prestadores: ${prestador}`);
    // Conteúdo mínimo do anexo de L4 (Astra).
    for (const titulo of ['Instruções e duração', 'Titulares e dados tratados', 'Uso próprio e confidencialidade', 'Segurança e acesso de suporte', 'Suboperadores',
        'Transferências internacionais', 'Direitos dos titulares e assistência', 'Incidentes de segurança', 'Término: devolução, exclusão e cópias de segurança'])
        assert.ok(DOCUMENTOS.DPA.secoes.some((s) => s.titulo === titulo), `DPA: seção ${titulo}`);
    assert.match(dpa, /pelo menos 30 dias de antecedência\. Nesse prazo, o Contratante pode apresentar objeção fundamentada/);
    assert.match(dpa, /meta contratual de até 24 horas a partir da ciência/);
    assert.match(dpa, /não é o prazo legal de comunicação à ANPD/);
    // Pendências que Felipe precisa ver (não decididas) e controles que ainda não existem.
    // Decisões de Felipe de 21/10 à tarde (11-DECISOES-FELIPE): L10, L11, tabela de retenção e reajuste saíram de DECISÃO PENDENTE.
    assert.match(termos, /no máximo uma vez a cada 12 meses, pela variação acumulada do IPCA \(IBGE\)/);
    assert.match(termos, /com aviso de pelo menos 30 dias antes da primeira cobrança reajustada\. O reajuste não altera o valor de período já pago/);
    assert.match(privacidade, /O prazo padrão recomendado é de 12 meses sem atividade para eliminar as conversas e suas mídias/, 'L10 descrito como recomendação (P16, 03/11)');
    assert.match(dpa, /ciclo máximo de 90 dias, incluindo cópias locais/);
    for (const linha of ['Até 10 anos após o término', 'em regra cinco anos', 'Seis meses', '12 meses, salvo necessidade', 'eliminar 30 dias após a festa', 'Ciclo máximo de 90 dias'])
        assert.ok(privacidade.includes(linha), `tabela de retenção aprovada: ${linha}`);
    // Decisões de Felipe de 03/11 (R-5): ponto urgente 4, ECA Digital, Gemini, mecanismo de transferência e processos manuais.
    // D-OF-1 (13/11, rodada R-5 sobre staging 15/11): a IA do atendimento pode ser ligada pela empresa cujo plano a inclui; substitui a P8.
    assert.doesNotMatch(privacidade, /não está habilitada para nenhuma empresa/, 'D-OF-1: a P8 (IA no WhatsApp desligada) saiu');
    assert.match(privacidade, /a inteligência artificial só funciona para a empresa cliente cujo plano inclui esse recurso e que liga o assistente no painel/, 'D-OF-1: plano + assistente ligado');
    assert.match(privacidade, /Mensagens com termos de saúde não são enviadas ao modelo: são tratadas pelas regras automáticas ou passam para a equipe da empresa, e o cliente pode pedir atendimento humano a qualquer momento/, 'D-OF-1: saúde fora do modelo');
    assert.doesNotMatch(privacidade, /saúde não são enviadas ao modelo e vão para a equipe/, 'r3 P2-1: saúde não promete passagem à equipe');
    assert.match(privacidade, /O número de respostas automáticas por conversa é limitado; atingido esse limite, ou se o provedor de IA estiver indisponível, a conversa passa para a equipe da empresa/, 'D-OF-1: limite e indisponibilidade');
    for (const doc of [privacidade, dpa]) assert.match(doc, /assistente do atendimento pelo WhatsApp/, 'D-OF-1: OpenAI no atendimento na relação de prestadores');
    assert.match(termos, /O atendimento com inteligência artificial pelo WhatsApp, nos planos que o incluem, é oferecido com uso justo, sem número garantido de conversas/, 'D-OF-1: uso justo nos Termos');
    assert.match(privacidade, /O Google Gemini não está habilitado para nenhuma empresa/, 'P7');
    assert.match(termos, /As páginas públicas de convite destinam-se aos responsáveis pelos convidados/, 'T13: ECA Digital');
    assert.doesNotMatch(termos, /não são indexadas/, 'P3: noindex é instrução aos buscadores, não garantia');
    assert.match(termos, /Toda alteração do Acordo de Tratamento de Dados e as mudanças relevantes destes Termos .+ exigirão novo aceite/, 'P3: reaceite alinhado ao DPA');
    assert.match(termos, /encerrado no registro do pedido, preservadas a somente leitura e a exportação previstas/, 'P2: encerramento anual não corta a consulta');
    assert.match(privacidade, /Enquanto a empresa não configurar um prazo, as conversas não são eliminadas automaticamente/, 'P16: modo sem prazo');
    for (const doc of [privacidade, dpa]) {
        assert.match(doc, /A Meta\/WhatsApp incorpora as cláusulas-padrão contratuais da ANPD \(Resolução CD\/ANPD nº 19\/2024\)/, 'D7: só a Meta já adota as cláusulas-padrão');
        assert.match(doc, /Os contratos públicos de tratamento de dados de Render, Resend e OpenAI, consultados pela Demerzel Labs, não incluem essas cláusulas-padrão/, 'D7 r4.3: conclusão limitada aos contratos públicos consultados');
        assert.doesNotMatch(doc, /demais suboperadores sediados fora do Brasil|não divulga/, 'D7 r4.3: sem generalizar além dos quatro examinados');
        assert.doesNotMatch(doc, /solicitou|solicitadas/, 'D7 r4.2: sem afirmar pedido sem comprovante');
        assert.doesNotMatch(doc, /art\. 33, IX|execução do contrato com/, 'D7 r4: sem base legal que não cobre crianças e convidados');
        assert.doesNotMatch(doc, /cláusulas contratuais específicas|quando o prestador as oferecer/, 'D7: sem mecanismo não adotado');
    }
    assert.match(termos, /No plano anual, o encerramento antecipado é pedido na mesma área/, 'T8: ferramenta da área Assinatura (097), não processo manual');
    assert.match(termos, /A exportação completa dos demais dados .+ pode ser pedida pelo canal oficial e é entregue em até 15 dias/, 'T10: processo manual');
    assert.match(privacidade, /A importação de documentos por IA não está disponível para as empresas clientes/, 'P9');
    assert.match(privacidade, /de 1 dia a 10 anos, sob sua responsabilidade/, 'P16: o texto descreve o que o sistema aplica');
    assert.ok(DOCUMENTOS.PRIVACIDADE.secoes.some((s) => s.id === 'transferencias' && s.tabela?.colunas.includes('Instrumento contratual e situação do mecanismo de transferência')), 'P13: relação de transferências por destinatário');
    {
        // R-5 r4.1 (Astra P2-1/P3-2): a coluna não sugere suficiência e a autorização do responsável não volta como mecanismo.
        const tabela = DOCUMENTOS.PRIVACIDADE.secoes.find((s) => s.id === 'transferencias')?.tabela;
        assert.ok(tabela, 'tabela de transferências');
        const col = tabela.colunas.indexOf('Instrumento contratual e situação do mecanismo de transferência');
        assert.ok(col >= 0 && !tabela.colunas.includes('Mecanismo'), 'P2-1: coluna sem sugestão de mecanismo suficiente');
        for (const nome of ['Render', 'Resend', 'OpenAI']) {
            const linha = tabela.linhas.find((l) => l[0] === nome);
            assert.ok(linha, nome);
            assert.match(linha[col], /mecanismo do art\. 33 da LGPD ainda não demonstrado/, `P2-1: ${nome}`);
            assert.doesNotMatch(linha[col], /autoriza|consentimento/i, `P3-2: ${nome} sem autorização como mecanismo`);
        }
        assert.doesNotMatch(textoCanonico(DOCUMENTOS.PRIVACIDADE), /mecanismo legal utilizado/, 'P2-1');
        for (const d of [DOCUMENTOS.PRIVACIDADE, DOCUMENTOS.DPA]) assert.match(textoCanonico(d), /mecanismo de transferência previsto no art\. 33 da LGPD ainda não está demonstrado/, `P2-1: ${d.documento}`);
    }
    for (const s of [...DOCUMENTOS.PRIVACIDADE.secoes, ...DOCUMENTOS.DPA.secoes].filter((x) => x.tabela?.colunas[0] === 'Prestador' || x.tabela?.colunas[0] === 'Suboperador'))
        assert.equal(s.tabela!.colunas[1], 'Entidade e país', `${s.titulo}: P11/D6`);
    assert.deepEqual(Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, marcadoresPendentes(d).length])), { TERMOS_USO: 0, PRIVACIDADE: 0, DPA: 0 }, 'R-5: nenhum marcador');
    assert.match(termos, /em “Desistir da contratação”, mesmo quando a devolução automática não estiver disponível/);
    assert.match(termos, /a equipe da Demerzel Labs analisa o pedido: tratando-se de arrependimento legal/);
    assert.match(termos, /se o e-mail não chegar, o protocolo da tela continua valendo/);
    assert.match(termos, /Também enviamos uma cópia do comprovante para o e-mail de quem contratou; uma falha nesse envio não invalida o comprovante\.\n/, 'comprovante por e-mail sem marcador: a conferência exige ASSINATURA_COMPROVANTE_EMAIL=true');
});

test('grupo B (22/10): contratante PF/PJ, teste por documento, Fundador com reserva e prazo, continuidade, síntese, comprovante e CPF no aviso', () => {
    const termos = textoCanonico(DOCUMENTOS.TERMOS_USO), privacidade = textoCanonico(DOCUMENTOS.PRIVACIDADE), dpa = textoCanonico(DOCUMENTOS.DPA);
    assert.match(termos, /contratado por pessoa física \(CPF\) ou jurídica \(CNPJ\)/);
    assert.match(termos, /A pessoa física contrata em nome próprio, com seu nome civil e CPF/);
    assert.match(termos, /O nome comercial não substitui a identificação do contratante/);
    assert.doesNotMatch(termos, /Cada CNPJ tem um único teste/);
    assert.match(termos, /a formalização da mesma operação de CPF para CNPJ, feita pelo atendimento, não gera novo teste/);
    assert.match(termos, /fim do 7º dia seguinte à confirmação, às 23h59 do horário de Brasília/);
    assert.match(termos, /não em 168 horas, e não se confunde com o direito de arrependimento/);
    assert.match(termos, /sem cobrança complementar automática/);
    assert.match(termos, /preservados o preço contratado, o benefício e sua data original de término, sem concessão de novo período/);
    assert.match(termos, /Antes de confirmar a contratação, a tela apresenta uma síntese/);
    assert.doesNotMatch(termos, /conferir que a página de planos e a tela de contratação exibem todos esses itens/, 'síntese implementada');
    assert.ok(DOCUMENTOS.TERMOS_USO.secoes.some((x) => x.id === 'comprovante'), '/termos#comprovante');
    assert.match(termos, /as versões integrais dos documentos aceitos continuam disponíveis para consulta, inclusive depois de novas versões/);
    assert.match(termos, /contratações por CPF ou CNPJ/);
    assert.match(dpa, /\(“Contratante”\): a pessoa física que contrata em nome próprio, com seu nome civil e CPF, ou a pessoa jurídica/);
    assert.match(dpa, /o titular atua como controlador dos dados de seus clientes/);
    assert.doesNotMatch(dpa, /\bEmpresa\b/, 'termo definido único no Acordo');
    assert.match(privacidade, /nome civil e CPF \(pessoa física, que contrata em nome próprio\)/);
    assert.ok(DOCUMENTOS.PRIVACIDADE.secoes.some((x) => x.id === 'cpf'), '/privacidade#cpf');
    assert.match(privacidade, /O mascaramento não é anonimização/);
    assert.match(privacidade, /Asaas \| Asaas Gestão Financeira Instituição de Pagamento S\.A\. \(Brasil\) \| Cobrança da assinatura e pagamentos \| Nome civil e CPF \(pessoa física\) ou razão social e CNPJ/);
    assert.match(privacidade, /registros de continuidade CPF → CNPJ \| Durante o contrato/);
});

test('privacidade v2 sobre a minuta5a (#199): a seção de IA mantém a âncora e os compromissos dos convites com IA publicados', () => {
    const ia = DOCUMENTOS.PRIVACIDADE.secoes.find((s) => s.titulo === 'Recursos de inteligência artificial');
    assert.equal(ia?.id, 'inteligencia-artificial', 'LINK_AVISO_IA do editor de convites');
    const texto = ia!.paragrafos.join(' ');
    for (const trecho of [/A geração de imagens e convites utiliza a OpenAI; o provedor utilizado é informado no momento da geração/, /nome e idade da criança, data, local e endereço do evento e fotografia opcional/,
        /autorização específica do responsável legal/, /a cada geração/, /É possível criar o convite sem IA/, /revogada para usos futuros no editor do convite ou pelo canal de privacidade/,
        /Provedores, finalidades e condições de armazenamento constam da relação de prestadores/, /A ativação de cada recurso depende da verificação de suas condições contratuais/])
        assert.match(texto, trecho);
    const prestadores = textoCanonico(DOCUMENTOS.PRIVACIDADE);
    assert.match(prestadores, /OpenAI para a geração de convites com IA/, 'R2-P3-2: convites na seção de prestadores');
    assert.match(prestadores, /Google Gemini \| Google LLC \(Estados Unidos\) \| Geração de artes de convite com IA \| Nenhum \| Integração disponível, não habilitada/);
    assert.match(prestadores, /OpenAI \| OpenAI OpCo, LLC \(Estados Unidos\) \| Geração de convites com IA/);
    assert.match(prestadores, /Resend \| Plus Five Five, Inc\., que opera a Resend \(Estados Unidos\)/, 'entidade do DPA público da Resend (31/12/2025)');
});

test('cadastro: telas e API apontam para o Acordo de Tratamento de Dados; a rota pública existe', () => {
    assert.match(readFileSync('app/acordo-de-tratamento/page.tsx', 'utf8'), /DOCUMENTOS\.DPA/);
    assert.match(readFileSync('app/api/cadastro/route.ts', 'utf8'), /acordoTratamento: versaoVigente\('DPA'\)\.versao/);
    for (const tela of ['app/cadastro/page.tsx', 'app/cadastro/empresa/page.tsx'])
        assert.match(readFileSync(tela, 'utf8'), /href="\/acordo-de-tratamento"/, tela);
    assert.match(readFileSync('lib/cadastro/publico.ts', 'utf8'), /acordoTratamento: \{ versao: versaoVigente\('DPA'\)\.versao, hash: versaoVigente\('DPA'\)\.hash \}/);
    assert.match(readFileSync('components/cadastro/DocumentoLegal.tsx', 'utf8'), /id=\{s\.id\}/);
    const ancoras = (d: keyof typeof DOCUMENTOS) => DOCUMENTOS[d].secoes.flatMap((s) => s.id ? [s.id] : []);
    for (const id of ['cancelamento', 'contato']) assert.ok(ancoras('TERMOS_USO').includes(id), `/termos#${id}`);
    for (const id of ['tratamento-de-dados', 'exclusao-de-dados', 'inteligencia-artificial']) assert.ok(ancoras('PRIVACIDADE').includes(id), `/privacidade#${id}`);
});

test('cadastro só abre com flag, e-mail configurado e criação direta desligada', () => {
    const base = { CADASTRO_PUBLICO_ATIVO: 'true', USUARIOS_CRIACAO_DIRETA: 'desativada', EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: process.platform === 'win32' ? 'C:\\tmp\\x' : '/tmp/x', NODE_ENV: 'development' };
    assert.equal(situacaoCadastro(base).ativo, true);
    assert.equal(situacaoCadastro({ ...base, CADASTRO_PUBLICO_ATIVO: undefined }).ativo, false);
    assert.match(situacaoCadastro({ ...base, USUARIOS_CRIACAO_DIRETA: undefined }).motivo ?? '', /criação direta/);
    assert.match(situacaoCadastro({ ...base, EMAIL_PROVIDER: 'desativado' }).motivo ?? '', /e-mail/);
    assert.equal(situacaoCadastro({ ...base, RENDER: 'true' }).ativo, false, 'provedor de arquivo nunca vale em deploy');
});

test('pedido: e-mail normalizado; exige aceites da versão vigente e senha válida; nada de banco', () => {
    assert.equal(validarPedidoCadastro(pedido()).email, 'ana@exemplo.test');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ aceiteTermos: false }))), 'DADOS_INVALIDOS');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ aceitePrivacidade: undefined }))), 'DADOS_INVALIDOS');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao: '2020-01-01' }))), 'DADOS_INVALIDOS');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-13-minuta' }))), 'DADOS_INVALIDOS', 'o texto anterior não autoriza um novo aceite da versão atual');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-15-minuta' }))), 'DADOS_INVALIDOS', 'a revisão anterior também exige novo aceite');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-15-minuta2' }))), 'DADOS_INVALIDOS', 'a revisão da retenção exige aceite do texto atualizado');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-15-minuta4' }))), 'DADOS_INVALIDOS', 'a troca do canal de contato exige aceite do texto atualizado');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao: '2026-10-13-minuta' }))), 'DADOS_INVALIDOS', 'termos anteriores ao canal único também exigem novo aceite');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao: '2026-10-20-minuta' }))), 'DADOS_INVALIDOS', 'termos publicados em 20/10 não cobrem o DPA incorporado na v2');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-20-minuta5' }))), 'DADOS_INVALIDOS', 'o aviso publicado em 20/10 exige aceite do texto v2');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-21-minuta5a' }))), 'DADOS_INVALIDOS', 'o aviso publicado em 21/10 (#199, convites com IA) exige aceite do texto definitivo');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao: '2026-10-22-minuta', privacidadeVersao: '2026-10-22-minuta6' }))), 'DADOS_INVALIDOS', 'a minuta v2 (nunca publicada em production) não vale');
    for (const [termosVersao, privacidadeVersao] of [['2026-10-21-minuta', '2026-10-22-minuta6'], [versaoVigente('TERMOS_USO').versao, '2026-10-21-minuta6']])
        assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao, privacidadeVersao }))), 'DADOS_INVALIDOS', 'a primeira candidata v2 (21/10, nunca publicada) não vale');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: versaoVigente('DPA').versao }))), 'DADOS_INVALIDOS', 'a versão do DPA não substitui a da privacidade');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ senha: 'curta', confirmacao: 'curta' }))), 'SENHA_INVALIDA');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ confirmacao: 'outra-senha-1' }))), 'SENHA_INVALIDA');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ extra: 1 }))), 'DADOS_INVALIDOS', 'campos estranhos recusados');
});

test('mensagens: token só no fragmento do link; conta existente não recebe link de confirmação', () => {
    const token = 'A'.repeat(43);
    const link = linkConfirmacao(token, 'https://manager.exemplo.test');
    assert.equal(link, `https://manager.exemplo.test/cadastro/confirmar#t=${token}`);
    const m = mensagemConfirmacao('ana@exemplo.test', link);
    assert.ok(m.texto.includes(link) && m.html.includes(link));
    const existente = mensagemContaExistente('ana@exemplo.test', 'https://manager.exemplo.test');
    assert.doesNotMatch(existente.texto + existente.html, /#t=|cadastro\/confirmar/);
});

test('rotas do cadastro: sempre permitidas pelo paywall; pedido responde 202 igual com after(); confirmação abre sessão; empresa usa a guarda', () => {
    assert.equal(rotaSemprePermitida('/api/cadastro/empresa'), true);
    const pedidoRota = readFileSync('app/api/cadastro/route.ts', 'utf8');
    assert.match(pedidoRota, /after\(async \(\) =>/);
    assert.match(pedidoRota, /responder\(\{ ok: true, data: \{ mensagem: MENSAGEM_PEDIDO_CADASTRO \} \}, 202\)/);
    assert.match(readFileSync('app/api/cadastro/confirmar/route.ts', 'utf8'), /verificarOrigem\(request\)/);
    const empresa = readFileSync('app/api/cadastro/empresa/route.ts', 'utf8');
    assert.match(empresa, /exigirApiAdminCrmDisponivel\(request\)/);
    assert.match(empresa, /MENSAGEM_CNPJ_EXISTENTE/);
    const servico = readFileSync('lib/cadastro/publico.ts', 'utf8');
    assert.doesNotMatch(servico, /plataforma_desenvolvedores|REPRESENTANTE_AUTORIZADO'\)\s*,\s*\$|papel\s*=\s*'REPRESENTANTE_AUTORIZADO'\s+WHERE id/, 'cadastro nunca concede plataforma');
    assert.match(servico, /inserirIdentidadeNeutra\(tx, p\.email/);
});

test('E2: cadastro público recusa (503) enquanto houver bloqueio de agenda antigo sem empresa; falha de leitura também recusa', async () => {
    const consultas: string[] = [];
    const tx = (n: unknown) => ({ query: async (sql: string) => { consultas.push(sql); return { rows: n === undefined ? [] : [{ n }], rowCount: 1 }; } });
    const erro = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return `${(e as { code?: string }).code}:${(e as { httpStatus?: number; status?: number }).httpStatus ?? (e as { status?: number }).status}`; } };
    assert.equal(await erro(exigirAgendaSemBloqueioGlobal(tx(0) as never)), 'OK');
    assert.equal(await erro(exigirAgendaSemBloqueioGlobal(tx(2) as never)), 'CADASTRO_INDISPONIVEL:503');
    assert.equal(await erro(exigirAgendaSemBloqueioGlobal(tx(undefined) as never)), 'CADASTRO_INDISPONIVEL:503', 'sem resposta: fechado');
    assert.match(consultas[0], /empresa_id IS NULL AND ativo AND data >= current_date/);
    const fonte = readFileSync(new URL('./publico.ts', import.meta.url), 'utf8');
    assert.match(fonte, /await exigirAgendaSemBloqueioGlobal\(tx\);\s+if \(!await consumirLimite\(tx, 'IDENTIFICADOR', sessao\.usuario_id, REGRA_EMPRESA\)\)/, 'dentro do cadastro da empresa, antes de criá-la');
});

test('guarda dos clientes do buffet (17/11): prazos, campanhas, criança e anonimização no DPA e no Aviso, sem prometer automatismo inexistente', () => {
    const dpa = textoCanonico(DOCUMENTOS.DPA), aviso = textoCanonico(DOCUMENTOS.PRIVACIDADE), termos = textoCanonico(DOCUMENTOS.TERMOS_USO);
    for (const titulo of ['Guarda dos dados dos clientes do Contratante', 'Campanhas, fidelidade e dados de crianças', 'Fim dos prazos: anonimização'])
        assert.ok(DOCUMENTOS.DPA.secoes.some((s) => s.titulo === titulo), `DPA: seção ${titulo}`);
    assert.ok(DOCUMENTOS.PRIVACIDADE.secoes.some((s) => s.titulo === 'Guarda dos dados dos clientes do buffet e campanhas'));
    for (const trecho of ['5 anos contados da data da festa ou do último pagamento', 'até 5 anos sem festa nem contato', '2 anos sem contato', 'Só com autorização do responsável', 'não renovam os prazos'])
        assert.ok(dpa.includes(trecho), `DPA: ${trecho}`);
    for (const trecho of ['autorização de mensagens confirmada', 'como deixar de receber', 'não seguem para quem pediu para sair'])
        assert.ok(dpa.includes(trecho) && aviso.includes(trecho), `DPA e Aviso: ${trecho}`);
    // Sem automatismo inexistente: a anonimização é por procedimento enquanto não houver rotina; o lembrete de aniversário não existe.
    assert.ok(dpa.includes('Enquanto a anonimização automática não estiver em operação, a Demerzel Labs aplica estes prazos por procedimento operacional'));
    assert.ok(dpa.includes('ele não oferece lembrete de aniversário') && aviso.includes('Hoje o iA.Fest não oferece esse lembrete'));
    assert.ok(dpa.includes('ciclo máximo de 90 dias; se houver restauração, a eliminação é reaplicada'));
    // Astra r1: saída sem garantia por telefone/e-mail antes de existir; prazo por finalidade; exceção restrita; nunca depois do vencimento.
    assert.ok(dpa.includes('O envio de campanhas pelo sistema só será ligado quando o pedido de saída for conferido também pelo telefone e pelo e-mail'));
    assert.ok(!dpa.includes('para que um novo cadastro ou uma importação não volte a chamar a pessoa'));
    assert.ok(dpa.includes('Cada prazo vale para a sua finalidade') && aviso.includes('Cada prazo vale para a sua finalidade'));
    assert.ok(dpa.includes('preserva só os registros necessários à cobrança ou à disputa'));
    assert.ok(dpa.includes('até 30 dias antes do vencimento, nunca depois, salvo na primeira aplicação'));
    assert.ok(dpa.includes('um único aviso alcança os dados já vencidos e os que vencem no mês do aviso e no seguinte; cada um é eliminado no primeiro dia do mês do seu vencimento ou 30 dias depois do aviso, o que for mais tarde'), 'Astra r2/r3: regra da primeira aplicação explícita no DPA');
    // Astra r1 P2: o Aviso dá ao titular os três critérios.
    for (const trecho of ['ou do cancelamento, se a festa foi cancelada', 'Só renova esses prazos o contato que parte da pessoa', 'enquanto o buffet for assinante do iA.Fest'])
        assert.ok(aviso.includes(trecho), `Aviso: ${trecho}`);
    assert.ok(termos.includes('“Guarda dos dados dos clientes do Contratante” e “Fim dos prazos: anonimização”'), 'Termos remetem às seções do DPA');
    for (const titulo of ['Guarda dos dados dos clientes do Contratante', 'Fim dos prazos: anonimização'])
        assert.ok(DOCUMENTOS.DPA.secoes.some((s) => s.titulo === titulo), `remissão dos Termos aponta para seção existente: ${titulo}`);
});

test('guarda dos clientes (Astra r3): primeira aplicação e ciclo normal — aviso mínimo de 30 dias e antecipação máxima de 30 dias', () => {
    const DIA = 86_400_000;
    const utc = (a: number, m: number, d: number) => Date.UTC(a, m - 1, d);
    const primeiroDoMes = (t: number) => { const x = new Date(t); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1); };
    const somaMeses = (t: number, n: number) => { const x = new Date(t); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, 1); };
    // Regra do DPA (“Fim dos prazos: anonimização”) e do calendário (seção 2, itens 8.3 e 8.6).
    const execucaoTransicao = (d: number, venc: number) => Math.max(primeiroDoMes(venc), d + 30 * DIA);
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    // Casos do parecer.
    assert.equal(iso(execucaoTransicao(utc(2027, 4, 1), utc(2027, 4, 15))), '2027-05-01');
    assert.equal(iso(execucaoTransicao(utc(2027, 4, 1), utc(2027, 5, 15))), '2027-05-01');
    assert.equal(iso(execucaoTransicao(utc(2027, 7, 1), utc(2027, 8, 31))), '2027-08-01');
    assert.equal(iso(execucaoTransicao(utc(2027, 2, 1), utc(2027, 3, 1))), '2027-03-03');
    // Varredura: todo D (dia 1º de 2027–2028) e todo vencimento até o fim do mês D+1.
    for (let m = 0; m < 24; m++) {
        const d = Date.UTC(2027, m, 1);
        for (let venc = d - 400 * DIA; venc < somaMeses(d, 2); venc += DIA) {
            const exec = execucaoTransicao(d, venc);
            assert.ok(exec - d >= 30 * DIA, `aviso mínimo: D=${iso(d)} venc=${iso(venc)}`);
            assert.ok(venc - exec <= 30 * DIA, `antecipação máxima: D=${iso(d)} venc=${iso(venc)}`);
            if (exec > venc) assert.ok(venc < d + 30 * DIA && exec === d + 30 * DIA, `atraso só na exceção do DPA: D=${iso(d)} venc=${iso(venc)}`);
        }
        // Ciclo normal: aviso em D para o mês D+2, execução no 1º de D+2.
        for (let venc = somaMeses(d, 2); venc < somaMeses(d, 3); venc += DIA) {
            const exec = somaMeses(d, 2);
            assert.ok(exec - d >= 30 * DIA && venc - exec <= 30 * DIA && exec <= venc, `ciclo normal: D=${iso(d)} venc=${iso(venc)}`);
        }
    }
});

test('manifesto versão → hash (R-5): conteúdo novo exige versão nova, DPA novo exige Termos novos e o histórico publicado fica guardado', () => {
    const pasta = 'lib/cadastro/textos-legais';
    const manifesto = (JSON.parse(readFileSync(`${pasta}/manifesto.json`, 'utf8')) as { versoes: EntradaManifesto[] }).versoes;
    const ler = (arquivo: string) => { try { return readFileSync(`${pasta}/${arquivo}`, 'utf8'); } catch { return null; } };
    assert.deepEqual(conferirManifesto(DOCUMENTOS, manifesto, ler), []);
    for (const [documento, versao] of [['TERMOS_USO', '2026-10-20-minuta'], ['PRIVACIDADE', '2026-10-21-minuta5a']])
        assert.ok(manifesto.some((e) => e.documento === documento && e.versao === versao), `versão publicada em production guardada: ${documento}@${versao}`);
    for (const [documento, versao] of [['TERMOS_USO', '2026-11-15-termos'], ['PRIVACIDADE', '2026-11-15-privacidade'], ['DPA', '2026-11-15-dpa']])
        assert.ok(manifesto.some((e) => e.documento === documento && e.versao === versao), `versão publicada em staging guardada: ${documento}@${versao}`);
    // Controle negativo 1: obrigação do DPA alterada mantendo a versão (a mutação da revisão do Astra de 03/11).
    const trocar = (d: TextoLegal, de: string, para: string) => ({ ...d, secoes: d.secoes.map((s) => ({ ...s, paragrafos: s.paragrafos.map((p) => p.replace(de, para)) })) });
    const dpaMutado = trocar(DOCUMENTOS.DPA, 'avisará o Contratante', 'avisará prontamente o Contratante');
    assert.notEqual(hashDocumento(dpaMutado), hashDocumento(DOCUMENTOS.DPA), 'a mutação muda o texto');
    assert.ok(conferirManifesto({ ...DOCUMENTOS, DPA: dpaMutado }, manifesto, ler).some((e) => e.startsWith(`DPA@${DOCUMENTOS.DPA.versao}: conteúdo mudou sem nova versão`)));
    // Controle negativo 2: o mesmo DPA mutado com versão nova registrada, sem nova versão dos Termos.
    const dpaNovo = { ...dpaMutado, versao: '2099-01-01-dpa' };
    const comDpaNovo = [...manifesto, { documento: 'DPA' as const, versao: dpaNovo.versao, sha256: hashDocumento(dpaNovo), arquivo: 'novo.txt' }];
    const lerNovo = (arquivo: string) => arquivo === 'novo.txt' ? textoCanonico(dpaNovo) : ler(arquivo);
    assert.deepEqual(conferirManifesto({ ...DOCUMENTOS, DPA: dpaNovo }, comDpaNovo, lerNovo), [`TERMOS_USO@${DOCUMENTOS.TERMOS_USO.versao}: o DPA mudou sem nova versão dos Termos`]);
    // Controle negativo 3: Termos alterados mantendo a versão; 4: versão repetida; 5: texto guardado adulterado.
    assert.ok(conferirManifesto({ ...DOCUMENTOS, TERMOS_USO: trocar(DOCUMENTOS.TERMOS_USO, 'sem multa', 'sem multa nem aviso') }, manifesto, ler)
        .some((e) => e.startsWith(`TERMOS_USO@${DOCUMENTOS.TERMOS_USO.versao}: conteúdo mudou sem nova versão`)));
    assert.ok(conferirManifesto(DOCUMENTOS, [...manifesto, manifesto[0]], ler).some((e) => e.endsWith('versão repetida no manifesto')));
    assert.ok(conferirManifesto(DOCUMENTOS, manifesto, (a) => (ler(a) ?? '') + ' ').every((e) => /não corresponde ao hash|diverge do publicado/.test(e)));
    assert.match(readFileSync('.gitattributes', 'utf8'), /^lib\/cadastro\/textos-legais\/\*\.txt -text$/m, 'checkout sem CRLF nos textos canônicos');
});

test('Termos: devolução por Pix volta à conta de origem, como no estorno do código', () => {
    const termos = textoCanonico(DOCUMENTOS.TERMOS_USO);
    assert.match(termos, /no cartão de crédito ou no Pix, o valor volta ao cartão ou à conta que fez o pagamento/);
    assert.match(termos, /no boleto, ou se o estorno pelo meio original não for possível, pediremos os dados bancários da empresa/);
    assert.doesNotMatch(termos, /para Pix ou boleto, pediremos os dados bancários/);
    const codigo = readFileSync('lib/assinatura/devolucao.ts', 'utf8');
    assert.match(codigo, /FORMAS_ESTORNO_API = new Set\(\['PIX', 'CREDIT_CARD'\]\)/, 'texto depende de Pix e cartão terem estorno pela API');
});

test('R-5 r5.2: a Gupshup deixou de ser usada (decisão de Felipe, só Meta) e não aparece em nenhum texto legal', () => {
    for (const d of Object.values(DOCUMENTOS))
        assert.doesNotMatch(textoCanonico(d), /Gupshup/i, d.documento);
    const meta = DOCUMENTOS.PRIVACIDADE.secoes.find((s) => s.id === 'prestadores')?.tabela?.linhas.find((l) => l[0] === 'Meta/WhatsApp');
    assert.match(meta?.[2] ?? '', /códigos de verificação/, 'os códigos de verificação passam a sair só pela Meta');
});
