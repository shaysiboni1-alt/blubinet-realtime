// server.js
// BluBinet Voice Bot – "נטע" (Gemini 2.0 Flash Realtime)
// ✅ שימוש ב-v1beta למניעת שגיאת 404 בחשבונות Tier 1
// ✅ תמיכה מלאה ב-ENV: MB_BOT_NAME, MB_BUSINESS_NAME, GEMINI_API_KEY
// ✅ החלפה מלאה של OpenAI ו-ElevenLabs לחיבור אחד יציב

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// -----------------------------
// Config & ENV
// -----------------------------
const PORT = process.env.PORT || 1000; // Render מצפה לפורט שהגדרת
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';
const VOICE_NAME = process.env.MB_VOICE_NAME || 'Aoede'; 

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
חוקים קבועים:
1) עני בעברית בלבד בצורה קצרה ואנושית (1-2 משפטים).
2) אל תברכי שוב אחרי תחילת השיחה.
3) אם הלקוח מבקש לסיים, עני בנימוס ונתקי.
${process.env.MB_BUSINESS_PROMPT || ''}
`.trim();

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('BluBinet Gemini Status: Online'));

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
    console.log('Twilio: Connected');
    let streamSid = null;
    let geminiWs = null;

    const connectToGemini = () => {
        // הכתובת המדויקת למניעת 404 בחשבונות Paid Tier 1
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: WebSocket Connection Opened');
            
            // הודעת SETUP - הגדרת מודל וקול
            const setup = {
                setup: {
                    model: "models/gemini-2.0-flash", // שם המודל ללא סיומת exp ליתר ביטחון ב-Tier 1
                    generation_config: { response_modalities: ["audio"] },
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: VOICE_NAME } }
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setup));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                // קבלת אישור שהחיבור עבר
                if (response.setupComplete) {
                    console.log('Gemini: Setup Verified! Connection is live.');
                }

                // הזרמת אודיו חזרה לטוויליו
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
            } catch (err) {
                console.error("Gemini parse error");
            }
        });

        geminiWs.on('error', (err) => {
            console.error('Gemini Socket Error:', err.message);
        });

        geminiWs.on('close', (code, reason) => {
            console.log(`Gemini Closed. Code: ${code}, Reason: ${reason}`);
        });
    };

    connectToGemini();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio Stream Started:', streamSid);
            }
            // הזרמת אודיו מטוויליו לג'מיני
            if (msg.event === 'media' && geminiWs?.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify({
                    realtime_input: {
                        media_chunks: [{
                            data: msg.media.payload,
                            mime_type: "audio/mulaw"
                        }]
                    }
                }));
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        console.log('Twilio Connection Closed');
        if (geminiWs) geminiWs.close();
    });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
