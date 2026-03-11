#!/usr/bin/env node
import { run, flush } from '@oclif/core'
await run(process.argv.slice(2), import.meta.url)
await flush()
