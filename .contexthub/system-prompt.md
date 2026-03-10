You have access to ContextHub memory tools. At the start of every session, call
context_get with scope=global to load project state. After completing significant
work, call context_commit with a message describing what was done and any open
threads. Use context_branch before exploring risky changes.
