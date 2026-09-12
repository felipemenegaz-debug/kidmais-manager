# Usuários e acessos — isolamento do clone manual

## Arquivos

- `components/festas/FestaAcessos.tsx`: lista compacta, formulário Gestão/Equipe, confirmação do próprio acesso, sem painel granular visível.
- `components/festas/acessos.module.css`: tabela no desktop e lista compacta no celular.
- `next.config.ts`: caches de desenvolvimento distintos para manual e automatizado; configuração de produção preservada.
- `scripts/festa-016-dev.cjs`: servidor manual na porta 3017, limitado ao banco manual cadastrado.
- `scripts/festa-016-test-environment.cjs`: autorização dos bancos automatizados e recusa do manual antes de abrir conexão.
- `scripts/festa-016-prepare-environments.cjs`: restauração dos dois ambientes a partir do dump do checkpoint, aplicação da 016 e verificação de preservação/ausência de fixtures.
- `scripts/festa-016-verify-environments.cjs`: verifica isolamento, recusa de fixtures, usuários reais, tabelas e hashes protegidos.
- `scripts/festa-016-browser.cjs`: servidor próprio na porta 3026, sem reaproveitar servidor existente; testes da nova lista e capturas desktop/celular.
- `scripts/festa-016-perfis.integration.cjs`: proteção de ambiente e teste de concessão à cópia de Felipe, com rollback no automatizado.
- `scripts/festa-016-migration-clone.cjs`: protege a origem e cadastra o novo clone descartável antes de testar migrations.
- Proteção de ambiente adicionada também a `scripts/festa-016.integration.cjs`, `scripts/festa-016-vigencia.cjs`, `scripts/festa-016-revisao.integration.cjs`, `scripts/festa-016-patch-final.integration.cjs`, `scripts/festa-016-contagem-final.integration.cjs`, `scripts/festa-016-concorrencia.cjs`, `scripts/festa-016-atomicidade.cjs`, `scripts/festa-016-regressoes.cjs` e `scripts/migration-016.integration.cjs`.
- Este relatório.

Configuração local gerada: `.local-festa/manual.env`, `.local-festa/clone.env` (automatizado) e `.local-festa/environments.json`. Nenhuma credencial é reproduzida neste relatório.

## Ambientes

Manual: **kidmais_016_1789104053902**, restaurado de `.backups/pre-016-1789088523141/database.dump`.

Automatizado: **kidmais_016_1789104053903**, restauração separada do mesmo checkpoint. As fixtures ficam exclusivamente nele e nos clones descartáveis cadastrados pelos executores.

Os bancos anteriores não foram apagados nem limpos por nome de usuário. Não há filtro de usuários sintéticos na aplicação. Os 12 executores de fixtures Festa recusam o banco manual antes de conectar. O navegador automatizado não reaproveita o servidor manual. Caches: `.next-festa-manual` e `.next-festa-auto`.

## Usuário do manual

**1 usuário: Felipe**, REPRESENTANTE_AUTORIZADO. Conta, senha armazenada e demais dados preservados do checkpoint. Nenhuma capacidade Festa foi concedida automaticamente. Felipe poderá configurar Gestão na interface.

Nenhum Funcionário Teste foi criado. O provisionamento de usuários existente é o comando administrativo `scripts/admin-provision.cjs`; não há uma tela segura equivalente já implementada. Por isso, o botão de adicionar está oculto e a interface informa o uso do provisionamento administrativo. Nenhuma autenticação paralela foi criada.

## Testes

- Restauração: 52 tabelas anteriores idênticas; precheck, aplicação e postcheck da 016 aprovados em ambos os clones.
- Manual após as baterias: 52 tabelas continuam idênticas, nove tabelas novas vazias e somente Felipe. Sem backfill, fixtures, concessões ou alteração de senha.
- Doze runners executados com o endereço manual: todos recusaram antes de conectar.
- Concessão de Gestão à cópia de Felipe: aprovada no automatizado e desfeita por rollback; manual não foi usado para esse teste.
- Integração Festa: 17 verificações aprovadas; perfis/autorização, unitários dos perfis e concorrência aprovados.
- Navegador automatizado: Gestão opera, Equipe respeita limites, usuário sem acesso recebe mensagem humana; lista utilizável no desktop/celular; nenhum erro JavaScript ou rolagem horizontal.
- Servidor manual: inicialização conferida e login HTTP 200, sem efetuar login; encerrado após a verificação.
- TypeScript, lint direcionado e build limpo aprovados. Desenvolvimento usou fonte alternativa durante indisponibilidade de Google Fonts; o build limpo foi executado com download liberado.

## Iniciar o manual

No PowerShell do VS Code:

```powershell
Set-Location -LiteralPath 'D:\glass\KidMais Manager\kidmais-manager'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node --env-file=.env.local --env-file=.local-festa/manual.env scripts/festa-016-dev.cjs
```

Deixe o terminal aberto. Entre em **http://localhost:3017/admin/login**, com sua conta e senha existentes. Use Configurações → Usuários e acessos → Felipe → Alterar → Gestão, confirme a alteração do próprio acesso e salve. A porta 3016 pertence ao ambiente anterior; não a use para esta validação limpa.

## Preservação

Banco real: 52 tabelas, sem Migration 016. Todos os registros de usuários reais coincidem com o início desta rodada. Nenhum usuário real foi alterado ou excluído. Central, domínio de Gestão/Equipe, migrations 012–015 e schema legado preservados.

016 byte a byte igual; SHA-256:

`3479cd1b39e23617e71ef65af693b47a156e5915fad603534bed81d05665418d`

Evidências: `.local-festa/results/isolation.json`, `environments.json`, `browser.json`, `perfis.json`, `quality.json` e capturas `acessos-desktop.png` / `acessos-mobile.png`.
