/* eslint-disable @typescript-eslint/no-require-imports */
// Componentes reais, APIs interceptadas, banco inacessível. Nenhum segredo ou .env é carregado.
const fs = require('node:fs'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const origin = 'http://127.0.0.1:3037', out = '.local-ux/contratos-perfil';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clienteId = id(1), contratoId = id(2), versaoId = id(3), aniversarioId = id(4);
const snapshot = {
    contratante: { nomeCompleto: 'Cliente de Exemplo', email: 'cliente@example.invalid' },
    aniversariante: { nome: 'Catarina Exemplo', idadeNoEvento: 1, temaFesta: 'Unicórnio' },
    evento: { data: '2099-09-30', horarioInicio: '17:00', horarioFim: '21:00', pacote: { nome: 'Premium', codigo: 'PREMIUM' }, convidados: 70 },
    comercial: { valorFinalContrato: 9800, formaPagamentoPretendida: 'PIX_AVISTA' },
    contratacao: { adicionais: [], buffet: {} },
};
const versao = { id: versaoId, numero_versao: 1, status: 'ATIVA', estado_edicao: 'EM_ELABORACAO', revisao: 1, origem_versao_id: null, snapshot, dados_fonte: null, criado_em: '2026-10-01T15:00:00Z', documento_revisado_id: null };
const painel = { contrato: { id: contratoId, status: 'AGUARDANDO_ASSINATURA', fechamento_id: id(5), versao_atual: 1 }, fluxo: { versao_vigente_id: null, versao_em_preparacao_id: versaoId }, versoes: [versao], documentos: [{ id: id(6), contrato_versao_id: versaoId, categoria: 'CONTRATO', revisao: 1 }], assinaturas: [], revisoesOperacionais: [], financeiro: [], pendencias: [] };
const endereco = { cep: '00000000', logradouro: 'Rua de Exemplo', numero: '100', semNumero: false, complemento: '', bairro: 'Centro', cidade: 'Cidade Exemplo', uf: 'SP', pais: 'BR' };
const cadastro = { nomeComercial: 'Empresa de Exemplo', razaoSocial: 'Empresa de Exemplo Ltda.', cnpj: '11222333000181', sede: endereco, unidadeNome: 'Unidade Exemplo', mesmoEnderecoSede: true, unidade: endereco, referenciaChegada: '', telefone: '11999999999', whatsapp: '', emailComercial: 'contato@example.invalid', site: '', instagram: '' };
const perfil = { estruturaInstalada: true, vazio: false, contexto: { codigoEmpresa: 'EXEMPLO', codigoUnidade: 'UNIDADE-EXEMPLO', versao: 1, cadastro, rascunho: null }, historico: [], capacidades: { PERFIL_CONSULTAR: true, PERFIL_EDITAR_RASCUNHO: true, PERFIL_APLICAR: true, PERFIL_ADMINISTRAR_CONCESSOES: false } };
const dia = data => ({ data, periodos: ['TURNO_1', 'TURNO_2'].map((codigo, i) => ({ configuracaoId: id(10 + i), codigo, nome: `Turno ${i + 1}`, status: 'DISPONIVEL', horarioInicioPadrao: i ? '17:00' : '11:00', horarioFimPadrao: i ? '21:00' : '15:00', horarios: [{ inicio: i ? '17:00' : '11:00', fim: i ? '21:00' : '15:00', ajusteMinutos: 0, status: 'DISPONIVEL' }] })) });

async function main() {
    assert(!fs.readdirSync('.').some(n => n === '.env' || n.startsWith('.env.') && n !== '.env.example'), 'Execute em worktree sem arquivos .env.');
    let ocupada = false; try { await fetch(origin); ocupada = true; } catch { /* porta livre */ } assert(!ocupada, 'Porta 3037 ocupada.');
    fs.mkdirSync(out, { recursive: true });
    const gerados = ['next-env.d.ts', 'tsconfig.json'].map(p => [p, fs.readFileSync(p)]);
    const log = fs.openSync(`${out}/server.log`, 'w');
    const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '-p', '3037'], { windowsHide: true, env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', KIDMAIS_PREVIEW_UX: '1', KIDMAIS_FESTA_ISOLADO: 'true', KIDMAIS_FESTA_AMBIENTE: 'automated', DATABASE_URL: 'postgresql://ux:ux@127.0.0.1:1/ux_no_database' }, stdio: ['ignore', log, log] });
    let browser;
    const errors = [], inesperados = [], posts = [], resultados = [];
    let estadoPerfil = 'ok', estadoIA = 'incompleto', estadoContrato = 'EM_ELABORACAO', revisado = false, draft = null, logoAplicada = null;
    const logoInputBytes = process.env.KIDMAIS_UX_LOGO_FILE
        ? fs.readFileSync(process.env.KIDMAIS_UX_LOGO_FILE)
        : Buffer.concat([fs.readFileSync('public/assets/kidmais-logo-horizontal.png'), Buffer.alloc(3 * 1024 * 1024)]);
    assert(logoInputBytes.length > 2 * 1024 * 1024 && logoInputBytes.length <= 10 * 1024 * 1024, 'A regressão deve exercitar um PNG acima do antigo limite de 2 MB.');
    const logoBytes = await sharp(logoInputBytes).rotate().resize({width:1024,height:512,fit:'inside',withoutEnlargement:true}).png().toBuffer();
    const logo = `data:image/png;base64,${logoBytes.toString('base64')}`;
    try {
        let pronto = false;
        for (let i = 0; i < 120; i++) { try { if ((await fetch(`${origin}/admin/login`)).ok) { pronto = true; break; } } catch { /* iniciando */ } await new Promise(r => setTimeout(r, 500)); }
        assert(pronto, 'Servidor indisponível.');
        const bin = chromium.executablePath();
        browser = await chromium.launch(fs.existsSync(bin) ? { headless: true } : { headless: true, channel: 'msedge' });
        const context = await browser.newContext({ colorScheme: 'dark' });
        await context.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.origin !== origin) { inesperados.push(url.origin); return route.abort(); }
            if (!url.pathname.startsWith('/api/')) return route.continue();
            const ok = data => route.fulfill({ json: { ok: true, data } });
            const fail = (status, codigo, erro) => route.fulfill({ status, json: { ok: false, codigo, erro } });
            const body = request.method() === 'POST' && request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null;
            if (body) posts.push({ url: url.pathname, body });
            if (url.pathname === '/api/admin/autenticacao') return ok({ usuarioId: id(9), nome: 'Revisão visual', papel: 'REPRESENTANTE_AUTORIZADO', csrf: 'csrf-sintetico' });
            if (url.pathname === '/api/admin/configuracoes/perfil-empresa/logo') return ok({logoDataUrl:request.method()==='POST'?logo:logoAplicada});
            if (url.pathname === '/api/admin/disponibilidade') return route.fulfill({json:{agenda:[],pacoteOverrides:[],descontos:[],bloqueios:[]}});
            if (url.pathname === '/api/admin/clientes') return ok([{cliente:{id:clienteId,nomeCompleto:'Cliente de Exemplo',status:'ATIVO',whatsapp:'11999999999'},cadastroCompleto:true,camposFaltantes:[]}]);
            if (url.pathname === '/api/admin/contratos/painel') {
                await new Promise(r => setTimeout(r, 150));
                const outro = url.searchParams.get('contratoId') === id(22);
                return ok(url.searchParams.has('contratoId') ? { ...painel, contrato: { ...painel.contrato, id: outro ? id(22) : contratoId, status: estadoContrato === 'CONCLUIDA' ? 'ASSINADO' : 'AGUARDANDO_ASSINATURA' }, versoes: [{ ...versao, id: outro ? id(23) : versaoId, snapshot: outro ? {...snapshot,contratante:{...snapshot.contratante,nomeCompleto:'Outro Cliente de Exemplo'}} : snapshot, estado_edicao: estadoContrato, status: estadoContrato === 'CONCLUIDA' ? 'ASSINADA' : 'ATIVA', documento_revisado_id: revisado ? id(6) : null }] } : [contratoId,id(22)].map(id=>({id,nome: id===contratoId ? snapshot.contratante.nomeCompleto : 'Outro Cliente de Exemplo', data_evento: snapshot.evento.data,pacote:'Premium',convidados:70,status:'AGUARDANDO_ASSINATURA'})));
            }
            if (url.pathname === `/api/admin/contratos/versoes/${versaoId}`) {
                if (body.acao === 'revisar') revisado = true;
                if (body.acao === 'assinar') estadoContrato = 'ASSINADA_KIDMAIS';
                if (body.acao === 'liberar') estadoContrato = 'AGUARDANDO_CLIENTE';
                return ok({ versaoId });
            }
            if (url.pathname === `/api/admin/clientes/${clienteId}/fechamentos`) return body ? ok({ fechamentoId: id(5), status: 'AGUARDANDO_CONTRATO' }) : ok({ cliente: { id: clienteId, nomeCompleto: 'Cliente de Exemplo', cpf: '00000000000' }, aniversariantes: [{ id: aniversarioId, nome: 'Catarina Exemplo' }], responsaveis: [], redirecionadoDe: null });
            if (url.pathname === '/api/admin/fechamentos/adicionais') return route.fulfill({ json: { adicionais: [] } });
            if (url.pathname === `/api/admin/fechamentos/${id(5)}/revisao`) return ok({ fechamento: { id: id(5), clienteId, dataEvento: '2099-09-30', horarioInicio: '17:00', horarioFim: '21:00', convidados: 70, temaFesta: 'Unicórnio', formaPagamentoPretendida: 'PIX_AVISTA', status: 'AGUARDANDO_CONTRATO', valorTabela: 9800, valorNegociado: null, valorAprovado: null, condicaoPagamento: { forma: 'PIX_AVISTA', revisaoStatus: 'APROVADA', pretendida: null, aprovada: null } }, aprovacoes: [] });
            if (url.pathname === '/api/disponibilidade') {
                if (url.searchParams.has('data')) return ok(dia(url.searchParams.get('data')));
                const inicio = new Date(`${url.searchParams.get('inicio')}T12:00:00Z`), fim = new Date(`${url.searchParams.get('fim')}T12:00:00Z`), dias = [];
                for (const d = inicio; d <= fim; d.setUTCDate(d.getUTCDate() + 1)) dias.push(dia(d.toISOString().slice(0, 10)));
                return ok(dias);
            }
            if (url.pathname === '/api/admin/configuracoes/perfil-empresa') {
                if (estadoPerfil === 'carregando') await new Promise(r => setTimeout(r, 2000));
                if (estadoPerfil === 'concessao') return fail(403, 'PERFIL_SEM_CONCESSAO', 'Sem concessão ativa para consultar o perfil.');
                if (estadoPerfil === '403') return fail(403, 'ACESSO_NEGADO', 'Operação não permitida para esta sessão.');
                if (estadoPerfil === 'erro') return fail(500, 'ERRO', 'Não foi possível carregar o perfil.');
                if (body?.acao === 'salvar-rascunho') { draft = { numero: 1, edicao: 1, versaoBase: 1, conteudo: body.cadastro }; return ok(draft); }
                if (body?.acao === 'aplicar') { if (estadoPerfil === 'conflito') { draft.edicao = 2; return route.fulfill({ status: 409, json: { ok: false, codigo: 'PERFIL_CONFLITO', erro: 'Outra edição alterou o perfil.', detalhes: { numero: 1, edicao: 2, versao: 1 } } }); } logoAplicada=draft.conteudo.logoDataUrl??null; draft = null; return ok({ versao: 2 }); }
                return ok({ ...perfil, contexto: { ...perfil.contexto, cadastro:{...cadastro,logoDataUrl:logoAplicada},rascunho: draft } });
            }
            if (url.pathname === '/api/admin/inteligencia/conversa') {
                await new Promise(r => setTimeout(r, estadoIA === 'carregando' ? 2000 : 100));
                if (estadoIA === 'erro') return fail(503, 'INTELIGENCIA_INDISPONIVEL', 'Não foi possível preparar esta resposta.');
                // Capability ausente: o mock reproduz a recusa, nunca inventa um rascunho contratual.
                return ok({ tipo: 'nao_suportado', mensagem: 'Criar contrato pela conversa ainda não está disponível. Abra o cliente no CRM para preparar a contratação.', sugestoes: [] });
            }
            inesperados.push(`${request.method()} ${url.pathname}`); return route.abort();
        });
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        const abrir = async tela => page.goto(`${origin}/preview-ux/contratos-perfil?tela=${tela}${tela === 'contratos' ? `&contratoId=${contratoId}` : ''}`);
        const foto = async nome => { const dialogo = await page.getByRole('dialog').count(); if (!dialogo) await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${out}/${nome}.png`, fullPage: !dialogo }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Overflow em ${nome}`); };
        for (const [viewport, width, height] of [['desktop', 1440, 1000], ['celular', 390, 844]]) {
            await page.setViewportSize({ width, height });
            await page.goto(`${origin}/preview-ux/dashboard`);
            await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
            const ai=page.locator('[data-km-assistente]:visible');
            assert.equal(await ai.count(),viewport==='desktop'?2:1);
            assert.notEqual(await ai.first().evaluate(el=>getComputedStyle(el).animationName),'none');
            assert.equal(await page.getByRole('link',{name:'Consultar disponibilidade',exact:true}).getAttribute('class'),await page.getByRole('link',{name:'Novo cliente',exact:true}).getAttribute('class'));
            await foto(`dashboard-${viewport}`);
            await page.goto(`${origin}/clientes`); await page.getByRole('link',{name:/Cliente de Exemplo/}).filter({visible:true}).waitFor();
            assert.equal(await page.locator('main header').count(),0);
            assert.equal(await page.getByRole('link',{name:'Fechamento',exact:true}).getAttribute('href'),'/fechamento?origem=ATENDIMENTO_KIDMAIS&contexto=ADMIN');
            await foto(`clientes-${viewport}`);
            await page.goto(`${origin}/admin/disponibilidade`); await page.getByRole('combobox',{name:/^Pacote/}).waitFor();
            assert.equal(await page.locator('main header img').count(),0);
            const clienteView=page.getByRole('link',{name:'Ver tela do cliente →',exact:true});
            const posView=await clienteView.boundingBox(),posFiltro=await page.getByRole('combobox',{name:/^Horário padrão/}).boundingBox();
            assert(posView.y>=posFiltro.y+posFiltro.height);
            await foto(`disponibilidade-${viewport}`);
            await page.goto(`${origin}/preview-ux/dashboard`);
            const pendencia=page.getByRole('link',{name:/Contrato aguardando assinatura/});
            await pendencia.click(); await page.getByRole('heading',{name:'Cliente de Exemplo',exact:true}).waitFor();
            assert.equal(new URL(page.url()).searchParams.get('contratoId'),contratoId);
            assert.equal(await page.getByRole('tab',{name:'Documentos',exact:true}).getAttribute('aria-selected'),'true');
            await page.goto(`${origin}/preview-ux/dashboard`);
            await page.getByRole('link',{name:'Abrir contrato da festa de João Souza',exact:true}).filter({visible:true}).click();
            await page.getByRole('heading',{name:'Outro Cliente de Exemplo',exact:true}).waitFor();
            assert.equal(new URL(page.url()).searchParams.get('contratoId'),id(22));
            await abrir('contratos'); await page.getByRole('heading', { name: 'Cliente de Exemplo', exact: true }).waitFor(); await foto(`contratos-${viewport}`);
            const tabs = page.getByRole('tablist', { name: 'Conteúdo do contrato' });
            await tabs.getByRole('tab', { name: 'Visão geral' }).focus(); await page.keyboard.press('ArrowRight');
            assert.equal(await tabs.getByRole('tab', { name: 'Documentos' }).getAttribute('aria-selected'), 'true');
            const nota = page.getByLabel('Observações exclusivamente documentais'); await nota.fill('Texto sintético preservado entre abas.');
            await tabs.getByRole('tab', { name: 'Histórico' }).click(); await page.getByRole('heading', { name: 'Histórico de versões' }).waitFor();
            await tabs.getByRole('tab', { name: 'Documentos' }).click(); assert.equal(await nota.inputValue(), 'Texto sintético preservado entre abas.'); await foto(`documentos-${viewport}`);
            await tabs.getByRole('tab', { name: 'Financeiro' }).click(); await page.getByRole('heading', { name: 'Financeiro da contratação', exact: true }).waitFor(); await foto(`financeiro-${viewport}`);
            await abrir('revisao'); await page.getByRole('heading', { name: 'Preparar contratação' }).waitFor(); await foto(`revisao-pendente-${viewport}`);
            await page.getByRole('button', { name: 'Revisar contratação', exact: true }).click(); assert.equal(await page.getByLabel('Aniversariante', { exact: true }).getAttribute('aria-invalid'), 'true');
            await page.getByLabel('Pacote', { exact: true }).selectOption('premium');
            await page.getByRole('button', { name: 'Próximo mês' }).click(); await page.getByRole('button', { name: /^15 de / }).click();
            await page.getByLabel('Horário disponível', { exact: true }).selectOption('11:00'); await page.getByLabel('Convidados pagantes', { exact: true }).fill('70');
            await page.getByLabel('Aniversariante', { exact: true }).selectOption(aniversarioId); await page.getByLabel('Idade no evento (opcional)', { exact: true }).fill('1'); await page.getByLabel('Tema', { exact: true }).fill('Unicórnio'); await page.getByLabel('Valor comercial proposto (R$)', { exact: true }).fill('9800');
            const antes = posts.length; await page.getByRole('button', { name: 'Revisar contratação', exact: true }).click(); await page.getByRole('heading', { name: 'Revise antes de criar' }).waitFor(); assert.equal(posts.length, antes, 'Revisar não grava'); await foto(`revisao-${viewport}`);
            await page.getByRole('button', { name: 'Voltar e corrigir' }).click(); assert.equal(await page.getByLabel('Tema', { exact: true }).inputValue(), 'Unicórnio'); assert.equal(await page.getByLabel('Convidados pagantes', { exact: true }).inputValue(), '70');
            await page.getByRole('button', { name: 'Revisar contratação', exact: true }).click(); await page.getByRole('button', { name: 'Confirmar e criar fechamento' }).click(); await page.getByRole('heading', { name: 'Fechamento criado' }).waitFor(); const criado = posts.at(-1); assert.equal(criado.url, `/api/admin/clientes/${clienteId}/fechamentos`); assert.equal(criado.body.temaFesta, 'Unicórnio'); assert.equal(criado.body.convidadosPagantes, 70);
            estadoPerfil = 'ok'; draft = null; logoAplicada=null; await abrir('perfil'); await page.getByLabel('Nome comercial (obrigatório ao aplicar)').waitFor();
            await page.getByLabel('Selecionar logo',{exact:true}).setInputFiles({name:'logo.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
            await page.getByRole('alert').filter({hasText:'PNG, JPEG ou WebP'}).waitFor(); assert.equal(await page.getByAltText('Prévia da logo do rascunho').count(),0);
            await page.getByLabel('Selecionar logo',{exact:true}).setInputFiles({name:'logo.png',mimeType:'image/png',buffer:logoInputBytes});
            await page.getByRole('status').filter({hasText:'logo.png: prévia pronta'}).waitFor();
            await page.getByAltText('Prévia da logo do rascunho').waitFor(); assert.equal(await page.getByAltText('Prévia da logo do rascunho').getAttribute('src'),logo);
            await page.getByLabel('Selecionar logo',{exact:true}).setInputFiles({name:'grande.png',mimeType:'image/png',buffer:Buffer.alloc(11 * 1024 * 1024)});
            await page.getByRole('alert').filter({hasText:'grande.png tem 11 MB. A logo deve ter até 10 MB.'}).waitFor();
            assert.equal(await page.getByAltText('Prévia da logo do rascunho').getAttribute('src'),logo);
            await page.getByLabel('Selecionar logo',{exact:true}).setInputFiles({name:'logo.png',mimeType:'image/png',buffer:logoInputBytes});
            await page.getByRole('status').filter({hasText:'logo.png: prévia pronta'}).waitFor();
            assert.equal(await page.getByAltText('Logo atual da empresa').count(),0);
            await foto(`perfil-logo-${viewport}`);
            await page.getByLabel('Nome comercial (obrigatório ao aplicar)').fill('Empresa Revisada Exemplo'); await page.getByRole('button', { name: 'Salvar rascunho' }).click(); await page.getByText('Rascunho salvo.', { exact: true }).first().waitFor(); await page.getByRole('button', { name: 'Revisar e aplicar', exact: true }).click(); await page.getByRole('dialog').waitFor(); await foto(`perfil-revisao-${viewport}`); await page.getByRole('button', { name: 'Fechar revisão' }).click();
            estadoPerfil = '403'; await abrir('perfil'); await page.getByRole('heading', { name: 'Acesso negado' }).waitFor(); assert(!/Sem concessão/.test(await page.locator('main').innerText())); await foto(`perfil-acesso-${viewport}`);
            estadoPerfil = 'erro'; await abrir('perfil'); await page.getByRole('alert').waitFor(); await foto(`perfil-erro-${viewport}`); assert.equal(await page.getByRole('heading', { name: 'Acesso negado' }).count(), 0);
            estadoPerfil = 'carregando'; await abrir('perfil'); await page.getByText('Carregando perfil.', { exact: true }).waitFor(); await foto(`perfil-carregando-${viewport}`); estadoPerfil = 'ok';
            await abrir('contratos'); await page.getByRole('heading', { name: 'Cliente de Exemplo', exact: true }).waitFor(); if (viewport === 'celular') await page.getByRole('button', { name: 'Abrir menu' }).click(); await page.getByRole('button', { name: 'Perguntar ao Kidmais' }).click(); await page.getByRole('dialog', { name: 'Assistente Kidmais' }).waitFor(); await foto(`ia-vazia-${viewport}`);
            const pergunta = 'Faça um contrato do Felipe, Premium, 70 convidados, 31/09 às 17h, Catarina 1 ano, tema unicórnio.';
            estadoIA = 'carregando'; await page.getByRole('textbox', { name: 'Sua pergunta' }).fill(pergunta); await page.getByRole('button', { name: 'Enviar', exact: true }).click(); await page.getByText('Preparando resposta…', { exact: true }).waitFor(); await foto(`ia-carregando-${viewport}`); await page.getByText(/^Criar contrato pela conversa/).waitFor(); await foto(`ia-${viewport}`); assert.equal(posts.at(-1).body.texto, pergunta);
            estadoIA = 'erro'; await page.getByRole('textbox', { name: 'Sua pergunta' }).fill('Consultar operação'); await page.getByRole('button', { name: 'Enviar', exact: true }).click(); await page.getByRole('alert').waitFor(); await foto(`ia-erro-${viewport}`); await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
            resultados.push({ viewport, botoesPadronizados:true,cabecalhosSimplificados:true,logoUploadPrevia:true, abasTeclado: true, observacoesPreservadas: true, revisaoSemGravacao: true, criacaoPayloadPreservado: true, perfilEstados: true, iaCapabilityAusente: true, overflow: false });
        }
        estadoPerfil = 'concessao'; await abrir('perfil'); await page.getByText('Sem concessão ativa para consultar o perfil.', { exact: true }).waitFor();
        // Assinatura e liberação continuam usando as mesmas operações, apenas em mocks.
        await page.setViewportSize({ width: 1440, height: 1000 });
        estadoContrato = 'EM_ELABORACAO'; await abrir('contratos'); await page.getByRole('tab', { name: 'Documentos', exact: true }).click();
        page.on('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Confirmar revisão deste PDF', exact: true }).click();
        await page.getByLabel('Confirme sua senha').fill('senha-sintetica-sem-credencial-real');
        await page.getByRole('button', { name: 'Aprovar e assinar pela Kidmais', exact: true }).click();
        await page.getByRole('button', { name: 'Liberar para o cliente', exact: true }).click();
        const publico = page.getByRole('link', { name: /^Abrir acesso público do cliente/ });
        await publico.waitFor(); assert.equal(await publico.count(),1);
        assert.equal(await publico.evaluate(el=>!!el.closest('div')?.textContent.includes('Próximo passo')),true);
        assert.deepEqual(posts.filter(p => p.url === `/api/admin/contratos/versoes/${versaoId}`).map(p => p.body.acao), ['revisar', 'assinar', 'liberar']);
        estadoPerfil = 'ok'; draft = null; await abrir('perfil');
        await page.getByLabel('Nome comercial (obrigatório ao aplicar)').fill('Perfil para revisão sintética');
        await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await page.getByText('Rascunho salvo.', { exact: true }).first().waitFor();
        await page.getByRole('button', { name: 'Revisar e aplicar', exact: true }).click();
        const dialogoPerfil = page.getByRole('dialog'); await dialogoPerfil.getByLabel('Motivo da aplicação').fill('Conferência sintética'); await dialogoPerfil.getByLabel('Confirmo o antes e o depois do rascunho salvo').check();
        estadoPerfil = 'conflito'; await dialogoPerfil.getByRole('button', { name: 'Confirmar e aplicar', exact: true }).click(); await dialogoPerfil.getByText('Outra edição alterou o perfil.', { exact: true }).waitFor(); assert(await dialogoPerfil.getByRole('button', { name: 'Confirmar e aplicar', exact: true }).isDisabled()); await foto('perfil-conflito-desktop');
        await page.getByRole('button', { name: 'Fechar revisão' }).click(); assert.equal(await page.getByLabel('Nome comercial (obrigatório ao aplicar)').inputValue(), 'Perfil para revisão sintética');
        // Fluxo completo no shell real: salvar não publica; aplicar atualiza o menu sem recarregar a página.
        estadoPerfil='ok'; draft=null; logoAplicada=null;
        await page.goto(`${origin}/admin/configuracoes/perfil-empresa`); await page.getByLabel('Selecionar logo',{exact:true}).waitFor();
        await page.getByLabel('Selecionar logo',{exact:true}).setInputFiles({name:'logo.png',mimeType:'image/png',buffer:logoInputBytes});
        await page.getByAltText('Prévia da logo do rascunho').waitFor();
        await page.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await page.getByText('Rascunho salvo.',{exact:true}).first().waitFor();
        assert.equal(logoAplicada,null);assert.equal(draft.conteudo.logoDataUrl,logo);
        await page.reload();await page.getByAltText('Prévia da logo do rascunho').waitFor();
        await page.getByRole('button',{name:'Revisar e aplicar',exact:true}).click();await page.getByAltText('Logo salva para aplicar').waitFor();
        const revisaoLogo=page.getByRole('dialog');await revisaoLogo.getByLabel('Motivo da aplicação').fill('Aplicar logo de exemplo');await revisaoLogo.getByLabel('Confirmo o antes e o depois do rascunho salvo').check();
        await revisaoLogo.getByRole('button',{name:'Confirmar e aplicar',exact:true}).click();await page.getByAltText('Logo atual da empresa').waitFor();await page.getByAltText('Logo da empresa',{exact:true}).waitFor();
        assert.equal(await page.getByRole('dialog').count(),0);await foto('perfil-logo-aplicada-desktop');
        await page.getByRole('button',{name:'Remover logo do rascunho',exact:true}).click();assert.equal(await page.getByAltText('Logo atual da empresa').count(),1);
        await page.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await page.getByText('Rascunho salvo.',{exact:true}).first().waitFor();
        await page.getByRole('button',{name:'Revisar e aplicar',exact:true}).click();const remover=page.getByRole('dialog');await remover.getByLabel('Motivo da aplicação').fill('Remover logo de exemplo');await remover.getByLabel('Confirmo o antes e o depois do rascunho salvo').check();await remover.getByRole('button',{name:'Confirmar e aplicar',exact:true}).click();
        await page.getByText('Nenhuma logo aplicada',{exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('img[alt="Logo da empresa"]'));assert.equal(logoAplicada,null);
        assert.equal(await page.getByRole('dialog').count(),0);
        assert.deepEqual(errors, []); assert.deepEqual(inesperados, []);
        estadoPerfil = 'ok';
        await page.emulateMedia({ colorScheme: 'light' });
        await abrir('contratos'); await page.getByRole('heading', { name: 'Cliente de Exemplo', exact: true }).waitFor(); await foto('contratos-preferencia-clara');
        await abrir('perfil'); await page.getByLabel('Nome comercial (obrigatório ao aplicar)').waitFor(); await foto('perfil-preferencia-clara');
        await page.goto(`${origin}/admin/fechamentos/${id(5)}/revisao`); await page.getByRole('button', { name: 'Gerar contrato', exact: true }).waitFor(); await foto('revisao-comercial-desktop');
        await page.goto(`${origin}/preview-ux/dashboard`);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.locator('[data-km-assistente]:visible').first().evaluate(el=>getComputedStyle(el).animationName),'none');
        assert.equal(await page.locator('section').filter({has:page.getByRole('heading',{name:'Precisa de atenção',exact:true})}).evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        fs.writeFileSync(`${out}/resultados.json`, JSON.stringify({ ok: true, resultados, assinaturaLiberacaoMocks: true, conflitoMantemDados: true, temaAdministrativoNasPreferenciasClaraEscura: true, errors, inesperados, dados: 'Sintéticos; todas as APIs interceptadas; banco inacessível.', runtime: process.version }, null, 2));
        console.log(JSON.stringify(resultados));
    } catch(error) {
        const atual=browser?.contexts()[0]?.pages()[0];
        if(atual) { await atual.screenshot({path:`${out}/falha.png`,fullPage:true});fs.writeFileSync(`${out}/falha.txt`,JSON.stringify({url:atual.url(),texto:await atual.locator('body').innerText(),errors,inesperados},null,2)); }
        throw error;
    } finally {
        if (browser) await browser.close();
        if (server.exitCode === null) {
            if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else server.kill('SIGTERM');
        }
        fs.closeSync(log); for (const [p, buffer] of gerados) fs.writeFileSync(p, buffer);
    }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
