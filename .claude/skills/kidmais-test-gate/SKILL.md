---
name: kidmais-test-gate
description: Define e roda os testes mínimos antes de considerar uma tarefa do Kidmais Manager concluída. Use ao terminar qualquer alteração de código, antes de commit/PR, ou quando o usuário perguntar quais testes rodar.
---

# Test gate

Se o mod `kidmais-gate` estiver carregado, `/kidmais-gate` roda o gate básico e os testes de área automaticamente. Sem o mod, rode na mão.

## 1. Gate do CI (sempre)

```bash
npm run lint
npx tsc --noEmit
npm run check:v1:static   # testes *.test.ts de app/components/lib, lint, tsc e build
```

## 2. Testes da área alterada (unitários, sem banco)

| Área | Comando |
|---|---|
| `lib/pagamentos` | `npm run test:pagamentos` |
| `lib/contratos` | `npm run test:contrato` |
| `lib/comercial` | `npm run test:comercial:pagamento` |
| `lib/disponibilidade` | `npm run test:disponibilidade` |
| outra pasta com `*.test.ts` ao lado | `node --experimental-strip-types --test <arquivo>` |

Mudou regra e não há teste cobrindo? Escreva o teste junto, no mesmo padrão (`node:test`, arquivo `*.test.ts` ao lado do `*-core.ts`).

## 3. Integração com banco (quando a mudança toca SQL, repository ou rota)

Exigem `.env.local` apontando para banco **local** e nunca rodam contra produção:
- `npm run test:pagamentos:integration`
- `npm run test:comercial:pagamento:integration`
- scripts `scripts/*.integration.cjs` da área.

Se o ambiente não tiver banco, diga explicitamente que não rodou e por quê.

## 4. Regressão V1 (mudança grande, pré-release)

Veja a skill `kidmais-homologacao`.

## Critério de parada

- Duas tentativas falhando pela mesma razão: pare, reavalie a hipótese e reporte (docs/08).
- Nunca desative, pule ou apague teste para ficar verde.

## Relato

Liste cada comando rodado com PASS/FAIL e o que não foi rodado, com o motivo.
