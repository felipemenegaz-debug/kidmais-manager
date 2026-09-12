"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ClienteFormData } from "./types";
import {
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
  }, [clienteId, form.cpf, form.nomeCompleto, form.telefone, form.whatsapp, mode]);

  const contatoDuplicado = useMemo(
    () => analise?.possiveisDuplicidades.find((item) => item.motivos.some((motivo) => motivo.endsWith("_IGUAL"))) ?? null,
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

    if (!form.nomeCompleto.trim()) {
      setErro("Informe o nome completo do cliente.");
      return;
    }
    if (!form.whatsapp.trim() && !form.telefone.trim()) {
      setErro("Informe pelo menos WhatsApp ou telefone.");
      return;
    }
    if (form.cpf.trim() && !cpfValido(form.cpf)) {
      setErro("Informe um CPF válido.");
      return;
    }
    if (mode === "create" && analise?.cpfExistente) {
      setErro(`Este CPF já pertence a ${analise.cpfExistente.nomeCompleto}. Use o cadastro existente.`);
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
      setErro(error instanceof Error ? error.message : "Não foi possível salvar o Cliente.");
    } finally {
      setSalvando(false);
    }
  }

  const voltar = mode === "edit" && clienteId ? `/clientes/${clienteId}` : "/clientes";
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

        <form className={styles.formCard} onSubmit={submit}>
          <div className={styles.formSection}>
            <h2>Informações principais</h2>
            <div className={styles.formGrid}>
              <label className={styles.spanTwo}><span>Nome completo *</span><input value={form.nomeCompleto} onChange={(e) => update("nomeCompleto", e.target.value)} /></label>
              <label><span>WhatsApp</span><input value={form.whatsapp} onChange={(e) => update("whatsapp", e.target.value)} placeholder="(61) 99999-9999" /></label>
              <label><span>Telefone</span><input value={form.telefone} onChange={(e) => update("telefone", e.target.value)} /></label>
              <label>
                <span>CPF</span>
                <input value={form.cpf} disabled={mode === "edit"} onChange={(e) => update("cpf", e.target.value)} placeholder="000.000.000-00" />
                {mode === "edit" && <small className={styles.fieldHelp}>Alteração de CPF será habilitada com autenticação/permissões reais.</small>}
              </label>
              <label><span>RG</span><input value={form.rg} onChange={(e) => update("rg", e.target.value)} placeholder="Opcional" /></label>
              <label><span>E-mail</span><input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} /></label>
            </div>
            <small className={styles.formHint}>Informe pelo menos WhatsApp ou telefone. CPF e endereço podem ser completados posteriormente, mas serão necessários antes do contrato.</small>

            {cpfExistente && (
              <div className={styles.duplicateAlert}>
                <div><strong>CPF já cadastrado</strong><span>Este CPF pertence a {cpfExistente.nomeCompleto}. O novo cadastro será bloqueado.</span></div>
                <Link href={`/clientes/${cpfExistente.clienteId}`}>Ver cliente</Link>
              </div>
            )}

            {!cpfExistente && contatoDuplicado && (
              <div className={styles.duplicateWarning}>
                <div><strong>Possível cadastro existente</strong><span>O telefone/WhatsApp também aparece em {contatoDuplicado.nomeCompleto}. Isso não bloqueia o cadastro.</span></div>
                <Link href={`/clientes/${contatoDuplicado.clienteId}`}>Conferir cliente</Link>
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
                  value={form.cep}
                  onChange={(e) => atualizarCep(e.target.value)}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="00000-000"
                />
                {consultandoCep && <small className={styles.fieldHelp}>Buscando endereço...</small>}
                {!consultandoCep && erroCep && <small className={styles.fieldHelp} role="alert">{erroCep}</small>}
                {!consultandoCep && !erroCep && (
                  <small className={styles.fieldHelp}>Ao informar os 8 dígitos, o endereço é preenchido automaticamente.</small>
                )}
              </label>
              <label><span>UF</span><input value={form.uf} onChange={(e) => update("uf", e.target.value.toUpperCase().slice(0, 2))} /></label>
              <label className={styles.spanTwo}><span>Logradouro</span><input value={form.logradouro} onChange={(e) => update("logradouro", e.target.value)} /></label>
              <label><span>Número</span><input value={form.numero} onChange={(e) => update("numero", e.target.value)} /></label>
              <label><span>Complemento</span><input value={form.complemento} onChange={(e) => update("complemento", e.target.value)} /></label>
              <label><span>Bairro</span><input value={form.bairro} onChange={(e) => update("bairro", e.target.value)} /></label>
              <label><span>Cidade</span><input value={form.cidade} onChange={(e) => update("cidade", e.target.value)} /></label>
            </div>
          </div>

          <div className={styles.formSection}>
            <h2>Observações</h2>
            <label className={styles.textareaField}><textarea value={form.observacoes} onChange={(e) => update("observacoes", e.target.value)} /></label>
          </div>

          {erro && <div className={styles.formError}>{erro}</div>}

          <div className={styles.formActions}>
            <Link className={styles.secondaryButton} href={voltar}>Cancelar</Link>
            <button className={styles.primaryButton} type="submit" disabled={salvando || consultandoCep || Boolean(cpfExistente)}>{salvando ? "Salvando..." : consultandoCep ? "Buscando CEP..." : "Salvar cliente"}</button>
          </div>
        </form>
      </div>
    </main>
  );
}
