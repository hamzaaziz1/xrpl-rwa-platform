/**
 * Global poll.
 *
 * ONE timer for the whole application. Every view reads from the same
 * snapshot, so the activity feed, intent statuses and drift panel all
 * update together.
 *
 * The alternative — each action polling its own intent — means a timer
 * per in-flight write, components that need to know about polling, and
 * views that can disagree about what has happened. This is simpler and
 * it makes the demo read better: things visibly resolve on their own.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  api, type Asset, type Holding, type Investor,
  type Intent, type Reconciliation, type Book,
} from './api'

const POLL_MS = 2000

export interface Snapshot {
  assets: Asset[]
  holdings: Holding[]
  investors: Investor[]
  intents: Intent[]
  reconciliation: Reconciliation | null
  book: Book | null
  loading: boolean
  error: string | null
}

const EMPTY: Snapshot = {
  assets: [],
  holdings: [],
  investors: [],
  intents: [],
  reconciliation: null,
  book: null,
  loading: true,
  error: null,
}

export function usePlatform() {
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const assetIdRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const assets = await api.assets()
      const assetId = assetIdRef.current ?? assets[0]?.asset_id ?? null
      assetIdRef.current = assetId

      const [holdings, investors, intents, reconciliation, book] = await Promise.all([
        assetId ? api.holdings(assetId) : Promise.resolve([]),
        api.investors(),
        api.intents(),
        api.reconciliation(),
        assetId ? api.book(assetId) : Promise.resolve(null),
      ])

      setSnap({
        assets, holdings, investors, intents, reconciliation, book,
        loading: false, error: null,
      })
    } catch (e: any) {
      setSnap(s => ({ ...s, loading: false, error: e?.message ?? String(e) }))
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  return { ...snap, refresh }
}

/** Intents that haven't settled yet. Drives the "in flight" indicator. */
export function inFlight(intents: Intent[]): Intent[] {
  return intents.filter(i => i.status === 'pending' || i.status === 'submitted')
}
