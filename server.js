// server.js
// BluBinet Voice Bot – "נטע" (Twilio Media Streams + Gemini Multimodal Live API)
// ✅ Gemini 2.0 Flash מחליף את OpenAI ו-ElevenLabs לביצועים מהירים יותר
// ✅ תמיכה מלאה ב-ENV המקוריים שלך
// ✅ ניהול תור (Turn taking) וזיהוי שפה אוטומטי

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
}
function envStr(name, def = '') {
    const raw = process.env[name];
    return raw === undefined || raw === null || raw === '' ? def : String(raw);
}

// -----------------------------
// Config
// -----------------------------
const PORT = envNumber('PORT', 3000);
const GEMINI_API_KEY = envStr('GEMINI_API_KEY', ''); // המפתח שלך (Default / Tier 1)
const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');
const VOICE_NAME = envStr('MB_VOICE_NAME', 'Aoede'); // הקול הנשי שבחרנו

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
חוקי עבודה:
1. עני בעברית בצורה קצרה ואנושית (1-3 משפטים).
2. אם המשתמש פונה באנגלית, ערבית או רוסית - עני לו באותה שפה.
3. אל תברכי שוב אם כבר בירכת בתחילת השיחה.
4. אם הלקוח רוצה לסיים, עני בנימוס וסיימי את השיחה.
${process.env.MB_BUSINESS_PROMPT || ''}
`.trim();

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('BluBinet Gemini Live is Running'));

// Twilio TwiML
app.post('/twilio-voice', (req, res) => {
    const host = req.headers.host;
    res.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <Stream url="wss://${host}/twilio-media-stream" />
            </Connect>
        </Response>
    `);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (ws) => {
    console.log(`[${new Date().toISOString()}] Twilio: Connection Established`);

    let streamSid = null;
    let geminiWs = null;

    // חיבור ל-Gemini Multimodal Live API
    const connectToGemini = () => {
        // הכתובת המדויקת לגרסת ה-Beta שעובדת עם מפתחות Tier 1
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: Live API Connected');
            
            // שליחת הודעת ה-SETUP הראשונית
            const setupMessage = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: { 
                        response_modalities: ["audio"] 
                    },
                    speech_config: {
                        voice_config: { 
                            prebuilt_voice_config: { voice_name: VOICE_NAME } 
                        }
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // קבלת אודיו מג'מיני ושליחה לטוויליו
                if (response.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                    const audioBase64 = response.serverContent.modelTurn.parts[0].inlineData.data;
                    if (streamSid && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: audioBase64 }
                        }));
                    }
                }

                if (response.setupComplete) {
                    console.log('Gemini: Setup Verified');
                }
            } catch (err) {
                console.error("Gemini Message Error:", err);
            }
        });

        geminiWs.on('error', (err) => console.error('Gemini WS Error:', err.message));
        geminiWs.on('close', () => console.log('Gemini Connection Closed'));
    };

    connectToGemini();

    // טיפול בהודעות מטוויליו
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    streamSid = msg.start.streamSid;
                    console.log('Twilio: Stream Started', streamSid);
                    break;

                case 'media':
                    // הזרמת האודיו מטוויליו ישירות לג'מיני
                    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                        const audioMessage = {
                            realtime_input: {
                                media_chunks: [{
                                    data: msg.media.payload,
                                    mime_type: "audio/mulaw"
                                }]
                            }
                        };
                        geminiWs.send(JSON.stringify(audioMessage));
                    }
                    break;

                case 'stop':
                    console.log('Twilio: Stream Stopped');
                    if (geminiWs) geminiWs.close();
                    break;
            }
        } catch (err) {
            console.error("Twilio Message Error:", err);
        }
    });

    ws.on('close', () => {
        if (geminiWs) geminiWs.close();
        console.log('Twilio: WS Closed');
    });
});

server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
