require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI } = require('@google/genai');

const PORT = process.env.PORT || 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const app = express();
app.get('/', (req, res) => res.send('BluBinet Gemini Live SDK is Active'));

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

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

wss.on('connection', async (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let session = null;

    // הגדרות המודל והקול לפי ה-SDK החדש
    const config = {
        model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        systemInstruction: { 
            parts: [{ text: `את נציגה בשם ${BOT_NAME} עבור ${BUSINESS_NAME}. עני בעברית קצרה (1-2 משפטים).` }] 
        },
        generationConfig: { 
            responseModalities: ['audio'] 
        },
        speechConfig: {
            voiceConfig: { 
                prebuiltVoiceConfig: { voiceName: 'Aoede' } 
            }
        }
    };

    try {
        // התחברות באמצעות ה-SDK הרשמי שמנהל את ה-Websocket
        session = await genAI.live.connect({
            ...config,
            callbacks: {
                onopen: () => console.log('Gemini SDK: Connected Successfully'),
                onmessage: (message) => {
                    // הזרמת אודיו חזרה לטוויליו
                    if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                        const audioData = message.serverContent.modelTurn.parts[0].inlineData.data;
                        if (streamSid && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: streamSid,
                                media: { payload: audioData }
                            }));
                        }
                    }
                },
                onerror: (e) => console.error('Gemini SDK Error:', e),
                onclose: (e) => console.log('Gemini SDK Closed:', e.reason)
            }
        });
    } catch (err) {
        console.error('Critical: Failed to connect to Gemini SDK:', err);
    }

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio Stream Started:', streamSid);
            }
            if (msg.event === 'media' && session) {
                // שליחת אודיו מטוויליו לג'מיני דרך ה-SDK
                session.send({
                    realtimeInput: {
                        mediaChunks: [{
                            data: msg.media.payload,
                            mimeType: 'audio/mulaw'
                        }]
                    }
                });
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        if (session) session.close();
        console.log('Twilio: Connection Closed');
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
