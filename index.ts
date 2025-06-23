import "dotenv/config"
import { queueUser, isInited, isRateLimitAllowed } from "./list"
import websocket from 'websocket'
import {errors, type Headers} from "undici"
(async function() {
const BACKFILL_PDS_LIST_URL = "https://raw.githubusercontent.com/mary-ext/atproto-scraping/refs/heads/trunk/state.json"
const client = websocket.client

const sleep = (ms: number)=> new Promise((resolve)=>setTimeout(resolve, ms))
const DID_REGEX = /did:plc:([a-zA-Z0-9])+/g

// wait for list to init

//just use app.bsky.feed.* basically cuz im lazy
const socket = new client()

socket.on('connectFailed', async(error) => {
    console.log('Connect Error: ' + error.toString());
});

socket.on('connect', async(connection)=> {
    console.log('WebSocket Client Connected');
    connection.on('error', async(error)=> {
        console.log("Connection Error: " + error.toString());
    });
    connection.on('close', async()=> {
        console.log('Connection Closed :(');
        process.exit(1)
    });
    connection.on('message', async(message)=> {
      try {
        if (message.type === "utf8" && isInited()) {
          let json = JSON.parse(message.utf8Data)
          if (typeof json?.commit?.record?.subject?.uri == "string") {
            let did = json.commit.record.subject.uri.match(DID_REGEX)
            if (did) {
              did = did[0]
              //console.log(did)
              queueUser(did)
            }
          }
        }
      } catch (err) {
        console.warn(err)
      }
    });
    
});

socket.connect('wss://jetstream2.us-west.bsky.network/subscribe');

/* taken from @zeppelin-social/backfill-bsky */
const ratelimitCooldowns = new Map<string, Promise<unknown>>();
const backoffs = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

async function processRatelimitHeaders(headers: Headers, url: string) {
	const remainingHeader = headers.get("ratelimit-remaining"),
		resetHeader = headers.get("ratelimit-reset");
	if (!remainingHeader || !resetHeader) return;

	const ratelimitRemaining = parseInt(remainingHeader);
	if (isNaN(ratelimitRemaining) || ratelimitRemaining <= 1) {
		const ratelimitReset = parseInt(resetHeader) * 1000;
		if (isNaN(ratelimitReset)) {
			//console.error("ratelimit-reset header is not a number at url " + url);
		} else {
			const now = Date.now();
			const waitTime = ratelimitReset - now + 1000; // add a second to be safe
			if (waitTime > 0) {
				const cooldown = sleep(waitTime);
				ratelimitCooldowns.set(url, cooldown);
				await cooldown;
			}
		}
	}
}

async function fetchPdsDids(pds: string, onDid: (did: string, pds: string) => void) {
	const url = new URL(`/xrpc/com.atproto.sync.listRepos`, pds).href;
	let cursor = "";
	let fetched = 0;
	while (true) {
		try {
			const signal = AbortSignal.timeout(30_000);
			const res = await fetch(url + "?limit=1000&cursor=" + cursor, { signal });
			if (!res.ok) {
				if (res.status === 429) {
					await processRatelimitHeaders(res.headers, url);
					continue;
				}
				throw new Error(
					`Failed to fetch DIDs from ${pds}: ${res.status} ${res.statusText}`,
				);
			}

			const { cursor: _c, repos } = await res.json() as {
				cursor: string;
				repos: Array<{ did: string }>;
			};
			for (const repo of repos) {
				if (!repo.did) continue;
				onDid(repo.did, pds);
				fetched++;
			}

			if (!_c || _c === cursor) break;
			cursor = _c;
		} catch (err: any) {
			const undiciError = err instanceof errors.UndiciError
				? err
				: (err instanceof Error && err.cause instanceof errors.UndiciError)
				? err.cause
				: null;
			if (
				[
					"ETIMEDOUT",
					"UND_ERR_CONNECT_TIMEOUT",
					"UND_ERR_HEADERS_TIMEOUT",
					"UND_ERR_SOCKET",
				].includes(undiciError?.code ?? "")
			) {
				console.warn(`Could not connect to ${url} for listRepos, skipping`);
				break;
			} else {
				// bsky.network PDS definitely exists
				if (pds.includes("bsky.network")) {
					console.warn(`listRepos failed for ${url} at cursor ${cursor}, retrying`);
					await sleep(5000);
				} else {
					console.warn(
						`listRepos failed for ${url} at cursor ${cursor}, skipping`,
						err.message || err,
					);
					break;
				}
			}
		}
	}
	console.log(`Fetched ${fetched} DIDs from ${pds}`);
	return fetched;
}


// also attempt to load the backfill of dids
let knownPDS: string[] = []
try {
  let res = await fetch(BACKFILL_PDS_LIST_URL)
  let json = await res.json()
  if (typeof json.pdses == "object") {
    knownPDS = Object.keys(json.pdses).filter((pds) => pds.startsWith("https://"));
  } else {
    throw "pdses object does not exist!"
  }
} catch (err) {
  console.warn('error loading backfill pdses')
  console.warn(err)
}

while (!isInited()) {
  await sleep(1000)
}

for (let pds of knownPDS) {
  // only allow https pdses to be loaded
  fetchPdsDids(pds, async(did:string)=>queueUser(did))
}
})().catch(console.error);