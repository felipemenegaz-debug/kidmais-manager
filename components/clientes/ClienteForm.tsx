"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ClienteFormData } from "./types";
import {
  CrmApiError,
  analisarCadastroApi,
  atualizarClienteApi,
  cadastrarClienteApi,
  clienteParaForm,
  obterClienteApi,
  type AnaliseCadastroClienteApi,
  type ClienteDetalheApi,
} from "@/lib/clientes/api-client";
import { cpfValido } from "@/lib/clientes/utils";
import KidmaisBrand from "@/components/layout/KidmaisBrand";
import { AvisoGlobal, MensagemCampo, ResumoErros } from "@/components/ui/ErrosFormulario";
import { focarPrimeiroErro, mapaErros, propsCampo, type ErroCampo } from "@/lib/ui/erros-formulario";
import styles from "./Clientes.module.css";


function somenteDigitosCep(valor: string) {
  return valor.replace(/\D/g, "").slice(0, 8);
}

function formatarCep(valor: string) {
  const numeros = somenteDigitosCep(valor);
  if (numeros.length <= 5) return numeros;
  return `${numeros.slice(0, 5)}-${numeros.slice(5)}`;
}

type ConsultaCepResponse = {
  ok: true;
  cep: string;
  logradouro: string;
  bairro: string;
  cidade: string;
  uf: string;
};

async function lerErroCep(response: Response) {
  try {
    const body = (await response.json()) as { erro?: string };
    return body.erro?.trim() || "Não foi possível localizar esse CEP. Preencha o endereço manualmente.";
  } catch {
    return "Não foi possível localizar esse CEP. Preencha o endereço manualmente.";
  }
}

/** ID estável de cada controle do formulário (N1/N2): o erro aponta para ele. */
const idCampo = (campo: keyof ClienteFormData) => `cliente-${campo}`;

const vazio: ClienteFormData = {
  nomeCompleto: "",
  cpf: "",
  rg: "",
  whatsapp: "",
  telefone: "",
  email: "",
  cep: "",
  logradouro: "",
  numero: "",
  complemento: "",
  bairro: "",
  cidade: "Brasília",
  uf: "DF",
  observacoes: "",
};

export default function ClienteForm({ mode, clienteId }: { mode: "create" | "edit"; clienteId?: string }) {
  const router = useRouter();
  const [form, setForm] = useState<ClienteFormData>(vazio);
  const [detalheInicial, setDetalheInicial] = useState<ClienteDetalheApi | null>(null);
  const [analise, setAnalise] = useState<AnaliseCadastroClienteApi | null>(null);
  const [carregando, setCarregando] = useState(mode === "edit");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
  const [analiseErro, setAnaliseErro] = useState("");
  const [salvoId, setSalvoId] = useState<string | null>(null);
  const [consultandoCep, setConsultandoCep] = useState(false);
  const [erroCep, setErroCep] = useState("");
  const [errosCampo, setErrosCampo] = useState<ErroCampo[]>([]);
  const cepConsultaSeq = useRef(0);
  const cepConfirmadoRef = useRef("");

  useEffect(() => {
    if (mode !== "edit" || !clienteId) return;
    const id = clienteId;
    let ativo = true;

    async function carregarCliente() {
      await Promise.resolve();
      if (!ativo) return;
      setCarregando(true);
      setErro("");
      try {
        const data = await obterClienteApi(id);
        if (!ativo) return;
        setDetalheInicial(data);
        const formCarregado = clienteParaForm(data.cliente);
        setForm({ ...formCarregado, cep: formatarCep(formCarregado.cep) });
        cepConfirmadoRef.current = somenteDigitosCep(formCarregado.cep);
      } catch (error) {
        if (ativo) setErro(error instanceof Error ? error.message : "Não foi possível carregar o Cliente.");
      } finally {
        if (ativo) setCarregando(false);
      }
    }

    void carregarCliente();
    return () => { ativo = false; };
  }, [clienteId, mode]);

  useEffect(() => {
    if (form.nomeCompleto.trim().length < 3) {
      const timer = window.setTimeout(() => setAnalise(null), 0);
      return () => window.clearTimeout(timer);
    }

    let ativo = true;
    const timer = window.setTimeout(async () => {
      setAnaliseErro("");
      try {
        const resultado = await analisarCadastroApi(
          {
            nomeCompleto: form.nomeCompleto,
            cpf: form.cpf,
            email: form.email,
            telefone: form.telefone,
            whatsapp: form.whatsapp,
          },
          mode === "edit" ? clienteId : undefined,
        );
        if (ativo) setAnalise(resultado);
      } catch (error) {
        if (ativo) {
          setAnalise(null);
          setAnaliseErro(error instanceof Error ? error.message : "Não foi possível verificar duplicidades.");
        }
      }
    }, 450);

    return () => {
      ativo = false;
      window.clearTimeout(timer);
    };
  }, [clienteId, form.email, form.cpf, form.nomeCompleto, form.telefone, form.whatsapp, mode]);

  const contatoDuplicado = useMemo(
    () => analise?.possiveisDuplicidades.find(item => item.status === "INATIVO" && item.motivos.some(m => m.endsWith("_IGUAL"))) ?? analise?.possiveisDuplicidades.find((item) => item.motivos.some((motivo) => motivo.endsWith("_IGUAL"))) ?? null,
    [analise],
  );
  const sugestoesNome = useMemo(
    () => (analise?.possiveisDuplicidades ?? []).filter((item) => item.motivos.includes("NOME_SEMELHANTE")).slice(0, 3),
    [analise],
  );

  function update(campo: keyof ClienteFormData, valor: string) {
    setForm((atual) => ({ ...atual, [campo]: valor }));
    setErro("");
    setSalvoId(null);
    // O destaque some quando o campo é corrigido; contato vale para WhatsApp e telefone juntos.
    const resolvidos = campo === "whatsapp" || campo === "telefone" ? [idCampo("whatsapp"), idCampo("telefone")] : [idCampo(campo)];
    setErrosCampo((atual) => atual.filter((e) => !resolvidos.includes(e.campo)));
  }

  /** Todos os erros de uma vez, na ordem visual do formulário. */
  function validar(): ErroCampo[] {
    const erros: ErroCampo[] = [];
    if (!form.nomeCompleto.trim()) erros.push({ campo: idCampo("nomeCompleto"), mensagem: "Informe o nome completo do cliente." });
    if (!form.whatsapp.trim() && !form.telefone.trim()) erros.push({ campo: idCampo("whatsapp"), mensagem: "Informe pelo menos WhatsApp ou telefone." });
    if (form.cpf.trim() && !cpfValido(form.cpf)) erros.push({ campo: idCampo("cpf"), mensagem: "Informe um CPF válido." });
    else if (mode === "create" && analise?.cpfExistente) erros.push({ campo: idCampo("cpf"), mensagem: `Este CPF já pertence a ${analise.cpfExistente.nomeCompleto}. Use o cadastro existente.` });
    return erros;
  }

  async function buscarEnderecoPorCep(cepInformado: string, sequencia: number) {
    const cep = somenteDigitosCep(cepInformado);
    if (cep.length !== 8) return;

    setConsultandoCep(true);
    setErroCep("");

    try {
      const response = await fetch("/api/endereco/consultar-cep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cep }),
      });

      if (!response.ok) {
        throw new Error(await lerErroCep(response));
      }

      const endereco = (await response.json()) as ConsultaCepResponse;
      if (sequencia !== cepConsultaSeq.current) return;

      setForm((atual) => ({
        ...atual,
        cep: formatarCep(endereco.cep ?? cep),
        logradouro: endereco.logradouro ?? "",
        bairro: endereco.bairro ?? "",
        cidade: endereco.cidade ?? "",
        uf: String(endereco.uf ?? "").toUpperCase(),
      }));
      cepConfirmadoRef.current = cep;
      setErroCep("");
      setErro("");
    } catch (error) {
      if (sequencia !== cepConsultaSeq.current) return;
      setErroCep(
        error instanceof Error
          ? error.message
          : "Não foi possível localizar esse CEP. Preencha o endereço manualmente.",
      );
    } finally {
      if (sequencia === cepConsultaSeq.current) {
        setConsultandoCep(false);
      }
    }
  }

  function atualizarCep(valor: string) {
    const cepFormatado = formatarCep(valor);
    const cep = somenteDigitosCep(cepFormatado);
    const sequencia = ++cepConsultaSeq.current;
    const mudouDoEnderecoConfirmado = cep.length === 8 && cep !== cepConfirmadoRef.current;

    setForm((atual) => ({
      ...atual,
      cep: cepFormatado,
      ...(mudouDoEnderecoConfirmado
        ? { logradouro: "", bairro: "", cidade: "", uf: "" }
        : {}),
    }));
    setErro("");
    setSalvoId(null);
    setErroCep("");
    setConsultandoCep(false);

    if (mudouDoEnderecoConfirmado) {
      void buscarEnderecoPorCep(cep, sequencia);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErro("");

    const erros = validar();
    setErrosCampo(erros);
    if (erros.length) {
      focarPrimeiroErro(erros, { resumoId: "cliente-erros" });
      return;
    }

    setSalvando(true);
    try {
      const resultado = mode === "create"
        ? await cadastrarClienteApi(form)
        : await atualizarClienteApi(clienteId!, form);
      setSalvoId(resultado.cliente.id);
      setDetalheInicial((atual) => atual ? { ...atual, cliente: resultado.cliente, cadastro: resultado.cadastro } : atual);
      if (mode === "edit") setForm(clienteParaForm(resultado.cliente));
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : "Não foi possível salvar o Cliente.";
      // Recusa do servidor ligada a um campo (detalhes.campo) marca o campo; o resto vai para o aviso fixo.
      const campo = error instanceof CrmApiError ? (error.details as { campo?: unknown } | null)?.campo : undefined;
      if (typeof campo === "string" && campo in vazio) {
        const erros = [{ campo: idCampo(campo as keyof ClienteFormData), mensagem }];
        setErrosCampo(erros);
        focarPrimeiroErro(erros, { resumoId: "cliente-erros" });
      } else setErro(mensagem);
    } finally {
      setSalvando(false);
    }
  }

  const voltar = mode === "edit" && clienteId ? `/clientes/${clienteId}` : "/clientes";
  const errosPorCampo = mapaErros(errosCampo);
  const campo = (k: keyof ClienteFormData) => propsCampo(idCampo(k), errosPorCampo[idCampo(k)]);
  const mensagem = (k: keyof ClienteFormData) => <MensagemCampo id={idCampo(k)} mensagem={errosPorCampo[idCampo(k)]} />;
  const cpfExistente = mode === "create" ? analise?.cpfExistente ?? null : null;

  if (carregando) {
    return (
      <main className={styles.page}>
        <div className={styles.shellNarrow}>
          <section className={styles.loadingState}>Carregando cadastro do cliente...</section>
        </div>
      </main>
    );
  }

  if (mode === "edit" && !detalheInicial && erro) {
    return (
      <main className={styles.page}>
        <div className={styles.shellNarrow}>
          <section className={styles.apiErrorBox}>
            <strong>Não foi possível abrir o cadastro.</strong>
            <span>{erro}</span>
            <Link className={styles.secondaryButton} href="/clientes">Voltar para clientes</Link>
          </section>
        </div>
      </main>
    );
  }

  if (salvoId) {
    const destino = `/clientes/${salvoId}`;
    return (
      <main className={styles.page}>
        <div className={styles.shellNarrow}>
          <header className={styles.topbar}>
            <KidmaisBrand compact context="manager" href="/clientes" />
            <Link className={styles.backLink} href="/clientes">← Clientes</Link>
          </header>
          <section className={styles.successBox}>
            <div>✓</div>
            <h2>{mode === "create" ? "Cliente cadastrado" : "Alterações salvas"}</h2>
            <p>Os dados foram gravados pela API do Kidmais Manager e persistidos no PostgreSQL.</p>
            <button className={styles.primaryButton} type="button" onClick={() => router.push(destino)}>Abrir perfil do cliente</button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.shellNarrow}>
        <header className={styles.topbar}>
          <KidmaisBrand compact context="manager" href="/clientes" />
          <Link className={styles.backLink} href={voltar}>← Voltar</Link>
        </header>

        <section className={styles.formHeader}>
          <p className={styles.eyebrow}>{mode === "create" ? "Novo cadastro" : "Cadastro do cliente"}</p>
          <h1>{mode === "create" ? "Novo cliente" : "Editar cliente"}</h1>
          <p>{mode === "create" ? "Comece com nome e um contato. Os dados contratuais podem ser completados depois." : "Atualize os dados atuais sem alterar o histórico das festas já realizadas."}</p>
        </section>

        <form className={styles.formCard} onSubmit={submit} noValidate>
          <ResumoErros id="cliente-erros" erros={errosCampo} />
          <div className={styles.formSection}>
            <h2>Informações principais</h2>
            <div className={styles.formGrid}>
              <label className={styles.spanTwo}><span>Nome completo *</span><input {...campo("nomeCompleto")} required value={form.nomeCompleto} onChange={(e) => update("nomeCompleto", e.target.value)} />{mensagem("nomeCompleto")}</label>
              <label><span>WhatsApp</span><input {...campo("whatsapp")} value={form.whatsapp} onChange={(e) => update("whatsapp", e.target.value)} placeholder="(61) 99999-9999" />{mensagem("whatsapp")}</label>
              <label><span>Telefone</span><input {...campo("telefone")} value={form.telefone} onChange={(e) => update("telefone", e.target.value)} />{mensagem("telefone")}</label>
              <label>
                <span>CPF</span>
                <input {...campo("cpf")} value={form.cpf} disabled={mode === "edit"} onChange={(e) => update("cpf", e.target.value)} placeholder="000.000.000-00" />
                {mensagem("cpf")}
                {mode === "edit" && <small className={styles.fieldHelp}>Alteração de CPF será habilitada com autenticação/permissões reais.</small>}
              </label>
              <label><span>RG</span><input {...campo("rg")} value={form.rg} onChange={(e) => update("rg", e.target.value)} placeholder="Opcional" />{mensagem("rg")}</label>
              <label><span>E-mail</span><input {...campo("email")} type="email" value={form.email} onChange={(e) => update("email", e.target.value)} />{mensagem("email")}</label>
            </div>
            <small className={styles.formHint}>Informe pelo menos WhatsApp ou telefone. CPF e endereço podem ser completados posteriormente, mas serão necessários antes do contrato.</small>

            {cpfExistente && (
              <div className={styles.duplicateAlert}>
                <div><strong>CPF já cadastrado</strong><span>Este CPF pertence a {cpfExistente.nomeCompleto}. O novo cadastro será bloqueado.</span></div>
                <Link href={`/clientes/${cpfExistente.clienteId}`}>{cpfExistente.status === "INATIVO" ? "Cliente arquivado/excluído — abrir para restaurar" : "Ver cliente"}</Link>
              </div>
            )}

            {!cpfExistente && contatoDuplicado && (
              <div className={styles.duplicateWarning}>
                <div><strong>Possível cadastro existente</strong><span>O contato também aparece em {contatoDuplicado.nomeCompleto}. {contatoDuplicado.status === "INATIVO" ? "Abra o cadastro para restaurar antes de cadastrar novamente." : "Isso não bloqueia o cadastro."}</span></div>
                <Link href={`/clientes/${contatoDuplicado.clienteId}`}>{contatoDuplicado.status === "INATIVO" ? "Cliente arquivado/excluído — abrir para restaurar" : "Conferir cliente"}</Link>
              </div>
            )}

            {!cpfExistente && !contatoDuplicado && sugestoesNome.length > 0 && (
              <div className={styles.duplicateSuggestion}>
                <strong>Clientes com nome semelhante</strong>
                <div>{sugestoesNome.map((item) => <Link key={item.clienteId} href={`/clientes/${item.clienteId}`}>{item.nomeCompleto}</Link>)}</div>
              </div>
            )}

            {analiseErro && <small className={styles.analysisWarning}>Verificação automática de duplicidade indisponível: {analiseErro}</small>}
          </div>

          <div className={styles.formSection}>
            <h2>Endereço</h2>
            <div className={styles.formGrid}>
              <label>
                <span>CEP</span>
                <input
                  {...campo("cep")}
                  value={form.cep}
                  onChange={(e) => atualizarCep(e.target.value)}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="00000-000"
                />
                {mensagem("cep")}
                {consultandoCep && <small className={styles.fieldHelp}>Buscando endereço...</small>}
                {!consultandoCep && erroCep && <small className={styles.fieldHelp} role="alert">{erroCep}</small>}
                {!consultandoCep && !erroCep && (
                  <small className={styles.fieldHelp}>Ao informar os 8 dígitos, o endereço é preenchido automaticamente.</small>
                )}
              </label>
              <label><span>UF</span><input {...campo("uf")} value={form.uf} onChange={(e) => update("uf", e.target.value.toUpperCase().slice(0, 2))} />{mensagem("uf")}</label>
              <label className={styles.spanTwo}><span>Logradouro</span><input {...campo("logradouro")} value={form.logradouro} onChange={(e) => update("logradouro", e.target.value)} />{mensagem("logradouro")}</label>
              <label><span>Número</span><input {...campo("numero")} value={form.numero} onChange={(e) => update("numero", e.target.value)} />{mensagem("numero")}</label>
              <label><span>Complemento</span><input {...campo("complemento")} value={form.complemento} onChange={(e) => update("complemento", e.target.value)} />{mensagem("complemento")}</label>
              <label><span>Bairro</span><input {...campo("bairro")} value={form.bairro} onChange={(e) => update("bairro", e.target.value)} />{mensagem("bairro")}</label>
              <label><span>Cidade</span><input {...campo("cidade")} value={form.cidade} onChange={(e) => update("cidade", e.target.value)} />{mensagem("cidade")}</label>
            </div>
          </div>

          <div className={styles.formSection}>
            <h2>Observações</h2>
            <label className={styles.textareaField}><textarea value={form.observacoes} onChange={(e) => update("observacoes", e.target.value)} /></label>
          </div>

          <AvisoGlobal mensagem={erro} onFechar={() => setErro("")} />

          <div className={styles.formActions}>
            <Link className={styles.secondaryButton} href={voltar}>Cancelar</Link>
            <button className={styles.cta} type="submit" disabled={salvando || consultandoCep || Boolean(cpfExistente) || (mode === "create" && contatoDuplicado?.status === "INATIVO")}>{salvando ? "Salvando..." : consultandoCep ? "Buscando CEP..." : "Salvar cliente"}</button>
          </div>
        </form>
      </div>
    </main>
  );
}
