/** Small formatting helpers. Deliberately dull. */

export function shortAddr(addr: string | null, chars = 6): string {
  if (!addr) return '—'
  return `${addr.slice(0, chars)}…${addr.slice(-4)}`
}

export function shortHash(hash: string | null): string {
  if (!hash) return '—'
  return `${hash.slice(0, 10)}…`
}

export function units(value: string | number | null): string {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n.toLocaleString('en-GB', { maximumFractionDigits: 6 })
}

export function ago(iso: string | null): string {
  if (!iso) return '—'
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return new Date(iso).toLocaleDateString('en-GB')
}

/** Explorer link for a transaction, so hashes are verifiable. */
export function explorerTx(hash: string): string {
  return `https://testnet.xrpl.org/transactions/${hash}`
}

export function explorerAccount(addr: string): string {
  return `https://testnet.xrpl.org/accounts/${addr}`
}

export const INTENT_LABEL: Record<string, string> = {
  credential_issue: 'Issue KYC credential',
  credential_revoke: 'Revoke KYC credential',
  trustline_authorize: 'Authorize trust line',
  token_issue: 'Issue units',
  freeze: 'Freeze holder',
  unfreeze: 'Unfreeze holder',
  clawback: 'Claw back units',
}
