# @contextgit/mcp

MCP (Model Context Protocol) server for [ContextGit](https://www.npmjs.com/package/contextgit). Provides `project_memory_load`, `project_memory_save`, `project_memory_plan`, `project_memory_threads`, and the other ContextGit tools to MCP clients like Claude Code.

This is an internal workspace package — the MCP server is launched automatically by `contextgit init`. If you want to use ContextGit, install the main package:

```bash
npm install -g contextgit
contextgit init
```

See the main package — [`contextgit`](https://www.npmjs.com/package/contextgit) — or the project on GitHub: [MendeTr/contextgit](https://github.com/MendeTr/contextgit).

## License

MIT
