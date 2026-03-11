// index.ts — ContextGit REST API entry point
// Starts the Express server on PORT (default 3141).

import { createApp } from './server.js'

const PORT = parseInt(process.env['PORT'] ?? '3141', 10)

createApp()
  .then(app => {
    app.listen(PORT, () => {
      console.log(`ContextGit API listening on http://localhost:${PORT}`)
    })
  })
  .catch(err => {
    console.error('Failed to start ContextGit API:', err)
    process.exit(1)
  })
