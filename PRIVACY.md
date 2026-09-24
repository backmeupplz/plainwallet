# Privacy policy

Plain Wallet has no servers, accounts, analytics or telemetry. Its developer receives no data from it.

**Stored on your device only.** Your seed phrases and private keys, encrypted with your password, plus your account addresses, nicknames, networks, tokens and connected sites. Uninstalling the extension or resetting the wallet deletes them.

**Sent over the network, only to do what you ask:**

- To the RPC endpoint of the selected network (a public endpoint by default, or one you or a site you approved configured): your address, to read balances, and the transactions you sign, to broadcast them. That provider also sees your IP address.
- To websites you connect: the address of the account you connected, and the signatures and transaction hashes you approve.
- To DeBank, only when you click the history button: your address, in the page it opens.
- To the same RPC, each transaction you review, to simulate it before you approve.
- Only if you enter a Jev API key in Settings, for each transaction or signature you review:
  - to Blockscout (on Ethereum, Base, Arbitrum, OP Mainnet and Polygon): the addresses of the contract called and of whoever gets to spend your tokens, to look up whether they are verified, how old they are and whether they are flagged;
  - to Sourcify (sourcify.dev): the first 4 bytes of the calldata, to name the function called when its contract isn't verified;
  - to TypeSafe (api.typesafe.ai), with your key: the network, the site's hostname and page title, the recipient, value, the wallet's description of the call, the simulation result and lookups, or the message or typed data you are asked to sign.

  Each of them also sees your IP address.

Nothing is sold or shared with anyone else, or used for anything other than running the wallet.

Questions: open an issue at https://github.com/backmeupplz/plainwallet/issues.
