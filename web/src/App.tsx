import { useState } from 'react'
import { usePlatform, inFlight } from './lib/store'
import { IssuerView } from './views/Issuer'
import { InvestorView } from './views/Investor'
import { RegulatorView } from './views/Regulator'
import { Status } from './components/ui'

type Role = 'issuer' | 'investor' | 'regulator'

const ROLES: { id: Role; label: string }[] = [
  { id: 'issuer', label: 'Issuer' },
  { id: 'investor', label: 'Investor' },
  { id: 'regulator', label: 'Regulator' },
]

export default function App() {
  const [role, setRole] = useState<Role>('issuer')
  const platform = usePlatform()

  const pending = inFlight(platform.intents)

  // Scoped to the selected asset, falling back to the first.
  const asset = platform.assets.find(a => a.asset_id === platform.assetId)
    ?? platform.assets[0]

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-300 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-baseline gap-3">
            {/* The selector only appears with more than one asset, so a
                single-asset deployment looks unchanged. */}
            {platform.assets.length > 1 ? (
              <select
                value={platform.assetId ?? ''}
                onChange={e => platform.selectAsset(e.target.value)}
                className="border border-neutral-300 bg-white px-2 py-1 text-sm font-semibold"
              >
                {platform.assets.map(a => (
                  <option key={a.asset_id} value={a.asset_id}>
                    {a.title}
                  </option>
                ))}
              </select>
            ) : (
              <h1 className="text-sm font-semibold">
                {asset?.title ?? 'RWA Platform'}
              </h1>
            )}

            {asset && (
              <span className="font-mono text-xs text-neutral-500">
                {asset.external_ref} · {asset.currency}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {pending.length > 0 && (
              <span className="text-xs text-amber-700">
                {pending.length} in flight
              </span>
            )}
            <span className="border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">
              XRPL Testnet
            </span>
          </div>
        </div>

        <nav className="mx-auto flex max-w-6xl gap-0 px-6">
          {ROLES.map(r => (
            <button
              key={r.id}
              onClick={() => setRole(r.id)}
              className={[
                'border-b-2 px-4 py-2 text-sm transition-colors',
                role === r.id
                  ? 'border-neutral-900 font-medium text-neutral-900'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800',
              ].join(' ')}
            >
              {r.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {platform.error && (
          <div className="mb-4 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            <strong>API unreachable.</strong> {platform.error}
            <p className="mt-1 text-xs">
              Is the backend running? <code>npm run api</code> and{' '}
              <code>npm run worker</code>
            </p>
          </div>
        )}

        {platform.loading && !platform.assets.length ? (
          <p className="py-12 text-center text-sm text-neutral-400">loading…</p>
        ) : (
          <>
            {role === 'issuer' && <IssuerView platform={platform} />}
            {role === 'investor' && <InvestorView platform={platform} />}
            {role === 'regulator' && <RegulatorView platform={platform} />}
          </>
        )}
      </main>

      <footer className="mx-auto max-w-6xl px-6 pb-8 text-xs text-neutral-400">
        <p>
          Testnet demonstration. Custodial keys, simulated KYC, no
          authentication — see the README for what production would require.
        </p>
        {platform.reconciliation?.sync && (
          <p className="mt-1 font-mono">
            ledger {platform.reconciliation.sync.last_projected_ledger} ·
            {' '}<Status value={platform.reconciliation.status} />
          </p>
        )}
      </footer>
    </div>
  )
}
