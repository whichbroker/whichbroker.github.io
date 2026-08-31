# Firm Brokers — public board

Every [Firm Brokers](https://opensea.io/collection/thefirmbrokers) listing on
OpenSea, with the level, payroll multiplier and merge status that OpenSea
cannot show you — those live on-chain in the EmployeeNFT contract, not in the
token metadata, so there is no attribute to filter on there.

**Listings appear 5 minutes after they go live on OpenSea.** The board says so
at the top of the page. It is not a real-time feed.

## How it works

`build.mjs` reads OpenSea for what is listed, reads the Robinhood Chain RPC for
each broker's on-chain state, drops anything listed inside the delay window, and
writes `dist/index.html` + `dist/listings.json`. A GitHub Action runs it every
5 minutes and publishes to Pages.

No dependencies and no build step — Node 22 has `fetch` built in.

```bash
OPENSEA_API_KEY=... node build.mjs     # writes ./dist
```

`DELAY_MINUTES` overrides the delay; `OUT_DIR` overrides the output directory.

## Broker # vs token id

They are different numbers. Broker #4246 is token 2486; token 4246 is broker
#1659. The board shows broker numbers, which is what the project itself uses,
and links each one to the right OpenSea item.
