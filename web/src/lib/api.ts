/**
 * API client.
 *
 * Thin. Every function maps to one endpoint and returns parsed JSON.
 * No caching, no retry logic — the polling hook handles freshness.
 */

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.json()
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  // Only send a content-type when there is actually a body. Declaring
  // application/json with an empty body makes the server try to parse
  // an empty string as JSON, which fails with a 400 before the handler
  // ever runs.
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    ...(body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error ?? `${res.status} ${path}`)
  return json
}

// ---- types -------------------------------------------------------

export interface Asset {
  asset_id: string
  currency: string
  issuer: string
  title: string
  external_ref: string | null
  jurisdiction: string | null
  total_units: string | null
  status: string
  units_outstanding: string
  holder_count: string
}

export interface Holding {
  account: string
  balance: string
  last_ledger_index: string
  investor_id: string | null
  legal_name: string | null
  kyc_status: 'pending' | 'issued' | 'approved' | 'revoked' | string | null
}

export interface Investor {
  investor_id: string
  legal_name: string
  email: string | null
  account: string | null
  kyc_status: string
  kyc_submitted: string | null
  kyc_approved: string | null
  credential_accepted_at: string | null
}

export interface Intent {
  intent_id: string
  kind: string
  actor: string
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'expired' | 'abandoned'
  tx_hash: string | null
  engine_result: string | null
  failure_reason: string | null
  failure_fix?: string | null
  created_at: string
  resolved_at: string | null
}

export interface Finding {
  id: string
  detected_at: string
  currency: string
  issuer: string
  account: string
  ledger_value: string | null
  registry_value: string | null
  severity: 'info' | 'warning' | 'critical'
}

export interface Reconciliation {
  status: 'clean' | 'drift'
  findingCount: number
  findings: Finding[]
  sync: {
    last_ingested_ledger: string
    last_projected_ledger: string
    updated_at: string
  } | null
}

export interface LedgerEvent {
  tx_hash: string
  ledger_index: string
  tx_index: number
  tx_type: string
  tx_result: string
  account: string
  ingested_at: string
}

// ---- reads -------------------------------------------------------

export const api = {
  assets: () => get<Asset[]>('/api/assets'),
  holdings: (assetId: string) => get<Holding[]>(`/api/assets/${assetId}/holdings`),
  investors: () => get<Investor[]>('/api/investors'),
  intents: (limit = 30) => get<Intent[]>(`/api/intents?limit=${limit}`),
  intent: (id: string) => get<Intent>(`/api/intents/${id}`),
  reconciliation: () => get<Reconciliation>('/api/reconciliation'),
  events: (limit = 50) => get<LedgerEvent[]>(`/api/events?limit=${limit}`),

  // ---- writes ----------------------------------------------------
  // all return 202 with an intent id; watch it via the poll store

  approve: (investorId: string) =>
    post<{ intentId: string }>(`/api/investors/${investorId}/approve`),

  acceptCredential: (investorId: string) =>
    post<{ intentId: string }>(`/api/investors/${investorId}/accept-credential`),

  revoke: (investorId: string) =>
    post<{ intentId: string }>(`/api/investors/${investorId}/revoke`),

  freeze: (assetId: string, holder: string) =>
    post<{ intentId: string }>(`/api/assets/${assetId}/freeze`, { holder }),

  unfreeze: (assetId: string, holder: string) =>
    post<{ intentId: string }>(`/api/assets/${assetId}/unfreeze`, { holder }),

  clawback: (assetId: string, holder: string, value: string) =>
    post<{ intentId: string }>(`/api/assets/${assetId}/clawback`, { holder, value }),

  issue: (assetId: string, holder: string, value: string) =>
    post<{ intentId: string }>(`/api/assets/${assetId}/issue`, { holder, value }),
}
