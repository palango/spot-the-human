# Implementation notes

Records deviations from the plan.

## Task 2

- Added `PromptPool.reset()` (controller ruling): marks every prompt unused again, needed by the full reset. Not in the original brief.
- The `# REVIEW:` comment above the rude prompt also says why: it is rude by design and needs a decision before the event.
- `prompts.txt` starts with a one-line header comment; `fromFile` skips it.
- The brief's `canSkip` test took one prompt from 10 and expected `canSkip(9)` false. That contradicts the brief's own definition (`remaining >= promptsStillNeeded`: 9 >= 9 is true). I kept the definition and changed the test to take two prompts before expecting false. Controller should confirm the definition.
- The first commit was made with a failing test and 41 prompts by mistake; the follow-up commit fixes both.
