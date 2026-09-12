export function somenteDigitos(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

export function textoOuNull(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export function normalizarCpf(value: string | null | undefined) {
  const digits = somenteDigitos(value);
  return digits || null;
}

export function normalizarTelefone(value: string | null | undefined) {
  const digits = somenteDigitos(value);
  return digits || null;
}

export function normalizarCep(value: string | null | undefined) {
  const digits = somenteDigitos(value);
  return digits || null;
}

export function normalizarEmail(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

export function normalizarUf(value: string | null | undefined) {
  const normalized = value?.trim().toUpperCase() ?? "";
  return normalized || null;
}
