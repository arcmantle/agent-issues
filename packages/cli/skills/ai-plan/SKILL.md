---
name: ai-plan
description: Ask the user detailed questions about a plan, decision, or idea. Use when the user wants to test a plan or uses a plan trigger phrase.
---

Follow the shared [language standard](../agent-issues-language.md).
Follow the shared [skill operating contract](../agent-issues-operating-contract.md).

Use the `ai-domain-modeling` skill for this interview.

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