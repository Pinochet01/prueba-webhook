const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const WebSocket = require('ws');
const http = require('http');
const app = express();

// ============================================================
// CONFIGURATION
// ============================================================
const WEBHOOK_SECRET = 'f4c5bb595e6b1aea2d4f47566ee22339ce2b0051';
const GITHUB_APP_ID  = '3296098';

// ✅ FIXED: Two ports for two different models
const LM_STUDIO_URLS = {
  reasoning: 'http://localhost:1234/v1/chat/completions',  // Gemma 3 4B
  tooluse:   'http://localhost:1235/v1/chat/completions',  // Granite 4 Micro
  embedding: 'http://localhost:1234/v1/embeddings'
};

const MODELS = {
  reasoning: 'google/gemma-3-4b',
  tooluse:   'ibm/granite-4-micro',
  embedding: 'text-embedding-nomic-embed-text-v1.5'
};

// WhatsApp configuration (Twilio example — replace with your credentials)
const WHATSAPP_CONFIG = {
  enabled: false,  // Set to true when you have credentials
  accountSid: process.env.TWILIO_SID || '',
  authToken: process.env.TWILIO_TOKEN || '',
  fromNumber: 'whatsapp:+14155238886',  // Twilio sandbox number
  toNumber: 'whatsapp:+YOUR_NUMBER'     // Replace with your phone
};

// ============================================================
// MIDDLEWARE — raw body for signature verification
// ============================================================
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// ============================================================
// WEBSOCKET SERVER (attached to same HTTP server)
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients
const connectedClients = new Set();

wss.on('connection', (ws, req) => {
  console.log(`🔌 WebSocket client connected — total: ${connectedClients.size + 1}`);
  connectedClients.add(ws);
  
  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(`🔌 WebSocket client disconnected — remaining: ${connectedClients.size}`);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
  
  // Send welcome message
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to GitHub webhook AI server' }));
});

// Broadcast to all connected WebSocket clients
function broadcastToClients(data) {
  const message = JSON.stringify(data);
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ============================================================
// WHATSAPP NOTIFICATION
// ============================================================
async function sendWhatsAppNotification(message) {
  if (!WHATSAPP_CONFIG.enabled) {
    console.log('📱 WhatsApp disabled — would have sent:', message.substring(0, 100));
    return false;
  }
  
  try {
    // Dynamic import for Twilio (to avoid requiring it if not used)
    const twilio = await import('twilio');
    const client = twilio.default(WHATSAPP_CONFIG.accountSid, WHATSAPP_CONFIG.authToken);
    
    await client.messages.create({
      body: message,
      from: WHATSAPP_CONFIG.fromNumber,
      to: WHATSAPP_CONFIG.toNumber
    });
    console.log('📱 WhatsApp notification sent');
    return true;
  } catch (err) {
    console.error('❌ WhatsApp error:', err.message);
    return false;
  }
}

// ============================================================
// GITHUB SIGNATURE VERIFICATION
// ============================================================
function verifyGitHubSignature(rawBody, signature) {
  if (!signature) return false;
  
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// ============================================================
// LM STUDIO AI CALL
// ============================================================
async function askLMStudio(prompt, mode = 'reasoning') {
  const model = MODELS[mode];
  const url = LM_STUDIO_URLS[mode];
  
  if (!url) {
    console.error(`❌ No URL configured for mode: ${mode}`);
    return null;
  }
  
  console.log(`\n🤖 Calling LM Studio [${model}] at ${url}...`);
  console.log(`📝 Prompt: ${prompt.substring(0, 150)}...`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      console.error(`❌ LM Studio HTTP error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || null;
    console.log(`✅ LM Studio reply: ${reply?.substring(0, 100)}`);
    return reply;

  } catch (err) {
    console.error('❌ LM Studio error:', err.message);
    return null;
  }
}

// ============================================================
// PROMPT BUILDER
// ============================================================
function buildPrompt(event, body) {
  switch (event) {
    case 'push': {
      const pusher  = body.pusher?.name || 'someone';
      const repo    = body.repository?.full_name || 'unknown repo';
      const commits = body.commits?.length || 0;
      const msgs    = body.commits?.map(c => `- ${c.message}`).join('\n') || 'none';
      return {
        prompt: `GitHub push event:\nUser: ${pusher}\nRepo: ${repo}\nCommits: ${commits}\nMessages:\n${msgs}\n\nSummarize this push in one clear sentence for a developer notification.`,
        mode: 'reasoning'
      };
    }
    case 'pull_request': {
      const action = body.action || 'unknown';
      const title  = body.pull_request?.title || 'no title';
      const user   = body.pull_request?.user?.login || 'someone';
      const base   = body.pull_request?.base?.ref || 'main';
      return {
        prompt: `GitHub pull request ${action}:\nUser: ${user}\nTitle: ${title}\nTarget branch: ${base}\n\nDescribe this PR event in one sentence.`,
        mode: 'reasoning'
      };
    }
    case 'issues': {
      const action = body.action || 'unknown';
      const title  = body.issue?.title || 'no title';
      const user   = body.issue?.user?.login || 'someone';
      return {
        prompt: `GitHub issue ${action}:\nUser: ${user}\nTitle: ${title}\n\nClassify this issue as: bug, feature, question, or other. Reply with JSON: {"type":"...","summary":"..."}`,
        mode: 'tooluse'
      };
    }
    case 'ping':
      return null;
    default:
      return {
        prompt: `Received GitHub event "${event}". Briefly describe what this event type means for a developer.`,
        mode: 'reasoning'
      };
  }
}

// ============================================================
// WEBHOOK ENDPOINT
// ============================================================
app.post('/webhook', (req, res) => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📨 Webhook received:', new Date().toLocaleString());

  const signature   = req.headers['x-hub-signature-256'];
  const githubEvent = req.headers['x-github-event'];
  const deliveryId  = req.headers['x-github-delivery'];

  console.log('🔹 Event     :', githubEvent);
  console.log('🔹 Delivery  :', deliveryId);
  
  // ✅ Signature verification (optional but recommended)
  const isValid = verifyGitHubSignature(req.rawBody, signature);
  if (!isValid && signature) {
    console.warn('⚠️ Invalid signature — webhook may be spoofed');
    // Still respond 200 to avoid blocking, but log warning
  } else if (signature) {
    console.log('✅ Signature verified');
  }

  // ✅ Always respond 200 OK immediately
  res.status(200).send('OK');
  console.log('✅ 200 OK sent to GitHub');
  
  // Broadcast webhook received via WebSocket
  broadcastToClients({
    type: 'webhook_received',
    event: githubEvent,
    delivery_id: deliveryId,
    timestamp: new Date().toISOString()
  });

  // Skip processing if no body
  if (!req.body) {
    console.log('⚠️ No body, skipping processing');
    return;
  }

  // ✅ Async processing
  (async () => {
    try {
      const promptConfig = buildPrompt(githubEvent, req.body);
      if (!promptConfig) {
        console.log(`ℹ️ Event "${githubEvent}" — no AI processing needed`);
        return;
      }
      
      // Broadcast AI processing started
      broadcastToClients({
        type: 'ai_processing_started',
        event: githubEvent,
        mode: promptConfig.mode
      });
      
      const aiReply = await askLMStudio(promptConfig.prompt, promptConfig.mode);
      
      if (aiReply) {
        console.log('\n📋 AI SUMMARY:');
        console.log('─────────────────────────────────────');
        console.log(aiReply);
        console.log('─────────────────────────────────────');
        
        // ✅ Broadcast to WebSocket clients
        broadcastToClients({
          type: 'ai_summary',
          event: githubEvent,
          summary: aiReply,
          timestamp: new Date().toISOString()
        });
        
        // ✅ Send WhatsApp notification
        const whatsappMessage = `🔔 GitHub ${githubEvent}:\n${aiReply}`;
        await sendWhatsAppNotification(whatsappMessage);
      } else {
        broadcastToClients({
          type: 'ai_error',
          event: githubEvent,
          error: 'LM Studio returned no response'
        });
      }
    } catch (err) {
      console.error('🔥 Error:', err.message);
      broadcastToClients({
        type: 'ai_error',
        event: githubEvent,
        error: err.message
      });
    }
  })();
});

// ============================================================
// HEALTH CHECK ENDPOINTS
// ============================================================
app.get('/webhook', (req, res) => {
  res.status(200).send(`
    <h2>✅ Webhook + WebSocket + WhatsApp Server Running</h2>
    <p><b>Endpoint:</b> POST /webhook</p>
    <p><b>WebSocket:</b> ws://localhost:3000</p>
    <p><b>Time:</b> ${new Date().toLocaleString()}</p>
    <hr>
    <h3>Connected WebSocket clients: ${connectedClients.size}</h3>
  `);
});

app.get('/health', async (req, res) => {
  let lmStudioOnline = { reasoning: false, tooluse: false };
  
  // Check Gemma (port 1234)
  try {
    const check = await fetch('http://localhost:1234/v1/models');
    lmStudioOnline.reasoning = check.ok;
  } catch (_) {}
  
  // Check Granite (port 1235)
  try {
    const check = await fetch('http://localhost:1235/v1/models');
    lmStudioOnline.tooluse = check.ok;
  } catch (_) {}
  
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    websocket_clients: connectedClients.size,
    lm_studio: lmStudioOnline,
    whatsapp_enabled: WHATSAPP_CONFIG.enabled
  });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║     🚀 WEBHOOK + WEBSOCKET + WHATSAPP + AI SERVER RUNNING      ║
╠════════════════════════════════════════════════════════════════╣
║  HTTP Port     : ${PORT}                                           ║
║  Webhook       : http://localhost:${PORT}/webhook                  ║
║  WebSocket     : ws://localhost:${PORT}                            ║
║  Health        : http://localhost:${PORT}/health                   ║
╠════════════════════════════════════════════════════════════════╣
║  LM Studio     : Gemma 3  → port 1234                           ║
║                 : Granite 4 → port 1235                          ║
╠════════════════════════════════════════════════════════════════╣
║  WhatsApp      : ${WHATSAPP_CONFIG.enabled ? '✅ ENABLED' : '⭕ DISABLED (set credentials to enable)'}     ║
║  WebSocket     : ${connectedClients.size} client(s) connected                         ║
╚════════════════════════════════════════════════════════════════╝
  `);
});