/**
 * Investor view.
 *
 * Deliberately the thinnest of the three. An investor holds units and
 * sees their own position — they don't operate anything. Padding this
 * out with features would misrepresent what the role actually does.
 */
import { useState } from 'react'
import type { Snapshot } from '../lib/store'
import {
  shortAddr, units, explorerAccount,
} from '../lib/format'
import { Panel, Table, Td, Status, Empty } from '../components/ui'

export function InvestorView({ platform }: { platform: Snapshot }) {
  const { assets, holdings, investors } = platform
  const asset = assets[0]

  const realInvestors = investors.filter(i => i.kyc_status !== 'system')
  const [selected, setSelected] = useState<string | null>(null)

  const me = realInvestors.find(i => i.investor_id === selected) ?? realInvestors[0]
  const myHolding = holdings.find(h => h.account === me?.account)

  if (!asset || !me) return <Empty>No investors. Run <code>npm run seed</code>.</Empty>

  const outstanding = Number(asset.units_outstanding) || 0
  const mine = Number(myHolding?.balance ?? 0)
  const share = outstanding > 0 ? (mine / outstanding) * 100 : 0

  return (
    <div className="space-y-6">

      <div className="flex items-center gap-2 text-sm">
        <span className="text-neutral-500">Viewing as</span>
        <select
          value={me.investor_id}
          onChange={e => setSelected(e.target.value)}
          className="border border-neutral-300 bg-white px-2 py-1 text-sm"
        >
          {realInvestors.map(i => (
            <option key={i.investor_id} value={i.investor_id}>
              {i.legal_name}
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-400">
          (no authentication — see README)
        </span>
      </div>

      <Panel title="Your position" subtitle={asset.title}>
        <dl className="grid grid-cols-3 gap-6 text-sm">
          <div>
            <dt className="text-xs text-neutral-500">Units held</dt>
            <dd className="mt-1 text-2xl tabular-nums">{units(mine)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Share of issue</dt>
            <dd className="mt-1 text-2xl tabular-nums">{share.toFixed(2)}%</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Account</dt>
            <dd className="mt-1 font-mono text-xs">
              {me.account ? (
                  <a
                    href={explorerAccount(me.account)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-neutral-300 hover:decoration-neutral-600"
                >
                  {shortAddr(me.account, 10)}
                </a>
              ) : '—'}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title="Eligibility"
        subtitle="Trading is restricted to holders of an accepted KYC credential"
      >
        <Table head={['Stage', 'Status', 'When']}>
          <tr>
            <Td>Application submitted</Td>
            <Td><Status value={me.kyc_submitted ? 'confirmed' : 'pending'} /></Td>
            <Td>{me.kyc_submitted ? new Date(me.kyc_submitted).toLocaleString('en-GB') : '—'}</Td>
          </tr>
          <tr>
            <Td>Credential issued by verifier</Td>
            <Td><Status value={me.kyc_approved ? 'confirmed' : 'pending'} /></Td>
            <Td>{me.kyc_approved ? new Date(me.kyc_approved).toLocaleString('en-GB') : '—'}</Td>
          </tr>
          <tr>
            <Td>Credential accepted by you</Td>
            <Td><Status value={me.credential_accepted_at ? 'confirmed' : 'pending'} /></Td>
            <Td>{me.credential_accepted_at ? new Date(me.credential_accepted_at).toLocaleString('en-GB') : '—'}</Td>
          </tr>
        </Table>

        <p className="mt-4 border-l-2 border-neutral-300 pl-3 text-xs leading-relaxed text-neutral-600">
          Credentials on the XRP Ledger are two-sided: the verifier issues one,
          and the subject must separately accept it. An issued but unaccepted
          credential does not grant domain membership, so all three stages must
          complete before this account can trade.
        </p>
      </Panel>

      <Panel title="Register" subtitle="All holders of this asset">
        {holdings.length === 0 ? (
          <Empty>No holders.</Empty>
        ) : (
          <Table head={['Holder', 'Account', 'Units', 'Share']}>
            {holdings.map(h => {
              const pct = outstanding > 0 ? (Number(h.balance) / outstanding) * 100 : 0
              const isMe = h.account === me.account
              return (
                <tr key={h.account} className={isMe ? 'bg-neutral-50' : ''}>
                  <Td>
                    {h.legal_name ?? '—'}
                    {isMe && <span className="ml-2 text-xs text-neutral-400">you</span>}
                  </Td>
                  <Td mono>{shortAddr(h.account)}</Td>
                  <Td right>{units(h.balance)}</Td>
                  <Td right>{pct.toFixed(2)}%</Td>
                </tr>
              )
            })}
          </Table>
        )}
      </Panel>
    </div>
  )
}