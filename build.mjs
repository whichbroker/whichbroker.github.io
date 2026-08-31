/**
 * Builds the public Firm Brokers board.
 *
 * Deliberately standalone: no dependencies, no build step, no framework. Node
 * 22 has fetch built in, so CI needs only a checkout and `node build.mjs`,
 * which keeps a run to a few seconds. It shares no code with the trading bot
 * that inspired it, so nothing about that strategy can leak through here.
 *
 * Two sources, neither of them a secret:
 *   - OpenSea, for what is listed and at what price
 *   - the Robinhood Chain RPC, for each broker's level, payroll multiplier and
 *     merge status, which live on-chain and so cannot be filtered on OpenSea
 *
 * THE DELAY IS ENFORCED HERE, not by how often this runs. Publishing whatever
 * is live at build time would expose listings only seconds old whenever a run
 * happened to land just after one. Schedule controls freshness; DELAY_MINUTES
 * controls how far behind the board sits. Keep them separate.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SLUG = "thefirmbrokers";
const NFT = "0x2d4dFF47ba18c89847facA0C968e073d8B70ABb4";
const RPCS = [
  "https://rpc.mainnet.chain.robinhood.com/",
  // The official endpoint throttles under sustained batches; the project's own
  // site carries this same fallback for the same reason.
  "https://robinhood-rpc.publicnode.com",
];
const DELAY_MINUTES = Number(process.env.DELAY_MINUTES ?? 5);
const OUT = path.resolve(HERE, process.env.OUT_DIR ?? "dist");
const API_KEY = process.env.OPENSEA_API_KEY ?? "";

/** Selectors on EmployeeNFT. The contract is unverified; these are the ones its own site uses. */
const SEL = {
  tierBurned: "0x78e6b4e1",
  parts: "0xc9eb4662",
  isActive: "0x82afd23b",
  weightOf: "0x0767d178",
  artworkOf: "0x8cfd9b5b",
  ownerOf: "0x6352211e",
};
const FIELDS = ["tierBurned", "parts", "isActive", "weightOf", "artworkOf", "ownerOf"];

/** A level is the highest tier whose burn threshold the lifetime burn reaches. */
const TIERS = [
  { name: "INTERN", burn: 25_000n * 10n ** 18n, level: 1 },
  { name: "ANALYST", burn: 75_000n * 10n ** 18n, level: 2 },
  { name: "MANAGER", burn: 150_000n * 10n ** 18n, level: 3 },
  { name: "VP", burn: 300_000n * 10n ** 18n, level: 4 },
  { name: "CEO", burn: 850_000n * 10n ** 18n, level: 5 },
];
/** Artwork 1-10 are the hand-drawn 1-of-1s, worth +50% payroll. */
const LEGENDARY_MAX_ART = 10;

const word = (id) => BigInt(id).toString(16).padStart(64, "0");
const toBig = (hex) => (hex && hex !== "0x" ? BigInt(hex) : 0n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tierOf(burned) {
  if (burned <= 0n) return null;
  let tier = TIERS[0];
  for (const t of TIERS) if (burned >= t.burn) tier = t;
  return tier;
}

/** Every live listing, deduped to the order a buyer would actually take. */
async function fetchListings() {
  const best = new Map();
  let cursor = null;
  let orders = 0;
  let pages = 0;
  while (pages < 25) {
    const url =
      `https://api.opensea.io/api/v2/listings/collection/${SLUG}/best?limit=100` +
      (cursor ? `&next=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url, { headers: API_KEY ? { "x-api-key": API_KEY } : {} });
    if (!res.ok) throw new Error(`OpenSea ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const listings = body.listings ?? [];
    pages += 1;
    for (const listing of listings) {
      const params = listing.protocol_data?.parameters;
      const tokenId = params?.offer?.[0]?.identifierOrCriteria;
      if (!tokenId) continue;
      // Price is the whole consideration: seller proceeds plus marketplace fee.
      const priceWei = (params.consideration ?? []).reduce(
        (sum, c) => sum + BigInt(c.startAmount ?? "0"),
        0n,
      );
      const startTime = Number(params.startTime ?? 0) * 1000;
      orders += 1;
      const held = best.get(tokenId);
      if (!held || priceWei < held.priceWei || (priceWei === held.priceWei && startTime > held.startTime)) {
        best.set(tokenId, { tokenId, priceWei, startTime, maker: (params.offerer ?? "").toLowerCase() });
      }
    }
    cursor = body.next;
    if (!cursor || !listings.length) break;
  }
  return { best, orders, pages };
}

/** One JSON-RPC batch, trying the fallback endpoint if the primary refuses. */
let preferred = null;
async function callBatch(calls) {
  const order = preferred === RPCS[1] ? [RPCS[1], RPCS[0]] : RPCS;
  let lastError;
  for (const endpoint of order) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          calls.map((c, i) => ({
            jsonrpc: "2.0",
            id: i,
            method: "eth_call",
            params: [{ to: c.to, data: c.data }, "latest"],
          })),
        ),
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      const json = await res.json();
      const out = new Array(calls.length).fill(null);
      for (const row of Array.isArray(json) ? json : []) {
        out[row.id] = row.error ? null : (row.result ?? null);
      }
      preferred = endpoint;
      return out;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("all RPC endpoints failed");
}

/**
 * Read broker state for a set of token ids.
 *
 * A failed call is recorded, never silently treated as a zero — a dropped read
 * would otherwise turn a CEO into "never hired".
 */
async function readBrokers(ids) {
  const state = new Map();
  let unread = [];
  const CHUNK = 6;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const calls = slice.flatMap((id) => FIELDS.map((f) => ({ to: NFT, data: SEL[f] + word(id) })));
    let result = null;
    for (let attempt = 0; attempt < 4 && !result; attempt++) {
      try {
        result = await callBatch(calls);
      } catch {
        await sleep(600 * 2 ** attempt);
      }
    }
    if (!result) {
      unread.push(...slice);
      continue;
    }
    slice.forEach((id, k) => {
      const at = (n) => result[k * FIELDS.length + n];
      if (FIELDS.some((_, n) => at(n) === null)) {
        unread.push(id);
        return;
      }
      const owner = at(5);
      state.set(id, {
        owner: owner && owner !== "0x" ? ("0x" + owner.slice(26)).toLowerCase() : null,
        tierBurned: toBig(at(0)),
        parts: Number(toBig(at(1))) || 1,
        active: toBig(at(2)) === 1n,
        weight: Number(toBig(at(3))),
        artwork: Number(toBig(at(4))),
        gone: !owner || owner === "0x" || /^0x0{64}$/.test(owner),
      });
    });
    if (i + CHUNK < ids.length) await sleep(60);
  }
  // Stragglers usually answer on a quieter, one-at-a-time retry.
  if (unread.length) {
    const retry = unread;
    unread = [];
    for (const id of retry) {
      const calls = FIELDS.map((f) => ({ to: NFT, data: SEL[f] + word(id) }));
      let result = null;
      try {
        result = await callBatch(calls);
      } catch {
        /* falls through to unread */
      }
      if (!result || result.some((r) => r === null)) {
        unread.push(id);
        continue;
      }
      const owner = result[5];
      state.set(id, {
        owner: owner && owner !== "0x" ? ("0x" + owner.slice(26)).toLowerCase() : null,
        tierBurned: toBig(result[0]),
        parts: Number(toBig(result[1])) || 1,
        active: toBig(result[2]) === 1n,
        weight: Number(toBig(result[3])),
        artwork: Number(toBig(result[4])),
        gone: !owner || owner === "0x" || /^0x0{64}$/.test(owner),
      });
      await sleep(120);
    }
  }
  return { state, unread };
}

function describe(s) {
  if (!s) {
    return { brokerNo: 0, level: null, levelName: "UNREAD", multiplier: 0, merged: "?", parts: 1, status: "UNREAD", legendary: false };
  }
  const tier = tierOf(s.tierBurned);
  const legendary = s.artwork >= 1 && s.artwork <= LEGENDARY_MAX_ART;
  const units = s.tierBurned > 0n ? s.weight : 100 * (legendary ? 1.5 : 1);
  return {
    brokerNo: s.artwork,
    level: s.gone ? null : (tier?.level ?? 1),
    levelName: s.gone ? "MERGED AWAY" : (tier?.name ?? "NEVER HIRED"),
    multiplier: s.gone ? 0 : units / 100,
    merged: s.gone ? "gone" : s.parts >= 2 ? `yes (${s.parts})` : "no",
    parts: s.parts,
    status: s.gone ? "GONE" : s.active ? "EARNING" : s.tierBurned > 0n ? "CLOCKED OUT" : "NEVER HIRED",
    legendary,
  };
}

async function main() {
  const started = Date.now();
  if (!API_KEY) console.warn("  OPENSEA_API_KEY is not set; public endpoints are heavily rate limited.");

  const { best, orders, pages } = await fetchListings();
  console.log(`  ${best.size} broker(s) listed across ${orders} order(s), ${pages} page(s)`);

  const cutoff = Date.now() - DELAY_MINUTES * 60_000;
  const eligible = [...best.values()].filter((l) => l.startTime && l.startTime <= cutoff);
  console.log(`  ${eligible.length} past the ${DELAY_MINUTES} min delay, ${best.size - eligible.length} withheld`);

  const { state, unread } = await readBrokers(eligible.map((l) => l.tokenId));
  if (unread.length) console.warn(`  ${unread.length} broker(s) could not be read from the chain`);

  // Drop orders the chain says are already dead: OpenSea keeps serving a
  // listing for a few minutes after the token changes hands, and a board that
  // offers a broker nobody can buy is simply wrong. Judged only when both the
  // seller and the current owner are known.
  const live = eligible.filter((l) => {
    const s = state.get(l.tokenId);
    return !(s?.owner && l.maker && s.owner !== l.maker);
  });
  const dead = eligible.length - live.length;
  if (dead) console.log(`  ${dead} listing(s) dropped: seller no longer holds the token`);

  const rows = live
    .map((l) => ({
      ...describe(state.get(l.tokenId)),
      tokenId: l.tokenId,
      priceEth: Number(l.priceWei) / 1e18,
      listedAt: new Date(l.startTime).toISOString(),
    }))
    .sort((a, b) => a.priceEth - b.priceEth);

  const payload = {
    rows,
    delayMinutes: DELAY_MINUTES,
    stats: { seeding: false, total: best.size, unread: unread.length },
    at: new Date().toISOString(),
  };

  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "listings.json"), JSON.stringify(payload), "utf8");
  await writeFile(path.join(OUT, "index.html"), await readFile(path.join(HERE, "page.html"), "utf8"), "utf8");
  // Without this, Pages runs the output through Jekyll and drops _-prefixed files.
  await writeFile(path.join(OUT, ".nojekyll"), "", "utf8");

  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);
  console.log(`  wrote ${OUT} — ${rows.length} row(s), ${kb} KB, ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
