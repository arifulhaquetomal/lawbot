// api/chat.js
// Serverless function to hide Gemini API Key

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Get the message history from the client
    const { contents, generationConfig } = req.body;

    // Get API Key from environment variable (Secure on server)
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'Server misconfiguration: API Key missing' });
    }

    try {
        // Forward the request to Gemini API
        // We use streamGenerateContent for streaming support
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${apiKey}`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ contents, generationConfig }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            return res.status(response.status).json({ error: errorData.error?.message || 'Gemini API Error' });
        }

        // Pipe the Gemini response stream back to the client
        // Vercel serverless functions support streaming response
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
        });

        // Handle the stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }

        res.end();

    } catch (error) {
        console.error('Proxy Error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
