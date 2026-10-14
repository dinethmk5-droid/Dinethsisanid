// 𝑫𝑰𝑵𝑬𝑻𝑯_𝑴𝑫_𝑴𝑰𝑵𝑰_𝑩𝑶𝑻 - Session ID generator (Pair Code + QR)
// Session ID = base64 of creds.json  (the format the Flash-MD bot reads from the SESSION variable)
const express = require('express')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const pino = require('pino')
const QRCode = require('qrcode')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    delay
} = require('@whiskeysockets/baileys')

const PORT = process.env.PORT || 3000
const JOB_TTL_MS = 3 * 60 * 1000        // time the user has to link
const KEEP_AFTER_DONE_MS = 5 * 60 * 1000 // how long the finished session stays in memory
const MAX_ACTIVE = 15
const BASE_DIR = path.join(os.tmpdir(), 'dineth-sessions')
fs.mkdirSync(BASE_DIR, { recursive: true })

const logger = pino({ level: 'silent' })
const jobs = new Map()
const hits = new Map()

const app = express()
app.set('trust proxy', 1)
app.use(express.json({ limit: '10kb' }))
app.use(express.static(path.join(__dirname, 'public')))

function rateLimited(ip) {
    const now = Date.now()
    const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000)
    if (list.length >= 6) { hits.set(ip, list); return true }
    list.push(now); hits.set(ip, list)
    return false
}

function closeSock(job) {
    try { job.sock?.ev.removeAllListeners('connection.update') } catch {}
    try { job.sock?.ws.close() } catch {}
    job.sock = null
}

function destroy(id) {
    const job = jobs.get(id)
    if (!job) return
    clearTimeout(job.timer)
    closeSock(job)
    fs.rm(job.dir, { recursive: true, force: true }, () => {})
    jobs.delete(id)
}

function fail(job, message) {
    if (job.done) return
    job.done = true
    job.status = 'failed'
    job.error = message
    clearTimeout(job.timer)
    closeSock(job)
    fs.rm(job.dir, { recursive: true, force: true }, () => {})
    setTimeout(() => jobs.delete(job.id), 60 * 1000)
}

async function finish(job) {
    if (job.done) return
    job.done = true
    clearTimeout(job.timer)
    const sock = job.sock
    await delay(3000) // let creds.json be written
    try {
        const raw = fs.readFileSync(path.join(job.dir, 'creds.json'))
        job.session = Buffer.from(raw).toString('base64')
        job.status = 'connected'
    } catch (e) {
        job.status = 'failed'
        job.error = 'Could not read session. Please try again.'
        closeSock(job)
        return
    }
    // also send the Session ID to the user's own WhatsApp chat
    try {
        const jid = jidNormalizedUser(sock.user.id)
        await sock.sendMessage(jid, { text: job.session })
        await sock.sendMessage(jid, {
            text: '*𝑫𝑰𝑵𝑬𝑻𝑯_𝑴𝑫_𝑴𝑰𝑵𝑰_𝑩𝑶𝑻*\n\nමෙය ඔබගේ SESSION ID එකයි. කිසිවෙකුට නොදෙන්න!\nThis is your SESSION ID. Never share it with anyone.'
        })
    } catch {}
    await delay(2000)
    closeSock(job) // no logout - the linked device must stay linked for the bot
    fs.rm(job.dir, { recursive: true, force: true }, () => {})
    setTimeout(() => jobs.delete(job.id), KEEP_AFTER_DONE_MS)
}

async function startSocket(job) {
    const { state, saveCreds } = await useMultiFileAuthState(job.dir)
    let version
    try { ({ version } = await fetchLatestBaileysVersion()) } catch {}
    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: state,
        markOnlineOnConnect: false,
        syncFullHistory: false
    })
    job.sock = sock
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u
        if (job.done) return
        if (qr && job.mode === 'qr') {
            try { job.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 }) } catch {}
        }
        if (connection === 'open') {
            finish(job)
        } else if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
                return fail(job, 'Linking was rejected. Please try again.')
            }
            if (job.retries++ > 12) return fail(job, 'Connection failed. Please try again.')
            // restartRequired (515) is normal right after pairing - reconnect with same auth state
            closeSock(job)
            setTimeout(() => { if (!job.done) startSocket(job).catch(e => fail(job, e.message)) }, 1000)
        }
    })

    if (job.mode === 'pair' && !job.code && !sock.authState.creds.registered) {
        await delay(3000)
        const code = await sock.requestPairingCode(job.number)
        job.code = code
    }
}

function newJob(mode, number) {
    const id = crypto.randomBytes(12).toString('hex')
    const job = {
        id, mode, number, status: 'waiting', code: null, qr: null, session: null, error: null,
        dir: path.join(BASE_DIR, id), retries: 0, done: false, sock: null
    }
    job.timer = setTimeout(() => { if (!job.done) fail(job, 'Time expired. Please try again.') }, JOB_TTL_MS)
    jobs.set(id, job)
    return job
}

function activeCount() {
    let n = 0
    for (const j of jobs.values()) if (!j.done) n++
    return n
}

app.post('/api/pair', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' })
    const number = String(req.body?.number || '').replace(/[^0-9]/g, '')
    if (!/^\d{8,15}$/.test(number)) return res.status(400).json({ error: 'Enter a valid number with country code (e.g. 94771234567).' })
    if (activeCount() >= MAX_ACTIVE) return res.status(503).json({ error: 'Server is busy. Try again in a minute.' })
    const job = newJob('pair', number)
    try {
        await startSocket(job)
        res.json({ id: job.id, code: job.code.match(/.{1,4}/g).join('-') })
    } catch (e) {
        fail(job, e.message)
        res.status(500).json({ error: 'Could not generate a pair code. Please try again.' })
    }
})

app.post('/api/qr', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' })
    if (activeCount() >= MAX_ACTIVE) return res.status(503).json({ error: 'Server is busy. Try again in a minute.' })
    const job = newJob('qr', null)
    try {
        await startSocket(job)
        res.json({ id: job.id })
    } catch (e) {
        fail(job, e.message)
        res.status(500).json({ error: 'Could not start. Please try again.' })
    }
})

app.get('/api/status/:id', (req, res) => {
    const job = jobs.get(req.params.id)
    if (!job) return res.status(404).json({ status: 'expired' })
    res.json({ status: job.status, qr: job.qr, session: job.session, error: job.error })
})

app.get('/health', (_, res) => res.send('OK'))

process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e?.message || e))
process.on('uncaughtException', (e) => console.log('uncaughtException:', e?.message || e))

app.listen(PORT, () => console.log(`𝑫𝑰𝑵𝑬𝑻𝑯_𝑴𝑫_𝑴𝑰𝑵𝑰_𝑩𝑶𝑻 session site running on port ${PORT}`))
