import "dotenv/config"
import { AtpAgent, AtUri, CredentialSession } from '@atproto/api'
import { XRPCError } from '@atproto/xrpc'
import { queueUser, isInited, isRateLimitAllowed } from "./list"
import websocket from 'websocket'
(async function() {
const client = websocket.client
//TODO: also grab dids from backfill endpoints

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
        if (message.type === "utf8" && isRateLimitAllowed() && isInited()) {
          let json = JSON.parse(message.utf8Data)
          if (typeof json?.commit?.record?.subject?.uri == "string" && json?.commit?.collection?.startsWith("app.bsky.feed")) {
            let did = json.commit.record.subject.uri.match(DID_REGEX)
            if (did) {
              did = did[0]
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
})();