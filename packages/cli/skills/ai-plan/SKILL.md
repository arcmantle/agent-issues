---
name: ai-plan
description: Ask the user detailed questions about a plan, decision, or idea. Use when the user wants to test a plan or uses a plan trigger phrase.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

Use the `ai-domain-modeling` skill for this interview.

## Persist Plan State

At the start of a new planning effort, read the active initiative with `agent-issues show <initiative-reference> --view full --json`. Create one initiative-owned Plan with `agent-issues create plan --title "<Plan title>" --parent <initiative-reference> --body-file - --json`, and provide a stable Goal and Context body through standard input. If the user gives an explicit Plan reference, resume that Plan instead. Do not infer a Plan to resume or create a duplicate Plan.

Use `agent-issues plan-entry add` to record planning state as it changes:

- Record each design question as a `question` entry before asking it.
- Record each durable user answer before continuing to the next round. When an answer resolves a design question, add a `decision` entry with `--supersedes <question-reference>`.
- Record each durable fact from code or tool output before it affects later planning. Use the approved role that describes the fact.
- When an answer changes the meaning of an active entry, add a new entry with explicit `--supersedes` references. Use entry edit only for a correction that preserves meaning.
- Add no entry for transient conversation that does not change planning state.

Mark the Plan ready with `agent-issues status <plan-reference> ready --json` only after the planning frontier is empty and the user confirms shared understanding. A ready Plan can retain only explicit implementation-discovery questions.

Ask questions until you and the user have the same understanding. Make a **design tree**. Each decision has related decisions below it.

Work on the tree in **rounds**. The **frontier** contains all decisions with settled prerequisites. These are the questions that you can ask now. Do not assume an answer that the user has not given. Ask all frontier questions in one round. Number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body. It can have more than one paragraph or choice.>

➡️ <your recommended answer>
```

After each user response, update the tree. A settled decision can make more questions ready. Calculate the frontier again, then ask the next round. Put a question in a later round if its answer needs an answer from an open question in the current round.

Find _facts_ yourself. Do not ask the user for facts that you can find in the environment, such as files or tool output. When a frontier question needs a fact, send a sub-agent to find it. Do not wait for the sub-agent. Treat the fact search as an unsettled prerequisite. Wait for its result before you ask questions that need that fact. Ask other frontier questions now. The user makes the _decisions_. Ask the user for each decision and wait for an answer.

End the session when the frontier is empty. At this point, you have checked each branch of the design tree. Do not leave any assumption unstated. Do not act until the user confirms that you and the user have the same understanding.