import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tela = readFileSync('components/admin/PerfilEmpresa.tsx', 'utf8');
const estilo = readFileSync('components/admin/perfil-empresa.module.css', 'utf8');
const rota = readFileSync('app/api/admin/configuracoes/perfil-empresa/route.ts', 'utf8');

test('a tela cobre os estados, oferece prévia da logo e não concede acesso', () => {
    assert.match(tela, /Carregando perfil/);
    assert.match(tela, /corpo.codigo === 'PERFIL_SEM_CONCESSAO'/);
    assert.match(tela, /Acesso negado/);
    assert.match(tela, /ainda não está instalada/);
    assert.match(tela, /não há empresa provisionada/);
    assert.match(tela, /Os dados digitados foram mantidos/);
    assert.match(tela, /Rascunho salvo/);
    assert.match(tela, /Complemento da unidade/);
    assert.match(tela, /Tentar novamente/);
    assert.match(tela, /Operação em andamento/);
    assert.match(tela, /Confirmo o antes e o depois/);
    assert.doesNotMatch(tela, /tenant|novas versões/);
    assert.match(tela, /Sem número/);
    assert.match(tela, /Mesmo endereço da sede/);
    assert.match(tela, /reautenticar/);
    assert.doesNotMatch(tela, /perfil_empresa_concessoes|INSERT INTO/);
    assert.match(tela, /type="file"/);
    assert.match(tela, /Prévia da logo do rascunho/);
    assert.match(estilo, /background:var\(--main-bg\)/);
    assert.match(tela, /data-profile-page/);
    assert.match(tela, /<dialog/);
    assert.doesNotMatch(estilo, /max-width:\s*46rem|#161022/);
});

test('shell mantém drawer mobile e não oferece collapse desktop', () => {
    const shell=readFileSync('components/admin/AdminShell.tsx','utf8');
    assert.doesNotMatch(shell,/Recolher menu|setRecolhido|data-recolhido/);
    assert.match(shell,/aria-expanded=\{aberto\}/);
    assert.match(shell,/Escape/);
    assert.match(shell,/menuRef.current\?\.focus\(\)/);
});

test('a API usa sessão, origem e CSRF e não concede acesso', () => {
    assert.match(rota, /exigirApiAdminCrmDisponivel/);
    assert.doesNotMatch(rota, /perfil_empresa_concessoes|INSERT INTO/);
    assert.match(rota, /salvar-rascunho/);
    assert.match(rota, /aplicar/);
});

test('empresa nova sem perfil: a tela oferece a criação só à Gestão, com reautenticação exigida no servidor; a API delega ao serviço dentro do tenant', () => {
    assert.match(tela, /perfilAusente/);
    assert.match(tela, /Criar perfil da empresa/);
    assert.match(tela, /PERFIL_REAUTENTICACAO/);
    assert.match(tela, /Somente a Gestão desta empresa cria o perfil/);
    assert.match(tela, /estruturarPerfil\('criar-perfil'\)/);
    assert.match(tela, /JSON\.stringify\(\{ acao, confirmar: true \}\)/);
    assert.match(rota, /perfilDoTenantOuNulo\(tx, tenant\.empresaComprovada\)/);
    assert.match(rota, /podeCriar: tenant\.papelAtual === 'REPRESENTANTE_AUTORIZADO'/);
    assert.match(rota, /criarPerfilDaEmpresa\(tx, tenant/);
    const criacao = readFileSync('lib/perfil/criacao.ts', 'utf8');
    assert.match(criacao, /exigirGestaoNoTenant\(tenant/);
    assert.match(criacao, /exigirReautenticacaoPerfil\(\{ autenticado_em: input\.autenticadoEm \}, input\.agora\)/);
    assert.match(criacao, /travarProvisionamentoInicial\(tx\)/);
    assert.match(criacao, /FROM empresas WHERE id = \$1::uuid FOR UPDATE/);
    assert.doesNotMatch(criacao, /kidmais/i, 'nada é copiado da Kidmais');
});

test('perfil existente sem administrador: o 403 traz só a elegibilidade; a tela oferece assumir a administração com confirmação e senha; o POST revalida na transação', () => {
    assert.match(rota, /elegibilidadeConcessaoInicial\(tx, tenant\)/);
    assert.match(rota, /new ClienteServiceError\('PERFIL_SEM_CONCESSAO', error\.message, 403, \{ concessaoInicial, empresa/);
    assert.match(rota, /acao: z\.literal\('concessao-inicial'\)/);
    assert.match(rota, /exigirExistente: body\.acao === 'concessao-inicial'/);
    assert.match(tela, /concessaoInicial\?\.elegivel && blocoConcessao\('h3'\)/, '403: bloco dentro de "Acesso negado"');
    // 200 (quem só consulta): o veredito vem com o cadastro e o mesmo bloco aparece acima do formulário, sem tirar nada.
    assert.match(rota, /const leitura = await lerCadastroPerfil\(tx, sessao\.usuario_id, perfil\);\s*\n[^\n]*\n[^\n]*\n\s*const concessaoInicial = await elegibilidadeConcessaoInicial\(tx, tenant\);\s*\n\s*return \{ \.\.\.leitura, perfilAusente: false, concessaoInicial \};/);
    assert.match(tela, /setConcessaoInicial\(\(corpo\.data as Resposta\)\.concessaoInicial \?\? null\);/);
    assert.match(tela, /!carregando && !semPermissao && dados\?\.contexto && concessaoInicial\?\.elegivel && <section[^>]*data-concessao-parcial>\{blocoConcessao\('h2', 'perfil-assumir'\)\}<\/section>/);
    assert.match(tela, /concessaoInicial\?\.motivo === 'ADMINISTRADOR_EXISTENTE' && !capacidades\?\.PERFIL_ADMINISTRAR_CONCESSOES && <p[^>]*data-concessao-administrada>Outra conta administra/, 'a dica não é mostrada a quem já administra as concessões');
    assert.match(tela, /Assumir a administração do perfil/);
    assert.match(tela, /Confirmo que quero assumir a administração do perfil desta empresa/);
    assert.match(tela, /disabled=\{ocupado \|\| !confirmarConcessao \|\| \(pedirSenhaCriacao && !senhaCriacao\)\}/);
    assert.match(tela, /estruturarPerfil\('concessao-inicial'\)/);
    assert.match(tela, /if \(acao === 'concessao-inicial' && !confirmarConcessao\)/);
    assert.match(tela, /Outra conta administra as concessões deste perfil/);
});
