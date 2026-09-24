// An optional second opinion on a transaction or signature from Jev (typesafe.ai), with the user's own API key, fed
// with what the wallet can find out first: a simulation (lib/chain.ts) and public lookups (lib/lookup.ts). Jev
// classifies, it doesn't simulate, and it reads hex poorly: it only sees text the wallet prepared. A site can still
// word things to sway it, so its answers only ever sit next to the wallet's own rows, never replace them.

export type Subject = 'transaction' | 'signature'

// Choice keys double as the label shown in the popup.
const ACTIONS: Record<Subject, Record<string, string>> = {
  transaction: {
    'Sends coins': 'Sends the native currency in `transaction.value` to an address, with no contract call',
    'Sends tokens': 'Transfers tokens or NFTs to another address',
    'Grants token access': "Approves another address to spend or move the account's tokens or NFTs later",
    'Revokes token access': 'Removes an approval that another address had',
    'Swaps': 'Trades one token or coin for another, e.g. on an exchange',
    'Wraps or unwraps': 'Converts between the native coin and its wrapped token, e.g. ETH and WETH',
    'Buys an NFT': 'Pays for an NFT from a marketplace or a sale',
    'Mints': 'Mints a new NFT or token',
    'Deposits or stakes': 'Puts assets into a protocol: lending, staking, a liquidity pool or a vault',
    'Withdraws or claims': 'Takes assets out of a protocol, or claims rewards or an airdrop',
    'Bridges': 'Moves assets to another blockchain',
    'Registers a name': 'Registers or renews a name such as ENS or Basenames',
    'Plays a game': 'Makes a move or takes an action in an on-chain game',
    'Social action': 'Posts, follows, likes or updates a profile in an on-chain social app',
    'Votes or delegates': 'Casts a governance vote or delegates voting power',
    'Manages a smart account': 'Changes the owners, modules or settings of a smart account or Safe',
    'Other app action': "Does something inside an app that moves none of the account's assets",
    'Deploys a contract': 'Creates a new contract',
    'Unclear': 'Nothing in `transaction` shows what it does',
  },
  signature: {
    'Signs in': 'Proves the account owner is logging in to `signature.site`; moves nothing',
    'Grants token access': "A permit: lets another address spend or move the account's tokens",
    'Lists or sells assets': 'A marketplace order or listing that trades away NFTs or tokens when someone fills it',
    'Makes an offer': 'An offer or bid to buy an asset, paid from the account if someone accepts it',
    'Authorizes a transfer': "Lets someone else submit a transfer of the account's tokens",
    'Runs a transaction': 'Approves a transaction someone else submits, e.g. for a Safe, smart account or relayer',
    'Adds a session key': 'Lets an app or another key act for the account for a while without asking again',
    'Upgrades the account': "Delegates the account's code to a contract (EIP-7702), giving it full control of the account",
    'Delegates or votes': 'Delegates voting power or casts a governance vote',
    'Confirms an app action': 'Confirms an action inside an app, such as a game move or a social post, that moves no assets',
    'Just a message': 'Agrees to terms or signs text; moves nothing and grants nothing',
    'Unclear': 'Nothing in `signature` shows what signing it allows',
  },
}

const questions = (subject: Subject, site: boolean) => ({
  action: {
    type: 'choice',
    instructions: subject === 'transaction'
      ? 'What does `transaction` do on-chain? `transaction.simulation`, when present, is how the account’s balances would change.'
      : 'What does signing `signature` allow?',
    criteria: ACTIONS[subject],
  },
  scam: {
    type: 'noul',
    instructions: `Is \`${subject}\` a scam, phishing or wallet-drainer ${subject}?`,
    criteria: {
      true: 'Gives tokens, NFTs or approvals to an unknown party for nothing in return (for example to a regular account, or a new or unverified contract), involves a contract flagged as a scam, comes from a site imitating a known app, or poses as a free reward or airdrop claim',
      false: 'An ordinary action the account owner would expect to take',
    },
  },
  ...(site && {
    lookalike: {
      type: 'noul',
      instructions: `Is \`${subject}.site\` a fake domain imitating a well-known crypto app, exchange or brand?`,
      criteria: {
        true: 'Misspells, adds words to, or swaps the ending of the official domain of a known brand',
        false: 'An official domain, or one that does not imitate any known brand',
      },
    },
  }),
})

/** `ranked`: every action with its probability, most likely first. */
export type Verdict = { action: string; ranked: [string, number][]; scam: number; lookalike?: number }

/** `fields` is plain text the wallet prepared; `site` only for requests from a website. */
export async function analyze(key: string, subject: Subject, fields: Record<string, string>): Promise<Verdict> {
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state: { [subject]: fields }, questions: questions(subject, !!fields.site) }),
  })
  if (!res.ok) throw new Error(res.status === 401 ? 'Jev rejected the API key' : `Jev answered ${res.status}`)
  const a = (await res.json())?.answers
  const action = a?.action?.choice
  const probabilities = a?.action?.probabilities ?? {}
  const ranked = Object.keys(ACTIONS[subject]).map((k): [string, number] => [k, probabilities[k]])
    .filter(([, p]) => typeof p === 'number').toSorted((x, y) => y[1] - x[1])
  const verdict = { action, ranked, scam: a?.scam?.noul, lookalike: a?.lookalike?.noul }
  const numbers = [probabilities[action], verdict.scam, ...(fields.site ? [verdict.lookalike] : [])]
  if (!Object.hasOwn(ACTIONS[subject], action) || !numbers.every((n) => typeof n === 'number')) throw new Error('Unexpected answer from Jev')
  return verdict
}
