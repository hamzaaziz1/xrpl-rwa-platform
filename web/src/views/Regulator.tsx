/**
 * Regulator view.
 *
 * The point of this view is the reconciliation panel. Everything else is
 * context for it.
 *
 * A drift panel that permanently reads "clean" demonstrates nothing, so
 * the demo controls below deliberately corrupt the projection and let
 * the reconciler catch it. Artificial, and labelled as such.
 */
import type { Snapshot } from '../lib/store'
import {
  shortAddr, shortHash, units, ago, explorerTx, INTENT_LABEL,
} from '../lib/format'
import { Panel, Table, Td, Status, Empty } from '../components/ui'

export function RegulatorView({ platform }: { platform: Snapshot }) {
  const { assets, holdings, intents, reconciliation } = platform
  // Scoped to the SELECTED asset. Using assets[0] here showed the
  // first asset's figures beside the selected asset's holdings — a
  // summary panel confidently describing a different asset from the
  // table beneath it.
  const asset = assets.find(a => a.asset_id === platform.assetId) ?? assets[0]

  if (!asset) return <Empty>No asset. Run <code>npm run seed</code>.</Empty>

  const drift = reconciliation?.status === 'drift'
  const failed = intents.filter(i => i.status === 'failed' || i.status === 'expired')

  return (
    <div className="space-y-6">

      <section
        className={[
          'border p-4',
          drift ? 'border-red-400 bg-red-50' : 'border-emerald-300 bg-emerald-50',
        ].join(' ')}
      >
        <div className="flex items-baseline justify-between">
          <h2 className={`text-sm font-semibold ${drift ? 'text-red-900' : 'text-emerald-900'}`}>
            {drift
              ? `Reconciliation: ${reconciliation?.findingCount} open finding${reconciliation!.findingCount === 1 ? '' : 's'}`
              : 'Reconciliation: registry agrees with the ledger'}
          </h2>
          {reconciliation?.sync && (
            <span className="font-mono text-xs text-neutral-600">
              ledger {reconciliation.sync.last_projected_ledger} · checked {ago(reconciliation.sync.updated_at)}
            </span>
          )}
        </div>

        <p className={`mt-1 text-xs ${drift ? 'text-red-800' : 'text-emerald-800'}`}>
          {drift
            ? 'The off-chain registry disagrees with on-ledger state. Replaying the event log repairs it.'
            : 'Every holder balance in the registry matches the trust line balance on the XRP Ledger.'}
        </p>

        {drift && reconciliation && (
          <div className="mt-3 border border-red-300 bg-white p-3">
            <Table head={['Account', 'Ledger', 'Registry', 'Severity', 'Detected']}>
              {reconciliation.findings.map(f => (
                <tr key={f.id}>
                  <Td mono>{shortAddr(f.account)}</Td>
                  <Td right>{units(f.ledger_value)}</Td>
                  <Td right>{units(f.registry_value)}</Td>
                  <Td><Status value={f.severity} /></Td>
                  <Td>{ago(f.detected_at)}</Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </section>

      <Panel
        title="How this works"
        subtitle="The reconciler assumes the projection is wrong and checks"
      >
        <div className="space-y-3 text-sm leading-relaxed text-neutral-700">
          <p>
            The XRP Ledger is the source of truth for ownership. The registry is
            a projection of it, plus the legal data that cannot live on-chain —
            title references, investor identity, document hashes.
          </p>
          <p>
            The reconciler reads live trust line balances and compares them
            against the projection, in both directions. A balance the ledger
            doesn't have means the projection logic is wrong. A balance the
            projection never recorded means an event was missed during ingest —
            the failure where the database looks internally consistent and is
            simply incomplete.
          </p>
          <p>
            Repair is not a patch. The projection is a pure function of the
            event log, so it is discarded and replayed. Corruption cannot
            survive because it was never in the log.
          </p>
        </div>

        <div className="mt-4 border border-neutral-300 bg-neutral-50 p-3">
          <p className="text-xs font-medium text-neutral-700">Demo controls</p>
          <p className="mt-1 text-xs text-neutral-600">
            An alarm you have never seen fire is untested. Run these from the
            project root to corrupt the projection and watch it recover:
          </p>
          <pre className="mt-2 overflow-x-auto bg-white p-2 font-mono text-xs text-neutral-800">
{`npm run drift                  # write a wrong balance
npm run reconcile              # detected as CRITICAL
npm run project -- --rebuild   # replay the log
npm run reconcile              # clean`}
          </pre>
        </div>
      </Panel>

      <Panel title="Register" subtitle={`${asset.title} · ${asset.external_ref ?? ''}`}>
        <Table head={['Holder', 'Account', 'Units', 'Last ledger']}>
          {holdings.map(h => (
            <tr key={h.account}>
              <Td>{h.legal_name ?? '—'}</Td>
              <Td mono>{shortAddr(h.account)}</Td>
              <Td right>{units(h.balance)}</Td>
              <Td mono>{h.last_ledger_index}</Td>
            </tr>
          ))}
        </Table>
      </Panel>

      {failed.length > 0 && (
        <Panel
          title="Failed operations"
          subtitle="Diagnosed by xrpl-why rather than reported as engine codes"
        >
          <Table head={['Operation', 'Code', 'Diagnosis', 'When']}>
            {failed.slice(0, 8).map(i => (
              <tr key={i.intent_id}>
                <Td>{INTENT_LABEL[i.kind] ?? i.kind}</Td>
                <Td mono>{i.engine_result ?? '—'}</Td>
                <Td>
                  <span className="text-xs text-neutral-700">
                    {i.failure_reason ?? '—'}
                  </span>
                </Td>
                <Td>{ago(i.created_at)}</Td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      <Panel title="Audit trail" subtitle="Every write recorded as intent before submission">
        <Table head={['Operation', 'Status', 'Transaction', 'When']}>
          {intents.slice(0, 15).map(i => (
            <tr key={i.intent_id}>
              <Td>{INTENT_LABEL[i.kind] ?? i.kind}</Td>
              <Td><Status value={i.status} /></Td>
              <Td mono>
                {i.tx_hash ? (
                  <a href={explorerTx(i.tx_hash)} target="_blank" rel="noreferrer"
                     className="underline decoration-neutral-300 hover:decoration-neutral-600">
                    {shortHash(i.tx_hash)}
                  </a>
                ) : '—'}
              </Td>
              <Td>{ago(i.created_at)}</Td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  )
}