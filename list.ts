import fs from "fs"
import { AtpAgent, CredentialSession } from "@atproto/api"
import { XRPCError } from "@atproto/xrpc"

const PENDING_FILE = "./pending.txt"
const ADDED_FILE = "./added.txt"
const ADD_INTERVAL = 1 * 60 * 1000
const SAVE_STATE_INTERVAL = 30* 60 * 1000
const LOG_LENGTHS_ENABLED = true
const LOG_LENGTHS_INTERVAL = 10 * 1000
let added: string[] = []
let pending: string[] = []
let processing: Set<string> = new Set()

const sleep = (ms: number)=> new Promise((resolve)=>setTimeout(resolve, ms))

// login
const creds = new CredentialSession(new URL("https://bsky.social"))
const agent = new AtpAgent(creds)


let inited = false

// add to the list with the ratelimit 
let rateLimitResetTime = 0
let rateLimitRemaining = 1

function isRateLimitAllowed() {
  return rateLimitRemaining > 0 || Date.now() >= (rateLimitResetTime * 1000)
}

function onRateLimitHeaders(headers: any) {
    if (headers && typeof headers["ratelimit-remaining"] == "string" && typeof headers["ratelimit-reset"] == "string") {
        let remaining = parseInt(headers["ratelimit-remaining"])
        let reset = parseInt(headers["ratelimit-reset"])
        if (isFinite(remaining) && isFinite(reset)) {
            rateLimitResetTime = reset
            rateLimitRemaining = remaining
            console.log('Rate limited!!! reset in: ' + (reset - (Date.now()/1000))/60 + " minutes")
        }
    }
}

async function createListEntry(did: string) {
    if (!inited || !agent.session) {
        throw "Not logged in?"
    }

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
        //console.log('added ' + did + ' to the list')
        added.push(did)
        processing.delete(did)
    } catch (err) {
        // add the user back to the list
        pending.push(did)
        processing.delete(did)
        console.warn(err)
        if (err instanceof XRPCError) {
            onRateLimitHeaders(err.headers)
        }
    }
}

async function loadList() {
    let cursor: string | undefined
    do {
        let res = await agent.app.bsky.graph.getList({
            list: process.env.BSKY_LIST,
            limit: 100,
            cursor
        })
        cursor = res.data.cursor
        for (let item of res.data.items) {
            added.push(item.subject.did)
        }
    } while (cursor)
}

// queue a user
async function queueUser(did: string, ignoreChecks: boolean) {
    if (!inited) {
        throw "Not inited!"
    }
    if (ignoreChecks || (!added.includes(did) && !pending.includes(did) && pending.length<10000 && !processing.has(did))) {
        pending.push(did)
    }
}

// return a promise for when it is inited, or true if it is already done
function isInited() {
    return inited
}

function syncWriteFile(filepath: string, data: string[]) {
    let index = 0
    let i = 0
    let fd = fs.openSync(filepath, 'w')
    for (let part of data) {
        let writing = part
        if (i<data.length-1) {
            writing+='\n'
        }
        fs.writeSync(fd, writing, index)
        index+=writing.length
        i++
    }
    fs.closeSync(fd)
}


function fileToArr(filename: string): Promise<string[]> {
    return new Promise((resolve,reject)=>{
        let readStream = fs.createReadStream(filename);
        let chunks: string = "";
        let array: string[] = []
        // Handle any errors while reading
        readStream.on('error', err => {
            // handle error

            // File could not be read
            return reject(err)
        });

        // Listen for data
        readStream.on('data', (chunk: string | Buffer) => {
            chunk = chunk.toString()
            chunks = chunks + chunk
            // try and split it
            let split = chunks.split('\n')
            for (let i = 0; i < split.length-1; i++) {
                // we use chunks.length-1 here because if it's still streaming data in we don't want to consume that piece
                array.push(split[i])
            }
            chunks = split[split.length-1]
        });

        // File is done being read
        readStream.on('close', () => {
            // Create a buffer of the image from the stream
            for (let chunk in chunks.split('\n')) {
                array.push(chunk)
            }
            return resolve(array)
        });
    })
}

// sync function used on exiting
function saveStateSync() {
    if (!inited) return
    syncWriteFile(PENDING_FILE,pending)
    syncWriteFile(ADDED_FILE,added)
    console.log('saved')
}

// async function used on a timer
async function saveState() {
    if (!inited) return
    //await fs.promises.writeFile(PENDING_FILE, Array.from(pending).join('\n'))
    //await fs.promises.writeFile(ADDED_FILE, Array.from(added).join('\n'))
    syncWriteFile(PENDING_FILE,pending)
    syncWriteFile(ADDED_FILE,added)
    console.log('saved')
}
setInterval(saveState,SAVE_STATE_INTERVAL)

async function addUsersToList() {
    console.log('adding!!')
    while (isRateLimitAllowed() && inited && pending.length > 0) {
        let did = pending.pop()
        //console.log(did)
        if (did) {
            processing.add(did)
            await createListEntry(did)
        }
    }
}
setInterval(addUsersToList, ADD_INTERVAL)

// log the lengths of the lists sometimes just for my amusement
if (LOG_LENGTHS_ENABLED) {
    setInterval(async()=>{
        console.log(`added: ${added.length} pending: ${pending.length}`)
    }, LOG_LENGTHS_INTERVAL)
}


process.on("SIGINT", function() {
    console.log("saving before shutdown");
    process.exit();
});

process.on("exit", function() {
    if (inited) {
        saveStateSync()
    }
});

async function init() {
    await creds.login({
        identifier: process.env.BSKY_USERNAME,
        password: process.env.BSKY_PASSWORD,
    })
    console.log("Logged in!")
    //check if pending exists
    if (fs.existsSync(PENDING_FILE)) {
        //pending = (await fs.promises.readFile(PENDING_FILE)).toString().split('\n')
        pending = await fileToArr(PENDING_FILE)
    }

    if (!fs.existsSync(ADDED_FILE)) {
        console.log('api loading list..')
        loadList().then(()=>{
            console.log('loaded list!!')
            inited = true
            addUsersToList()
        })
    } else {
        //added = (await fs.promises.readFile(ADDED_FILE)).toString().split('\n')
        added = await fileToArr(ADDED_FILE)
        console.log('loaded list!!')
        inited = true
        addUsersToList()
    }
}
init()

export {
    isRateLimitAllowed,
    queueUser,
    isInited
}