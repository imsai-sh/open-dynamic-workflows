<!--
Source: https://code.claude.com/docs/en/workflows.md
Retrieved: 2026-05-29 (verbatim archive, kept for fidelity reference).
This is Anthropic's official Claude Code docs page for dynamic workflows — the
behavioral contract this project reimplements. Do not edit the body; it is a snapshot.
-->

# Orchestrate subagents at scale with dynamic workflows

> Dynamic workflows orchestrate many subagents from a script Claude writes and you can rerun. Use them for codebase audits, large migrations, and cross-checked research.

> Dynamic workflows are in research preview. They require Claude Code v2.1.154 or later and are available on all paid plans, with Anthropic API access, and on Amazon Bedrock, Google Cloud Vertex AI, and Microsoft Foundry. On Pro, turn them on from the Dynamic workflows row in `/config`.

A dynamic workflow is a JavaScript script that orchestrates [subagents](https://code.claude.com/docs/en/sub-agents) at scale. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive.

Reach for a workflow when a task needs more agents than one conversation can coordinate, or when you want the orchestration codified as a script you can read and rerun. Examples include a codebase-wide bug sweep, a 500-file migration, a research question that needs sources cross-checked against each other, and a hard plan worth drafting from several independent angles before you commit to one.

This page covers how to:

* Decide when to use a workflow instead of subagents or skills
* Run a bundled workflow with `/deep-research`
* Have Claude write a workflow for your task and save it
* Understand how a workflow runs and manage runs

## When to use a workflow

Subagents, skills, and workflows can all run a multi-step task. The difference is who holds the plan:

|                                 | Subagents                      | Skills                       | Workflows                            |
| :------------------------------ | :----------------------------- | :--------------------------- | :----------------------------------- |
| What it is                      | A worker Claude spawns         | Instructions Claude follows  | A script the runtime executes        |
| Who decides what runs next      | Claude, turn by turn           | Claude, following the prompt | The script                           |
| Where intermediate results live | Claude's context window        | Claude's context window      | Script variables                     |
| What's repeatable               | The worker definition          | The instructions             | The orchestration itself             |
| Scale                           | A few delegated tasks per turn | Same as subagents            | Dozens to hundreds of agents per run |
| Interruption                    | Restarts the turn              | Restarts the turn            | Resumable in the same session        |

A workflow moves the plan into code. With subagents and skills, Claude is the orchestrator: it decides turn by turn what to spawn next, and every result lands in Claude's context. A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer.

Moving the plan into code also lets a workflow apply a repeatable quality pattern, not just run more agents: it can have independent agents adversarially review each other's findings before they're reported, or draft a plan from several angles and weigh them against each other, so you get a more trustworthy result than a single pass.

## Run a bundled workflow

The quickest way to see a workflow in action is to run `/deep-research`, the built-in workflow Claude Code includes for investigating a question across many sources. You'll see agents work through a set of phases in the background while your session stays free, and get one report at the end instead of a turn-by-turn transcript.

1. **Run the workflow.** Run `/deep-research` with a question you want investigated. It fans out web searches across several angles, fetches and cross-checks the sources it finds, and synthesizes a cited report.

   ```text
   /deep-research What changed in the Node.js permission model between v20 and v22?
   ```

2. **Allow workflows.** Claude Code asks whether to allow the workflow. Select **Yes** to continue. The exact prompt depends on your permission mode.

3. **Watch progress.** The run starts in the background. Run `/workflows`, use the arrow keys to select the run, and press Enter to open its progress view. The view shows each phase with its agent count, token total, and elapsed time. Drill into any phase to see its agents and what each one found. You can also watch from the task panel below the input box: a one-line progress summary appears there while the run is going.

4. **Read the report.** When the run finishes, the report lands in your session. It cites the sources each claim came from, with claims that didn't survive cross-checking already filtered out.

To run a workflow for your own task, have Claude write one, and once a run does what you wanted you can save it as a command of your own.

### Bundled workflows

Claude Code includes `/deep-research` as a built-in workflow:

| Command                     | What it does                                                                                                                                                                                                                                       |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/deep-research <question>` | Fans out web searches on a question across several angles, fetches and cross-checks the sources it finds, votes on each claim, and returns a cited report with claims that didn't survive cross-checking filtered out. Requires the WebSearch tool. |

Workflows you save yourself become commands the same way and appear in `/` autocomplete alongside the bundled ones.

### Watch the run

Workflows run in the background, so the session stays responsive while agents work. Run `/workflows` at any time to list running and completed workflows, then select one to open its progress view. The progress view shows each phase with its agent counts, token totals, and elapsed time. The footer lists the key for each action:

| Key            | Action                                                                                              |
| :------------- | :-------------------------------------------------------------------------------------------------- |
| `↑` / `↓`      | Select a phase or agent                                                                             |
| `Enter` or `→` | Drill into the selected phase, then into an agent to read its prompt, recent tool calls, and result |
| `Esc`          | Back out one level                                                                                  |
| `j` / `k`      | Scroll within the agent detail when it overflows                                                    |
| `p`            | Pause or resume the run                                                                             |
| `x`            | Stop the selected agent, or stop the whole workflow when focus is on the run                        |
| `r`            | Restart the selected running agent                                                                  |
| `s`            | Save the run's script as a command                                                                  |

## Have Claude write a workflow

You can have Claude write a workflow for your task in two ways:

* **Ask for a workflow** in your prompt with the word `workflow`, and Claude writes one for the task.
* **Let Claude decide with ultracode**: set `/effort ultracode` and Claude plans a workflow for every substantive task in the session.

You can also run a workflow command that already exists: a bundled workflow like `/deep-research`, or one you've saved.

### Ask for a workflow in your prompt

To run a single task as a workflow without changing the session's effort level, include the word `workflow` anywhere in your prompt.

```text
Run a workflow to audit every API endpoint under src/routes/ for missing auth checks
```

Claude Code highlights the word in your input and Claude writes a workflow script for the task instead of working through it turn by turn. If the run does what you wanted, you can save it as a command afterward. If Claude Code highlights the word when you didn't mean to trigger one, press `alt+w` to ignore it for this prompt.

### Let Claude decide with ultracode

Ultracode is a Claude Code setting that combines `xhigh` reasoning effort with automatic workflow orchestration. With it on, Claude plans a workflow for each substantive task instead of waiting for you to ask.

```text
/effort ultracode
```

With ultracode on, Claude decides when a task warrants a workflow. A single request can turn into several workflows in a row: one to understand the code, one to make the change, and one to verify it. This applies to every task in the session, so each request uses more tokens and takes longer than at lower effort levels. Ultracode lasts for the current session and resets when you start a new one. Drop back with `/effort high` when you return to routine work.

### Approve the plan before it runs

In the CLI, the per-run prompt shows the planned phases and these options:

* **Yes, run it**: start the run
* **Yes, and don't ask again for `<name>` in `<path>`**: start, and skip this prompt for this workflow in this project from now on
* **View raw script**: read the script before deciding
* **No**: cancel

`Ctrl+G` opens the script in your editor. `Tab` lets you adjust the prompt before the run starts.

Whether you see this prompt depends on your permission mode:

| Permission mode                            | When you're prompted                                                                                                                                    |
| :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default, accept edits                      | Every run, unless you've selected **Yes, and don't ask again** for that workflow in this project                                                        |
| Auto                                       | First launch only. Any **Yes** records consent in your user settings, and later launches start without prompting. Skipped entirely when ultracode is on |
| Bypass permissions, `claude -p`, Agent SDK | Never. The run starts immediately                                                                                                                       |

The subagents the workflow spawns always run in `acceptEdits` mode and inherit your tool allowlist, regardless of your session's mode. File edits are auto-approved. Shell commands, web fetches, and MCP tools that aren't in your allowlist can still prompt you mid-run.

### Save the workflow for reuse

When Claude writes a workflow for a task you'll repeat, you can save that run's script as a command. Run `/workflows`, select the run you want to keep, and press `s`. In the save dialog, Tab toggles between the two save locations:

* `.claude/workflows/` in your project: shared with everyone who clones the repo
* `~/.claude/workflows/` in your home directory: available in every project, visible only to you

Press Enter to save. The workflow runs as `/<name>` in future sessions from either location. If a project workflow and a personal workflow share a name, the project one runs.

## How a workflow runs

The workflow runtime executes the script in an isolated environment, separate from your conversation. Intermediate results stay in script variables instead of landing in Claude's context. The runtime tracks each agent's result as the run progresses, which is what makes a run resumable within the same session.

### Behavior and limits

The runtime applies the following constraints:

| Constraint                                                           | Why                                                                                                            |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------- |
| No mid-run user input                                                | Only agent permission prompts can pause a run. For sign-off between stages, run each stage as its own workflow |
| No direct filesystem or shell access from the workflow itself        | Agents read, write, and run commands. The script coordinates the agents                                        |
| Up to 16 concurrent agents, fewer on machines with limited CPU cores | Bounds local resource use                                                                                      |
| 1,000 agents total per run                                           | Prevents runaway loops                                                                                         |

## Manage runs

Once a run starts, you manage it from the `/workflows` view, or by expanding its progress line in the task panel below the input box.

### Resume after a pause

If you stop a run, you can resume it: agents that already completed return their cached results, and the rest run live. Resume a paused run from `/workflows` by selecting it and pressing `p`, or ask Claude to relaunch the workflow with the same script.

Resume works within the same Claude Code session. If you exit Claude Code while a workflow is running, the next session starts the workflow fresh.

### Cost

A workflow spawns many agents, so a single run can use meaningfully more tokens than working through the same task in conversation. Runs count toward your plan's usage and rate limits like any other session. You can stop a running workflow from `/workflows` at any time without losing completed work.

Every agent in a workflow uses your session's model unless the script routes a stage to a different one.

### Turn workflows off

Workflows are available in the CLI, the Desktop app, the IDE extensions, non-interactive mode with `claude -p`, and the Agent SDK. The same disable settings apply on every surface.

* Toggle Dynamic workflows off in `/config`. Persists across sessions.
* Set `"disableWorkflows": true` in `~/.claude/settings.json`. Persists across sessions.
* Set `CLAUDE_CODE_DISABLE_WORKFLOWS=1`. Read at startup.

When workflows are disabled, the bundled workflow commands are unavailable, the `workflow` keyword no longer triggers a run, and `ultracode` is removed from the `/effort` menu.
