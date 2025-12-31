require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// הגדרות בסיסיות מה-ENV
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';

// הוראות מערכת ל-Gemini
const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
חוקים קריטיים:
1. עני בעברית בלבד בצורה טבעית ואנושית.
2. תשובות קצרות מאוד (1-3 משפטים).
3. אל תברכי שוב אם כבר בירכת בתחילת השיחה.
4. אם הלקוח רוצה לסיים (ביי, תודה וכו'), הגיבי בנימוס וסיימי.
`.trim();

const app = express();
app.use(express.json());

// דף נחיתה לבדיקת תקינות
app.get('/', (req, res) => res.send('BluBinet Gemini Bot is Running!'));

// TwiML עבור Twilio
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

// אתחול Gemini SDK
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

wss.on('connection', (ws) => {
    console.log('Twilio: חיבור חדש נוצר');

    let streamSid = null;
    
    // התחברות ל-Gemini Multimodal Live API
    // אנחנו משתמשים במודל ה-Flash למהירות מקסימלית
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    
    let geminiWs = null;

    const connectToGemini = () => {
        // יצירת חיבור WebSocket ישיר ל-Gemini (נעשה דרך ה-SDK או ישירות)
        // לצורך הפשטות והיציבות ב-Node, נשתמש ב-URL ה-WebSocket הרשמי
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: מחובר ל-API בזמן אמת');
            
            // שליחת הודעת ה-Setup
            const setupMessage = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: { response_modalities: ["audio"] },
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } } // הקול שבחרנו
                    },
                    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] }
                }
            };
            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            const response = JSON.parse(data);

            // אם Gemini מחזיר אודיו, נשלח אותו ישר לטוויליו
            if (response.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                const audioBase64 = response.serverContent.modelTurn.parts[0].inlineData.data;
                
                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: audioBase64 }
                    }));
                }
            }
        });

        geminiWs.on('error', (err) => console.error('Gemini Error:', err));
    };

    connectToGemini();

    // טיפול בהודעות מטוויליו
    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        switch (msg.event) {
            case 'connected':
                console.log('Twilio: Connected event received');
                break;
            case 'start':
                streamSid = msg.start.streamSid;
                console.log('Twilio: Stream started with SID:', streamSid);
                break;
            case 'media':
                // הזרמת האודיו מטוויליו ישירות ל-Gemini
                if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                    const audioMessage = {
                        realtime_input: {
                            media_chunks: [{
                                data: msg.media.payload,
                                mime_type: "audio/mulaw" // טוויליו שולח mulaw
                            }]
                        }
                    };
                    geminiWs.send(JSON.stringify(audioMessage));
                }
                break;
            case 'stop':
                console.log('Twilio: Stream stopped');
                if (geminiWs) geminiWs.close();
                break;
        }
    });

    ws.on('close', () => {
        if (geminiWs) geminiWs.close();
        console.log('Twilio: Connection closed');
    });
});

server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
