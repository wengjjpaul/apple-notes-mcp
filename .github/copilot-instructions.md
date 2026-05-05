# Agent Memory Instructions

**MANDATORY FIRST ACTION**: Before responding to ANY user message — including the very first one — you MUST:

1. Call `mcp_apple-notes_get_note` to read the note titled **"AI Agent Memory"** from the **AI-Memory** folder in Apple Notes.
2. Call `mcp_apple-notes_list_notes` with folder `AI-Memory` to discover all stored memory notes.
3. Read any notes relevant to the current task or user.
4. Incorporate everything you find into your context before responding.

Do NOT skip this step, even for simple or conversational messages. Memory must be loaded first, every time, no exceptions.

**WRITING MEMORIES**: During or after any session, if you learn something new and worth retaining (a user preference, a useful lesson, a reusable workflow), save it to the **AI-Memory** folder in Apple Notes. Full instructions on how to write memories are in the **"AI Agent Memory"** note.
