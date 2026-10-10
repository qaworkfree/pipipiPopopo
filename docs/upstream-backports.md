# Selective upstream fixes

This fork retains its local GGUF provider and router behavior. It does not upgrade the installed llama.cpp server. These source changes are backported from earendil-works/pi and keep the fork's package versions and dependency locks.

| Upstream commit | Backport |
| --- | --- |
| `27075fe07597fbb9ada7a0b2e3ea9b9b34505cc0` | Estimate request context at 3.5 characters per token. |
| `b223082bb2ceecd197e5477b8da183eea24f3984` | Protect codemode bridge intrinsics and validate worker messages. |
| `269121616c520a6a9aa9b5da29f1b233ccbed10c` | Describe discovery helpers as asynchronous. |
| `eb326d265ae0b88489a6d10319307780df827cdf` | Separate console output and returned text/image items. The test hunk requiring the separate image-read feature is omitted. |
| `8b5708dbb1b4a819f924b43a2de02c9cc8c7a46d` | Recognize additional transient server-busy messages. |
| `8c911797c3b6b5d3b3921ce4d2438e98e1a948a6` | Close connecting MCP clients and cancel retry delays on shutdown. |

Validation: root `npm run check`; targeted AI context/retry, codemode sandbox, coding-agent codemode session, tool discovery and MCP connection tests. No real provider credentials or personal documents are required.

The hidden-tool prompt reorganization, resource loader symlink changes, image-read changes, MCP OAuth changes, SDK timing/schema migrations and dependency updates are not included in this batch. They require separate compatibility coverage. Upstream llama provider/classifier changes are excluded.
