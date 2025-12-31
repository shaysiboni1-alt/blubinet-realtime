// server.js
// BluBinet Voice Bot – "נטע" (Gemini 2.5 Flash Native Audio)
// ✅ שימוש במודל Gemini 2.5 החדש ביותר לביצועים מקסימליים
// ✅ התאמה מלאה למפתח AI VOICE (Tier 1)
// ✅ תמיכה ב-Thinking Mode וביכולות האודיו החדשות

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
הנחיות קבועות:
1) עני בעברית בלבד בצורה קצרה, אנושית ומקצועית.
2) אל תחזרי על ברכות אם כבר בירכת בתחילת השיחה.
3) אם הלקוח מעוניין לסיים, הודי לו בנימוס וסיימי את השיחה.
${process.env.MB_BUSINESS_PROMPT || ''}
`.trim();

const app = express();
app.get('/', (req, res) => res.send('BluBinet Gemini 2.5 is Live'));

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
        // שימוש ב-v1beta עבור יציבות מול מודל 2.5 החדש
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: WebSocket Connection Opened');
            
            const setup = {
                setup: {
                    // שם המודל המדויק כפי שמופיע אצלך במסך ה-Playground
                    model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                    generation_config: { 
                        response_modalities: ["audio"],
                        thinking_config: { include_thoughts: true } 
                    },
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } }
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setup));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (response.setupComplete) {
                    console.log('Gemini: Setup Verified! Using Gemini 2.5 Flash Native Audio.');
                }

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

        geminiWs.on('error', (err) => console.error('Gemini Socket Error:', err.message));
        geminiWs.on('close', (code, reason) => console.log(`Gemini Closed. Code: ${code}`));
    };

    connectToGemini();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio Stream Started:', streamSid);
            }
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
        if (geminiWs) geminiWs.close();
    });
});

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
