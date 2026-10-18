/**
 * A coworker's persona: who it is, written by the person who owns it.
 *
 * Three parts because that is how a person describes a colleague, and because a single free-text
 * "personality" box produces prose the model has to guess how to obey. Each part is optional, and an
 * empty one is left out of the prompt rather than announced in it — a persona with nothing in it is
 * the coworker with no persona, not a coworker told it has none.
 */
export type Persona = {
  /** How it speaks: register, directness, warmth, what its sentences sound like. */
  tone: string;
  /** How it works: the rules it keeps to while doing the job. */
  principles: string;
  /** What it always or never says — the standing lines a person can rely on it to keep. */
  habits: string;
};

export const emptyPersona = (): Persona => ({
  tone: "",
  principles: "",
  habits: "",
});

const SECTIONS: { key: keyof Persona; heading: string; gloss: string }[] = [
  {
    key: "tone",
    heading: "How you speak",
    gloss: "voice and register",
  },
  {
    key: "principles",
    heading: "How you work",
    gloss: "the rules you keep to",
  },
  {
    key: "habits",
    heading: "What you always do",
    gloss: "standing lines and refusals",
  },
];

/** Whether anything at all was written, which is what decides whether a section is sent. */
export function personaIsEmpty(persona: Persona | null | undefined): boolean {
  if (!persona) return true;
  return SECTIONS.every((section) => !persona[section.key]?.trim());
}

/**
 * The persona as a prompt section, or null when there is nothing to say.
 *
 * Goes AFTER the role and BEFORE what the coworker holds: the role says what the job is, this says
 * who does it, and the tools say what it can reach. Ordering matters the same way it does for the
 * grants beside it — a coworker that read about its instruments last reached for them even when the
 * persona had told it to think first.
 *
 * It is told who the persona belongs to, because a persona is not a request: the job can be changed
 * by whoever is talking, and this cannot be, which is the difference this sentence draws for the
 * model.
 */
export function personaGuidance(
  persona: Persona | null | undefined,
): string | null {
  if (personaIsEmpty(persona) || !persona) return null;
  const written = SECTIONS.map((section) => {
    const value = persona[section.key]?.trim();
    if (!value) return null;
    return `${section.heading} (${section.gloss}): ${value}`;
  }).filter((line): line is string => line !== null);

  return [
    "This is who you are, written by the person who owns you:",
    written.join("\n\n"),
    "The role decides what the job is and this decides how you carry it out. Where the two conflict, the job wins and you say so plainly rather than quietly dropping the part of yourself that got in the way.",
  ].join("\n\n");
}
