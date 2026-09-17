import { getAddress, type Address } from 'viem';

/**
 * pons v2 deployment on Robinhood Chain (chain id 4663).
 * Every address here was read back from chain; the factory is the root of trust —
 * escrow/hook/locker are re-read from it at boot and compared against these pins.
 */
export const CHAIN_ID = 4663;

export const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.chain.robinhood.com',
] as const;

export const PONS_V2 = {
  factory: getAddress('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'),
  launchAndBuyRouter: getAddress('0xe33E9E479dF8802cb0866d5d05258bEc4cF62948'),
  feeEscrow: getAddress('0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'),
  memeHook: getAddress('0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'),
} satisfies Record<string, Address>;

export const NATIVE_QUOTE: Address = '0x0000000000000000000000000000000000000000';
