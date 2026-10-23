import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { PAPEL_GLOBAL_NEUTRO, PAPEL_PLATAFORMA, temAutoridadeDePlataforma } from './plataforma.ts';
import { exigirGestaoDaEmpresa, exigirReautenticacaoRecente } from '../whatsapp/onboarding-core.ts';

/**
 * F1 — autoridade de plataforma (tabela PDF pública) não nasce de rota de tenant. O WhatsApp/Meta passou a ser da
 * EMPRESA na 083 (cada empresa conecta o próprio número; Gestão da empresa comprovada), não da plataforma.
 * A conta criada por uma empresa como Gestão tem papel global neutro: opera na empresa pela membership e é
 * recusada nos recursos da instalação. A autoridade legítima (papel da identidade dado pelo provisionamento do
 * operador) continua funcionando.
 */
const req = createRequire(import.meta.url);
const agora = Date.parse('2026-09-29T12:00:00.000Z');
const sessao = (papel: string) => ({ id: 's', usuario_id: 'u', nome: 'Pessoa', cargo: null, papel, autenticado_em: new Date(agora - 1_000).toISOString(), expira_em: new Date(agora + 3_600_000).toISOString(), csrf_hash: 'h' });

class Recusa extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** Carrega a rota real da tabela PDF com dependências dubladas; devolve status e se publicou. */
async function postTabela(papel: string, daDona = true) {
  const publicados: string[] = [];
  const arquivo = 'app/api/admin/configuracoes/tabela-pacotes/route.ts';
  const code = ts.transpileModule(readFileSync(arquivo, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, (r: unknown) => Promise<Response>> = {};
  const json = (body: unknown, init?: { status?: number }) => new Response(JSON.stringify(body), { status: init?.status ?? 200 });
  new Function('require', 'exports', code)((nome: string) => {
    if (nome === 'next/server') return { NextResponse: { json } };
    if (nome === '@/lib/http/admin-crm-api') return { exigirApiAdminCrmDisponivel: async () => sessao(papel) };
    if (nome === '@/lib/catalogo/documento-publico') return { documentoVigente: async () => null, publicarPdf: async (_b: Buffer, n: string) => { publicados.push(n); return { id: 'd', nome_arquivo: n, publicado_em: 'agora' }; } };
    if (nome === '@/lib/autenticacao/service') return { authError: (m: string, s: number) => new Recusa(m, s) };
    if (nome === '@/lib/http/api-response') return { apiErrorResponse: (e: unknown) => json({ ok: false }, { status: e instanceof Recusa ? e.status : 500 }) };
    if (nome === '@/lib/autenticacao/plataforma') return { temAutoridadeDePlataforma };
    if (nome === '@/lib/saas/provar-tenant') return { withTenantTransaction: async (_s: unknown, _e: unknown, w: (tx: unknown, t: { empresaComprovada: string }) => Promise<unknown>) => w({}, { empresaComprovada: 'e1' }) };
    if (nome === '@/lib/disponibilidade/config-legada') return { ehDonaDaConfigLegada: async () => daDona };
    return req(nome);
  }, exports);
  const form = new FormData();
  form.set('arquivo', new File([Buffer.from('%PDF-1.4\n%%EOF')], 'tabela.pdf', { type: 'application/pdf' }));
  const resposta = await exports.POST({ formData: async () => form, nextUrl: new URL('http://x/api') });
  return { status: resposta.status, publicados };
}

test('F1 autoridade de plataforma é o papel da identidade dado pelo operador; o papel neutro de conta criada por empresa não tem', () => {
  assert.equal(PAPEL_PLATAFORMA, 'REPRESENTANTE_AUTORIZADO');
  assert.equal(PAPEL_GLOBAL_NEUTRO, 'ADMINISTRATIVO');
  assert.notEqual(PAPEL_GLOBAL_NEUTRO, PAPEL_PLATAFORMA);
  assert.equal(temAutoridadeDePlataforma({ papel: PAPEL_GLOBAL_NEUTRO }), false);
  assert.equal(temAutoridadeDePlataforma({ papel: PAPEL_PLATAFORMA }), true);
  assert.equal(temAutoridadeDePlataforma({ papel: '' }), false);
});

test('F1 conta criada por empresa como Gestão (papel global neutro) NÃO publica a tabela PDF global; a plataforma legítima publica', async () => {
  const empresarial = await postTabela(PAPEL_GLOBAL_NEUTRO);
  assert.equal(empresarial.status, 403);
  assert.deepEqual(empresarial.publicados, [], 'nada publicado');
  const legitima = await postTabela(PAPEL_PLATAFORMA);
  assert.equal(legitima.status, 200);
  assert.deepEqual(legitima.publicados, ['tabela.pdf']);
  // A plataforma operando outra empresa (não a dona da agenda pública) não substitui o PDF da instalação.
  const outraEmpresa = await postTabela(PAPEL_PLATAFORMA, false);
  assert.equal(outraEmpresa.status, 403);
  assert.deepEqual(outraEmpresa.publicados, []);
});

test('083 WhatsApp é da EMPRESA: só a Gestão da empresa comprovada consulta, conecta e desconecta; o papel global não decide', () => {
  assert.throws(() => exigirGestaoDaEmpresa('ADMINISTRATIVO', 'conectar'), /Somente a Gestão da empresa/);
  assert.doesNotThrow(() => exigirGestaoDaEmpresa('REPRESENTANTE_AUTORIZADO', 'conectar'));
  // A Gestão de uma contratante (identidade com papel global neutro) é aceita pelo papel DA EMPRESA, nunca pelo global.
  assert.doesNotThrow(() => exigirReautenticacaoRecente(sessao(PAPEL_GLOBAL_NEUTRO), agora));
  assert.throws(() => exigirReautenticacaoRecente(sessao(PAPEL_PLATAFORMA), agora + 300_001), /Confirme sua senha/);
  const servico = readFileSync('lib/whatsapp/onboarding.service.ts', 'utf8').replace(/\r\n/g, '\n');
  const consultar = servico.slice(servico.indexOf('export async function consultarConfiguracaoWhatsapp('));
  assert.ok(consultar.includes("const tenant = await provarTenant(tx, sessao, null);\n    exigirGestaoDaEmpresa(tenant.papelAtual, 'consultar');"), 'consultar: empresa comprovada + Gestão');
  assert.ok(servico.includes('const sessao = await consultarSessao(token, tx, true);\n  exigirReautenticacaoRecente(sessao);\n  const tenant = await provarTenant(tx, sessao, null);\n  exigirGestaoDaEmpresa(tenant.papelAtual, acao);'), 'iniciar/concluir/desconectar: sessão travada, senha recente, empresa comprovada e Gestão dentro da transação');
  for (const f of ['lib/whatsapp/onboarding-core.ts', 'lib/whatsapp/onboarding.service.ts']) {
    const texto = readFileSync(f, 'utf8');
    assert.doesNotMatch(texto, /temAutoridadeDePlataforma/, `${f}: WhatsApp não usa a autoridade de plataforma`);
    assert.doesNotMatch(texto, /sessao\.papel/, `${f}: nunca o papel global`);
  }
});

function arquivos(dir: string, saida: string[] = []) {
  for (const nome of readdirSync(dir)) {
    const p = path.join(dir, nome);
    if (statSync(p).isDirectory()) arquivos(p, saida);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.ts$/.test(nome)) saida.push(p.replace(/\\/g, '/'));
  }
  return saida;
}

test('F1 nenhum código da aplicação concede, eleva ou altera o papel global; recursos da instalação só pela autoridade de plataforma', () => {
  const codigo = [...arquivos('app'), ...arquivos('lib')];
  const inserem = codigo.filter((f) => /INSERT INTO usuarios_administrativos/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(inserem, ['lib/autenticacao/usuarios.ts'], 'só a criação por empresa cria identidade');
  const usuarios = readFileSync('lib/autenticacao/usuarios.ts', 'utf8').replace(/\r\n/g, '\n');
  assert.match(usuarios, /'INSERT INTO usuarios_administrativos\(email,nome,senha_hash,papel\) VALUES\(\$1,\$2,\$3,\$4\) RETURNING id',\s*\n\s*\[email, input\.nome, senhaHash, PAPEL_GLOBAL_NEUTRO\]/);
  for (const f of codigo) {
    const texto = readFileSync(f, 'utf8');
    assert.doesNotMatch(texto, /UPDATE usuarios_administrativos\s+SET[^;`']*\bpapel\s*=/i, `${f}: nenhuma escrita do papel global`);
  }
  for (const f of ['app/api/admin/configuracoes/tabela-pacotes/route.ts']) {
    const texto = readFileSync(f, 'utf8');
    assert.match(texto, /temAutoridadeDePlataforma\(sessao\)/, f);
    assert.doesNotMatch(texto, /sessao\.papel\s*[!=]==/, `${f}: sem comparação solta de papel`);
  }
});

test('057 revalidação: nenhum fluxo empresarial decide pelo papel global; assinatura empresarial não é plataforma e não abre plataforma', () => {
  const codigo = [...arquivos('app'), ...arquivos('lib')];
  // Toda comparação que DISCRIMINA papel (só representante) sobre o papel da sessão/identidade:
  const discriminantes: string[] = [];
  for (const f of codigo) {
    const linhas = readFileSync(f, 'utf8').split(/\r?\n/);
    linhas.forEach((l, i) => { if (/\b(sessao|s|identidade)\.papel\s*[!=]==\s*'REPRESENTANTE_AUTORIZADO'/.test(l)) discriminantes.push(`${f}:${i + 1}`); });
  }
  const permitidos = [
    'lib/autenticacao/usuarios.ts', // desativar a identidade: PLATAFORMA, sem rota de tenant
    'lib/pagamentos/services/devolucao.service.ts', // `s` = sessão com o papel DA MEMBERSHIP (bloquearFinanceiro)
  ];
  assert.deepEqual([...new Set(discriminantes.map((d) => d.split(':')[0]))].sort(), permitidos.sort(), discriminantes.join(', '));
  const financeiro = readFileSync('lib/pagamentos/services/alteracao-financeira.service.ts', 'utf8');
  assert.match(financeiro, /if\(!context\.papelNoTenant\)recusarFinanceiro\('OPERACAO_NAO_AUTORIZADA'/, 'financeiro sem papel da membership recusa');
  assert.match(financeiro, /papel:context\.papelNoTenant as SessaoAdmin\['papel'\]/, 'o papel é sempre o da membership');
  // Pré-checagens que ainda leem o papel da sessão aceitam OS DOIS papéis: não distinguem autoridade.
  for (const [f, constante] of [['lib/inteligencia/leituras/comum.ts', 'PAPEIS_ADMIN'], ['lib/inteligencia/documentos/upload.ts', 'PAPEIS_DOCUMENTO'], ['lib/inteligencia/importacao/acao.ts', 'PAPEIS_IMPORTACAO'], ['lib/inteligencia/atencao-hoje.ts', 'PAPEIS_FINANCEIRO']]) {
    if (!existsSync(f)) continue; // arquivo de um PR ausente neste estágio do check:ia:prs
    const linha = readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.includes(`${constante}`) && l.includes('='))!;
    assert.match(linha, /"ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"/, `${f}: ${constante}`);
  }
  // Assinatura empresarial: capability da membership; nada de plataforma no caminho, nada de capability na plataforma.
  const contrato = readFileSync('lib/contratos/services/administrativo.service.ts', 'utf8');
  assert.match(contrato, /capacidade='CONTRATO_ASSINAR_EMPRESA' AND revogado_em IS NULL/);
  assert.doesNotMatch(contrato, /temAutoridadeDePlataforma/);
  for (const f of ['lib/autenticacao/plataforma.ts', 'app/api/admin/configuracoes/tabela-pacotes/route.ts']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /empresa_membership_capacidades|CONTRATO_ASSINAR_EMPRESA|FROM memberships|papelAtual/, `${f}: plataforma não lê capability de empresa`);
  }
  const m057 = readFileSync('database/migrations/20260929_057_assinatura_contrato_empresa.sql', 'utf8');
  assert.doesNotMatch(m057.slice(m057.indexOf('CREATE OR REPLACE FUNCTION public.kidmais_validar_fluxo_contrato')), /u\.papel<>'REPRESENTANTE_AUTORIZADO'/, 'o banco não exige mais o papel global para assinar pela empresa');
});
