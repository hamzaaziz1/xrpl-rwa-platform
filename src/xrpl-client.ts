import 'dotenv/config'
import { Client } from 'xrpl'

export const TESTNET = 'wss://s.altnet.rippletest.net:51233'
export const DEVNET  = 'wss://s.devnet.rippletest.net:51233'

export function networkUrl(): string {
  return (process.env.XRPL_NETWORK ?? 'testnet') === 'devnet' ? DEVNET : TESTNET
}

export async function connect(): Promise<Client> {
  const client = new Client(networkUrl())
  await client.connect()
  return client
}
