const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use((req, res, next) => { if (req.headers['content-type']?.includes('multipart/form-data')) return next(); express.json({ limit: '50mb' })(req, res, next); });

app.use('/api', require('./routes/floorplan'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));


