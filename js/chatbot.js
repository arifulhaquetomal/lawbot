// Chatbot logic for Lawbot (Refactored)

document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
    const SYSTEM_PROMPT_URL = "bot_data/prompt.txt";
    const SOURCES_CONFIG_URL = "bot_data/sources.json";

    // --- DOM Elements ---
    const welcomeScreen = document.getElementById('welcome-screen');
    const chatMessages = document.getElementById('chat-messages');
    const userInput = document.getElementById('userInput');
    const sendBtn = document.getElementById('sendBtn');
    const typingIndicator = document.getElementById('typing-indicator');
    const clearBtn = document.getElementById('clearBtn');

    // --- State ---
    let systemPrompt = "You are a specialized Legal Assistant for Bangladesh.";
    let chatHistory = [];
    const INITIAL_HISTORY = []; // We will load system prompt into this

    // --- Initialization ---
    async function init() {
        await loadPrompts();
        setupEventListeners();

        // Expose quickPrompt to global scope for HTML onclick handlers
        window.quickPrompt = (text) => {
            userInput.value = text;
            handleSendMessage();
        };

        // Initialize history with system prompt
        // Default history if prompt fails or is simple
        updateHistoryWithPrompt();
    }

    async function loadPrompts() {
        try {
            // 1. Load System Prompt (Persona)
            const pRes = await fetch(SYSTEM_PROMPT_URL);
            if (pRes.ok) systemPrompt = await pRes.text();

            // 2. Load Sources from sources.json
            const sRes = await fetch(SOURCES_CONFIG_URL);
            if (sRes.ok) {
                const sources = await sRes.json();
                let sourcesText = "\n\n### Context from Sources:\n";

                for (const filename of sources) {
                    try {
                        const fileUrl = `bot_data/${filename}`;
                        let fileContent = "";

                        if (filename.toLowerCase().endsWith('.pdf')) {
                            fileContent = await extractPdfText(fileUrl);
                        } else {
                            const fRes = await fetch(fileUrl);
                            if (fRes.ok) {
                                const rawText = await fRes.text();
                                if (rawText.trim().startsWith('<') || rawText.includes('<!DOCTYPE html>')) {
                                    fileContent = extractTextFromHtml(rawText);
                                } else {
                                    fileContent = rawText;
                                }
                            }
                        }

                        if (fileContent) {
                            sourcesText += `\n--- Source: ${filename} ---\n${fileContent}\n`;
                        }
                    } catch (err) {
                        console.error(`Error loading source ${filename}:`, err);
                    }
                }

                systemPrompt += sourcesText;
            }
        } catch (e) {
            console.warn("Error initializing prompts:", e);
        }
        updateHistoryWithPrompt();
    }

    async function extractPdfText(url) {
        try {
            const loadingTask = pdfjsLib.getDocument(url);
            const pdf = await loadingTask.promise;
            let fullText = "";

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += pageText + "\n";
            }
            return fullText;
        } catch (e) {
            console.error("PDF Extraction Error:", e);
            return "[Error reading PDF]";
        }
    }

    function extractTextFromHtml(htmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        // Remove scripts and styles
        const scripts = doc.querySelectorAll('script, style, link, meta, noscript');
        scripts.forEach(el => el.remove());
        return doc.body.innerText.replace(/\s+/g, ' ').trim();
    }

    function updateHistoryWithPrompt() {
        INITIAL_HISTORY.length = 0; // Clear
        INITIAL_HISTORY.push({
            role: "user",
            parts: [{ text: systemPrompt }]
        });
        INITIAL_HISTORY.push({
            role: "model",
            parts: [{ text: "Understood. I am LawBot BD, ready to assist." }]
        });

        if (chatHistory.length === 0) {
            chatHistory = [...INITIAL_HISTORY];
        }
    }

    function setupEventListeners() {
        sendBtn.addEventListener('click', handleSendMessage);
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
            }
        });

        clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the conversation?')) {
                chatMessages.innerHTML = '';
                chatMessages.classList.add('hidden');
                welcomeScreen.classList.remove('hidden');
                chatHistory = [...INITIAL_HISTORY];
            }
        });

        // Auto-resize textarea
        userInput.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });
    }

    async function handleSendMessage() {
        const text = userInput.value.trim();
        const apiKey = window.GEMINI_API_KEY;

        if (!text) return;
        if (!apiKey || apiKey.includes('TODO') || apiKey === 'YOUR_API_KEY_HERE') {
            alert('Error: API Key not configured. Please check js/config.js');
            return;
        }

        // UI Updates
        welcomeScreen.classList.add('hidden');
        chatMessages.classList.remove('hidden');

        appendMessage('user', text);
        userInput.value = '';
        userInput.style.height = 'auto';
        sendBtn.disabled = true;
        typingIndicator.classList.remove('hidden');

        try {
            // Prepare payload
            const historyForApi = chatHistory.map(msg => ({
                role: msg.role,
                parts: msg.parts
            }));

            // Add current message
            historyForApi.push({ role: "user", parts: [{ text: text }] });

            // --- STREAMING REQUEST ---
            const streamUrl = API_URL.replace(":generateContent", ":streamGenerateContent");
            const response = await fetch(`${streamUrl}?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: historyForApi,
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 2048
                    }
                })
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error?.message || "API Request Failed");
            }

            // Create initial bot message bubble
            const botMessageDiv = appendMessage('bot', '');
            const contentDiv = botMessageDiv.querySelector('.prose'); // Target the text container
            let fullResponseText = "";

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });

                    // Process SSE-like chunks (Gemini stream returns JSON array elements)
                    // The buffer might contain multiple JSON objects or partial ones.
                    // Simplified parsing for Gemini REST API stream format:
                    // It returns a JSON array of candidates, but streamed.
                    // Actually, the REST API returns a JSON array `[{...}, {...}]`.
                    // We need to parse this properly. A robust way for simple projects
                    // without a complex parser is to assume well-formed JSON chunks if possible, 
                    // but standard fetch stream isn't always perfect JSON lines.

                    // Better approach for client-side without a library:
                    // 1. Accumulate text.
                    // 2. Try to find complete JSON objects `{ ... }`.
                    // 3. Extract `text` from them.

                    // Hacky but effective for this demo:
                    // The API returns distinct JSON objects in the array.
                    // We can just regex for the `text` field in the raw string buffer if parsing is hard,
                    // OR we can rely on the fact that `response.json()` handles the whole thing if we weren't streaming.
                    // For true streaming we need to parse the incoming JSON stream.

                    // Let's try to parse complete JSON objects from the buffer.
                    // Typically chunks start with `[` or `,` and end with `]`.

                    // Let's stick to non-streaming for now to avoid breaking the bot with complex parsing logic,
                    // BUT prompt asked for 'smooth chat experience'. 
                    // Gemini 1.5/2.0 returns independent JSON objects if using SSE endpoint? 
                    // No, the standard REST endpoint returns a JSON array. 
                    //
                    // Correction: The `streamGenerateContent` endpoint returns a stream of `GenerateContentResponse` messages.
                    // They are sent as a JSON array, e.g. `[{"candidates":...},\r\n{"candidates":...}]`.

                    let startIndex = 0;
                    while (true) {
                        const openBrace = buffer.indexOf('{', startIndex);
                        if (openBrace === -1) break;

                        // Try to find matching close brace
                        let braceCount = 1;
                        let closeBrace = -1;
                        for (let i = openBrace + 1; i < buffer.length; i++) {
                            if (buffer[i] === '{') braceCount++;
                            else if (buffer[i] === '}') braceCount--;

                            if (braceCount === 0) {
                                closeBrace = i;
                                break;
                            }
                        }

                        if (closeBrace !== -1) {
                            const jsonStr = buffer.substring(openBrace, closeBrace + 1);
                            try {
                                const chunk = JSON.parse(jsonStr);
                                if (chunk.candidates && chunk.candidates[0].content && chunk.candidates[0].content.parts) {
                                    const textChunk = chunk.candidates[0].content.parts[0].text;
                                    fullResponseText += textChunk;
                                    // Update UI
                                    contentDiv.innerHTML = typeof marked !== 'undefined' ? marked.parse(fullResponseText) : fullResponseText;
                                    chatMessages.scrollTop = chatMessages.scrollHeight;
                                }
                            } catch (e) {
                                // ignore partial/invalid json
                            }
                            // Move buffer past this object
                            buffer = buffer.substring(closeBrace + 1);
                            startIndex = 0; // restart search in new buffer
                        } else {
                            break; // Wait for more data
                        }
                    }
                }
            } catch (streamError) {
                console.error("Stream reading error:", streamError);
            }

            // Update history with full text
            chatHistory.push({ role: "user", parts: [{ text: text }] });
            chatHistory.push({ role: "model", parts: [{ text: fullResponseText }] });

        } catch (error) {
            console.error(error);
            appendMessage('bot', `**Error:** ${error.message}. Please check your connection and API key.`);
        } finally {
            typingIndicator.classList.add('hidden');
            sendBtn.disabled = false;
        }
    }

    function appendMessage(role, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `flex ${role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`;

        // Parse markdown if marked is available, otherwise plain text
        let content = text;
        if (role === 'bot' && typeof marked !== 'undefined' && text) {
            content = marked.parse(text);
        } else if (role === 'bot' && text) {
            // simple fallback for bold
            content = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
        }

        msgDiv.innerHTML = `
            <div class="max-w-[85%] ${role === 'user' ? 'message-user shadow-md' : 'message-bot shadow-sm'} p-4">
                <div class="flex items-center space-x-2 mb-2">
                    <i class="fas ${role === 'user' ? 'fa-user' : 'fa-balance-scale text-emerald-600'} text-xs opacity-70"></i>
                    <span class="text-[10px] font-bold uppercase tracking-wider opacity-70">${role === 'user' ? 'You' : 'LawBot BD'}</span>
                </div>
                <div class="prose prose-sm max-w-none text-inherit">
                    ${content}
                </div>
            </div>
        `;

        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return msgDiv; // Return the div so we can update it during streaming
    }

    // Run init
    init();
});
