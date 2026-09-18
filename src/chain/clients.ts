import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAIN_ID } from './addresses.js';
import type { Config } from '../config.js';

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

/** The public Robinhood RPC rate-limits bursts (429) and times out under load; back off hard. */
const RPC_HTTP_OPTIONS = { timeout: 20_000, retryCount: 8, retryDelay: 1_000 } as const;

export function makePublicClient(config: Config): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: fallback(config.rpcUrls.map((url) => http(url, RPC_HTTP_OPTIONS))),
  }) as PublicClient;
}

/** One client per RPC, used to cross-check price-critical reads before trading on them. */
export function makeVerifierClients(config: Config): PublicClient[] {
  return config.rpcUrls.map(
    (url) => createPublicClient({ chain: robinhoodChain, transport: http(url) }) as PublicClient,
  );
}

export function makeAccount(key: Hex): Account {
  return privateKeyToAccount(key);
}

export function makeWalletClient(config: Config, key: Hex): WalletClient {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: robinhoodChain,
    transport: fallback(config.rpcUrls.map((url) => http(url, RPC_HTTP_OPTIONS))),
  });
}

/** A lying or misconfigured RPC is the cheapest way to make a bot sign the wrong thing. */
export async function assertChainId(client: PublicClient, expected: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) {
    throw new Error(`RPC reports chain id ${actual}, expected ${expected}`);
  }
}
