const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// ─── 1. PARSE FLOOR PLAN ─────────────────────────────────────────────────────
// Takes a floor plan image, returns rooms with positions + dimensions
router.post('/parse-floorplan', upload.single('floorplan'), async (req, res) => {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: imageBase64 }
          },
          {
            type: 'text',
            text: `Analyze this floor plan carefully. Return ONLY valid JSON, no markdown, no explanation.

{
  "totalWidth": 12,
  "totalHeight": 10,
  "rooms": [
    {
      "id": "room_1",
      "name": "Living Room",
      "type": "living",
      "x": 0,
      "y": 0,
      "width": 6,
      "height": 5,
      "wallColor": "#F5F0E8",
      "floorColor": "#C4A882",
      "description": "Bright open living space with natural light"
    }
  ]
}

Rules:
- x, y, width, height are in meters, positioned so rooms tile together perfectly
- totalWidth and totalHeight are the bounding box of the whole floor plan
- type must be one of: living, bedroom, kitchen, bathroom, dining, hallway, office, other
- wallColor is a warm realistic wall hex color per room type
- floorColor is a realistic floor hex color per room type
- description is one sentence about the room
- detect ALL rooms visible in the floor plan`
          }
        ]
      }]
    });

    const raw = response.content[0].text.trim();
    const json = JSON.parse(raw);
    res.json(json);

  } catch (err) {
    console.error('parse-floorplan error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── 2. PARSE PRODUCT FROM URL ───────────────────────────────────────────────
// Takes Amazon/Airbnb/any URL, returns furniture metadata for 3D placement
router.post('/parse-product', express.json(), async (req, res) => {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are given this product URL: ${url}

Based on the URL and any product information you can infer, return ONLY valid JSON:

{
  "name": "Modern Grey Sectional Sofa",
  "type": "sofa",
  "color": "#808080",
  "width": 2.8,
  "height": 0.85,
  "depth": 1.6,
  "price": "$1,299",
  "source": "amazon",
  "thumbnailColor": "#808080"
}

Rules:
- type must be one of: sofa, chair, table, bed, lamp, shelf, desk, rug, plant, tv, other
- width, depth are footprint in meters (realistic furniture size)
- height is how tall in meters
- color is dominant product color as hex
- source is: amazon, airbnb, or other
- infer everything from the URL structure and common sense`
      }]
    });

    const raw = response.content[0].text.trim();
    const json = JSON.parse(raw);
    res.json(json);

  } catch (err) {
    console.error('parse-product error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── 3. CHAT WITH ROOM ───────────────────────────────────────────────────────
// Takes user message + room context, returns design changes
router.post('/chat', express.json(), async (req, res) => {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { message, roomName, roomType, currentFurniture = [] } = req.body;

    const furnitureList = currentFurniture.length > 0
      ? `Current furniture: ${currentFurniture.map(f => f.name).join(', ')}`
      : 'Room is currently empty';

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are an AI interior designer for a ${roomName} (type: ${roomType}).
${furnitureList}

User request: "${message}"

Return ONLY valid JSON:
{
  "reply": "Here's what I'd suggest...",
  "changes": {
    "wallColor": "#F5F0E8",
    "floorColor": "#C4A882",
    "addFurniture": [
      {
        "name": "White marble coffee table",
        "type": "table",
        "color": "#F0F0F0",
        "width": 1.2,
        "height": 0.45,
        "depth": 0.6
      }
    ],
    "removeFurniture": [],
    "mood": "minimalist"
  }
}

Rules:
- reply is conversational, 2-3 sentences max
- only include wallColor/floorColor if the user wants to change them
- addFurniture is a list of new items to place (can be empty)
- removeFurniture is a list of furniture names to remove (can be empty)
- mood is one of: minimalist, cozy, modern, scandinavian, industrial, bohemian`
      }]
    });

    const raw = response.content[0].text.trim();
    const json = JSON.parse(raw);
    res.json(json);

  } catch (err) {
    console.error('chat error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── 4. GET ROOM VIEWS ───────────────────────────────────────────────────────
// Returns 4 camera viewpoints for the bottom view switcher
router.post('/room-views', express.json(), async (req, res) => {
  try {
    const { roomName, roomType, width, height } = req.body;

    // Fixed viewpoints - no AI needed for this
    const views = [
      {
        id: 'perspective',
        label: 'Perspective',
        camera: { x: width * 0.8, y: Math.max(width, height) * 1.2, z: height * 0.8 },
        target: { x: width / 2, y: 0, z: height / 2 }
      },
      {
        id: 'topdown',
        label: 'Top Down',
        camera: { x: width / 2, y: Math.max(width, height) * 1.8, z: height / 2 },
        target: { x: width / 2, y: 0, z: height / 2 }
      },
      {
        id: 'front',
        label: 'Front',
        camera: { x: width / 2, y: height * 0.6, z: height * 1.5 },
        target: { x: width / 2, y: 0, z: 0 }
      },
      {
        id: 'side',
        label: 'Side',
        camera: { x: width * 1.5, y: height * 0.6, z: height / 2 },
        target: { x: 0, y: 0, z: height / 2 }
      }
    ];

    res.json({ views });

  } catch (err) {
    console.error('room-views error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;