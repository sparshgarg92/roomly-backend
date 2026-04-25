const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEN_MODEL = 'gemini-2.0-flash-preview-image-generation';
const TEXT_MODEL = 'gemini-2.0-flash';

async function callGemini(model, body) {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

// ── 1. PARSE FLOOR PLAN ──────────────────────────────────────────────────────
router.post('/parse-floorplan', upload.single('floorplan'), async (req, res) => {
  try {
    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const data = await callGemini(TEXT_MODEL, {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: `Analyze this floor plan. Return ONLY valid JSON, no markdown.
{
  "totalWidth": 12,
  "totalHeight": 10,
  "rooms": [
    {
      "id": "room_1",
      "name": "Living Room",
      "type": "living",
      "x": 0, "y": 0, "width": 6, "height": 5,
      "wallColor": "#F5F0E8",
      "floorColor": "#C4A882",
      "description": "Bright open living space"
    }
  ]
}
Rules:
- x,y,width,height in meters, rooms tile together with no gaps
- type: living|bedroom|kitchen|bathroom|dining|hallway|office|other
- Detect ALL rooms in the floor plan` }
        ]
      }]
    });

    const text = data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    console.error('parse-floorplan:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. ANALYZE ROOM PHOTO ────────────────────────────────────────────────────
router.post('/analyze-room', upload.single('photo'), async (req, res) => {
  try {
    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const data = await callGemini(TEXT_MODEL, {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: `Analyze this room photo and return a compact JSON room map for furniture staging.
Return valid JSON only:
{
  "summary": string,
  "roomType": string,
  "cameraView": string,
  "floorPolygon": [{"x": number, "y": number}],
  "wallZones": [{"name": string, "x": number, "y": number, "width": number, "height": number}],
  "avoidZones": [{"name": string, "x": number, "y": number, "width": number, "height": number}],
  "placementGuidance": [string],
  "lighting": string
}
Use percentages 0-100 for all x, y, width, height. Keep floorPolygon to 3-6 points.` }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });

    const text = data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    console.error('analyze-room:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. GENERATE ROOM WITH FURNITURE (Nano Banana) ───────────────────────────
router.post('/generate', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { roomImageDataUrl, furniture = [], prompt: userPrompt = '', roomAnalysis = {}, roomFinishes = {} } = req.body;
    if (!roomImageDataUrl) return res.status(400).json({ error: 'roomImageDataUrl required' });

    const [header, base64Data] = roomImageDataUrl.split(',');
    const mimeType = header.replace('data:', '').replace(';base64', '');

    const furnitureLines = furniture.map(item =>
      `- ${item.name} at approximately (${Math.round(item.x)}%, ${Math.round(item.y)}%) with scale ${item.scale} and rotation ${item.rotation} degrees.${item.productUrl ? ` Product link: ${item.productUrl}.` : ''}`
    );

    const finishLines = [];
    if (roomFinishes.wallColor || roomFinishes.wallMaterial) {
      finishLines.push(`Update the visible walls to ${[roomFinishes.wallColor, roomFinishes.wallMaterial].filter(Boolean).join(' with material ')}.`);
    }
    if (roomFinishes.floorColor || roomFinishes.floorMaterial) {
      finishLines.push(`Update the visible floor to ${[roomFinishes.floorColor, roomFinishes.floorMaterial].filter(Boolean).join(' with material ')}.`);
    }

    const promptParts = [
      'Use the provided room photo as the base image.',
      roomAnalysis.summary ? `Room summary: ${roomAnalysis.summary}` : '',
      roomAnalysis.roomType ? `Room type: ${roomAnalysis.roomType}` : '',
      roomAnalysis.lighting ? `Lighting: ${roomAnalysis.lighting}` : '',
      ...finishLines,
      'Add only the staged furniture items listed below.',
      'Do not redesign, replace, remove, or restyle any existing architecture, decor, furniture, windows, doors, art, rugs, or lighting already present in the room.',
      'Preserve the original camera position, room layout, perspective, materials, shadows, and all existing objects.',
      'Render a single photorealistic still image from the uploaded camera viewpoint.',
      furnitureLines.length ? furnitureLines.join('\n') : '- No extra furniture placements supplied.',
      `Total staged items to add: ${furniture.length}.`,
      userPrompt ? `Additional direction: ${userPrompt}` : '',
    ].filter(Boolean);

    const data = await callGemini(GEN_MODEL, {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Data } },
          { text: promptParts.join('\n') }
        ]
      }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      }
    });

    const parts = data.candidates[0].content.parts;
    const imgPart = parts.find(p => p.inline_data);
    const textPart = parts.find(p => p.text);

    if (!imgPart) return res.status(500).json({ error: 'No image generated' });

    res.json({
      imageDataUrl: `data:${imgPart.inline_data.mime_type};base64,${imgPart.inline_data.data}`,
      text: textPart?.text || '',
    });
  } catch (err) {
    console.error('generate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 4. SIMILAR PRODUCTS (DuckDuckGo — NO API KEY NEEDED) ────────────────────
router.post('/similar-products', express.json(), async (req, res) => {
  try {
    const { items = [], prompt: userPrompt = '', roomType = '' } = req.body;
    if (!items.length) return res.status(400).json({ error: 'items required' });

    const searches = await Promise.all(
      items.slice(0, 6).map(async (item) => {
        const query = buildSearchQuery(item.name, userPrompt, roomType);
        const results = await fetchDuckDuckGoResults(query);
        return { itemName: item.name, query, results };
      })
    );

    router.post('/fetch-product-image', express.json(), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await response.text();

    const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1]
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i)?.[1]
      || html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/)?.[1]
      || '';

    const ogTitle = html.match(/<span[^>]+id="productTitle"[^>]*>\s*([^<]+)\s*<\/span>/)?.[1]?.trim()
      || html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
      || '';

    const price = html.match(/<span[^>]+class="[^"]*a-offscreen[^"]*"[^>]*>\s*(\$[^<]+)\s*<\/span>/)?.[1]?.trim() || '';

    res.json({ image: ogImage, title: ogTitle, price });
  } catch (err) {
    console.error('fetch-product-image:', err.message);
    res.status(500).json({ error: err.message });
  }
});

    res.json({ searches });
  } catch (err) {
    console.error('similar-products:', err.message);
    res.status(500).json({ error: err.message });
  }
});
router.post('/fetch-product-image', express.json(), async (req, res) => {
  try {
    const { url } = req.body;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const html = await response.text();
    
    // Try og:image first (works on Amazon, Airbnb, most sites)
    const ogMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
    
    // Amazon-specific image fallback
    const amazonImgMatch = html.match(/\"large\":\"(https:\/\/m\.media-amazon\.com\/images\/[^"]+)\"/);
    
    const image = ogMatch?.[1] || amazonImgMatch?.[1] || '';
    const title = titleMatch?.[1] || '';
    
    res.json({ image, title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildSearchQuery(itemName, prompt, roomType) {
  const styleWords = prompt.toLowerCase().match(/[a-z][a-z-]+/g)?.slice(0, 4).join(' ') || '';
  return [itemName, styleWords, roomType, 'furniture buy'].filter(Boolean).join(' ');
}

async function fetchDuckDuckGoResults(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await res.text();

  const matches = [...html.matchAll(/class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
  const results = [];

  for (const [, href, rawTitle] of matches) {
    const cleanUrl = normalizeDDGHref(href);
    const cleanTitle = rawTitle.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (cleanUrl && cleanTitle) {
      results.push({ title: cleanTitle, url: cleanUrl });
      if (results.length >= 5) break;
    }
  }
  return results;
}

function normalizeDDGHref(href) {
  try {
    const url = new URL(href, 'https://html.duckduckgo.com');
    if (url.hostname && url.protocol.startsWith('http')) return href;
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : '';
  } catch { return ''; }
}

// ── 5. CHAT ──────────────────────────────────────────────────────────────────
router.post('/chat', express.json(), async (req, res) => {
  try {
    const { message, roomName, roomType, currentFurniture = [] } = req.body;

    const data = await callGemini(TEXT_MODEL, {
      contents: [{
        parts: [{ text: `You are an AI interior designer. Room: ${roomName} (${roomType}). Current furniture: ${currentFurniture.map(f => f.name).join(', ') || 'empty'}.
User: "${message}"
Return ONLY valid JSON:
{
  "reply": "Here's what I'd suggest...",
  "changes": {
    "wallColor": "#F5F0E8",
    "floorColor": "#C4A882",
    "addFurniture": [{"name": "White marble coffee table", "type": "table", "color": "#F0F0F0", "width": 1.2, "height": 0.45, "depth": 0.6}],
    "removeFurniture": [],
    "mood": "minimalist"
  }
}
Only include wallColor/floorColor if user wants to change them. mood: minimalist|cozy|modern|scandinavian|industrial|bohemian` }]
      }]
    });

    const text = data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    console.error('chat:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
