/** Alerts address router model keys; rows have provider-qualified identities. */
export function findPoolTarget<T extends { dataset: { poolModel?: string } }>(rows: Iterable<T>, model: string): T | undefined {
  return Array.from(rows).find(row => row.dataset.poolModel === model);
}
