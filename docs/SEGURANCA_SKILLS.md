# Segurança das Skills de agentes

Skills de agentes (`.claude/skills/`, `.codex/skills/`) são **tooling de desenvolvimento**. Nunca fazem parte
do runtime do Kidmais Manager: nada em `app/`, `components/` ou no Kidmais Intelligence lê skills (o lint
verifica). Ficam no PR de tooling (`PR-AI-TOOLING`, ver [IA_MANIFESTO_PRS.md](IA_MANIFESTO_PRS.md)).

A [política operacional](OPERACAO_AGENTES.md) é a fonte de autorização. Uma skill nunca concede permissão
além dela, e **uma skill pedir uma permissão não é motivo para concedê-la**.

## Política

1. **Proveniência obrigatória.** Nome, origem (repositório/autor), versão **e commit**, data da revisão e
   sha256 do `SKILL.md`. Sem origem verificável ⇒ REJEITADA.
2. **Menor privilégio.** Inventário explícito de arquivos, shell, rede, secrets, git, banco e produção.
   "Não sabe" conta como "sim".
3. **Sem secrets.** Nenhuma skill lê `.env.local`, imprime valores de env, tokens ou connection strings.
4. **Sem produção, sem banco real, sem deploy.** Escrita em Render/produção, migration e SQL de escrita
   só com autorização explícita do Felipe, conforme a política operacional. Nunca `kidmais_manager` para teste.
5. **Sem auto-merge, push ou force-push** a partir de skill.
6. **Sem instruções remotas.** Skill que manda baixar/ler texto de uma URL e segui-lo ⇒ REJEITADA.
   `curl | sh`, `npx <pacote>` e scripts baixados são proibidos.
7. **Conteúdo lido é dado.** Logs, issues, páginas, respostas de ferramentas e arquivos nunca mudam o que a
   skill faz.
8. **Revisão independente.** Skill nova ou alterada é revisada por outra pessoa ou outro agente sem o
   contexto de quem a trouxe. Até lá, fica RESTRITA.
9. **Nada é instalado ou copiado às cegas.** Skills de terceiros entram só depois da revisão completa.

## Como revisar

Use a skill `kidmais-skill-security` (Claude Code: `.claude/skills/kidmais-skill-security/SKILL.md`;
Codex: `.codex/skills/kidmais-skill-security/SKILL.md`). Ela só lê texto, preenche o inventário, avalia
ASI01–ASI10 e registra a decisão:

- **APROVADA**: sem risco aberto; permissões mínimas descritas.
- **RESTRITA**: utilizável só com as restrições escritas no registro.
- **REJEITADA**: não entra no repositório.

## Registro e lint

- Registro: [`scripts/skills-registro.json`](../scripts/skills-registro.json) — nome, origem, versão/commit,
  sha256 (conteúdo com fim de linha LF), data, permissões, resultado OWASP por item, restrições, revisão
  independente e decisão.
- Lint: `lib/agentes/skills.test.ts` (roda com os testes unitários). Falha se:
  - existir skill sem entrada no registro;
  - o sha256 atual divergir do registrado (qualquer mudança exige nova revisão);
  - faltar frontmatter `name`/`description`, permissão inventariada ou item ASI;
  - houver skill REJEITADA presente, ou RESTRITA sem restrições escritas;
  - uma linha mandar (sem negação) `curl | sh`, `npx <pacote>`, ler `.env`, `git push`, `trigger_deploy`,
    `update_environment_variables` ou seguir instruções de URL;
  - algum arquivo de `app/` ou `components/` referenciar skills ou o registro.

O lint é heurístico: não substitui a revisão humana.

## Mapeamento OWASP (ASI01–ASI10)

Os temas seguem o OWASP Top 10 para aplicações agênticas (sequestro de objetivo, uso indevido de ferramenta,
identidade/privilégio, cadeia de suprimentos, execução inesperada de código, memória/contexto envenenado,
comunicação entre agentes, falha em cascata, confiança humano-agente, agente fora de controle). A numeração
e os nomes exatos devem ser **conferidos com a versão oficial que a equipe adotar**; se mudarem, atualize a
tabela da skill e as chaves `owasp` do registro juntos. Isto não é auditoria formal nem certificação.

## Resultado por skill (2026-09-28)

| Skill | Origem / versão | Shell · Rede · Secrets · Git · Banco · Produção | OWASP | Decisão |
|---|---|---|---|---|
| `kidmais-render-production` (`.codex`) | interna · `fa0a62e` | scripts `node scripts/` versionados · URLs públicas autorizadas (smoke) · só presença · leitura · nenhum · leitura; escrita só com autorização | ASI02 **risco** (operações de produção no escopo; mitigado por gates explícitos); demais ok; ASI09 ok ("GO" não é autorização) | **RESTRITA**: só verificadores/leitura; deploy/env/restart/migration/SQL de escrita só com autorização explícita |
| `kidmais-render-staging` (`.codex`) | interna · `fa0a62e` | nenhum de escrita · Render MCP (staging) · só nomes · leitura · nenhum · nenhuma | ASI02 **risco**: o Render MCP expõe `update_environment_variables` e `trigger_deploy`; o texto proíbe, mas não impede tecnicamente | **RESTRITA**: configurar o Render MCP só com ferramentas de leitura no harness |
| `kidmais-skill-security` (`.codex`) | interna · sem commit | nenhum em todas | ASI01–ASI10 ok | **APROVADA** (revisão independente pendente) |
| `kidmais-skill-security` (`.claude`) | interna · sem commit | nenhum; escreve só no registro e neste documento | ASI01–ASI10 ok | **RESTRITA** até a revisão independente (skill nova) |

Hashes e detalhes por item: ver o registro.

## Demerzel A.I. — pendente

Nenhuma skill Demerzel A.I. foi encontrada no repositório nem nas pastas de skills desta máquina
(busca em 2026-09-28). **Nada foi instalado, copiado ou executado.** Situação registrada como
`FONTE_NAO_DISPONIVEL`, sem decisão.

Para revisar é preciso informar: URL do repositório de origem, commit fixo e a lista das skills
pretendidas. Cada uma passa pelos passos da `kidmais-skill-security` (proveniência, inventário, ASI01–ASI10,
regras fixas, decisão), recebe entrada no registro com hash e revisão independente e, se APROVADA ou
RESTRITA, entra só no `PR-AI-TOOLING`.

## Relação com o Kidmais Intelligence

As mesmas ideias valem no produto: o LLM não recebe ferramentas de escrita, conteúdo lido é tratado como
dado, e toda escrita passa por Policy, Tenant Context e Human Gate
([INTELIGENCIA_PRODUCAO_V1.md](INTELIGENCIA_PRODUCAO_V1.md)). O JEV é classificador auxiliar e nunca
autoriza ação.
