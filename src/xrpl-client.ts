import 'dotenv/config'
import { Client } from 'xrpl'

export const TESTNET = 'wss://s.altnet.rippletest.net:51233'
export const DEVNET  = 'wss://s.devnet.rippletest.net:51233'

export function networkUrl(): string {
  return (process.env.XRPL_NETWORK ?? 'testnet') === 'devnet' ? DEVNET : TESTNET
}

export async function connect(): Promise<Client> {
  // The public cluster refuses or stalls a meaningful share of
  // connections. Five seconds (the default) is too tight and produces
  // spurious failures in anything that connects on a timer.
  const client = new Client(networkUrl(), { connectionTimeout: 20_000 })
  await client.connect()
  return client
}
