'use strict';
const { createApp } = require('./app');
const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`shortlink running on http://localhost:${port}`));
