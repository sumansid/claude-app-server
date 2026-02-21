/**
 * Built-in tool catalog — used only for skills/list discovery.
 * Tool execution is handled natively by the local claude CLI.
 */

export const BUILTIN_SKILLS = [
  {
    name: "Read",
    description: "Read the contents of a file.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to read" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description: "Create a new file with specified content.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path for the new file" },
        content:   { type: "string", description: "Content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description: "Make targeted edits to an existing file.",
    parameters: {
      type: "object",
      properties: {
        file_path:  { type: "string", description: "Path to the file to modify" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "Bash",
    description: "Execute a shell command in the working directory.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        timeout: { type: "number", description: "Timeout in milliseconds" },
      },
      required: ["command"],
    },
  },
  {
    name: "Glob",
    description: "Find files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'" },
        path:    { type: "string", description: "Base directory (default: cwd)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "Search file contents using regex.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path:    { type: "string", description: "Directory or file to search" },
        include: { type: "string", description: "File glob filter, e.g. '*.ts'" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "WebFetch",
    description: "Fetch and analyze the contents of a URL.",
    parameters: {
      type: "object",
      properties: {
        url:    { type: "string", description: "URL to fetch" },
        prompt: { type: "string", description: "What to extract from the page" },
      },
      required: ["url", "prompt"],
    },
  },
  {
    name: "WebSearch",
    description: "Search the web.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "Task",
    description: "Spawn a sub-agent to handle a parallel task.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short description of the task" },
        prompt:      { type: "string", description: "Full prompt for the sub-agent" },
      },
      required: ["description", "prompt"],
    },
  },
];
