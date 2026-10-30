/** DeepSeek-only probe: a failed request is never evidence of connectivity success. */
export async function probeDeepSeek(
  baseUrl: string | null,
  modelName: string,
  apiKey: string,
  transport: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const base = baseUrl?.replace(/\/$/, "") || "https://api.deepseek.com";
  if (
    !["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(base) ||
    !apiKey.trim() ||
    !modelName.trim()
  ) return { ok: false, error: "DeepSeek configuration unavailable." };
  try {
    const response = await transport(`${base}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error();
    const value = body as {
      id?: unknown; object?: unknown; model?: unknown; choices?: unknown;
    };
    if (
      typeof value.id !== "string" || !value.id ||
      value.object !== "chat.completion" ||
      typeof value.model !== "string" || !value.model ||
      !Array.isArray(value.choices) || value.choices.length === 0
    ) throw new Error();
    const choice = value.choices[0];
    if (
      !choice || typeof choice !== "object" ||
      !choice.message || typeof choice.message !== "object" ||
      choice.message.role !== "assistant" ||
      typeof choice.message.content !== "string"
    ) throw new Error();
    return { ok: true };
  } catch {
    // Exception strings and response bodies may echo credentials; neither is returned.
    return { ok: false, error: "DeepSeek probe failed." };
  }
}
