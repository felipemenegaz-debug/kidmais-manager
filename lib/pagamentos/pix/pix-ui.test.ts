import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** 066 — telas e rotas do Pix copia e cola: tenant só da sessão, QR como imagem, senha para trocar a chave. */
const ler = (f: string) => readFileSync(f, 'utf8');

test('rotas: empresa sempre a comprovada da sessão; Pix da parcela é só leitura', () => {
    const config = ler('app/api/admin/configuracoes/pix/route.ts');
    assert.match(config, /consultarFinanceiro\(request, \(tx, tenant\) => consultarConfiguracaoPix\(tx, tenant\)\)/);
    assert.match(config, /withTenantTransaction\(sessao, request\.nextUrl\.searchParams\.get\("empresaId"\)/);
    assert.match(config, /exigirApiAdminCrmDisponivel\(request\)/);
    const parcela = ler('app/api/admin/financeiro/contas-receber/[parcelaId]/pix/route.ts');
    assert.match(parcela, /consultarFinanceiro\(request, \(tx, tenant\) => pixDaParcela\(tx, tenant, parcelaId, hojeIso\(\)\)\)/);
    assert.doesNotMatch(parcela, /export async function (POST|PUT|PATCH|DELETE)/);
    const servico = ler('lib/pagamentos/pix/recebimento.ts');
    assert.match(servico, /exigirReautenticacaoPerfil\(sessao\)/);
    assert.match(servico, /tenant\.papelAtual !== 'REPRESENTANTE_AUTORIZADO'/);
    assert.doesNotMatch(servico, /input\.empresaId|raw\.empresaId/);
});

test('telas: botão Pix só em parcela de contrato com saldo; QR como imagem, sem HTML injetado; chave pede senha', () => {
    const financeiro = ler('components/admin/FinanceiroTelas.tsx');
    assert.match(financeiro, /pix: item\.origem !== 'ENTRADA_MANUAL' && item\.saldoCentavos > 0 && !\['Cancelado', 'Reembolsado', 'Pago'\]\.includes\(item\.status\)/);
    assert.match(financeiro, /<PixParcela parcelaId=\{pixParcela\}/);
    const festa = ler('components/festas/FestaFinanceiro.tsx');
    assert.match(festa, /<PixParcela parcelaId=\{pixParcela\}/);
    const dialogo = ler('components/admin/PixParcela.tsx');
    assert.doesNotMatch(dialogo, /dangerouslySetInnerHTML/);
    assert.match(dialogo, /data:image\/svg\+xml;charset=utf-8,\$\{encodeURIComponent\(pix\.qrSvg\)\}/);
    assert.match(dialogo, /o sistema não confirma o Pix automaticamente/);
    // Chave Pix no Perfil da empresa: só tipo e chave; senha num segundo passo (o navegador não preenche a chave com o
    // e-mail); seletor escuro; nome e cidade do recebedor vêm do Perfil.
    const secao = ler('components/admin/PerfilRecebimentoPix.tsx');
    assert.match(secao, /reautenticarSessao\(senha\)/);
    assert.match(secao, /etapa === 'confirmar'/);
    assert.match(secao, /autoComplete="off"/);
    assert.doesNotMatch(secao, /Cidade do recebedor|Nome do recebedor/);
    assert.doesNotMatch(secao, /<form/);
    assert.match(ler('components/admin/PerfilEmpresa.tsx'), /<PerfilRecebimentoPix \/>/);
    assert.match(ler('components/admin/perfil-empresa.module.css'), /\.campo select option \{ background:/);
    assert.match(ler('app/admin/configuracoes/pix/page.tsx'), /redirect\('\/admin\/configuracoes\/perfil-empresa#recebimento-pix'\)/);
    assert.doesNotMatch(ler('app/admin/configuracoes/page.tsx'), /route:'pix'/);
    assert.match(ler('lib/pagamentos/pix/recebimento.ts'), /const \{ nome, cidade \} = await recebedorDoPerfil\(tx, empresaId\);/);
    // Menu: o título Configurações é o atalho; nenhum item novo.
    assert.match(ler('components/admin/AdminShell.tsx'), /<Link className=\{styles\.grupoLink\} href="\/admin\/configuracoes"/);
    assert.doesNotMatch(ler('lib/admin/navegacao.ts'), /configuracoes\/pix/);
});

test('migration 066: guardas, CHECKs por tipo de chave, rollback que recusa com dados e checks registrados', () => {
    const m = ler('database/migrations/20261006_066_pix_recebimento_empresa.sql');
    assert.match(m, /NÃO APLICADA/);
    assert.match(m, /IF to_regclass\('public\.empresa_pix_recebimento'\) IS NOT NULL THEN RAISE EXCEPTION '066 já aplicada\.'/);
    assert.match(m, /empresa_id uuid PRIMARY KEY REFERENCES empresas \(id\)/);
    for (const tipo of ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA'])
        assert.match(m, new RegExp(`tipo_chave = '${tipo}' AND`));
    const down = ler('database/rollback/20261006_066_pix_recebimento_empresa_down.sql');
    assert.match(down, /rollback recusado: há chave Pix configurada/);
    const inventario = ler('scripts/production/check-migrations.mjs');
    assert.match(inventario, /'20261006_066_pix_recebimento_empresa\.sql'/);
    assert.match(inventario, /066_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION/);
    assert.match(ler('scripts/regressao-v1-selecao.cjs'), /"lib\/pagamentos\/pix\/pix\.postgres\.test\.ts": \{ descartavel: "atual" \}/);
});
