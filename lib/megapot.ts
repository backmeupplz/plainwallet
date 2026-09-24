// Optional, off unless turned on in Settings: every N transactions the wallet sends, it asks to buy one Megapot
// (megapot.io) lottery ticket with random numbers, on Base, for the account that sent the Nth. Each purchase goes through
// the usual approval window. Pure, so `npm test` covers it; the background does the asking (entrypoints/background.ts).
import { encodeFunctionData, erc20Abi, parseAbi, zeroHash } from 'viem'

export const BASE = 8453
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const JACKPOT = '0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2'
const BUYER = '0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd' // JackpotRandomTicketBuyer: picks the numbers on-chain
// Plain Wallet's developer (borodutch.eth) gets Megapot's referral share of tickets bought through the wallet.
export const REFERRER = '0xbf74483DB914192bb0a9577f3d8Fb29a6d4c08eE'
// When the allowance runs out, approve this many tickets at once: one extra window per ten tickets, at most $10 exposed.
export const TICKETS_PER_APPROVAL = 10n

export const megapotAbi = parseAbi([
  'function ticketPrice() view returns (uint256)',
  'function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)',
])

export const approveTickets = (price: bigint) =>
  ({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [BUYER, price * TICKETS_PER_APPROVAL] }) }) as const
export const buyTicket = (recipient: `0x${string}`) =>
  ({ to: BUYER, data: encodeFunctionData({ abi: megapotAbi, functionName: 'buyTickets', args: [1n, recipient, [REFERRER], [10n ** 18n], zeroHash] }) }) as const
export const allowanceOf = (owner: `0x${string}`) => ({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [owner, BUYER] }) as const

/** Kept in storage.local, unsigned: at worst a tampered one brings up a purchase you can reject. */
export type Megapot = { on: boolean; every: number; count: number; error?: string }
export const megapotSettings = (v: any): Megapot => ({
  on: v?.on === true,
  every: Number.isSafeInteger(v?.every) && v.every >= 1 ? v.every : 10,
  count: Number.isSafeInteger(v?.count) && v.count >= 0 ? v.count : 0,
  ...(typeof v?.error === 'string' && { error: v.error }),
})
/** One more transaction sent: the settings to store, and whether this one earns a ticket. */
export function tick(m: Megapot): { next: Megapot; buy: boolean } {
  if (!m.on) return { next: m, buy: false }
  const count = m.count + 1
  return count >= m.every ? { next: { ...m, count: 0 }, buy: true } : { next: { ...m, count }, buy: false }
}
