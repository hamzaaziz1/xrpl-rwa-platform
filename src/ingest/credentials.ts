/**
 * Credential projection.
 *
 * Reads CredentialCreate / CredentialAccept / CredentialDelete out of
 * the event log and maintains the `credentials` table.
 *
 * This exists because kyc_status used to be a column the API wrote,
 * which meant the registry could claim a state the ledger disagreed
 * with — and nothing detected it. Balances were projected from the
 * start; credentials were not, and that inconsistency caused every KYC
 * bug in this project.
 *
 * A NOTE ON DIRECTION, because it is wrong in the obvious reading:
 *
 *   CredentialCreate  submitted by the ISSUER  -> subject is `Subject`
 *   CredentialDelete  submitted by the ISSUER  -> subject is `Subject`
 *   CredentialAccept  submitted by the SUBJECT -> subject is `Account`,
 *                                                 and `Issuer` is separate
 *
 * Reading `Subject` on an Accept gives undefined, and the acceptance
 * silently attaches to nothing.
 */

interface Applied {
  subject: string
  issuer: string
  credentialType: string
  field: 'issued' | 'accepted' | 'revoked'
}

/** Extract the credential identity from a transaction, or null. */
export function credentialFrom(tx: any): Applied | null {
  const type = tx?.TransactionType

  if (type === 'CredentialCreate') {
    if (!tx.Subject || !tx.Account || !tx.CredentialType) return null
    return {
      subject: tx.Subject,
      issuer: tx.Account,
      credentialType: tx.CredentialType,
      field: 'issued',
    }
  }

  if (type === 'CredentialAccept') {
    // submitted BY the subject
    if (!tx.Account || !tx.Issuer || !tx.CredentialType) return null
    return {
      subject: tx.Account,
      issuer: tx.Issuer,
      credentialType: tx.CredentialType,
      field: 'accepted',
    }
  }

  if (type === 'CredentialDelete') {
    // either party may delete; Subject is present when the issuer does it
    const subject = tx.Subject ?? tx.Account
    const issuer = tx.Issuer ?? tx.Account
    if (!subject || !issuer || !tx.CredentialType) return null
    return {
      subject,
      issuer,
      credentialType: tx.CredentialType,
      field: 'revoked',
    }
  }

  return null
}

/**
 * Apply one credential event. Called from inside the projection's
 * database transaction, so it takes a client rather than the pool.
 */
export async function applyCredential(
  client: any, applied: Applied, ledgerIndex: number,
): Promise<void> {
  const { subject, issuer, credentialType, field } = applied

  const col = field === 'issued' ? 'issued' : field === 'accepted' ? 'accepted' : 'revoked'

  await client.query(
    `insert into credentials
       (subject, issuer, credential_type, ${col}_at, ${col}_ledger)
     values ($1, $2, $3, now(), $4)
     on conflict (subject, issuer, credential_type) do update
       set ${col}_at = now(),
           ${col}_ledger = excluded.${col}_ledger`,
    [subject, issuer, credentialType, ledgerIndex],
  )

  // Re-issuing after a revoke clears the revocation, otherwise a
  // credential that was deleted and granted again reads as revoked
  // forever.
  if (field === 'issued') {
    await client.query(
      `update credentials
          set revoked_at = null, revoked_ledger = null, accepted_at = null,
              accepted_ledger = null
        where subject = $1 and issuer = $2 and credential_type = $3
          and revoked_ledger is not null
          and revoked_ledger < $4`,
      [subject, issuer, credentialType, ledgerIndex],
    )
  }
}

/** Human-readable status for one credential row. */
export function statusOf(row: {
  issued_at: string | null
  accepted_at: string | null
  revoked_at: string | null
}): 'revoked' | 'approved' | 'issued' | 'none' {
  if (row.revoked_at) return 'revoked'
  if (row.accepted_at) return 'approved'
  if (row.issued_at) return 'issued'
  return 'none'
}
