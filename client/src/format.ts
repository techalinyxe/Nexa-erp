const currency = (import.meta.env.VITE_CURRENCY as string | undefined) || "EUR";
const formatter = new Intl.NumberFormat("fr-FR", { style: "currency", currency });
const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
const factor = 10 ** digits;

/** Les montants sont stockés en unités mineures (centimes pour l'euro). */
export function formatMoney(minor: number): string {
  return formatter.format(minor / factor);
}

export function parseMoney(input: string): number | null {
  const value = Number(input.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * factor);
}

export function moneyToInput(minor: number): string {
  return (minor / factor).toFixed(digits).replace(".", ",");
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}
