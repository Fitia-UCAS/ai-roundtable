# Real Edge E2E · v1.0.31

`e2e-edge-autotest.js` launches a **separate Edge instance** with a dedicated
profile, loads this unpacked extension, opens Gemini/DeepSeek, and runs:

1. fresh Gemini → DeepSeek
2. DeepSeek → Gemini
3. three full bidirectional cycles
4. DeepSeek refresh + reverse relay
5. a long-message round trip

It never uses the normal Edge profile or the user's open tabs.

The test creates its own Roundtable session (`E2E 自动测试 ...`) so test
receipts do not mix into your normal discussion. Keep it, or add
`--delete-session` to delete that isolated session after the run.

## Run

```bat
tests\run-e2e-edge.cmd --yes --cycles 3
```

First run only:

- Edge opens with a dedicated profile.
- Sign in to Gemini and DeepSeek in that Edge window.
- Press Enter in the console to continue.

The profile defaults to `%TEMP%\ai-roundtable-e2e-profile`. You can reuse it:

```bat
tests\run-e2e-edge.cmd --profile "C:\path\to\profile" --yes --cycles 3
```

Options:

- `--cycles N` number of full Gemini→DeepSeek→Gemini cycles (default 3)
- `--skip-refresh` skip the page-refresh recovery test
- `--skip-long` skip the long-message test
- `--keep-open` leave the test Edge open
- `--port N` use a fixed CDP port (otherwise a free port is chosen)
- `--report path.json` output report path
  (default: `%TEMP%\ai-roundtable-e2e-report.json`, so test runs do not write into the extension folder)
- `--delete-session` delete the isolated Roundtable E2E session after the run
- `--fail-after-setup` deliberately fail after creating fresh chats, before the first send
  (used to verify that cleanup skips without a conversation whitelist)
- `--extension path` override the extension folder

The test sends real messages in the dedicated profile. It records a
creation proof for the fresh Gemini/DeepSeek chats and registers their
conversation IDs only after a successful relay. Cleanup only deletes entries in
that per-run whitelist; without creation/registration evidence it skips
deletion and records the skip. It never uses the cleanup-time page URL as
permission to delete a conversation.

The test also creates and deletes its own Roundtable session with
`--delete-session`. It never deletes other conversations from the account.

Do not run it against a profile containing conversations you do not want
changed.
