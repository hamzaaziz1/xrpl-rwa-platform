/**
 * Shared primitives.
 *
 * Deliberately plain. This is a regulated-finance internal tool and it
 * should look like one — no gradients, no cards floating on shadows, no
 * dashboard aesthetic. Restraint reads as judgement.
 */
import type { ReactNode } from 'react'

export function Panel({ title, subtitle, right, children }: {
  title: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="border border-neutral-300 bg-white">
      <header className="flex items-baseline justify-between border-b border-neutral-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p>
          )}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-neutral-200 text-left">
          {head.map(h => (
            <th key={h} className="pb-2 pr-4 text-xs font-medium uppercase tracking-wide text-neutral-500">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-neutral-100">{children}</tbody>
    </table>
  )
}

export function Td({ children, mono, right }: {
  children: ReactNode; mono?: boolean; right?: boolean
}) {
  return (
    <td className={[
      'py-2 pr-4 align-middle',
      mono ? 'font-mono text-xs' : '',
      right ? 'text-right tabular-nums' : '',
    ].join(' ')}>
      {children}
    </td>
  )
}

const STATUS_STYLE: Record<string, string> = {
  pending:   'bg-neutral-100 text-neutral-700 border-neutral-300',
  submitted: 'bg-amber-50 text-amber-800 border-amber-300',
  confirmed: 'bg-emerald-50 text-emerald-800 border-emerald-300',
  failed:    'bg-red-50 text-red-800 border-red-300',
  expired:   'bg-neutral-100 text-neutral-600 border-neutral-300',
  clean:     'bg-emerald-50 text-emerald-800 border-emerald-300',
  drift:     'bg-red-50 text-red-800 border-red-300',
  approved:  'bg-emerald-50 text-emerald-800 border-emerald-300',
  approving: 'bg-amber-50 text-amber-800 border-amber-300',
  issued:    'bg-amber-50 text-amber-800 border-amber-300',
  revoked:   'bg-neutral-100 text-neutral-600 border-neutral-300',
  critical:  'bg-red-50 text-red-800 border-red-300',
  warning:   'bg-amber-50 text-amber-800 border-amber-300',
}

export function Status({ value }: { value: string }) {
  const style = STATUS_STYLE[value] ?? 'bg-neutral-100 text-neutral-700 border-neutral-300'
  return (
    <span className={`inline-block border px-1.5 py-0.5 text-xs ${style}`}>
      {value}
    </span>
  )
}

export function Button({ children, onClick, disabled, danger }: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'border px-2.5 py-1 text-xs transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        danger
          ? 'border-red-300 text-red-800 hover:bg-red-50'
          : 'border-neutral-300 text-neutral-800 hover:bg-neutral-100',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-neutral-400">{children}</p>
}