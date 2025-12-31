require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const app = express();
app.get('/', (req, res) => res.send('BluBinet Status: Online'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

wss.on('connection', (ws) => {
    console.log('Twilio: Connected');
    let streamSid = null;
    let geminiWs = null;

    const connectToGemini = () => {
        // הכתובת המלאה והרשמית ל-Realtime בגרסת v1beta
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidirectionalGenerateContent?key=${GEMINI_API_KEY}`;
        
        geminiWs = new WebSocket(url);

        geminiWs.on('open', () => {
            console.log('Gemini: Connection Opened');
            
            // הודעת SETUP - בגרסה הזו חייבים לשלוח רק את שם המודל קודם
            const setup = {
                setup: {
                    model: "models/gemini-2.0-flash-exp"
                }
            };
            geminiWs.send(JSON.stringify(setup));
        });

        geminiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                // ברגע שגוגל מאשרת שה-Setup עבר, אנחנו יודעים שהחיבור חי
                if (response.setupComplete) {
                    console.log('Gemini: Setup Verified (No more 404!)');
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
            } catch (e) { }
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
                console.log('Twilio Started:', streamSid);
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

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
