import assert from "node:assert/strict";
import test from "node:test";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { lerCardapioPublico } from "./cardapio-publico.ts";

test("cardápio público seleciona e deduplica as escolhas vigentes da empresa, inclusive com vínculos inválidos", async () => {
  const client = await conectarDescartavel();
  const A = "00000000-0000-4000-8000-000000000001";
  const B = "00000000-0000-4000-8000-000000000002";
  try {
    await client.query("BEGIN");
    // Tabelas temporárias permitem provar as barreiras da leitura mesmo em linhas que os gatilhos reais recusam.
    await client.query(`
      CREATE TEMP TABLE pacotes (id int, empresa_id uuid, ativo bool DEFAULT true, vigente bool DEFAULT true, arquivado_em date);
      CREATE TEMP TABLE buffet_categorias (id int, empresa_id uuid, codigo text, nome text, ativo bool DEFAULT true, ordem_exibicao int DEFAULT 0);
      CREATE TEMP TABLE buffet_itens (id int, empresa_id uuid, categoria_id int, nome text, ativo bool DEFAULT true, ordem_exibicao int DEFAULT 0);
      CREATE TEMP TABLE pacote_buffet_categorias (pacote_id int, categoria_id int, ativo bool DEFAULT true, modo_itens text DEFAULT 'TODOS_ATIVOS');
      CREATE TEMP TABLE pacote_buffet_itens (pacote_id int, categoria_id int, item_id int);
      CREATE TEMP TABLE pacote_itens_especificos (pacote_id int, item_id int);`);
    await client.query("INSERT INTO pacotes (id,empresa_id) VALUES (1,$1),(2,$1),(3,$1),(4,$2)", [A,B]);
    await client.query(`INSERT INTO buffet_categorias (id,empresa_id,codigo,nome) VALUES
      (10,$1,'DOCES','Doces'),(11,$1,'BOLOS','Bolos'),(20,$2,'DOCES','Doces')`, [A,B]);
    await client.query(`INSERT INTO buffet_itens (id,empresa_id,categoria_id,nome,ordem_exibicao) VALUES
      (1,$1,10,'Brigadeiro',1),(2,$1,10,'  BRIGADEÍRO ',2),(3,$1,11,'Brigadeiro',1),
      (4,$2,20,'Doce de B',1),(5,$2,10,'Item intruso',3),(6,$1,11,'Bolo não selecionado',2),
      (7,$1,NULL,'Decoração temática',6),(8,$2,10,'Escolha de B',5),(9,$1,20,'Categoria intrusa',4)`, [A,B]);
    await client.query(`INSERT INTO pacote_buffet_categorias (pacote_id,categoria_id,modo_itens) VALUES
      (1,10,'TODOS_ATIVOS'),(2,10,'TODOS_ATIVOS'),(3,10,'TODOS_ATIVOS'),(1,11,'SELECIONADOS'),
      (4,20,'TODOS_ATIVOS'),(1,20,'TODOS_ATIVOS')`);
    await client.query("INSERT INTO pacote_buffet_itens VALUES (1,11,3),(2,11,6),(1,10,6)");
    await client.query("INSERT INTO pacote_itens_especificos VALUES (1,7)");
    const doces = { codigo: "doces", nome: "Doces", itens: ["Brigadeiro"] };
    const bolos = { codigo: "bolos", nome: "Bolos", itens: ["Brigadeiro"] };
    const ler = () => lerCardapioPublico(client, A);
    assert.deepEqual(await ler(), [bolos, doces]);
    assert.deepEqual(await lerCardapioPublico(client, B), [{ ...doces, itens: ["Doce de B"] }]);
    await client.query("UPDATE buffet_categorias SET nome='Massas' WHERE id=11");
    assert.deepEqual((await ler()).find(c => c.codigo === "bolos"), { ...bolos, nome: "Massas" });
    for (const alteracao of [
      "UPDATE pacotes SET ativo=false WHERE id=1", "UPDATE pacotes SET vigente=false WHERE id=1",
      "UPDATE pacotes SET arquivado_em=current_date WHERE id=1", "DELETE FROM pacote_buffet_categorias WHERE categoria_id=11",
      "UPDATE pacote_buffet_categorias SET ativo=false WHERE categoria_id=11", "UPDATE buffet_categorias SET ativo=false WHERE id=11",
      "UPDATE buffet_itens SET ativo=false WHERE id=3", "DELETE FROM pacote_buffet_itens WHERE pacote_id=1 AND categoria_id=11",
    ]) {
      await client.query("SAVEPOINT oferta");
      await client.query(alteracao);
      assert.deepEqual(await ler(), [doces], alteracao);
      await client.query("ROLLBACK TO SAVEPOINT oferta");
    }
    await client.query("UPDATE pacotes SET ativo=false WHERE empresa_id=$1", [A]);
    assert.deepEqual(await ler(), []);
  } finally { await encerrarDescartavel(client); }
});
