# Implementation notes

Records deviations from the plan.

## Task 2

- Added `PromptPool.reset()` (controller ruling): marks every prompt unused again, needed by the full reset. Not in the original brief.
- The `# REVIEW:` comment above the rude prompt also says why: it is rude by design and needs a decision before the event.
- `prompts.txt` starts with a one-line header comment; `fromFile` skips it.
