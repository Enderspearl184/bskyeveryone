import { AtpAgent, AtUri } from '@atproto/api'
import { configDotenv } from 'dotenv'
import websocket from 'websocket'
const client = websocket.client

const MAX_PER_HOUR = 3000 // I STILL WANT TO BE ABLE TO USE MY ACCOUNT SOMETIMES
const DID_REGEX = /did:plc:([a-zA-Z0-9])+/g

configDotenv()

// login
const agent = new AtpAgent({
  service: 'https://bsky.social'
})

await agent.login({
    identifier: process.env.BSKY_USERNAME,
    password: process.env.BSKY_PASSWORD
})

// add to the list with the ratelimit 
let lastReset = Date.now()
let reqCount = 0
let hasMentionedHour = false

function isRateLimit() {
  if (Date.now() - lastReset >= 60 * 60 * 1000) {
    lastReset = Date.now()
    reqCount = 0
    hasMentionedHour = false
  }
  return reqCount >= MAX_PER_HOUR
}

async function addToListWithRatelimit(did) {
  if (!isRateLimit()) {
    reqCount++;

    try {
      await agent.com.atproto.repo.createRecord({
        repo: agent.session.did,
        collection: 'app.bsky.graph.listitem',
        record: {
          $type: 'app.bsky.graph.listitem',
          subject: did,
          list: process.env.BSKY_LIST,
          createdAt: new Date().toISOString()
        }
      })
      console.log('added ' + did + ' to the list')
    } catch (err) {
      //console.warn(err.message)
      if (err.message.includes("Rate Limit")) {
        reqCount = MAX_PER_HOUR
      }
    }
  } else {
    if (!hasMentionedHour) {
      hasMentionedHour = true
      console.log('too many added for this hour!!')
    }
  }
}


//connect

//just use app.bsky.* cuz im lazy
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
        if (message.type === "utf8" && !isRateLimit()) {
          //console.log(message)
          let json = JSON.parse(message.utf8Data)
          //console.log(json)
          if (typeof json?.commit?.record?.subject?.uri == "string" && json?.commit?.collection?.startsWith("app.bsky.feed")) {
            let did = json.commit.record.subject.uri.match(DID_REGEX)
            if (did) {
              did = did[0]
              addToListWithRatelimit(did)
            }
          }
        }
      } catch (err) {
        console.warn(err)
      }
    });
    
});

socket.connect('wss://jetstream2.us-west.bsky.network/subscribe');