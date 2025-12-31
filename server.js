require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const VOICE_NAME = process.env.MB_VOICE_NAME || 'Aoede'; 
const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const SYSTEM_INSTRUCTIONS = `
You are an AI assistant named ${BOT_NAME} for ${BUSINESS_NAME}.
Respond in the language the user speaks to you. Keep it short.
`.trim();

const app = express();
app.get('/', (req, res) => res.send('BluBinet is Up'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let geminiWs = null;

    const connectToGemini = () => {
        // ניסיון עם ה-URL המקוצר והישיר ביותר
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: Socket Opened');
            
            // הודעת SETUP מינימלית
            const setupMessage = {
                setup: {
                    model: "models/gemini-2.0-flash-exp"
                }
            };
            geminiWs.send(JSON.stringify(setupMessage));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                // אם קיבלנו אישור SETUP, נשלח את הקונפיגורציה
                if (response.setupComplete) {
                    console.log('Gemini: Setup Complete');
                    const configUpdate = {
                        client_content: {
                            turns: [{
                                role: "user",
                                parts: [{ text: SYSTEM_INSTRUCTIONS }]
                            }],
                            turn_complete: true
                        }
                    };
                    geminiWs.send(JSON.stringify(configUpdate));
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
                console.error("Gemini Msg Error:", err);
            }
        });

        geminiWs.on('error', (error) => {
            console.error('Gemini Error:', error.message);
        });

        geminiWs.on('close', (code) => {
            console.log('Gemini Closed:', code);
        });
    };

    connectToGemini();

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log('Twilio Started:', streamSid);
            }
            if (msg.event === 'media' && geminiWs?.readyState === WebSocket.OPEN) {
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
        } catch (err) {
            console.error("Twilio Msg Error:", err);
        }
    });

    ws.on('close', () => {
        console.log('Twilio Closed');
        if (geminiWs) geminiWs.close();
    });
});

server.listen(PORT, () => console.log(`Running on ${PORT}`));
